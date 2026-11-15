'use strict';
/**
 * หน้า /citizen/cases/:caseNo (บล็อก B05) · CONTRACT §2.6 (ฝั่งประชาชน)
 *   case-no · case-status · case-service · case-step (SV-03) · case-fee · sla-due · sla-level · case-timeline/timeline-item
 *   closed-at · case-id-full · doc-item/doc-download-link · (doc-no · verify-code · doc-qr · download-doc-btn มาจาก
 *   documents.renderDocSection ของ B07 ผ่าน c.docSectionHtml)
 *   cancel-case-btn (+ cancel-confirm-text · confirm-cancel-btn) · return-reason-display · fix-deadline
 *   fix-upload-input · submit-fix-btn · no-refund-note
 */

const { esc, fmtMoney, timeTag, serviceLabel, formatIdFull } = require('../../lib/format');
const { statusBadge, levelBadge } = require('../layout');
const { SV03_STEP_LABELS, DOC_LABELS } = require('../../lib/constants');

const NO_REFUND = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน';

const PAGE_CSS = `<style>
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}
.kv dt{font-weight:600}
.kv dd{margin:0;min-width:0}
@media (max-width:480px){.kv{grid-template-columns:1fr}.kv dd{margin:0 0 6px}}
.timeline{list-style:none;margin:0;padding:0;border-left:3px solid var(--border)}
.timeline li{margin:0 0 8px;padding:0 0 0 12px}
.timeline time{font-weight:600;margin-right:6px}
.doc-list{list-style:none;margin:0;padding:0}
.doc-list li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:0 0 6px;background:#fff}
dialog{border:2px solid var(--navy);border-radius:8px;max-width:min(92vw,480px);padding:16px}
dialog::backdrop{background:rgba(0,0,0,.45)}
.fix-form input[type=file]{width:100%}
</style>`;

function kv(label, valueHtml) {
  return `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>`;
}

function inputSummary(c) {
  if (c.serviceId === 'SV-01' && c.qty != null) return `${esc(c.qty)} ฉบับ`;
  if (c.serviceId === 'SV-03' && c.areaSqm != null) return `${esc(c.areaSqm)} ตร.ม.`;
  return '';
}

function timelineHtml(items) {
  if (!items.length) return '<p class="muted">ยังไม่มีเหตุการณ์</p>';
  const lis = items
    .map(
      (t) => `<li data-testid="timeline-item" data-iso="${esc(t.at)}" data-type="${esc(t.type)}">${timeTag(t.at)}<span>${esc(t.text)}</span></li>`
    )
    .join('');
  return `<ol class="timeline" data-testid="case-timeline">${lis}</ol>`;
}

function filesHtml(files) {
  if (!files.length) return '<p class="muted">ไม่มีไฟล์แนบ</p>';
  const lis = files
    .map(
      (f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.fileId)}" data-doc-key="${esc(f.docKey)}">
<span>${esc(DOC_LABELS[f.docKey] || f.docKey)}: ${esc(f.name)}</span>
<a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.fileId)}" download="${esc(f.name)}">ดาวน์โหลด ${esc(f.name)}</a>
</li>`
    )
    .join('');
  return `<ul class="doc-list">${lis}</ul>`;
}

function fixHtml(c, fix) {
  if (c.status !== 'NEED_FIX' || !fix) return '';
  const deadline = `<p>ส่งแก้ไขได้ภายใน ${timeTag(fix.deadline, 'fix-deadline')}</p>`;
  const reason = `<p>เหตุผลที่ถูกตีกลับ: <strong data-testid="return-reason-display">${esc(fix.reason || '')}</strong></p>`;
  const form = fix.open
    ? `<form class="fix-form stack" id="fix-form" novalidate>
<div class="form-row">
<label for="fix-doc-key">ประเภทเอกสารที่แนบใหม่</label>
<select id="fix-doc-key" name="docKey">${fix.docOptions
        .map((d) => `<option value="${esc(d.key)}">${esc(d.name)}</option>`)
        .join('')}</select>
</div>
<div class="form-row">
<label for="fix-upload-input">แนบไฟล์ใหม่ (ไม่บังคับ · PDF/JPG/PNG ไม่เกิน 5 MB)</label>
<input type="file" id="fix-upload-input" name="file" data-testid="fix-upload-input" multiple>
</div>
<button type="submit" class="btn btn-primary" data-testid="submit-fix-btn" id="submit-fix-btn">ส่งแก้ไข</button>
</form>`
    : '<p class="alert alert-error">หมดเวลาแก้ไขแล้ว</p>';
  return `<section class="card" aria-labelledby="fix-h">
<h2 id="fix-h">รอแก้ไขเอกสาร</h2>
${reason}
${deadline}
${form}
</section>`;
}

function cancelHtml(c) {
  if (!c.canCancel) return '';
  return `<section class="card" aria-labelledby="cancel-h">
<h2 id="cancel-h">ยกเลิกคำขอ</h2>
<p class="muted">ยกเลิกได้เฉพาะคำขอที่ส่งแล้วและยังไม่มีเจ้าหน้าที่รับเรื่อง</p>
<button type="button" class="btn btn-danger" data-testid="cancel-case-btn" id="cancel-case-btn">ยกเลิกคำขอ</button>
<dialog id="cancel-dialog" aria-labelledby="cancel-dialog-h" aria-describedby="cancel-confirm-text">
<h3 id="cancel-dialog-h">ยืนยันการยกเลิกคำขอ ${esc(c.caseNo)}</h3>
<p data-testid="cancel-confirm-text" id="cancel-confirm-text">${esc(NO_REFUND)}</p>
<div class="row">
<button type="button" class="btn btn-danger" data-testid="confirm-cancel-btn" id="confirm-cancel-btn">ยืนยันยกเลิก</button>
<button type="button" class="btn" id="cancel-dialog-close">ไม่ยกเลิก</button>
</div>
</dialog>
</section>`;
}

function script(caseNo) {
  const cn = JSON.stringify(caseNo).replace(/</g, '\\u003c');
  return `<script>
