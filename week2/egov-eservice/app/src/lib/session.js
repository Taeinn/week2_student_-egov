'use strict';
/**
 * Session แบบ cookie 'sid' (HttpOnly · SameSite=Lax) เก็บข้อมูลในตาราง sessions
 * reset ฐานข้อมูล (DROP sessions) = ทุกคนหลุดจากระบบ (CONTRACT §0 ข้อ 9)
 *
 * middleware (ติดตั้งใน server.js แล้ว) ให้ทุก request มี:
 *   req.session  object (แก้ได้ · บันทึกอัตโนมัติก่อนส่ง response ถ้ามีการเปลี่ยน)
 *   req.user     = req.session.user || null   ({ id, username, name, role, dept } snapshot ตอนล็อกอิน)
 *
 * ตัวช่วย (ใช้ใน auth.js):
 *   session.login(req, res, { user: {id, username, name, role, dept} })  // สร้าง sid ใหม่ (กัน session fixation)
 *   session.logout(req, res)                                            // ลบ session + ล้าง cookie
 *   session.clearAll()                                                  // ลบทุก session
 *   (มี alias req.login(data) / req.logout() ด้วย)
 *
 * ห้ามเก็บเลขบัตร/เบอร์โทรแบบตรง ๆ ใน session (ตารางนี้อยู่ในไฟล์ DB · NFR-04) → ใช้ crypto.encrypt หรือ blindIndex
 */

const db = require('../db');
const { randomToken } = require('./crypto');

const COOKIE_NAME = 'sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch (_) {
      out[k] = v;
    }
  }
  return out;
}

function cookieString(value, { maxAge, expires } = {}) {
  const attrs = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (/^(1|true)$/i.test(process.env.COOKIE_SECURE || '')) attrs.push('Secure');
  if (maxAge != null) attrs.push(`Max-Age=${maxAge}`);
  if (expires) attrs.push(`Expires=${expires.toUTCString()}`);
  return attrs.join('; ');
}

function appendSetCookie(res, str) {
  if (res.headersSent) return;
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [String(prev)]) : [];
  // แทนที่ cookie sid ตัวก่อนหน้าใน response เดียวกัน
  const filtered = list.filter((c) => !c.startsWith(`${COOKIE_NAME}=`));
  filtered.push(str);
  res.setHeader('Set-Cookie', filtered);
}

function setCookie(res, sid) {
  appendSetCookie(res, cookieString(sid));
}

function clearCookie(res) {
  appendSetCookie(res, cookieString('', { maxAge: 0, expires: new Date(0) }));
}

const realNow = () => new Date().toISOString(); // เวลาเครื่อง (ไม่ใช่กฎธุรกิจ)

function loadSession(sid) {
  if (!sid) return null;
  try {
    const row = db.prepare('SELECT data FROM sessions WHERE sid = ?').get(sid);
    if (!row) return null;
    const data = JSON.parse(row.data || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return null;
  }
}

function insertSession(sid, data) {
  const t = realNow();
  db.prepare('INSERT OR REPLACE INTO sessions(sid, data, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    sid,
    JSON.stringify(data || {}),
    t,
    t
  );
}

function updateSession(sid, data) {
  db.prepare('UPDATE sessions SET data = ?, updated_at = ? WHERE sid = ?').run(JSON.stringify(data || {}), realNow(), sid);
}

function deleteSession(sid) {
  if (!sid) return;
  try {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  } catch (_) {
    /* ตารางอาจถูก reset ไปแล้ว */
  }
}

/** บันทึก req.session ถ้าเปลี่ยน (เรียกอัตโนมัติก่อน res.end) */
function persist(req, res) {
  const st = req._sessionState;
  if (!st || st.done) return;
  st.done = true;
  if (st.destroyed) return;
  const json = JSON.stringify(req.session || {});
  if (req.sessionId) {
    if (json !== st.original) updateSession(req.sessionId, req.session);
  } else if (json !== '{}' && !res.headersSent) {
    const sid = randomToken(32);
    insertSession(sid, req.session);
    req.sessionId = sid;
    setCookie(res, sid);
  }
}

/** สร้าง session ใหม่ (แทนของเดิม) พร้อมข้อมูล data แล้วตั้ง cookie */
function login(req, res, data) {
  if (req.sessionId) deleteSession(req.sessionId);
  const sid = randomToken(32);
  const payload = data && typeof data === 'object' ? { ...data } : {};
  insertSession(sid, payload);
  req.sessionId = sid;
  req.session = payload;
  req.user = payload.user || null;
  req._sessionState = { original: JSON.stringify(payload), done: false, destroyed: false };
  setCookie(res, sid);
  return sid;
}

/** ลบ session ปัจจุบันและล้าง cookie */
function logout(req, res) {
  if (req.sessionId) deleteSession(req.sessionId);
  req.sessionId = null;
  req.session = {};
  req.user = null;
  if (req._sessionState) req._sessionState.destroyed = true;
  clearCookie(res);
}

/** ลบทุก session (ใช้ตอน reset) */
function clearAll() {
  try {
    db.prepare('DELETE FROM sessions').run();
  } catch (_) {
    /* ไม่มีตาราง */
  }
}

function middleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (!req.cookies) req.cookies = cookies;
  const sid = cookies[COOKIE_NAME] || null;
  const data = loadSession(sid);
  req.sessionId = data ? sid : null;
  req.session = data || {};
  req.user = req.session.user || null;
  req._sessionState = { original: JSON.stringify(req.session), done: false, destroyed: false };
  req.login = (payload) => login(req, res, payload);
  req.logout = () => logout(req, res);

  const origEnd = res.end;
  res.end = function patchedEnd(...args) {
    try {
      persist(req, res);
    } catch (e) {
      console.error('[session] persist error:', e.message);
    }
    return origEnd.apply(this, args);
  };
  next();
}

module.exports = {
  COOKIE_NAME,
  middleware,
  login,
  logout,
  clearAll,
  clearCookie,
  parseCookies,
};
