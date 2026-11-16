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

/*
 * ธีม "white engineering blueprint" ตาม DESIGN-visitor.md
 * ปรับเพื่อ WCAG AA (TC-NFR-02 · axe color-contrast):
 *   - ปุ่มหลักใช้ --action (#5b4fe0 ลาเวนเดอร์เข้ม · 5.8:1 กับขาว) แทน Lavender #918df6 (2.9:1 ไม่ผ่าน)
 *     Lavender ใช้เป็นสีตกแต่ง: เส้นใต้เมนูที่เลือก · focus ring · แถบไอคอน
 *   - ข้อความรอง = Graphite #666 (5.7:1) · Ash #999 ใช้กับเส้น/placeholder เท่านั้น
 *   - สถานะใช้พื้นพาสเทล + ตัวอักษรเข้ม (ไม่ใช้ Mint/Amber เป็นสีตัวอักษรบนขาว)
 * ฟอนต์: OpenRunde ไม่มีอักษรไทย → Inter / Noto Sans Thai / ฟอนต์ระบบ (ไม่โหลดฟอนต์ภายนอก)
 * ตัวแปรเดิม (--navy --gold --border …) คงไว้เป็น alias ให้ CSS ของหน้าอื่นใช้ต่อได้
 */
const CSS = `
:root{
--color-carbon:#181925;--color-paper:#ffffff;--color-linen:#fafafa;--color-mist:#f5f5f5;--color-fog:#e8e8e8;
--color-ash:#999999;--color-graphite:#666666;--color-lavender:#918df6;--color-iris:#9580ff;--action:#5b4fe0;--action-dark:#4a3fc9;
--color-mint:#33c758;--color-mint-wash:#def6e4;--color-amber:#ffa600;--color-sky:#2c78fc;--color-magenta:#d6409f;
--radius-pill:9999px;--radius-card:16px;--radius-input:8px;--radius-table:16px;
--shadow-subtle:rgba(0,0,0,.08) 0 1px 1px 1px,rgba(0,0,0,.06) 0 0 0 .5px;
--shadow-subtle-2:rgba(0,0,0,.08) 0 1px 1px 0,rgba(0,0,0,.05) 0 0 0 1px;
--shadow-panel:rgba(0,0,0,.06) 0 1px 3px 0,rgba(0,0,0,.06) 0 8px 16px 0,rgba(0,0,0,.02) 0 0 0 1px;
--navy:var(--action);--navy-dark:var(--color-carbon);--gold:var(--color-lavender);--bg:var(--color-paper);--text:var(--color-carbon);
--muted:var(--color-graphite);--border:var(--color-fog);--danger:#c0262d;--ok:#1a7f37}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:"Inter","Noto Sans Thai","Leelawadee UI","Segoe UI",system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.6;letter-spacing:-.01em;color:var(--text);background:var(--color-paper);overflow-wrap:anywhere;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--action);text-underline-offset:3px}
a:hover{color:var(--action-dark)}
:focus-visible{outline:3px solid var(--color-lavender);outline-offset:2px}
img,svg,canvas,video{max-width:100%;height:auto}
.skip-link{position:absolute;left:8px;top:-60px;z-index:100;background:#fff;color:var(--text);padding:8px 16px;border:1px solid var(--border);border-radius:var(--radius-pill);font-weight:500;box-shadow:var(--shadow-subtle-2)}
.skip-link:focus{top:8px}
.app-header{background:rgba(255,255,255,.92);color:var(--text);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;backdrop-filter:saturate(1.4) blur(8px)}
.app-header .inner{max-width:1200px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;min-width:0}
.brand:hover{color:var(--text)}
.brand img{width:40px;height:40px;flex:none;border-radius:50%;background:#fff;box-shadow:0 0 0 1px var(--border)}
.brand-text{display:flex;flex-direction:column;line-height:1.2}
.brand-text strong{font-size:1rem;font-weight:600;letter-spacing:-.02em}
.brand-text span{font-size:.8rem;color:var(--muted)}
.main-nav{flex:1 1 auto;min-width:0}
.main-nav ul{list-style:none;margin:0;padding:4px;display:inline-flex;flex-wrap:wrap;gap:2px;border:1px solid var(--border);border-radius:var(--radius-pill);background:#fff;box-shadow:var(--shadow-subtle-2);max-width:100%}
.main-nav a{display:inline-block;color:var(--muted);text-decoration:none;padding:6px 14px;border-radius:var(--radius-pill);font-size:.92rem;font-weight:500}
.main-nav a:hover{color:var(--text);background:var(--color-mist)}
.main-nav a[aria-current="page"]{color:var(--text);background:var(--color-mist);box-shadow:inset 0 -2px 0 var(--color-lavender)}
.user-box{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:.92rem}
.user-box .bell{color:var(--text);text-decoration:none;padding:5px 12px;border:1px solid var(--border);border-radius:var(--radius-pill);background:#fff;font-weight:500}
.user-box .bell:hover{background:var(--color-mist)}
.bell-count{display:inline-block;min-width:1.6em;text-align:center;background:var(--action);color:#fff;border-radius:var(--radius-pill);padding:0 6px;font-weight:600;font-size:.85em}
.role-tag{background:var(--color-mist);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-pill);padding:1px 10px;font-weight:500;font-size:.85em}
.btn{display:inline-block;font:inherit;font-size:.92rem;font-weight:500;letter-spacing:-.01em;padding:9px 20px;border-radius:var(--radius-pill);border:none;background:#fff;color:var(--text);cursor:pointer;text-decoration:none;line-height:1.3;white-space:nowrap;box-shadow:var(--shadow-subtle-2);transition:background .15s,box-shadow .15s}
.btn:hover{background:var(--color-mist)}
.btn-primary{background:var(--action);color:#fff;box-shadow:var(--shadow-subtle)}
.btn-primary:hover{background:var(--action-dark);color:#fff}
.btn-danger{background:var(--danger);color:#fff;box-shadow:var(--shadow-subtle)}
.btn-danger:hover{background:#9b1c22;color:#fff}
.btn-secondary{background:var(--color-mist);color:var(--text);box-shadow:none}
.btn-secondary:hover{background:var(--color-fog)}
.btn:disabled,.btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.app-header .btn{padding:5px 14px;background:transparent;color:var(--muted);box-shadow:none}
.app-header .btn:hover{background:var(--color-mist);color:var(--text)}
main{display:block;flex:1 0 auto;width:100%;max-width:1200px;margin:0 auto;padding:32px 16px}
main>h1+p.muted{margin-top:-.6em;margin-bottom:1.4em}
main:focus{outline:none}
h1{font-size:2.25rem;font-weight:600;line-height:1.22;letter-spacing:-.03em;margin:.2em 0 .7em;color:var(--text)}
h2{font-size:1.4rem;font-weight:600;line-height:1.25;letter-spacing:-.02em;margin:1.4em 0 .6em}
h3{font-size:1.1rem;font-weight:600;letter-spacing:-.015em}
.card{background:#fff;border:1px solid var(--border);border-radius:var(--radius-card);padding:24px;margin:0 0 16px}
.card>:first-child,.card>section>:first-child,.card>h2:first-child{margin-top:0}
.card>:last-child,.card .table-wrap:last-child{margin-bottom:0}
dl{margin:0}
dl.grid{gap:16px 24px}
dl.grid dt{font-size:.82rem;font-weight:500;color:var(--muted);margin:0 0 2px}
dl.grid dd{margin:0;font-weight:500}
.timeline,ol[data-testid="case-timeline"]{list-style:none;margin:0;padding:0 0 0 4px;border-left:2px solid var(--border)}
.timeline li,ol[data-testid="case-timeline"] li{position:relative;margin:0 0 12px;padding:0 0 0 18px}
.timeline li:last-child,ol[data-testid="case-timeline"] li:last-child{margin-bottom:0}
.timeline li::before,ol[data-testid="case-timeline"] li::before{content:"";position:absolute;left:-7px;top:.55em;width:10px;height:10px;border-radius:50%;background:var(--color-lavender);box-shadow:0 0 0 3px #fff}
.timeline time,ol[data-testid="case-timeline"] time{font-weight:600}
.doc-list{list-style:none;margin:0;padding:0}
.doc-list li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin:0 0 8px;background:#fff}
.doc-list li:last-child{margin-bottom:0}
.doc-list.doc-inline li{justify-content:flex-start}
.doc-list a[download]{font-weight:500}
.empty,p[data-testid="noti-empty"]{margin:0;padding:28px 16px;text-align:center;color:var(--muted);border:1px dashed #d4d4dc;border-radius:var(--radius-card);background:var(--color-linen)}
td>[data-testid="queue-empty"]{padding:24px 0;text-align:center;color:var(--muted)}
.error-page{max-width:560px;margin:32px auto;text-align:center}
.error-page .alert{text-align:left}
.error-code{display:inline-block;font-size:.85rem;font-weight:600;letter-spacing:.04em;color:#3f35b0;background:#efeefe;border:1px solid #d6d4fc;border-radius:var(--radius-pill);padding:2px 12px;margin:0 0 12px}
section.card>.row,section.card>.stack{margin-bottom:12px}
section.card>.row:last-child,section.card>.stack:last-child{margin-bottom:0}
[aria-labelledby="h-actions"]>.row{display:inline-flex;vertical-align:top;margin:0 8px 8px 0}
[aria-labelledby="h-actions"]>.stack{padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--color-linen)}
figure{margin:0 0 16px}
figure img{border:1px solid var(--border);border-radius:12px;padding:8px;background:#fff}
dd{margin:0 0 8px}
tbody th{background:transparent;font-weight:600}
fieldset{border:1px solid var(--border);border-radius:var(--radius-card);padding:16px 20px;margin:0 0 16px}
legend{font-weight:600;padding:0 6px}
hr{border:none;border-top:1px solid var(--border);margin:24px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}
.stack>*+*{margin-top:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.muted{color:var(--muted)}
.table-wrap{position:relative;width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:var(--radius-table);margin:0 0 16px;background:linear-gradient(to right,#fff 30%,rgba(255,255,255,0)) left center/40px 100% no-repeat local,linear-gradient(to left,#fff 30%,rgba(255,255,255,0)) right center/40px 100% no-repeat local,linear-gradient(to right,rgba(24,25,37,.10),rgba(24,25,37,0)) left center/12px 100% no-repeat scroll,linear-gradient(to left,rgba(24,25,37,.10),rgba(24,25,37,0)) right center/12px 100% no-repeat scroll,#fff}
table{border-collapse:collapse;width:100%;background:transparent;font-size:.92rem}
th,td{border-bottom:1px solid var(--border);padding:10px 14px;text-align:left;vertical-align:middle;overflow-wrap:normal}
td .btn{padding:6px 14px;font-size:.88rem}
td .btn+.btn{margin-left:4px}
td .btn-danger{background:#fff;color:var(--danger);box-shadow:inset 0 0 0 1px #f3c4c6}
td .btn-danger:hover{background:#fef1f1;color:#9b1c22}
td p{margin:0}
caption{caption-side:top;text-align:left}
.table-wrap table{min-width:720px}
.table-wrap tr:last-child td,.table-wrap tr:last-child th{border-bottom:none}
table:not(.table-wrap table){border:1px solid var(--border)}
th{background:var(--color-linen);color:var(--text);font-weight:600}
td{color:#3a3b47}
tbody tr:hover td{background:var(--color-linen)}
label{font-weight:500}
input,select,textarea{font:inherit;max-width:100%;padding:8px 12px;border:1px solid #8a8a96;border-radius:var(--radius-input);background:#fff;color:var(--text)}
input:focus,select:focus,textarea:focus{border-color:var(--action);outline:3px solid rgba(145,141,246,.35);outline-offset:0}
input[type=checkbox],input[type=radio]{width:1.1em;height:1.1em;accent-color:var(--action)}
::placeholder{color:#767680}
.form-row{display:flex;flex-direction:column;gap:6px;margin:0 0 16px}
.form-row input[type=number]{max-width:220px}
form.row{margin:0 0 16px}
input[type=file]{padding:6px;border-style:dashed;border-color:#b9b9c6;background:var(--color-linen);color:var(--muted);cursor:pointer;width:100%}
input[type=file]::file-selector-button{font:inherit;font-size:.88rem;font-weight:500;margin-right:12px;padding:6px 14px;border:none;border-radius:var(--radius-pill);background:#fff;color:var(--text);box-shadow:var(--shadow-subtle-2);cursor:pointer}
input[type=file]:hover{border-color:var(--action)}
input[readonly]{background:var(--color-mist);color:var(--muted)}
textarea{width:100%;min-height:88px;resize:vertical}
p.field-error{margin:4px 0}
.field-error{color:var(--danger);font-weight:500;font-size:.92rem}
.alert{border-radius:12px;padding:12px 16px;margin:0 0 16px;border:1px solid}
.alert-error{background:#fef1f1;border-color:#f3c4c6;color:#8f1a1f}
.alert-success{background:var(--color-mint-wash);border-color:#b5e5c1;color:#14532d}
.badge{display:inline-block;border-radius:var(--radius-pill);padding:2px 10px;font-size:.85em;font-weight:500;border:1px solid transparent;white-space:nowrap}
.st-DRAFT,.st-PENDING_PAYMENT{background:var(--color-mist);color:#3a3b47;border-color:var(--border)}
.st-SUBMITTED{background:#eaf1ff;color:#1648a8;border-color:#c9dafd}
.st-IN_REVIEW{background:#efeefe;color:#3f35b0;border-color:#d6d4fc}
.st-NEED_FIX,.st-PENDING_APPROVAL{background:#fff4dc;color:#7a4b00;border-color:#ffdc99}
.st-APPROVED,.st-COMPLETED{background:var(--color-mint-wash);color:#16642c;border-color:#b5e5c1}
.st-REJECTED,.st-CANCELLED{background:#fdebf4;color:#9a1f63;border-color:#f4c2dd}
.lv-normal{background:var(--color-mint-wash);color:#16642c;border-color:#b5e5c1}
.lv-near{background:#fff4dc;color:#7a4b00;border-color:#ffdc99}
.lv-overdue{background:#fef1f1;color:#8f1a1f;border-color:#f3c4c6}
.lv-paused{background:var(--color-mist);color:#3a3b47;border-color:var(--border)}
.lv-closed{background:var(--color-fog);color:#333;border-color:#d4d4d4}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.app-footer{width:100%;max-width:1200px;margin:48px auto 0;padding:20px 16px;color:var(--muted);font-size:.82rem;border-top:1px solid var(--border)}
#flash:empty{display:none}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0;align-items:baseline}
.kv>div{display:contents}
.kv dt{font-weight:500;color:var(--muted);margin:0}
.kv dd{margin:0;min-width:0}
.card dl+.row,.card dl+.stack,.card .kv+.row{margin-top:16px}
section.card>.stack[id]{margin-top:12px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--color-linen)}
section.card>.stack[id] .form-row{margin-bottom:0}
.form-row input[type=text],.form-row input:not([type]),.form-row input[type=email],.form-row input[type=tel],.form-row input[type=date],.form-row select{max-width:520px;width:100%}
button:disabled,.btn:disabled{box-shadow:none}
.verify-card{max-width:760px;margin:0 auto}
.verify-card .table-wrap table{min-width:0}
.verify-card tbody th{width:36%;color:var(--muted);font-weight:500;white-space:nowrap}
.verify-card tbody td{color:var(--text);font-weight:500}
.doc-body{display:flex;flex-wrap:wrap;gap:16px 32px;align-items:flex-start}
.doc-body .kv{flex:0 1 auto}
.doc-body figure{flex:0 1 240px;padding:12px;border:1px solid var(--border);border-radius:12px;margin:0;text-align:center;font-size:.82rem;color:var(--muted)}
.doc-body figure svg,.doc-body figure img{display:block;margin:0 auto 6px;width:160px;height:160px}
@media (max-width:600px){.app-header{position:static}.app-header .inner{padding:8px 10px;gap:8px}.brand img{width:34px;height:34px}.brand-text strong{font-size:.92rem}.brand-text span{font-size:.75rem}.main-nav{flex:1 1 auto;text-align:right}.main-nav ul{border-radius:16px;justify-content:flex-end;padding:3px}.main-nav a{padding:5px 11px;font-size:.85rem}.user-box{width:100%;flex-wrap:nowrap;font-size:.82rem;gap:8px;border-top:1px solid var(--border);padding-top:8px}.user-box [data-testid="user-name"]{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.user-box .bell{padding:3px 10px;white-space:nowrap}.user-box .bell-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.role-tag{white-space:nowrap}.app-header .btn{padding:3px 6px;font-size:.82rem}main{padding:16px 12px}h1{font-size:1.6rem}.card{padding:16px}th,td{padding:8px 10px}.table-wrap table{min-width:0}.table-wrap th,.table-wrap td{white-space:nowrap}.app-footer{margin-top:24px}dl.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:480px){.kv{grid-template-columns:1fr;gap:0}.kv dd{margin:0 0 10px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{.app-header,.app-footer,.skip-link,.btn{display:none!important}main{padding:0}}
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
      // หน้าย่อยของเมนู (เช่น /officer/cases/… ของคิวงาน) ให้เมนูต้นทางยังถูกเลือกอยู่
      const p = currentPath || '';
      const sub = (n.testid === 'nav-my-cases' && p.startsWith('/citizen/')) || (n.testid === 'nav-queue' && p.startsWith('/officer/'));
      const cur = p === n.href || p.startsWith(`${n.href}/`) || sub ? ' aria-current="page"' : '';
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
    bell = `<a class="bell" data-testid="nav-bell" href="/notifications"><span aria-hidden="true">🔔</span> <span class="bell-label">แจ้งเตือน</span> <span class="bell-count" data-testid="bell-count">${n}</span></a>`;
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
<meta name="theme-color" content="#5b4fe0">
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
    body: `<div class="error-page"><p class="error-code" aria-hidden="true">403</p><h1>ไม่มีสิทธิ์เข้าถึง</h1><p class="alert alert-error" data-testid="forbidden-msg">${esc(message)}</p><p><a class="btn btn-secondary" href="/">กลับหน้าหลัก</a></p></div>`,
  });
}

/** หน้า 404 ของคำขอ (not-found-msg) */
function sendNotFound(req, res, message = PAGE_MESSAGES.NOT_FOUND_CASE) {
  return sendPage(req, res, {
    status: 404,
    title: 'ไม่พบข้อมูล',
    body: `<div class="error-page"><p class="error-code" aria-hidden="true">404</p><h1>ไม่พบข้อมูล</h1><p class="alert alert-error" data-testid="not-found-msg">${esc(message)}</p><p><a class="btn btn-secondary" href="/">กลับหน้าหลัก</a></p></div>`,
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
