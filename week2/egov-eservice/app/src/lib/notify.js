'use strict';
/**
 * B08 · แจ้งเตือน SLA (กระดิ่ง) + ยกเลิกอัตโนมัติเมื่อเลย 168 ชม.
 *
 * ที่มา: REQUIREMENTS FR-11 FR-20 BR-14 BR-15 BR-20 · A-21 A-30 A-31 A-46
 *        CONTRACT §0 ข้อ 7 · §1 (/notifications) · §2.1 (nav-bell/bell-count) · §2.12 · §6.3 (GET /api/notifications)
 *        TEST-DATA §8 §8.1 §8.2 · DECISIONS §8 §9 §18 (ผู้รับแจ้งเตือน)
 *
 * server.js เรียก middleware(req, res, next) หลัง session แต่ /api/health และ static ถูกวางไว้ก่อน
 * → ตอนโหลดโมดูลนี้ (server.js require ใน createApp() ก่อน app.listen() → ก่อนรับ request แรกเสมอ)
 *   installRouterHook() ห่อ express.Router.handle (prototype ของทุก router รวม app._router ที่สร้างแล้ว)
 *   ให้ router หลักของแอป (มี layer expressInit) ประเมินก่อน layer แรกทำงาน → ทุก request ตั้งแต่ request แรก
 *   (รวม /api/health และไฟล์ static) ประเมินก่อนถึง route ใด ๆ (CONTRACT §0 ข้อ 7)
 *   ยกเว้น /api/test/* · 1 ครั้งต่อ request (evaluateFor) · เวลาอ่านจาก clock.js เท่านั้น
 * ทุกครั้งทำตามลำดับ (ใน transaction เดียว ตามนาฬิกา clock.nowMs()):
 *   1. autoCancelExpired(now): คำขอ NEED_FIX ที่ now ≥ ตีกลับ + 168:00 → CANCELLED
 *        cancelled_at = ตีกลับ + 168 ชม. (A-46: เวลาที่ลงไทม์ไลน์) · cancel_reason = 'FIX_EXPIRED' · dept = NULL
 *        + case_events type 'AUTO_CANCEL' (at = เวลาเดียวกัน) · 167:59 ยังส่งแก้ได้ · 168:00 ยกเลิกแล้ว
 *   2. evaluateNotifications(now): คำขอที่มีเลขและยังไม่ปิด (SUBMITTED IN_REVIEW PENDING_APPROVAL APPROVED)
 *        ระดับ = rules.slaLevel(now, due_at, วันหยุด, status) (B03 · NEED_FIX = หยุดนับ ไม่ประเมิน)
 *        ประเมินเฉพาะระดับปัจจุบัน (A-30: ไม่ย้อนแจ้ง near เมื่อนาฬิกาข้ามไป overdue)
 *        ผู้รับ (BR-15 · A-31):
 *          PENDING_APPROVAL              → head ทุกคน (active)
 *          APPROVED (รอออกเอกสาร)          → ผู้ออกเอกสาร (A-27 · documents.issuerIdOf)
 *          SUBMITTED/IN_REVIEW มีผู้ถือ    → ผู้ถือ
 *          SUBMITTED/IN_REVIEW ไม่มีผู้ถือ → officer ทุกคน (active) ของแผนกที่เรื่องอยู่
 *          ระดับ overdue                 → + head ทุกคน (ไม่ซ้ำถ้าเป็นผู้รับอยู่แล้ว)
 *        บันทึก INSERT OR IGNORE (UNIQUE user_id, case_id, level) → 1 ครั้งต่อระดับต่อคำขอต่อคน
 *        ข้อความ 'คำขอ EG-2569-000024 ใกล้ครบกำหนด' / 'คำขอ EG-2569-000020 เกินกำหนด'
 *   3. ถ้ายังไม่มีไฟล์ src/routes/notifications.js → middleware เสิร์ฟ route ของบล็อกนี้เอง (router ด้านล่าง):
 *        GET /notifications       officer · head (อื่น 403 forbidden-msg · ไม่ล็อกอิน → /login)
 *        GET /api/notifications   officer · head → 200 {"items":[{id,caseNo,level,text,createdAt}]} (ของผู้ใช้นั้นเท่านั้น)
 *      ถ้าภายหลังมี src/routes/notifications.js ให้เขียนเพียง: module.exports = require('../lib/notify').router;
 *
 * bell-count (layout.js) = COUNT(*) ของ notifications ของผู้ใช้ (A-30: ไม่มีสถานะอ่านแล้ว)
 * reset (POST /api/test/reset) DROP ตาราง notifications → ว่างจนมี request แรกที่ไม่ใช่ /api/test/*
 *
 * ตัวช่วยที่ export: middleware · installRouterHook() · evaluateFor(req) · evaluate(now?) · autoCancelExpired(now?) · evaluateNotifications(now?)
 *   recipientsFor(caseRow, level) · listFor(userId) · countFor(userId) · notiText(caseNo, level) · router
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const clock = require('./clock');
const rules = require('./rules');
const rbac = require('./rbac');
const { LEVEL_LABELS, LIMITS } = require('./constants');
const { esc, timeTag } = require('./format');

const NOTIFY_LEVELS = ['near', 'overdue'];
const OPEN_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];
const ROUTE_FILE = path.join(__dirname, '..', 'routes', 'notifications.js');
const AUTO_CANCEL_TEXT = 'ยกเลิกอัตโนมัติ: ไม่ส่งแก้ไขภายใน 168 ชั่วโมงนับจากตีกลับ';

// ---------------------------------------------------------------------------
// ตัวช่วย
// ---------------------------------------------------------------------------

function toNowMs(now) {
  if (now === undefined || now === null) return clock.nowMs();
  const ms = clock.toMs(now);
  return Number.isFinite(ms) ? ms : clock.nowMs();
}

/** 'คำขอ EG-2569-000024 ใกล้ครบกำหนด' */
function notiText(caseNo, level) {
  return `คำขอ ${caseNo} ${LEVEL_LABELS[level] || level}`;
}

