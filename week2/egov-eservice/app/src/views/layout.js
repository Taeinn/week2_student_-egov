'use strict';
/**
 * โครงหน้า HTML กลาง (CONTRACT §2.1 · NFR-01..03 · lang="th" · skip link)
 *
 *   const { sendPage, renderPage, sendForbidden, sendNotFound, statusBadge, levelBadge } = require('../views/layout');
 *   sendPage(req, res, { title: 'คิวงาน', body: '<h1>…</h1>' });
 *   sendPage(req, res, { title, body, status: 400, error: 'ข้อความ' });   // แสดง action-error (role=alert)
 *   sendForbidden(req, res);   // 403 + forbidden-msg 'ไม่มีสิทธิ์เข้าถึงหน้านี้'
 *   sendNotFound(req, res);    // 404 + not-found-msg 'ไม่พบคำขอ'
 *
 * ฝั่ง browser มี window.App (ฝังในทุกหน้า):
 *   App.api(method, url, body)  → Promise<{ ok, status, data }>  (JSON, cookie same-origin)
 *   App.showError(msg) / App.showSuccess(msg) / App.clearFlash()
 *     → สร้าง/อัปเดต [data-testid=action-error] (role=alert) / [data-testid=action-success] ได้ตัวเดียวทั้งหน้า
 *     (ห้าม render action-error ซ้ำเองในหน้า — ใช้ opts.error หรือ App.showError แทน เพื่อไม่ให้ testid ซ้ำ)
 *   App.fmtMoney(n) → '฿1,010'
 *
 * CSS class ที่ใช้ได้: .btn .btn-primary .btn-danger .btn-secondary .card .grid .stack .row .muted
 *   .table-wrap (ห่อ table ทุกตารางกัน scroll แนวนอนทั้งหน้า) .form-row .field-error .badge .st-<STATUS> .lv-<level>
 *   .visually-hidden (label ซ่อนแต่ screen reader อ่านได้)
 */

const db = require('../db');
const { ROLE_LABELS, STATUS_LABELS, LEVEL_LABELS } = require('../lib/constants');
const { esc, fmtDateTime, fmtDate, fmtMoney, timeTag } = require('../lib/format');
const { PAGE_MESSAGES } = require('../lib/errors');
const { isTestMode } = require('../lib/clock');

const SITE_NAME = 'เทศบาลนครตัวอย่าง';
const APP_NAME = 'e-Service กลาง';

/** เมนูตามบทบาท (CONTRACT §2.1) */
const NAV_ITEMS = [
  { testid: 'nav-my-cases', href: '/citizen', label: 'คำขอของฉัน', roles: ['citizen'] },
  { testid: 'nav-queue', href: '/officer/queue', label: 'คิวงาน', roles: ['officer', 'head'] },
  { testid: 'nav-approvals', href: '/head/approvals', label: 'รออนุมัติ', roles: ['head'] },
  { testid: 'nav-dashboard', href: '/dashboard', label: 'Dashboard', roles: ['executive'] },
  { testid: 'nav-audit', href: '/audit', label: 'Audit Trail', roles: ['auditor'] },
  { testid: 'nav-admin-services', href: '/admin/services', label: 'บริการ', roles: ['admin'] },
  { testid: 'nav-admin-holidays', href: '/admin/holidays', label: 'วันหยุด', roles: ['admin'] },
  { testid: 'nav-admin-users', href: '/admin/users', label: 'ผู้ใช้', roles: ['admin'] },
];

