'use strict';
/**
 * RBAC กลาง (B04) · CONTRACT §1 · DECISIONS §1 · REQUIREMENTS FR-03 BR-21 · A-39
 *
 * ใช้ในไฟล์ route:
 *   const { requireLogin, requireRole } = require('../lib/rbac');
 *   router.get('/officer/queue', requireRole('officer', 'head'), handler);
 *   router.get('/api/audit', requireRole('auditor'), handler);
 *   router.get('/api/me', requireLogin, handler);
 *
 * ผลเมื่อไม่ผ่าน (ตรวจเองว่าเป็น API หรือหน้า จาก path ขึ้นต้น /api/):
 *   ยังไม่ล็อกอิน        → API 401 UNAUTHENTICATED  · หน้า redirect 302 /login
 *   ประชาชนยังไม่ลงทะเบียน → API 401 UNAUTHENTICATED  · หน้า redirect 302 /register  (cookie ใช้ได้เฉพาะ /register)
 *   บทบาทไม่ตรง          → API 403 FORBIDDEN        · หน้า 403 forbidden-msg 'ไม่มีสิทธิ์เข้าถึงหน้านี้'
 *
 * ทุกครั้งที่ผ่าน requireLogin/requireRole จะโหลดบทบาท/แผนก/ชื่อปัจจุบันจากตาราง users ใหม่
 * (admin เปลี่ยนบทบาทแล้วมีผลทันที · ผู้ใช้ที่ถูกปิด active=0 หลุดจากระบบ)
 *
 * เจ้าของคำขอ (citizen):
 *   isCaseOwner(user, caseRow)          → true ถ้า caseRow.applicant_id === user.id
 *   canCitizenViewCase(user, caseRow)   → เจ้าของเท่านั้น · BUG_MODE=B06 → true เสมอ (IDOR ตาม BUGS.md)
 *   ไม่ใช่เจ้าของ → ตอบ 404 NOT_FOUND/not-found-msg เหมือนเลขที่ไม่มีจริง (ห้ามเผยว่ามีอยู่)
 */

const db = require('../db');
const session = require('./session');
const { isBug } = require('./bugs');
const { sendError } = require('./errors');
const { LANDING, ROLES } = require('./constants');

/** เป็นคำขอ API หรือไม่ (รองรับ router ที่ mount ด้วย basePath) */
function isApiRequest(req) {
  const p = `${req.baseUrl || ''}${req.path || ''}`;
  return p === '/api' || p.startsWith('/api/');
}

/** หน้าตั้งต้นของผู้ใช้ (CONTRACT §1) */
function landingFor(user) {
  if (!user) return '/login';
  if (user.role === 'citizen' && user.registered === false) return '/register';
  return LANDING[user.role] || '/login';
}

/** ประชาชนที่ยังไม่ลงทะเบียน (session ใช้ได้เฉพาะ /register) */
function isUnregistered(user) {
  return !!user && user.role === 'citizen' && user.registered === false;
}

/**
 * โหลดข้อมูลผู้ใช้ปัจจุบันจาก DB ใหม่ (ครั้งเดียวต่อ request) แล้วอัปเดต req.user / req.session.user
 * คืน req.user หรือ null (ถ้าผู้ใช้ถูกลบ/ปิดใช้งาน → ออกจากระบบ)
 */
function refreshUser(req, res) {
  if (req._rbacRefreshed) return req.user || null;
  req._rbacRefreshed = true;
  const u = req.user;
  if (!u) return null;
  if (u.id == null) return u; // ประชาชนใหม่ที่ยังไม่มีแถวใน users (รอลงทะเบียน)
  let row;
  try {
    row = db.prepare('SELECT id, username, name, role, dept, registered, active FROM users WHERE id = ?').get(u.id);
  } catch (_) {
    row = undefined;
  }
  if (!row || !row.active) {
    if (res) session.logout(req, res);
    else req.user = null;
    return null;
  }
  const fresh = {
    ...u,
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    dept: row.role === 'officer' ? row.dept || null : null,
  };
  if (row.role === 'citizen') fresh.registered = !!row.registered;
  else delete fresh.registered;
  if (JSON.stringify(fresh) !== JSON.stringify(u)) {
    req.user = fresh;
    if (req.session && typeof req.session === 'object') req.session.user = fresh;
  }
  return req.user;
}

/** ตอบ "ยังไม่ล็อกอิน" */
function denyUnauthenticated(req, res) {
  if (isApiRequest(req)) return sendError(res, 'UNAUTHENTICATED');
  return res.redirect(302, '/login');
}

/** ตอบ "ไม่มีสิทธิ์" (API 403 FORBIDDEN · หน้า 403 forbidden-msg) */
function forbid(req, res) {
  if (isApiRequest(req)) return sendError(res, 'FORBIDDEN');
  // require ตอนใช้ เพื่อเลี่ยง require วนกับ layout
  // eslint-disable-next-line global-require
  return require('../views/layout').sendForbidden(req, res);
}