/** แผนกที่เรื่องอยู่ (คิว) · cases.dept ว่าง → SV-03 ขั้น 2 = works · อื่น = registry */
function deptOf(c) {
  if (c.dept === 'registry' || c.dept === 'works') return c.dept;
  if (c.service_id === 'SV-03' && Number(c.step) === 2) return 'works';
  return 'registry';
}

function activeHeadIds() {
  return db
    .prepare("SELECT id FROM users WHERE role = 'head' AND active = 1 ORDER BY id")
    .all()
    .map((r) => r.id);
}

function activeOfficerIds(dept) {
  return db
    .prepare("SELECT id FROM users WHERE role = 'officer' AND dept = ? AND active = 1 ORDER BY id")
    .all(dept)
    .map((r) => r.id);
}

/** ผู้ออกเอกสาร (A-27) · ใช้ตัวเดียวกับ B07 (src/routes/documents.js) ถ้าโหลดได้ */
let docsIssuerFn;
function issuerIdOf(c) {
  if (docsIssuerFn === undefined) {
    docsIssuerFn = null;
    try {
      const docs = require('../routes/documents');
      if (docs && typeof docs.issuerIdOf === 'function') docsIssuerFn = docs.issuerIdOf;
    } catch (_) {
      docsIssuerFn = null;
    }
  }
  if (docsIssuerFn) {
    try {
      const id = docsIssuerFn(c);
      if (id != null) return id;
    } catch (_) {
      /* ใช้กฎสำรองด้านล่าง */
    }
  }
  // กฎสำรอง (เหมือน documents.issuerIdOf): SV-01 = ผู้อนุมัติที่เป็น officer → ผู้ถือ → issuer_id · SV-02/03 = issuer_id
  if (c.service_id === 'SV-01') {
    if (c.approver_id != null) {
      const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(c.approver_id);
      if (u && u.role === 'officer') return u.id;
    }
    return c.owner_id || c.issuer_id || null;
  }
  return c.issuer_id || c.owner_id || null;
}

