'use strict';
/**
 * หน้า /citizen (บล็อก B05) · CONTRACT §2.4
 *   citizen-welcome · start-service-SV-0x · my-case-row (เรียงเลขคำขอมากไปน้อย) · my-draft-row (ไม่มีข้อความ EG-)
 *   row-case-no · row-service · row-status · row-due · row-sla-level · row-draft-id · open-draft-btn
 */

const { esc, fmtMoney, timeTag, serviceLabel } = require('../../lib/format');
const { statusBadge, levelBadge } = require('../layout');
const { SERVICES } = require('../../lib/constants');

const PAGE_CSS = `<style>
.svc-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}
.svc-card{border:1px solid var(--border);border-radius:16px;padding:20px;background:#fff;display:flex;flex-direction:column;gap:10px;transition:box-shadow .15s,border-color .15s}
.svc-card:hover{border-color:#d6d4fc;box-shadow:var(--shadow-panel)}
.svc-card h3{margin:0;font-size:1.1rem;line-height:1.35}
.svc-icon{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,var(--action),var(--color-lavender))}
.svc-card:nth-child(2) .svc-icon{background:linear-gradient(135deg,#1f63e0,var(--color-sky))}
.svc-card:nth-child(3) .svc-icon{background:linear-gradient(135deg,#b3307f,var(--color-magenta))}
.svc-icon svg{width:20px;height:20px}
.svc-code{font-size:.78rem;font-weight:600;letter-spacing:.04em;color:var(--muted)}
.svc-fee{font-weight:500}
.svc-meta{font-size:.88rem;color:var(--muted)}
.home-section{margin:0 0 40px}
.home-section>h2{margin-top:0}
.home-lead{color:var(--muted);margin:-.6em 0 2em}
.svc-card .btn{margin-top:auto}
.svc-card p{margin:0}
.svc-card .btn{align-self:flex-start}
.actions{display:flex;flex-wrap:wrap;gap:6px}
</style>`;

const SVG = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  'SV-01': SVG('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  'SV-02': SVG('<path d="M4 9l1.5-5h13L20 9M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M4 9h16M9 20v-6h6v6"/>'),
  'SV-03': SVG('<path d="M4 21V8l8-5 8 5v13M9 21v-6h6v6M3 21h18"/>'),
};

/** ข้อความค่าธรรมเนียม/SLA ของบริการ (จากตาราง services ที่ admin แก้ได้) */
function feeText(svc) {
  if (!svc) return '';
  if (svc.id === 'SV-01') return `${fmtMoney(svc.fee)} ต่อฉบับ (1–5 ฉบับ)`;
  if (svc.id === 'SV-02') return `${fmtMoney(svc.fee)} คงที่`;
  return `${fmtMoney(svc.fee)} (1–100 ตร.ม.) + ${fmtMoney(svc.fee_per_sqm)} ต่อ ตร.ม. ส่วนเกิน 100 (สูงสุด 500 ตร.ม.)`;
}

function serviceCards(services) {
  const items = services
    .map((s) => {
      const meta = SERVICES[s.id] || {};
      const docs = (meta.docs || []).map((d) => `${d.name}${d.required ? ' ✱' : ''}`).join(' · ');
      return `<li class="svc-card">
<span class="svc-icon" aria-hidden="true">${ICONS[s.id] || ICONS['SV-01']}</span>
<h3><span class="svc-code">${esc(s.id)}</span><br>${esc(meta.name || s.name)}</h3>
<p class="svc-fee">ค่าธรรมเนียม: ${esc(feeText(s))}</p>
<p class="svc-meta">ระยะเวลา ${esc(s.sla_days)} วันทำการ<br>เอกสาร: ${esc(docs)}</p>
<a class="btn btn-primary" data-testid="start-service-${esc(s.id)}" href="/citizen/new/${esc(s.id)}">ยื่นคำขอ ${esc(s.id)}</a>
</li>`;
    })
    .join('');
  return `<ul class="svc-list">${items}</ul>`;
}

