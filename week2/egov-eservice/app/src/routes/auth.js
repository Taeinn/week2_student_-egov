'use strict';
/**
 * B04 · ยืนยันตัวตน + ลงทะเบียน + RBAC
 * REQUIREMENTS FR-01..03 · BR-01..03 · BR-21 · CONTRACT §1 §2.2 §2.3 §5 §6.1 · DECISIONS §1 §2
 *
 * หน้า:
 *   GET  /login                    ประชาชน (ThaiD จำลอง + OTP) / เจ้าหน้าที่ (SSO จำลอง) · ?tab=staff เปิดแท็บเจ้าหน้าที่
 *   GET  /register                 ลงทะเบียนครั้งแรก (เฉพาะประชาชนที่ยังไม่ลงทะเบียน · อื่น ๆ redirect)
 *   POST /register                 (สำรองกรณีไม่มี JavaScript · ฟอร์มปกติ)
 *   GET  /logout                   ออกจากระบบแล้วไป /login
 *
 * API (CONTRACT §6.1):
 *   POST /api/auth/thaid/start     {"idNo"}           → 200 {"status":"OTP_SENT"} · 400 INVALID_ID · 423 LOCKED {lockedUntil}
 *   POST /api/auth/thaid/verify    {"idNo","otp"}     → 200 {"registered":true|false,"landing"} + cookie
 *                                                       · 400 INVALID_ID · 401 OTP_INVALID {attemptsLeft} · 423 LOCKED {lockedUntil}
 *   POST /api/auth/register        {"mobile","email","consent"} → 201 · 400 INVALID_MOBILE · 400 CONSENT_REQUIRED
 *                                                       · 401 (ไม่มี session) · 403 (ไม่ใช่ประชาชน) · 409 ALREADY_REGISTERED
 *   POST /api/auth/staff/login     {"username","password"} → 200 {"role","dept","landing"} · 401 INVALID_CREDENTIALS
 *   POST /api/auth/logout          → 204
 *   GET  /api/me                   → 200 {"username","name","role","dept","registered"?} · 401
 *
 * กฎ OTP (BR-02): OTP ทดสอบ 123456 · ผิดติดกัน 3 ครั้ง → ล็อกเลขบัตรนั้น 15 นาทีนับจากครั้งที่ 3 (เวลาจาก clock.js)
 *   ระหว่างล็อกตอบ 423 แม้ OTP ถูก · ครบ 15:00 ปลดล็อกและตัวนับเริ่ม 0 · OTP ถูกรีเซ็ตตัวนับเป็น 0
 *   ตัวนับเก็บในตาราง otp_attempts ด้วย blind index (ไม่เก็บเลขบัตรตรง ๆ · NFR-04) · reset ล้างทั้งตาราง
 * Audit: STAFF_LOGIN เฉพาะล็อกอินสำเร็จ (A-36)
 * ไม่มีบั๊ก BUG_MODE ในบล็อกนี้
 */

const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const session = require('../lib/session');
const crypto = require('../lib/crypto');
const { sendError } = require('../lib/errors');
const { esc, maskId } = require('../lib/format');
const { sendPage } = require('../views/layout');
const rbac = require('../lib/rbac');

const router = express.Router();

const TEST_OTP = '123456';
const MAX_OTP_FAILS = 3;
const LOCK_MINUTES = 15;
const NEW_THAID_NAME = 'ผู้ใช้ ThaiD (จำลอง)'; // เลขบัตรถูกต้องแต่ไม่มีใน seed (ชื่อจริงต้องมาจาก ThaiD · Q-03)

// ---------------------------------------------------------------------------
// กฎ
// ---------------------------------------------------------------------------

/** BR-01: ตัวเลข 13 หลักพอดี + หลักที่ 13 = (11 − (Σ dᵢ×(14−i), i=1..12) mod 11) mod 10 */
function isValidThaiId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const s = String(value).trim();
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

/** BR-03: เบอร์มือถือ 10 หลักขึ้นต้น 0 */
function isValidMobile(value) {
  return typeof value === 'string' || typeof value === 'number' ? /^0\d{9}$/.test(String(value).trim()) : false;
}