/**
 * ผู้รับแจ้งเตือนของคำขอที่ระดับนี้ (BR-15 · A-31) → [user_id, ...] ไม่ซ้ำ
 * @param {object} c  แถว cases (status, service_id, step, dept, owner_id, issuer_id, approver_id)
 * @param {'near'|'overdue'} level
 */
function recipientsFor(c, level) {
  const out = [];
  const add = (id) => {
    if (id == null) return;
    const n = Number(id);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  };
  if (c.status === 'PENDING_APPROVAL') {
    activeHeadIds().forEach(add);
  } else if (c.status === 'APPROVED') {
    const issuer = issuerIdOf(c);
    if (issuer != null) add(issuer);
    else activeOfficerIds('registry').forEach(add); // ไม่ควรเกิด: ไม่รู้ผู้ออกเอกสาร → คิวทะเบียน
  } else if (c.owner_id != null) {
    add(c.owner_id);
  } else {
    activeOfficerIds(deptOf(c)).forEach(add);
  }
  if (level === 'overdue') activeHeadIds().forEach(add);
  return out;
}

// ---------------------------------------------------------------------------
// 1. ยกเลิกอัตโนมัติ NEED_FIX ที่เลย 168 ชม. (BR-20 · A-21 · A-46)
// ---------------------------------------------------------------------------

