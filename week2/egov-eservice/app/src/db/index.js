'use strict';
/**
 * ฐานข้อมูล SQLite (better-sqlite3) ที่ไฟล์ DB_PATH (CONTRACT §0 ข้อ 11)
 *
 * ใช้ได้ทั้งสองแบบ:
 *   const db = require('../db');            db.prepare('SELECT ...').get(...)
 *   const { db, nextSeq, appendAudit } = require('../db');
 *
 * ตัวช่วยที่แนบไว้กับ db:
 *   db.nextSeq('case:2569')        → 31   (atomic · ใช้ใน transaction เดียวกับการ UPDATE ได้)
 *   db.peekSeq(name) / db.setSeq(name, value)
 *   db.appendAudit({ user, event, caseNo, fromStatus, toStatus, detail })   (user = req.user)
 *   db.resetDatabase()             → DROP ทุกตาราง + exec schema.sql + seed.js (เรียกโดย POST /api/test/reset)
 *   db.onReset(fn)                 → ให้โมดูลที่มี cache ในหน่วยความจำล้างตัวเองหลัง reset
 *   db.tx(fn)                      → db.transaction(fn)() (synchronous เท่านั้น ห้าม await ข้างใน)
 *
 * หมายเหตุ: statement ที่ prepare ค้างไว้ยังใช้ได้หลัง reset (SQLite re-prepare อัตโนมัติเมื่อ schema เปลี่ยน)
 * แต่แนะนำให้ prepare ภายใน handler
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const clock = require('../lib/clock');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'egov.db'));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const SEED_PATH = path.join(__dirname, 'seed.js');

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = DELETE'); // ไฟล์เดียว ตรวจแบบ inspection (TC-NFR-04) ได้ง่าย
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('secure_delete = ON'); // หน้าที่ถูกลบถูกเขียนทับด้วย 0 (ไม่เหลือข้อมูลเก่าในไฟล์)
db.pragma('foreign_keys = ON');

const resetHooks = [];

function readSchema() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function schemaHash() {
  return crypto.createHash('sha1').update(readSchema()).digest('hex');
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function dropAll() {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('trigger','view','table')")
    .all();
  const order = { trigger: 0, view: 1, table: 2 };
  objects.sort((a, b) => order[a.type] - order[b.type]);
  for (const o of objects) {
    db.exec(`DROP ${o.type.toUpperCase()} IF EXISTS "${o.name.replace(/"/g, '""')}"`);
  }
}

function createSchema() {
  db.exec(readSchema());
  db.prepare('INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)').run('schema_hash', schemaHash());
}

/** โหลดฟังก์ชัน seed จาก src/db/seed.js (ถ้ามี) · รองรับ module.exports = fn | { seed } | { default } */
function loadSeedFn() {
  if (!fs.existsSync(SEED_PATH)) return null;
  const mod = require(SEED_PATH);
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.seed === 'function') return mod.seed;
  if (mod && typeof mod.default === 'function') return mod.default;
  console.warn('[db] src/db/seed.js ไม่ได้ export ฟังก์ชัน seed(db) — ข้ามการ seed');
  return null;
}

function hasSeed() {
  return fs.existsSync(SEED_PATH);
}

function checkForeignKeys() {
  const bad = db.pragma('foreign_key_check');
  if (bad.length) {
    console.warn(`[db] foreign_key_check พบ ${bad.length} แถวที่อ้างอิงไม่ถูกต้อง (แสดง 5 แถวแรก):`, bad.slice(0, 5));
  }
}

/**
 * เรียก seed(db) · seed แบบ synchronous รันใน transaction เดียว (foreign_keys ปิดระหว่าง seed แล้วตรวจภายหลัง)
 * ถ้า seed เป็น async คืน Promise (test.js await ให้)
 */