(function(){
  var caseNo = ${cn};
  var base = '/citizen/cases/' + encodeURIComponent(caseNo);
  function msg(r, fb){ return (r && r.data && r.data.message) || fb; }
  var cbtn = document.getElementById('cancel-case-btn');
  var dlg = document.getElementById('cancel-dialog');
  if (cbtn && dlg) {
    var ok = document.getElementById('confirm-cancel-btn');
    cbtn.addEventListener('click', function(){ if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', ''); ok.focus(); });
    document.getElementById('cancel-dialog-close').addEventListener('click', function(){ if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); cbtn.focus(); });
    ok.addEventListener('click', function(){
      ok.disabled = true;
      App.api('POST', '/api/cases/' + encodeURIComponent(caseNo) + '/cancel').then(function(r){
        if (r.ok) { window.location.href = base + '?done=cancelled'; return; }
        ok.disabled = false;
        if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
        App.showError(msg(r, 'ยกเลิกคำขอไม่สำเร็จ'));
      });
    });
  }
  var form = document.getElementById('fix-form');
  if (form) {
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var btn = document.getElementById('submit-fix-btn');
      var input = document.getElementById('fix-upload-input');
      var fd = new FormData();
      fd.append('docKey', document.getElementById('fix-doc-key').value);
      Array.prototype.forEach.call(input.files || [], function(f){ fd.append('file', f, f.name); });
      btn.disabled = true;
      App.clearFlash();
      App.api('POST', '/api/cases/' + encodeURIComponent(caseNo) + '/resubmit', fd).then(function(r){
        if (r.ok) { window.location.href = base + '?done=resubmitted'; return; }
        btn.disabled = false;
        App.showError(msg(r, 'ส่งแก้ไขไม่สำเร็จ'));
      });
    });
  }
})();
</script>`;
}

/**
 * @param {object} c  ข้อมูลคำขอที่เตรียมแล้วจาก route
 * @returns {{title:string, body:string, head:string, scripts:string}}
 */
function renderCase(c) {
  const step = c.serviceId === 'SV-03' && c.step && SV03_STEP_LABELS[c.step] && c.showStep
    ? kv('ขั้นตอน', `<span data-testid="case-step">${esc(SV03_STEP_LABELS[c.step])}</span>`)
    : '';
  const summary = inputSummary(c);
  const closed = c.status === 'COMPLETED' || c.status === 'REJECTED' ? kv('ปิดงานเมื่อ', timeTag(c.closedAt, 'closed-at')) : '';
  const cancelled = c.status === 'CANCELLED' && c.cancelledAt ? kv('ยกเลิกเมื่อ', timeTag(c.cancelledAt, 'cancelled-at')) : '';
  const noRefund = c.status === 'REJECTED' || c.status === 'CANCELLED'
    ? `<p class="alert alert-error" data-testid="no-refund-note">${esc(NO_REFUND)}</p>`
    : '';
  const rejectReason = c.status === 'REJECTED' && c.rejectReason
    ? `<p>เหตุผลที่ไม่อนุมัติ: <strong data-testid="reject-reason-display">${esc(c.rejectReason)}</strong></p>`
    : '';

  const body = `<h1>คำขอ <span data-testid="case-no">${esc(c.caseNo)}</span></h1>
${noRefund}
<section class="card" aria-labelledby="case-h">
<h2 id="case-h">รายละเอียดคำขอ</h2>
<dl class="kv">
${kv('สถานะ', statusBadge(c.status, 'case-status'))}
${kv('บริการ', `<span data-testid="case-service">${esc(serviceLabel(c.serviceId))}</span>`)}
${step}
${summary ? kv('ข้อมูลที่กรอก', summary) : ''}
${kv('ค่าธรรมเนียม', `<span data-testid="case-fee">${esc(fmtMoney(c.fee))}</span>`)}
${kv('ผู้ยื่น', esc(c.applicantName || ''))}
${kv('เลขบัตรประชาชน', `<span data-testid="case-id-full">${esc(formatIdFull(c.idNo || ''))}</span>`)}
${kv('ชำระเงินเมื่อ', timeTag(c.paidAt, 'case-paid-at'))}
${c.receiptNo ? kv('เลขใบเสร็จ', `<span data-testid="case-receipt-no">${esc(c.receiptNo)}</span>`) : ''}
${kv('กำหนดเสร็จ', timeTag(c.dueAt, 'sla-due'))}
${kv('ระดับเตือน', c.slaLevel ? levelBadge(c.slaLevel, 'sla-level') : '–')}
${closed}
${cancelled}
</dl>
${rejectReason}
</section>
${fixHtml(c, c.fix)}
${c.docSectionHtml || ''}
<section class="card" aria-labelledby="files-h">
<h2 id="files-h">เอกสารแนบ</h2>
${filesHtml(c.files)}
</section>
<section class="card" aria-labelledby="timeline-h">
<h2 id="timeline-h">ไทม์ไลน์</h2>
${timelineHtml(c.timeline)}
</section>
${cancelHtml(c)}
<p><a href="/citizen">กลับไปหน้าคำขอของฉัน</a></p>`;
  return { title: `คำขอ ${c.caseNo}`, body, head: PAGE_CSS, scripts: script(c.caseNo) };
}

module.exports = { renderCase, NO_REFUND };