function isConsentGiven(value) {
  return value === true || value === 1 || ['true', 'on', '1', 'yes'].includes(String(value == null ? '' : value).toLowerCase());
}

const normId = (v) => String(v == null ? '' : v).trim();

// ---------------------------------------------------------------------------
// ตัวนับ OTP / การล็อก (otp_attempts)
// ---------------------------------------------------------------------------

/** สถานะล็อกปัจจุบันของ hash · ล็อกหมดอายุแล้ว → ล้างตัวนับเป็น 0 */
function lockState(hash) {
  const row = db.prepare('SELECT fail_count, locked_until FROM otp_attempts WHERE id_no_hash = ?').get(hash);
  if (!row) return { failCount: 0, lockedUntil: null };
  if (row.locked_until) {
    if (clock.toMs(row.locked_until) > clock.nowMs()) return { failCount: row.fail_count, lockedUntil: row.locked_until };
    db.prepare('DELETE FROM otp_attempts WHERE id_no_hash = ?').run(hash); // ปลดล็อก → นับใหม่จาก 0
    return { failCount: 0, lockedUntil: null };
  }
  return { failCount: row.fail_count || 0, lockedUntil: null };
}

/** บันทึก OTP ผิด 1 ครั้ง → { attemptsLeft } หรือ { lockedUntil } */
const recordFailure = (hash) =>
  db.transaction(() => {
    const st = lockState(hash);
    if (st.lockedUntil) return { lockedUntil: st.lockedUntil };
    const fails = st.failCount + 1;
    const nowIso = clock.nowIso();
    const lockedUntil = fails >= MAX_OTP_FAILS ? clock.toIso(clock.nowMs() + LOCK_MINUTES * clock.MINUTE_MS) : null;
    db.prepare(
      `INSERT INTO otp_attempts(id_no_hash, fail_count, last_fail_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(id_no_hash) DO UPDATE SET fail_count = excluded.fail_count, last_fail_at = excluded.last_fail_at,
       locked_until = excluded.locked_until`
    ).run(hash, fails, nowIso, lockedUntil);
    return lockedUntil ? { lockedUntil } : { attemptsLeft: MAX_OTP_FAILS - fails };
  })();