const CSS = `
:root{--navy:#1f3a68;--navy-dark:#162a4c;--gold:#c9a227;--bg:#f5f6f8;--text:#1a1a1a;--muted:#555;--border:#c8ccd4;--danger:#a4161a;--ok:#1d5e33}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:"Sarabun","Noto Sans Thai","Leelawadee UI","Tahoma",system-ui,sans-serif;font-size:16px;line-height:1.6;color:var(--text);background:var(--bg);overflow-wrap:anywhere}
a{color:#0b4a8b}
a:hover{color:#06315e}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
img,svg,canvas,video{max-width:100%;height:auto}
.skip-link{position:absolute;left:8px;top:-60px;z-index:100;background:#fff;color:var(--navy);padding:8px 12px;border:2px solid var(--navy);border-radius:4px;font-weight:600}
.skip-link:focus{top:8px}
.app-header{background:var(--navy);color:#fff;border-bottom:4px solid var(--gold)}
.app-header .inner{max-width:1200px;margin:0 auto;padding:8px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;min-width:0}
.brand:hover{color:#fff}
.brand img{width:44px;height:44px;flex:none;border-radius:50%;background:#fff}
.brand-text{display:flex;flex-direction:column;line-height:1.2}
.brand-text strong{font-size:1.05rem}
.brand-text span{font-size:.85rem;color:#e8ecf3}
.main-nav{flex:1 1 auto;min-width:0}
.main-nav ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.main-nav a{display:inline-block;color:#fff;text-decoration:none;padding:6px 10px;border-radius:4px}
.main-nav a:hover,.main-nav a[aria-current="page"]{background:var(--navy-dark);text-decoration:underline}
.user-box{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:.95rem}
.user-box .bell{color:#fff;text-decoration:none;padding:4px 8px;border:1px solid #9fb0cc;border-radius:4px}
.user-box .bell:hover{background:var(--navy-dark)}
.bell-count{display:inline-block;min-width:1.6em;text-align:center;background:var(--gold);color:#1a1a1a;border-radius:999px;padding:0 6px;font-weight:700}
.role-tag{background:#fff;color:var(--navy);border-radius:4px;padding:0 6px;font-weight:600}
.btn{display:inline-block;font:inherit;font-weight:600;padding:8px 14px;border-radius:6px;border:1px solid var(--navy);background:#fff;color:var(--navy);cursor:pointer;text-decoration:none;line-height:1.3}
.btn:hover{background:#e9eef7}
.btn-primary{background:var(--navy);color:#fff}
.btn-primary:hover{background:var(--navy-dark);color:#fff}
.btn-danger{background:var(--danger);border-color:var(--danger);color:#fff}
.btn-danger:hover{background:#7d1013}
.btn-secondary{background:#eef1f6}
.btn:disabled,.btn[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
.app-header .btn{padding:4px 10px;background:transparent;color:#fff;border-color:#fff}
.app-header .btn:hover{background:var(--navy-dark)}
main{display:block;max-width:1200px;margin:0 auto;padding:16px}
main:focus{outline:none}
h1{font-size:1.5rem;margin:.4em 0 .6em;color:var(--navy-dark)}
h2{font-size:1.2rem;margin:1.2em 0 .5em}
.card{background:#fff;border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}
.stack>*+*{margin-top:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.muted{color:var(--muted)}
.table-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
th{background:#e9eef7}
label{font-weight:600}
input,select,textarea{font:inherit;max-width:100%;padding:6px 8px;border:1px solid #767c87;border-radius:4px;background:#fff;color:var(--text)}
input[type=checkbox],input[type=radio]{width:1.1em;height:1.1em}
.form-row{display:flex;flex-direction:column;gap:4px;margin:0 0 12px}
.field-error{color:var(--danger);font-weight:600}
.alert{border-radius:6px;padding:10px 14px;margin:0 0 12px;border:1px solid}
.alert-error{background:#fdecec;border-color:#e3a5a7;color:#7a1013}
.alert-success{background:#e6f4ea;border-color:#9ccfaa;color:#14532d}
.badge{display:inline-block;border-radius:4px;padding:1px 8px;font-weight:600;border:1px solid transparent;white-space:nowrap}
.st-DRAFT,.st-PENDING_PAYMENT{background:#eef1f6;color:#2b3445;border-color:#b9c1cf}
.st-SUBMITTED{background:#e3edfb;color:#123f7a;border-color:#a9c3ec}
.st-IN_REVIEW{background:#e8e4f8;color:#3b2a7a;border-color:#bdb3e8}
.st-NEED_FIX,.st-PENDING_APPROVAL{background:#fff4cc;color:#5c4400;border-color:#e5c95c}
.st-APPROVED,.st-COMPLETED{background:#e3f4e8;color:#1d5e33;border-color:#9ccfaa}
.st-REJECTED,.st-CANCELLED{background:#fde2e1;color:#8a1c1c;border-color:#eba9a7}
.lv-normal{background:#e3f4e8;color:#1d5e33;border-color:#9ccfaa}
.lv-near{background:#fff4cc;color:#5c4400;border-color:#e5c95c}
.lv-overdue{background:#fde2e1;color:#8a1c1c;border-color:#eba9a7}
.lv-paused{background:#eceff3;color:#3b4452;border-color:#b9c1cf}
.lv-closed{background:#e8e8e8;color:#333;border-color:#bbb}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.app-footer{max-width:1200px;margin:24px auto 0;padding:12px 16px;color:var(--muted);font-size:.85rem;border-top:1px solid var(--border)}
#flash:empty{display:none}
@media (max-width:600px){.app-header .inner{padding:8px}.brand img{width:36px;height:36px}main{padding:12px 8px}th,td{padding:4px 6px}}
`;