function casesTable(cases) {
  if (!cases.length) return '<p class="empty">ยังไม่มีคำขอที่ยื่นแล้ว</p>';
  const rows = cases
    .map(
      (c) => `<tr data-testid="my-case-row" data-case-no="${esc(c.caseNo)}" data-status="${esc(c.status)}">
<td><a data-testid="row-case-no" href="/citizen/cases/${esc(c.caseNo)}">${esc(c.caseNo)}</a></td>
<td data-testid="row-service">${esc(serviceLabel(c.serviceId))}</td>
<td>${statusBadge(c.status, 'row-status')}</td>
<td>${timeTag(c.dueAt, 'row-due')}</td>
<td>${c.slaLevel ? levelBadge(c.slaLevel, 'row-sla-level') : '–'}</td>
</tr>`
    )
    .join('');
  return `<div class="table-wrap"><table>
<caption class="visually-hidden">คำขอของฉันที่ชำระเงินแล้ว (เรียงเลขคำขอล่าสุดก่อน)</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function draftsTable(drafts) {
  if (!drafts.length) return '<p class="empty">ไม่มีร่างหรือคำขอที่รอชำระเงิน</p>';
  const rows = drafts
    .map(
      (d) => `<tr data-testid="my-draft-row" data-draft-id="${esc(d.draftId)}" data-status="${esc(d.status)}">
<td data-testid="row-draft-id">${esc(d.draftId)}</td>
<td data-testid="row-service">${esc(serviceLabel(d.serviceId))}</td>
<td>${statusBadge(d.status, 'row-status')}</td>
<td>${esc(fmtMoney(d.fee))}</td>
<td><div class="actions"><a class="btn" data-testid="open-draft-btn" href="/citizen/new/${esc(d.serviceId)}?draft=${esc(d.draftId)}">เปิดร่าง ${esc(d.draftId)}</a>
<button type="button" class="btn btn-danger" data-testid="delete-draft-btn" data-draft-id="${esc(d.draftId)}">ลบร่าง ${esc(d.draftId)}</button></div></td>
</tr>`
    )
    .join('');
  return `<div class="table-wrap"><table>
<caption class="visually-hidden">ร่างและคำขอที่รอชำระเงิน (ยังไม่มีเลขคำขอ)</caption>
<thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

const SCRIPT = `<script>
(function(){
  document.addEventListener('click', function(ev){
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-testid="delete-draft-btn"]') : null;
    if (!b) return;
    var id = b.getAttribute('data-draft-id');
    if (!window.confirm('ลบร่าง ' + id + ' ? (ลบแล้วกู้คืนไม่ได้)')) return;
    b.disabled = true;
    App.api('DELETE', '/api/drafts/' + encodeURIComponent(id)).then(function(r){
      if (r.ok) { window.location.reload(); return; }
      b.disabled = false;
      App.showError((r.data && r.data.message) || 'ลบร่างไม่สำเร็จ');
    });
  });
})();
</script>`;

/**
 * @param {object} o
 * @param {{name:string}} o.user
 * @param {Array<{id,fee,fee_per_sqm,sla_days,name}>} o.services
 * @param {Array<{caseNo,serviceId,status,dueAt,slaLevel}>} o.cases
 * @param {Array<{draftId,serviceId,status,fee}>} o.drafts
 * @returns {{title:string, body:string, head:string, scripts:string}}
 */
function renderHome(o) {
  const body = `<h1 data-testid="citizen-welcome">สวัสดี ${esc(o.user.name || '')}</h1>
<p class="home-lead">ยื่นคำขอ ติดตามสถานะ และดาวน์โหลดเอกสารดิจิทัลได้จากหน้านี้</p>
<section class="home-section" aria-labelledby="svc-heading">
<h2 id="svc-heading">เริ่มยื่นคำขอ</h2>
${serviceCards(o.services)}
</section>
<section class="home-section" aria-labelledby="drafts-heading">
<h2 id="drafts-heading">ร่างและรอชำระเงิน</h2>
${draftsTable(o.drafts)}
</section>
<section class="home-section" aria-labelledby="cases-heading">
<h2 id="cases-heading">คำขอของฉัน</h2>
${casesTable(o.cases)}
</section>`;
  return { title: 'คำขอของฉัน', body, head: PAGE_CSS, scripts: SCRIPT };
}

module.exports = { renderHome, feeText };