/** เส้นตายส่งแก้ (ms) ของคำขอ NEED_FIX = ตีกลับครั้งล่าสุด + 168 ชม. */
function fixDeadlineMs(c) {
  let returnedAt = c.returned_at;
  if (!returnedAt) {
    const r = db
      .prepare('SELECT returned_at FROM case_returns WHERE case_id = ? ORDER BY seq DESC, id DESC LIMIT 1')
      .get(c.id);
    returnedAt = r && r.returned_at;
  }
  if (returnedAt) {
    const ms = clock.toMs(returnedAt);
    if (Number.isFinite(ms)) return ms + LIMITS.FIX_WINDOW_MS;
  }
  if (c.fix_deadline) {
    const ms = clock.toMs(c.fix_deadline);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

/** คืนรายการเลขคำขอที่ถูกยกเลิกในรอบนี้ */
function autoCancelExpired(now) {
  const nowMs = toNowMs(now);
  const nowIso = clock.toIso(nowMs);
  const rows = db
    .prepare("SELECT id, case_no, status, returned_at, fix_deadline, step FROM cases WHERE status = 'NEED_FIX'")
    .all();
  const cancelled = [];
  for (const c of rows) {
    const deadlineMs = fixDeadlineMs(c);
    if (!Number.isFinite(deadlineMs) || nowMs < deadlineMs) continue; // 167:59 ยังส่งแก้ได้
    const at = clock.toIso(deadlineMs);
    const info = db
      .prepare(
        `UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = 'FIX_EXPIRED', dept = NULL, updated_at = ?
         WHERE id = ? AND status = 'NEED_FIX'`
      )
      .run(at, nowIso, c.id);
    if (!info.changes) continue;
    db.prepare(
      `INSERT INTO case_events (case_id, at, type, actor_id, from_status, to_status, step, text, detail)
       VALUES (?, ?, 'AUTO_CANCEL', NULL, 'NEED_FIX', 'CANCELLED', ?, ?, ?)`
    ).run(c.id, at, c.step == null ? null : c.step, AUTO_CANCEL_TEXT, `fixDeadline=${at}`);
    cancelled.push(c.case_no);
  }
  return cancelled;
}

// ---------------------------------------------------------------------------
// 2. ประเมินแจ้งเตือน (FR-20 · BR-14 · BR-15 · A-30 · A-31)
// ---------------------------------------------------------------------------

/** คืนจำนวนแจ้งเตือนที่สร้างใหม่ในรอบนี้ */
function evaluateNotifications(now) {
  const nowMs = toNowMs(now);
  const nowIso = clock.toIso(nowMs);
  const holidays = rules.holidayList(db);
  const marks = OPEN_STATUSES.map(() => '?').join(',');
  const cases = db
    .prepare(
      `SELECT id, case_no, service_id, status, step, dept, owner_id, issuer_id, approver_id, due_at
       FROM cases
       WHERE case_no IS NOT NULL AND due_at IS NOT NULL AND status IN (${marks})
       ORDER BY due_at, case_no`
    )
    .all(...OPEN_STATUSES);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notifications (user_id, case_id, case_no, level, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let created = 0;
  for (const c of cases) {
    let level;
    try {
      level = rules.slaLevel(nowMs, c.due_at, holidays, c.status);
    } catch (_) {
      continue; // due_at ผิดรูปแบบ → ข้ามคำขอนี้
    }
    if (!NOTIFY_LEVELS.includes(level)) continue;
    const text = notiText(c.case_no, level);
    for (const userId of recipientsFor(c, level)) {
      created += insert.run(userId, c.id, c.case_no, level, text, nowIso).changes;
    }
  }
  return created;
}

/** ยกเลิกอัตโนมัติ แล้วประเมินแจ้งเตือน (ใน transaction เดียว) */
function evaluate(now) {
  const nowMs = toNowMs(now);
  return db.transaction(() => {
    const cancelled = autoCancelExpired(nowMs);
    const created = evaluateNotifications(nowMs);
    return { cancelled, created };
  })();
}

// ---------------------------------------------------------------------------
// 3. อ่านแจ้งเตือนของผู้ใช้ + หน้า /notifications + GET /api/notifications
// ---------------------------------------------------------------------------

/** ใหม่ก่อน (เวลาเท่ากัน → id มากก่อน) */
function listFor(userId) {
  if (userId == null) return [];
  return db
    .prepare(
      `SELECT id, case_no, level, text, created_at FROM notifications
       WHERE user_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(userId)
    .map((r) => ({ id: r.id, caseNo: r.case_no, level: r.level, text: r.text, createdAt: r.created_at }));
}

function countFor(userId) {
  if (userId == null) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(userId).n;
}

const PAGE_CSS = `<style>
.noti-list{list-style:none;margin:0;padding:0;max-width:760px}
.noti-list li{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;justify-content:space-between;
  padding:10px 14px;margin:0 0 8px;border:1px solid #d5dbe5;border-left-width:6px;border-radius:6px;background:#fff}
.noti-list li.lv-near{border-left-color:#b7791f;background:#fffaf0}
.noti-list li.lv-overdue{border-left-color:#b42318;background:#fef3f2}
.noti-list li a{font-weight:600}
.noti-list li time{color:#475467;font-size:.92em}
</style>`;

function renderItems(items) {
  if (!items.length) return '<p class="muted" data-testid="noti-empty">ไม่มีแจ้งเตือน</p>';
  const lis = items
    .map(
      (n) =>
        `<li class="lv-${esc(n.level)}" data-testid="noti-item" data-id="${esc(n.id)}" data-case-no="${esc(n.caseNo)}" data-level="${esc(n.level)}">`
        + `<a href="/officer/cases/${encodeURIComponent(n.caseNo)}">${esc(n.text)}</a>`
        + ` ${timeTag(n.createdAt)}</li>`
    )
    .join('');
  return `<ul class="noti-list" aria-label="รายการแจ้งเตือน">${lis}</ul>`;
}

const router = express.Router();

router.get('/notifications', rbac.requireRole('officer', 'head'), (req, res) => {
  const layout = require('../views/layout');
  const items = listFor(req.user.id);
  return layout.sendPage(req, res, {
    title: 'แจ้งเตือน',
    head: PAGE_CSS,
    body: `<h1>แจ้งเตือน</h1>
<p>แจ้งเตือนคำขอที่ใกล้ครบกำหนดหรือเกินกำหนด (ทั้งหมด ${items.length} รายการ)</p>
${renderItems(items)}`,
  });
});

router.get('/api/notifications', rbac.requireRole('officer', 'head'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ items: listFor(req.user.id) });
});

/** มีไฟล์ src/routes/notifications.js หรือไม่ (มี → ให้ไฟล์นั้นเสิร์ฟ route แทน) */
let routeFileExists;
function hasRouteFile() {
  if (routeFileExists === undefined) routeFileExists = fs.existsSync(ROUTE_FILE);
  return routeFileExists;
}

function isNotificationPath(p) {
  return p === '/notifications' || p === '/notifications/' || p === '/api/notifications' || p === '/api/notifications/';
}

// ---------------------------------------------------------------------------
// middleware (CONTRACT §0 ข้อ 7: ทุกคำขอ HTTP ยกเว้น /api/test/*)
// ---------------------------------------------------------------------------

let parseUrl = null;
try {
  parseUrl = require('parseurl'); // ตัวเดียวกับที่ router ของ Express ใช้หา pathname
} catch (_) {
  parseUrl = null;
}

/** pathname ของ request แบบเดียวกับที่ Express ใช้จับ route (ใช้ได้ทั้งก่อนและหลัง expressInit) */
function pathOf(req) {
  if (parseUrl) {
    try {
      const u = parseUrl(req);
      if (u && typeof u.pathname === 'string') return u.pathname;
    } catch (_) {
      /* ใช้วิธีสำรองด้านล่าง */
    }
  }
  const url = String((req && req.url) || '');
  const end = url.search(/[?#]/);
  let p = end >= 0 ? url.slice(0, end) : url;
  if (p && p[0] !== '/') {
    try {
      p = new URL(p).pathname; // absolute-form เช่น http://host/api/test/reset
    } catch (_) {
      /* คงค่าเดิม */
    }
  }
  return p;
}

/** /api/test · /api/test/* (ไม่สนตัวพิมพ์ เหมือนการจับ path ของ Express) */
function isTestPath(p) {
  const s = String(p || '').toLowerCase();
  return s === '/api/test' || s.startsWith('/api/test/');
}

// log ข้อผิดพลาดของการประเมินโดยไม่อ่านเวลา (เวลาอ่านจาก clock.js เท่านั้น · นาฬิกาทดสอบแช่แข็ง)
// → log เมื่อข้อความเปลี่ยน และทุก ๆ ERROR_LOG_EVERY ครั้งที่ซ้ำ
const ERROR_LOG_EVERY = 500;
let lastErrorMsg = null;
let repeatErrors = 0;

function logEvalError(err) {
  const msg = String((err && err.message) || err);
  if (msg === lastErrorMsg) {
    repeatErrors += 1;
    if (repeatErrors % ERROR_LOG_EVERY !== 0) return;
    console.error(`[notify] ประเมินไม่สำเร็จ (ซ้ำ ${repeatErrors} ครั้ง): ${msg}`);
    return;
  }
  lastErrorMsg = msg;
  repeatErrors = 0;
  console.error('[notify] ประเมินไม่สำเร็จ:', err && err.stack ? err.stack : err);
}

const EVALUATED = Symbol.for('egov.notify.evaluated');

/** ประเมิน (ยกเลิกอัตโนมัติ + แจ้งเตือน) 1 ครั้งต่อ request · ข้าม /api/test/* · ไม่ throw */
function evaluateFor(req) {
  if (!req || req[EVALUATED]) return false;
  let p;
  try {
    p = pathOf(req);
  } catch (_) {
    p = '';
  }
  if (isTestPath(p)) return false;
  req[EVALUATED] = true;
  try {
    evaluate();
  } catch (err) {
    // ไม่ให้หน้าเว็บพังเพราะการประเมิน (เช่น ตารางยังไม่ถูกสร้าง)
    logEvalError(err);
  }
  return true;
}

/**
 * hook ระดับ Express ที่ติดตั้ง "ตอนโหลดโมดูล" (ก่อนรับ request แรก) ให้การประเมินเกิดกับทุกคำขอจริง
 * รวม GET /api/health และไฟล์ static ที่ server.js วางไว้ก่อน middleware นี้
 *
 * วิธี: ห่อ express.Router.handle (Express 4: router ทุกตัว รวม app._router ที่สร้างไปแล้ว
 *   ใช้ prototype นี้ร่วมกัน · app.handle → this._router.handle(...) อ่าน method ตอนเรียก)
 *   - router หลักของแอป = router ที่มี layer `expressInit` (Express ใส่ให้ตอนสร้าง) → ประเมินก่อน layer แรก
 *   - router ย่อย (ไฟล์ route ต่าง ๆ) ไม่มี expressInit → ส่งต่อทันที (จำผลไว้ใน symbol ของ router)
 *   - ไม่แทรก/ลบ layer ใด ๆ → ลำดับ stack ของ server.js คงเดิม
 *   - ติดตั้งครั้งเดียวต่อโปรเซส (Symbol.for) · ถ้าโครงสร้าง Express ไม่ตรง → คืน false
 *     (middleware ด้านล่างยังประเมินเองตามเดิม) · server.js ย้าย middleware ขึ้นก่อนภายหลังก็ไม่ประเมินซ้ำ
 *     เพราะ evaluateFor() ทำ 1 ครั้งต่อ request
 */
const ROUTER_HOOK = Symbol.for('egov.notify.routerHook');
const MAIN_ROUTER = Symbol.for('egov.notify.isMainRouter');

function isMainRouter(router) {
  if (!router || !Array.isArray(router.stack)) return false;
  const known = router[MAIN_ROUTER];
  if (known !== undefined) return known;
  const main = router.stack.some((l) => l && l.name === 'expressInit');
  if (router.stack.length) router[MAIN_ROUTER] = main; // stack ว่าง = ยังสรุปไม่ได้ ไม่จำ
  return main;
}

function installRouterHook() {
  const proto = express.Router;
  if (!proto || typeof proto.handle !== 'function') return false;
  if (proto.handle[ROUTER_HOOK]) return true;
  const original = proto.handle;
  const handle = function handle(req, res, out) {
    try {
      if (isMainRouter(this)) evaluateFor(req);
    } catch (err) {
      logEvalError(err);
    }
    return original.call(this, req, res, out);
  };
  handle[ROUTER_HOOK] = true;
  handle.original = original;
  proto.handle = handle;
  return true;
}

function middleware(req, res, next) {
  const p = req.path || '';
  if (isTestPath(p)) return next(); // server.js กันไว้แล้ว · กันซ้ำ
  evaluateFor(req); // สำรอง: hook ประเมินไปแล้วใน request นี้ → ข้าม
  if (isNotificationPath(p) && !hasRouteFile()) return router(req, res, next);
  return next();
}

// ติดตั้งทันทีที่โหลดโมดูล (server.js โหลดใน createApp() ก่อน app.listen())
const routerHookInstalled = installRouterHook();

module.exports = {
  middleware,
  notifyMiddleware: middleware,
  router,
  installRouterHook,
  routerHookInstalled,
  evaluateFor,
  evaluate,
  autoCancelExpired,
  evaluateNotifications,
  recipientsFor,
  issuerIdOf,
  fixDeadlineMs,
  listFor,
  countFor,
  notiText,
  renderItems,
  NOTIFY_LEVELS,
  OPEN_STATUSES,
};