/** ตอบ 404 ของคำขอ (ไม่ว่าเลขไม่มีจริงหรือเป็นของคนอื่น) */
function notFound(req, res) {
  if (isApiRequest(req)) return sendError(res, 'NOT_FOUND');
  // eslint-disable-next-line global-require
  return require('../views/layout').sendNotFound(req, res);
}

/** ประชาชนยังไม่ลงทะเบียนเข้าหน้าที่ต้องล็อกอิน */
function denyUnregistered(req, res) {
  if (isApiRequest(req)) return sendError(res, 'UNAUTHENTICATED');
  return res.redirect(302, '/register');
}

/** middleware: ต้องล็อกอิน (ประชาชนต้องลงทะเบียนแล้ว) */
function requireLogin(req, res, next) {
  const user = refreshUser(req, res);
  if (!user) return denyUnauthenticated(req, res);
  if (isUnregistered(user)) return denyUnregistered(req, res);
  return next();
}

/** middleware: ต้องล็อกอิน (ยอมให้ประชาชนที่ยังไม่ลงทะเบียน เช่น /register, /api/me, /api/auth/register) */
function requireSession(req, res, next) {
  const user = refreshUser(req, res);
  if (!user) return denyUnauthenticated(req, res);
  return next();
}

function flatRoles(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...flatRoles(a));
    else if (a != null && a !== '') out.push(String(a));
  }
  for (const r of out) {
    if (!ROLES.includes(r)) throw new Error(`rbac: ไม่รู้จักบทบาท '${r}'`);
  }
  return out;
}

/** ผู้ใช้มีบทบาทใดบทบาทหนึ่งหรือไม่ */
function hasRole(user, ...roles) {
  const list = flatRoles(roles);
  return !!user && list.includes(user.role);
}

/**
 * middleware: ต้องล็อกอิน + บทบาทตรง
 *   requireRole('officer', 'head')  หรือ  requireRole(['officer', 'head'])
 */
function requireRole(...roles) {
  const list = flatRoles(roles);
  if (!list.length) throw new Error('rbac: requireRole ต้องระบุบทบาทอย่างน้อย 1 บทบาท');
  const mw = function requireRoleMiddleware(req, res, next) {
    const user = refreshUser(req, res);
    if (!user) return denyUnauthenticated(req, res);
    if (isUnregistered(user)) return denyUnregistered(req, res);
    if (!list.includes(user.role)) return forbid(req, res);
    return next();
  };
  mw.roles = list;
  return mw;
}

/**
 * ตรวจสิทธิ์แบบ inline ใน handler (คืน true ถ้าผ่าน · ไม่ผ่านจะตอบ response ให้แล้ว)
 *   if (!rbac.ensureRole(req, res, 'head')) return;
 */
function ensureRole(req, res, ...roles) {
  const list = flatRoles(roles);
  const user = refreshUser(req, res);
  if (!user) {
    denyUnauthenticated(req, res);
    return false;
  }
  if (isUnregistered(user)) {
    denyUnregistered(req, res);
    return false;
  }
  if (list.length && !list.includes(user.role)) {
    forbid(req, res);
    return false;
  }
  return true;
}

/** เจ้าของคำขอ (รองรับแถวจาก DB `applicant_id` หรือ object ที่มี `applicantId`) */
function isCaseOwner(user, caseRow) {
  if (!user || !caseRow || user.role !== 'citizen' || user.id == null) return false;
  const owner = caseRow.applicant_id != null ? caseRow.applicant_id : caseRow.applicantId;
  return owner != null && Number(owner) === Number(user.id);
}

/** ประชาชนดูคำขอนี้ได้หรือไม่ · BUG_MODE=B06 ข้ามการตรวจเจ้าของ (IDOR) */
function canCitizenViewCase(user, caseRow) {
  if (!user || !caseRow || user.role !== 'citizen') return false;
  if (isBug('B06')) return true;
  return isCaseOwner(user, caseRow);
}

module.exports = {
  isApiRequest,
  landingFor,
  isUnregistered,
  refreshUser,
  requireLogin,
  requireSession,
  requireRole,
  ensureRole,
  hasRole,
  forbid,
  notFound,
  denyUnauthenticated,
  isCaseOwner,
  canCitizenViewCase,
  // ชุดที่ใช้บ่อย (A-39)
  requireCitizen: requireRole('citizen'),
  requireOfficerOrHead: requireRole('officer', 'head'),
  requireHead: requireRole('head'),
  requireExecutive: requireRole('executive'),
  requireAuditor: requireRole('auditor'),
  requireAdmin: requireRole('admin'),
};