function runSeed() {
  const fn = loadSeedFn();
  if (!fn) return false;
  const isAsync = fn.constructor && fn.constructor.name === 'AsyncFunction';
  db.pragma('foreign_keys = OFF');
  if (isAsync) {
    return Promise.resolve()
      .then(() => fn(db))
      .then(() => true)
      .finally(() => {
        db.pragma('foreign_keys = ON');
        checkForeignKeys();
      });
  }
  try {
    db.transaction(() => {
      const r = fn(db);
      if (r && typeof r.then === 'function') {
        throw new Error('seed(db) ต้องเป็นฟังก์ชัน synchronous (better-sqlite3)');
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  checkForeignKeys();
  return true;
}

function runResetHooks() {
  for (const fn of resetHooks) {
    try {
      fn();
    } catch (e) {
      console.error('[db] reset hook error:', e);
    }
  }
}

/**
 * ล้างทุกอย่างแล้วสร้างใหม่: DROP ทุกตาราง (รวม sessions, audit_log, notifications, attachments)
 * → exec schema.sql → seed.js (ถ้ามี) → reset hooks
 * คืน true/false (หรือ Promise ถ้า seed เป็น async)
 */
function resetDatabase() {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      dropAll();
      createSchema();
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const seeded = runSeed();
  if (seeded && typeof seeded.then === 'function') {
    return seeded.then((v) => {
      runResetHooks();
      return v;
    });
  }
  runResetHooks();
  return seeded;
}

/**
 * เรียกตอนเริ่มเซิร์ฟเวอร์:
 *   - ยังไม่มีตาราง / schema.sql เปลี่ยน → สร้างใหม่ทั้งหมด + seed
 *   - มีตารางแต่ยังไม่มีผู้ใช้ (seed.js เพิ่งถูกเพิ่ม) → seed
 */
async function initDatabase() {
  const fresh = !tableExists('users') || !tableExists('app_meta');
  let stale = false;
  if (!fresh) {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_hash'").get();
    stale = !row || row.value !== schemaHash();
  }
  if (fresh || stale) {
    if (stale) console.warn('[db] schema.sql เปลี่ยน → สร้างฐานข้อมูลใหม่และ seed ใหม่');
    await resetDatabase();
    return { created: true };
  }
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (users === 0 && hasSeed()) {
    await runSeed();
    runResetHooks();
    return { created: false, seeded: true };
  }
  return { created: false, seeded: false };
}

// ---------------------------------------------------------------------------
// ตัวนับเลขรัน
// ---------------------------------------------------------------------------
const nextSeqSql =
  'INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value';

/** เพิ่มตัวนับแล้วคืนค่าใหม่ (เริ่ม 1 ถ้ายังไม่มี) */
function nextSeq(name) {
  return db.prepare(nextSeqSql).get(name).value;
}

/** ค่าปัจจุบันของตัวนับ (ยังไม่มี = 0) */
function peekSeq(name) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  return row ? row.value : 0;
}

/** ตั้งค่าตัวนับ (ใช้ใน seed) */
function setSeq(name, value) {
  db.prepare(
    'INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
  ).run(name, value);
}

// ---------------------------------------------------------------------------
// Audit (append-only)
// ---------------------------------------------------------------------------
/**
 * บันทึก Audit 1 แถว
 * @param {object} e
 * @param {object} [e.user]  req.user ({id, username, role}) — หรือส่ง userId/username/role แยก
 * @param {string} e.event   STAFF_LOGIN CLAIM RETURN FORWARD APPROVE REJECT ISSUE UNMASK EXPORT ADMIN_CHANGE
 * @param {string} [e.caseNo] @param {string} [e.fromStatus] @param {string} [e.toStatus] @param {string} [e.detail]
 * @param {string} [e.at]    ค่าเริ่มต้น = clock.nowIso()
 * @returns {number} id ของแถว
 */
function appendAudit(e) {
  const u = e.user || {};
  const info = db
    .prepare(
      `INSERT INTO audit_log (at, user_id, username, role, event, case_no, from_status, to_status, detail)
       VALUES (@at, @user_id, @username, @role, @event, @case_no, @from_status, @to_status, @detail)`
    )
    .run({
      at: e.at || clock.nowIso(),
      user_id: e.userId != null ? e.userId : u.id != null ? u.id : null,
      username: e.username || u.username || '',
      role: e.role || u.role || '',
      event: e.event,
      case_no: e.caseNo || null,
      from_status: e.fromStatus || null,
      to_status: e.toStatus || null,
      detail: e.detail == null ? '' : String(e.detail),
    });
  return Number(info.lastInsertRowid);
}

function onReset(fn) {
  if (typeof fn === 'function') resetHooks.push(fn);
}

function tx(fn) {
  return db.transaction(fn)();
}

function getDb() {
  return db;
}

Object.assign(db, {
  db,
  DB_PATH,
  getDb,
  initDatabase,
  resetDatabase,
  runSeed,
  hasSeed,
  tableExists,
  nextSeq,
  peekSeq,
  setSeq,
  appendAudit,
  onReset,
  tx,
});

module.exports = db;