const CLIENT_JS = `
(function(){
  var App = window.App = window.App || {};
  function flash(){ return document.getElementById('flash'); }
  function setMsg(testid, cls, role, msg){
    var box = flash(); if (!box) return null;
    var el = document.querySelector('[data-testid="' + testid + '"]');
    if (!el){ el = document.createElement('div'); el.setAttribute('data-testid', testid); el.className = 'alert ' + cls; el.setAttribute('role', role); box.appendChild(el); }
    el.hidden = false; el.textContent = msg; return el;
  }
  App.clearFlash = function(){
    ['action-error','action-success'].forEach(function(t){ var el = document.querySelector('[data-testid="' + t + '"]'); if (el && el.parentNode) el.parentNode.removeChild(el); });
  };
  App.showError = function(msg){ var s = document.querySelector('[data-testid="action-success"]'); if (s && s.parentNode) s.parentNode.removeChild(s); return setMsg('action-error', 'alert-error', 'alert', msg); };
  App.showSuccess = function(msg){ var e = document.querySelector('[data-testid="action-error"]'); if (e && e.parentNode) e.parentNode.removeChild(e); return setMsg('action-success', 'alert-success', 'status', msg); };
  App.api = function(method, url, body){
    var opt = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (body instanceof FormData) { opt.body = body; }
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function(r){
      return r.text().then(function(t){ var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = { raw: t }; } return { ok: r.ok, status: r.status, data: d }; });
    });
  };
  App.fmtMoney = function(n){ if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '\\u2013'; return '\\u0e3f' + String(Math.round(Number(n))).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); };
  document.addEventListener('click', function(ev){
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-testid="logout-btn"]') : null;
    if (!b) return;
    ev.preventDefault();
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(function(){}).then(function(){ window.location.href = '/login'; });
  });
})();
`;

function bellCount(user) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(user.id).n;
  } catch (_) {
    return 0;
  }
}

function renderNav(user, currentPath) {
  if (!user) return '';
  const items = NAV_ITEMS.filter((n) => n.roles.includes(user.role));
  if (!items.length) return '';
  const lis = items
    .map((n) => {
      const cur = currentPath === n.href || (currentPath || '').startsWith(`${n.href}/`) ? ' aria-current="page"' : '';
      return `<li><a data-testid="${n.testid}" href="${n.href}"${cur}>${esc(n.label)}</a></li>`;
    })
    .join('');
  return `<nav class="main-nav" aria-label="เมนูหลัก"><ul>${lis}</ul></nav>`;
}

function renderUserBox(user) {
  if (!user) return '';
  const role = user.role || '';
  const deptAttr = role === 'officer' && user.dept ? ` data-dept="${esc(user.dept)}"` : '';
  let bell = '';
  if (role === 'officer' || role === 'head') {
    const n = bellCount(user);
    bell = `<a class="bell" data-testid="nav-bell" href="/notifications"><span aria-hidden="true">🔔</span> แจ้งเตือน <span class="bell-count" data-testid="bell-count">${n}</span></a>`;
  }
  return `<div class="user-box">${bell}<span data-testid="user-name">${esc(user.name || user.username || '')}</span>`
    + `<span class="role-tag" data-testid="user-role" data-role="${esc(role)}"${deptAttr}>${esc(ROLE_LABELS[role] || role)}</span>`
    + `<button type="button" class="btn" data-testid="logout-btn">ออกจากระบบ</button></div>`;
}

/**
 * HTML ทั้งหน้า
 * @param {import('express').Request} req
 * @param {object} opts
 * @param {string} opts.title       ชื่อหน้า (ใส่ใน <title>)
 * @param {string} opts.body        HTML ภายใน <main>
 * @param {string} [opts.error]     ข้อความ action-error (role=alert)
 * @param {string} [opts.success]   ข้อความ action-success
 * @param {string} [opts.head]      HTML เพิ่มใน <head>
 * @param {string} [opts.scripts]   HTML เพิ่มท้าย <body> (เช่น <script>…</script>)
 * @param {object} [opts.user]      แทน req.user
 * @param {boolean} [opts.hideUser] ไม่แสดงส่วนผู้ใช้ (เช่น /login /verify)
 */