function clearFailures(hash) {
  db.prepare('DELETE FROM otp_attempts WHERE id_no_hash = ?').run(hash);
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

function sessionUserFromRow(row) {
  const u = {
    id: row.id,
    username: row.username || null,
    name: row.name,
    role: row.role,
    dept: row.role === 'officer' ? row.dept || null : null,
  };
  if (row.role === 'citizen') u.registered = !!row.registered;
  return u;
}

function loginCitizen(req, res, idNo) {
  const hash = crypto.blindIndex(idNo);
  const row = db
    .prepare("SELECT id, username, name, role, dept, registered, active FROM users WHERE id_no_hash = ? AND role = 'citizen'")
    .get(hash);
  if (row) {
    if (!row.active) return null;
    const user = sessionUserFromRow(row);
    session.login(req, res, { user });
    return user;
  }
  // เลขบัตรถูกต้องแต่ยังไม่มีในระบบ → ผู้ใช้ใหม่ ต้องลงทะเบียนก่อน (เก็บเลขบัตรแบบเข้ารหัสใน session เท่านั้น)
  const user = { id: null, username: null, name: NEW_THAID_NAME, role: 'citizen', dept: null, registered: false };
  session.login(req, res, { user, pendingCitizen: { idEnc: crypto.encrypt(idNo), idHash: hash } });
  return user;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

router.post('/api/auth/thaid/start', (req, res) => {
  const idNo = normId(req.body && req.body.idNo);
  if (!isValidThaiId(idNo)) return sendError(res, 'INVALID_ID');
  const st = lockState(crypto.blindIndex(idNo));
  if (st.lockedUntil) return sendError(res, 'LOCKED', { lockedUntil: st.lockedUntil });
  return res.status(200).json({ status: 'OTP_SENT' });
});

router.post('/api/auth/thaid/verify', (req, res) => {
  const body = req.body || {};
  const idNo = normId(body.idNo);
  if (!isValidThaiId(idNo)) return sendError(res, 'INVALID_ID');
  const hash = crypto.blindIndex(idNo);
  const st = lockState(hash);
  if (st.lockedUntil) return sendError(res, 'LOCKED', { lockedUntil: st.lockedUntil });

  const otp = String(body.otp == null ? '' : body.otp).trim();
  if (otp !== TEST_OTP) {
    const r = recordFailure(hash);
    if (r.lockedUntil) return sendError(res, 'LOCKED', { lockedUntil: r.lockedUntil });
    return sendError(res, 'OTP_INVALID', { attemptsLeft: r.attemptsLeft });
  }

  clearFailures(hash);
  const user = loginCitizen(req, res, idNo);
  if (!user) return sendError(res, 'FORBIDDEN');
  return res.status(200).json({ registered: user.registered !== false, landing: rbac.landingFor(user) });
});

/**
 * ลงทะเบียน · คืน { ok:true, user } หรือ { ok:false, status, code, message }
 * (ใช้ร่วมกันระหว่าง API และฟอร์มสำรอง)
 */
function doRegister(req, res, input) {
  const user = rbac.refreshUser(req, res);
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' };
  if (user.role !== 'citizen') return { ok: false, code: 'FORBIDDEN' };
  if (user.registered !== false) {
    return { ok: false, status: 409, code: 'ALREADY_REGISTERED', message: 'ลงทะเบียนแล้ว' };
  }
  const mobile = String(input.mobile == null ? '' : input.mobile).trim();
  if (!isValidMobile(mobile)) return { ok: false, code: 'INVALID_MOBILE' };
  if (!isConsentGiven(input.consent)) return { ok: false, code: 'CONSENT_REQUIRED' };
  const email = String(input.email == null ? '' : input.email).trim().slice(0, 254);

  const now = clock.nowIso();
  const mobileEnc = crypto.encrypt(mobile);
  let userId = user.id;
  db.transaction(() => {
    if (userId == null) {
      const pending = (req.session && req.session.pendingCitizen) || {};
      const idNo = crypto.decrypt(pending.idEnc);
      if (!idNo || !pending.idHash) throw Object.assign(new Error('no pending citizen'), { authCode: 'UNAUTHENTICATED' });
      const existing = db.prepare('SELECT id FROM users WHERE id_no_hash = ?').get(pending.idHash);
      if (existing) {
        userId = existing.id;
      } else {
        userId = Number(
          db
            .prepare(
              `INSERT INTO users(username, password_hash, name, role, dept, id_no_enc, id_no_hash, id_masked, registered, active, created_at, updated_at)
               VALUES (NULL, NULL, ?, 'citizen', NULL, ?, ?, ?, 0, 1, ?, ?)`
            )
            .run(user.name, crypto.encrypt(idNo), pending.idHash, maskId(idNo), now, now).lastInsertRowid
        );
      }
    }
    db.prepare(
      `UPDATE users SET mobile_enc = ?, email = ?, registered = 1, consent_at = ?, updated_at = ?
       WHERE id = ? AND role = 'citizen'`
    ).run(mobileEnc, email, now, now, userId);
  })();

  const row = db.prepare('SELECT id, username, name, role, dept, registered, active FROM users WHERE id = ?').get(userId);
  const fresh = sessionUserFromRow(row);
  session.login(req, res, { user: fresh }); // sid ใหม่ ไม่มี pendingCitizen ค้าง
  return { ok: true, user: fresh };
}

function registerSafely(req, res, input) {
  try {
    return doRegister(req, res, input);
  } catch (err) {
    if (err && err.authCode) return { ok: false, code: err.authCode };
    throw err;
  }
}

function sendRegisterError(res, r) {
  if (r.status) return res.status(r.status).json({ code: r.code, message: r.message });
  return sendError(res, r.code);
}

router.post('/api/auth/register', (req, res) => {
  const r = registerSafely(req, res, req.body || {});
  if (!r.ok) return sendRegisterError(res, r);
  return res.status(201).json({ registered: true, landing: rbac.landingFor(r.user), name: r.user.name });
});

router.post('/api/auth/staff/login', (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const row = username
    ? db
        .prepare(
          "SELECT id, username, password_hash, name, role, dept, active FROM users WHERE username = ? AND role <> 'citizen'"
        )
        .get(username)
    : null;
  if (!row || !row.active || !password || !crypto.verifyPassword(password, row.password_hash)) {
    return sendError(res, 'INVALID_CREDENTIALS');
  }
  const user = sessionUserFromRow(row);
  session.login(req, res, { user });
  db.appendAudit({ user, event: 'STAFF_LOGIN', detail: '' });
  return res.status(200).json({ role: user.role, dept: user.dept, landing: rbac.landingFor(user), username: user.username, name: user.name });
});

router.post('/api/auth/logout', (req, res) => {
  session.logout(req, res);
  return res.status(204).end();
});

router.get('/api/me', rbac.requireSession, (req, res) => {
  const u = req.user;
  const out = { username: u.username || null, name: u.name, role: u.role, dept: u.dept || null };
  if (u.role === 'citizen') out.registered = u.registered !== false;
  return res.status(200).json(out);
});

// method อื่นบนเส้นของบล็อกนี้ → 405
const methodNotAllowed = (req, res) => sendError(res, 'METHOD_NOT_ALLOWED');
for (const p of [
  '/api/auth/thaid/start',
  '/api/auth/thaid/verify',
  '/api/auth/register',
  '/api/auth/staff/login',
  '/api/auth/logout',
]) {
  router.all(p, methodNotAllowed);
}
router.all('/api/me', methodNotAllowed);

// ---------------------------------------------------------------------------
// หน้า /login
// ---------------------------------------------------------------------------

const LOGIN_CSS = `<style>
.auth-wrap{max-width:560px;margin:0 auto}
.tabs{display:inline-flex;flex-wrap:wrap;gap:2px;padding:4px;border:1px solid var(--border);border-radius:9999px;background:var(--color-linen,#fafafa);margin:0 0 20px}
.tab{font:inherit;font-size:.92rem;font-weight:500;padding:6px 18px;border:none;border-radius:9999px;background:transparent;color:var(--muted);cursor:pointer}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"]{background:#fff;color:var(--text);box-shadow:var(--shadow-subtle-2),inset 0 -2px 0 var(--color-lavender,#918df6)}
.auth-wrap input[type=text],.auth-wrap input[type=password],.auth-wrap input[type=tel],.auth-wrap input[type=email]{width:100%}
.otp-box{margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.auth-wrap p.field-error{margin:0}
.auth-wrap .form-row .muted{margin:0;font-size:.88rem}
.check-row{display:flex;gap:8px;align-items:flex-start}
.check-row input{margin-top:.3em;flex:none}
</style>`;

const LOGIN_JS = `<script>
(function(){
  var TH_M = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function fmt(iso){
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(iso || '');
    if (!m) return iso || '';
    return Number(m[3]) + ' ' + TH_M[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543) + ' ' + m[4] + ':' + m[5];
  }
  function $(id){ return document.getElementById(id); }
  function show(el, text){ if (text !== undefined) el.textContent = text; el.hidden = false; }
  function hide(el){ el.hidden = true; }
  function msgOf(r, fallback){ return (r && r.data && r.data.message) || fallback; }

  // แท็บ
  var tabs = [$('tab-citizen'), $('tab-staff')];
  function select(tab){
    tabs.forEach(function(t){
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function(t, i){
    t.addEventListener('click', function(){ select(t); });
    t.addEventListener('keydown', function(e){
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        n.focus(); select(n);
      }
    });
  });

  var idInput = $('thaid-id'), thaidErr = $('thaid-error'), lockBox = $('lock-box'), lockUntil = $('lock-until');
  var otpForm = $('otp-form'), otpInput = $('otp-input'), otpErr = $('otp-error'), otpLeft = $('otp-attempts-left');
  var currentId = '';

  function showLock(iso){
    hide(otpForm); hide(otpErr); hide(otpLeft); hide(thaidErr);
    lockUntil.setAttribute('data-iso', iso || '');
    lockUntil.setAttribute('datetime', iso || '');
    lockUntil.textContent = fmt(iso);
    show(lockBox);
  }
  function busy(form, on){ var b = form.querySelector('button[type=submit]'); if (b) b.disabled = !!on; }

  $('thaid-form').addEventListener('submit', function(e){
    e.preventDefault();
    var idNo = idInput.value.trim();
    var form = e.currentTarget;
    busy(form, true);
    App.api('POST', '/api/auth/thaid/start', { idNo: idNo }).then(function(r){
      busy(form, false);
      hide(otpErr); hide(otpLeft);
      if (r.ok) {
        currentId = idNo;
        hide(thaidErr); hide(lockBox);
        otpInput.value = '';
        show(otpForm);
        otpInput.focus();
        return;
      }
      hide(otpForm);
      if (r.status === 423) { showLock(r.data && r.data.lockedUntil); return; }
      hide(lockBox);
      idInput.setAttribute('aria-invalid', 'true');
      show(thaidErr, msgOf(r, 'เลขบัตรประชาชนไม่ถูกต้อง'));
    }).catch(function(){ busy(form, false); show(thaidErr, 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่'); });
  });
  idInput.addEventListener('input', function(){ idInput.removeAttribute('aria-invalid'); });

  otpForm.addEventListener('submit', function(e){
    e.preventDefault();
    var form = e.currentTarget;
    busy(form, true);
    App.api('POST', '/api/auth/thaid/verify', { idNo: currentId, otp: otpInput.value.trim() }).then(function(r){
      busy(form, false);
      if (r.ok) { window.location.href = (r.data && r.data.landing) || (r.data && r.data.registered === false ? '/register' : '/citizen'); return; }
      if (r.status === 423) { showLock(r.data && r.data.lockedUntil); return; }
      if (r.status === 401) {
        show(otpErr, msgOf(r, 'รหัส OTP ไม่ถูกต้อง'));
        var left = r.data && r.data.attemptsLeft;
        if (left !== undefined && left !== null) show(otpLeft, 'เหลือ ' + left + ' ครั้ง'); else hide(otpLeft);
        otpInput.value = '';
        otpInput.focus();
        return;
      }
      hide(otpLeft);
      show(otpErr, msgOf(r, 'เกิดข้อผิดพลาด'));
    }).catch(function(){ busy(form, false); show(otpErr, 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่'); });
  });

  $('staff-form').addEventListener('submit', function(e){
    e.preventDefault();
    var form = e.currentTarget, err = $('staff-error');
    busy(form, true);
    App.api('POST', '/api/auth/staff/login', { username: $('staff-username').value.trim(), password: $('staff-password').value }).then(function(r){
      busy(form, false);
      if (r.ok) { window.location.href = (r.data && r.data.landing) || '/'; return; }
      $('staff-password').value = '';
      show(err, msgOf(r, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'));
    }).catch(function(){ busy(form, false); show(err, 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่'); });
  });
})();
</script>`;

function loginBody(staffTab) {
  const cSel = staffTab ? 'false' : 'true';
  const sSel = staffTab ? 'true' : 'false';
  return `<div class="auth-wrap">
<h1>เข้าสู่ระบบ e-Service กลาง</h1>
<div class="card">
<div class="tabs" role="tablist" aria-label="เลือกประเภทผู้ใช้">
<button type="button" class="tab" role="tab" id="tab-citizen" data-testid="login-tab-citizen" aria-selected="${cSel}" aria-controls="panel-citizen">ประชาชน</button>
<button type="button" class="tab" role="tab" id="tab-staff" data-testid="login-tab-staff" aria-selected="${sSel}" aria-controls="panel-staff">เจ้าหน้าที่</button>
</div>

<section id="panel-citizen" role="tabpanel" aria-labelledby="tab-citizen"${staffTab ? ' hidden' : ''}>
<form id="thaid-form" novalidate>
<div class="form-row">
<label for="thaid-id">เลขบัตรประจำตัวประชาชน 13 หลัก</label>
<input type="text" id="thaid-id" name="idNo" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off" aria-describedby="thaid-id-hint thaid-error">
<span id="thaid-id-hint" class="muted">กรอกตัวเลข 13 หลัก ไม่ต้องมีขีด</span>
<p id="thaid-error" class="field-error" data-testid="thaid-error" role="alert" hidden></p>
</div>
<button type="submit" class="btn btn-primary" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
</form>

<div id="lock-box" class="alert alert-error" hidden>
<p data-testid="lock-message" role="alert">ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที</p>
<p>ลองใหม่ได้ตั้งแต่ <time id="lock-until" data-testid="lock-until" data-iso="" datetime=""></time></p>
</div>

<form id="otp-form" class="otp-box" data-testid="otp-step" novalidate hidden>
<p class="muted">ส่งรหัส OTP ไปยังแอป ThaiD (จำลอง) แล้ว · โหมดทดสอบใช้รหัส 123456</p>
<div class="form-row">
<label for="otp-input">รหัส OTP 6 หลัก</label>
<input type="text" id="otp-input" name="otp" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-describedby="otp-error otp-attempts-left">
<p id="otp-error" class="field-error" data-testid="otp-error" role="alert" hidden></p>
<p id="otp-attempts-left" class="field-error" data-testid="otp-attempts-left" hidden></p>
</div>
<button type="submit" class="btn btn-primary" data-testid="otp-submit">ยืนยัน OTP</button>
</form>
</section>

<section id="panel-staff" role="tabpanel" aria-labelledby="tab-staff"${staffTab ? '' : ' hidden'}>
<form id="staff-form" novalidate>
<div class="form-row">
<label for="staff-username">ชื่อผู้ใช้</label>
<input type="text" id="staff-username" name="username" data-testid="staff-username" autocomplete="username" autocapitalize="off" spellcheck="false">
</div>
<div class="form-row">
<label for="staff-password">รหัสผ่าน</label>
<input type="password" id="staff-password" name="password" data-testid="staff-password" autocomplete="current-password" aria-describedby="staff-error">
</div>
<p id="staff-error" class="field-error" data-testid="staff-error" role="alert" hidden></p>
<button type="submit" class="btn btn-primary" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
</form>
</section>
</div>
<p class="muted">ThaiD และ SSO ภาครัฐในระบบนี้เป็นตัวจำลองเพื่อการทดสอบ ไม่เชื่อมต่อระบบจริง</p>
</div>`;
}

router.get('/login', (req, res) => {
  const staffTab = String(req.query.tab || '') === 'staff';
  return sendPage(req, res, {
    title: 'เข้าสู่ระบบ',
    body: loginBody(staffTab),
    head: LOGIN_CSS,
    scripts: LOGIN_JS,
    hideUser: true,
  });
});

router.get('/logout', (req, res) => {
  session.logout(req, res);
  return res.redirect(302, '/login');
});

// ---------------------------------------------------------------------------
// หน้า /register
// ---------------------------------------------------------------------------

const REGISTER_JS = `<script>
(function(){
  var form = document.getElementById('reg-form');
  var mErr = document.getElementById('reg-error-mobile'), cErr = document.getElementById('reg-error-consent');
  var mobile = document.getElementById('reg-mobile'), consent = document.getElementById('reg-consent');
  form.addEventListener('submit', function(e){
    e.preventDefault();
    mErr.hidden = true; cErr.hidden = true;
    mobile.removeAttribute('aria-invalid'); consent.removeAttribute('aria-invalid');
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    App.api('POST', '/api/auth/register', {
      mobile: mobile.value.trim(),
      email: document.getElementById('reg-email').value.trim(),
      consent: consent.checked
    }).then(function(r){
      btn.disabled = false;
      if (r.ok) { window.location.href = (r.data && r.data.landing) || '/citizen'; return; }
      var code = r.data && r.data.code, msg = (r.data && r.data.message) || 'เกิดข้อผิดพลาด';
      if (code === 'INVALID_MOBILE') { mErr.textContent = msg; mErr.hidden = false; mobile.setAttribute('aria-invalid', 'true'); mobile.focus(); return; }
      if (code === 'CONSENT_REQUIRED') { cErr.textContent = msg; cErr.hidden = false; consent.setAttribute('aria-invalid', 'true'); consent.focus(); return; }
      if (code === 'ALREADY_REGISTERED') { window.location.href = '/citizen'; return; }
      if (r.status === 401) { window.location.href = '/login'; return; }
      App.showError(msg);
    }).catch(function(){ btn.disabled = false; App.showError('เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่'); });
  });
})();
</script>`;

function registerBody(user, values = {}, errors = {}) {
  const v = (k) => esc(values[k] == null ? '' : values[k]);
  const err = (id, testid, msg) =>
    `<p id="${id}" class="field-error" data-testid="${testid}" role="alert"${msg ? '' : ' hidden'}>${esc(msg || '')}</p>`;
  return `<div class="auth-wrap">
<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<div class="card">
<p>ข้อมูลชื่อ-สกุลดึงจาก ThaiD (จำลอง) แก้ไขไม่ได้ กรุณากรอกเบอร์มือถือและยืนยันการยินยอม</p>
<form id="reg-form" method="post" action="/register" novalidate>
<div class="form-row">
<label for="reg-name">ชื่อ-สกุล (จาก ThaiD)</label>
<input type="text" id="reg-name" name="name" data-testid="reg-name" value="${esc(user.name || '')}" readonly aria-readonly="true">
</div>
<div class="form-row">
<label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
<input type="tel" id="reg-mobile" name="mobile" data-testid="reg-mobile" inputmode="numeric" autocomplete="tel-national" required aria-required="true" aria-describedby="reg-mobile-hint reg-error-mobile" value="${v('mobile')}"${errors.mobile ? ' aria-invalid="true"' : ''}>
<span id="reg-mobile-hint" class="muted">ตัวเลข 10 หลัก ขึ้นต้นด้วย 0</span>
${err('reg-error-mobile', 'reg-error-mobile', errors.mobile)}
</div>
<div class="form-row">
<label for="reg-email">อีเมล (ไม่บังคับ)</label>
<input type="email" id="reg-email" name="email" data-testid="reg-email" autocomplete="email" value="${v('email')}">
</div>
<div class="form-row">
<div class="check-row">
<input type="checkbox" id="reg-consent" name="consent" value="true" data-testid="reg-consent" required aria-required="true" aria-describedby="reg-error-consent"${values.consent ? ' checked' : ''}${errors.consent ? ' aria-invalid="true"' : ''}>
<label for="reg-consent">ข้าพเจ้ายินยอมให้เทศบาลนครตัวอย่างเก็บและประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ e-Service ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</label>
</div>
${err('reg-error-consent', 'reg-error-consent', errors.consent)}
</div>
<button type="submit" class="btn btn-primary" data-testid="reg-submit">ลงทะเบียน</button>
</form>
</div>
</div>`;
}

/** /register ใช้ได้เฉพาะประชาชนที่ยังไม่ลงทะเบียน · อื่น ๆ redirect (CONTRACT §1) */
function registerGate(req, res) {
  const user = rbac.refreshUser(req, res);
  if (!user) {
    res.redirect(302, '/login');
    return null;
  }
  if (!rbac.isUnregistered(user)) {
    res.redirect(302, rbac.landingFor(user));
    return null;
  }
  return user;
}

router.get('/register', (req, res) => {
  const user = registerGate(req, res);
  if (!user) return undefined;
  return sendPage(req, res, { title: 'ลงทะเบียน', body: registerBody(user), head: LOGIN_CSS, scripts: REGISTER_JS });
});

// ฟอร์มสำรอง (ไม่มี JavaScript)
router.post('/register', (req, res) => {
  const user = registerGate(req, res);
  if (!user) return undefined;
  const input = req.body || {};
  const r = registerSafely(req, res, input);
  if (r.ok) return res.redirect(303, rbac.landingFor(r.user));
  if (r.code === 'UNAUTHENTICATED') return res.redirect(303, '/login');
  const errors = {};
  if (r.code === 'INVALID_MOBILE') errors.mobile = 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0';
  else if (r.code === 'CONSENT_REQUIRED') errors.consent = 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)';
  const values = { mobile: input.mobile, email: input.email, consent: isConsentGiven(input.consent) };
  return sendPage(req, res, {
    status: 400,
    title: 'ลงทะเบียน',
    body: registerBody(user, values, errors),
    head: LOGIN_CSS,
    scripts: REGISTER_JS,
  });
});

module.exports = router;
module.exports.isValidThaiId = isValidThaiId;
module.exports.isValidMobile = isValidMobile;