function renderPage(req, opts = {}) {
  const user = opts.hideUser ? null : opts.user !== undefined ? opts.user : (req && req.user) || null;
  const title = opts.title ? `${opts.title} · ${SITE_NAME}` : `${APP_NAME} · ${SITE_NAME}`;
  const flash = [
    opts.error ? `<div class="alert alert-error" data-testid="action-error" role="alert">${esc(opts.error)}</div>` : '',
    opts.success ? `<div class="alert alert-success" data-testid="action-success" role="status">${esc(opts.success)}</div>` : '',
  ].join('');
  const currentPath = req ? req.path : '';
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/img/logo.png">
<style>${CSS}</style>
${opts.head || ''}
</head>
<body>
<a class="skip-link" href="#main">ข้ามไปยังเนื้อหาหลัก</a>
<header class="app-header" data-testid="app-header">
<div class="inner">
<a class="brand" href="/"><img src="/img/logo.png" alt="ตราเทศบาลนครตัวอย่าง" width="44" height="44"><span class="brand-text"><strong>${esc(SITE_NAME)}</strong><span>${esc(APP_NAME)}</span></span></a>
${renderNav(user, currentPath)}
${renderUserBox(user)}
</div>
</header>
<main id="main" tabindex="-1">
<div id="flash" aria-live="polite">${flash}</div>
${opts.body || ''}
</main>
<footer class="app-footer"><p>${esc(SITE_NAME)} (หน่วยงานสมมติเพื่อการทดสอบ) · ThaiD / PromptPay / ลายเซ็นดิจิทัลเป็นระบบจำลอง${isTestMode() ? ' · โหมดทดสอบ' : ''}</p></footer>
<script>${CLIENT_JS}</script>
${opts.scripts || ''}
</body>
</html>`;
}

/** ส่งหน้า HTML */
function sendPage(req, res, opts = {}) {
  res.status(opts.status || 200);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  return res.send(renderPage(req, opts));
}

/** หน้า 403 (forbidden-msg) */
function sendForbidden(req, res, message = PAGE_MESSAGES.FORBIDDEN_PAGE) {
  return sendPage(req, res, {
    status: 403,
    title: 'ไม่มีสิทธิ์เข้าถึง',
    body: `<h1>ไม่มีสิทธิ์เข้าถึง</h1><p class="alert alert-error" data-testid="forbidden-msg">${esc(message)}</p>`,
  });
}

/** หน้า 404 ของคำขอ (not-found-msg) */
function sendNotFound(req, res, message = PAGE_MESSAGES.NOT_FOUND_CASE) {
  return sendPage(req, res, {
    status: 404,
    title: 'ไม่พบข้อมูล',
    body: `<h1>ไม่พบข้อมูล</h1><p class="alert alert-error" data-testid="not-found-msg">${esc(message)}</p>`,
  });
}

/** <span data-testid="case-status" data-status="IN_REVIEW" class="badge st-IN_REVIEW">กำลังตรวจสอบ</span> */
function statusBadge(status, testid = 'case-status') {
  const tid = testid ? ` data-testid="${esc(testid)}"` : '';
  return `<span${tid} data-status="${esc(status)}" class="badge st-${esc(status)}">${esc(STATUS_LABELS[status] || status || '')}</span>`;
}

/** <span data-testid="sla-level" data-level="near" class="badge lv-near">ใกล้ครบกำหนด</span> */
function levelBadge(level, testid = 'sla-level') {
  const tid = testid ? ` data-testid="${esc(testid)}"` : '';
  return `<span${tid} data-level="${esc(level)}" class="badge lv-${esc(level)}">${esc(LEVEL_LABELS[level] || level || '')}</span>`;
}

module.exports = {
  SITE_NAME,
  APP_NAME,
  NAV_ITEMS,
  renderPage,
  layout: renderPage,
  sendPage,
  sendForbidden,
  sendNotFound,
  statusBadge,
  levelBadge,
  // re-export ตัวช่วยรูปแบบเพื่อความสะดวกของหน้าอื่น
  esc,
  fmtDateTime,
  fmtDate,
  fmtMoney,
  timeTag,
};
