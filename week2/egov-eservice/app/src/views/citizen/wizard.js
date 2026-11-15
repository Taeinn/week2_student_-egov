'use strict';
/**
 * หน้า /citizen/new/:service (บล็อก B05) · ขั้นตอนยื่น 3 ขั้น · CONTRACT §2.5 · NFR-01..03
 *
 * ขั้น 1 กรอกข้อมูล: qty-input (SV-01 ค่าตั้งต้น 1) / area-input (SV-03) · fee-total (คำนวณทันทีทุกครั้งที่พิมพ์)
 *        fee-error · save-draft-btn · draft-id · to-upload-btn (disabled เมื่อค่าไม่ถูกต้อง)
 * ขั้น 2 แนบเอกสาร: upload-input-<docKey> · file-item (+ file-remove-btn) · upload-error · missing-docs · to-payment-btn
 * ขั้น 3 ชำระเงิน: payment-amount · create-qr-btn · qr-image · qr-ref · qr-expires · payment-status · qr-expired-msg
 *        regenerate-qr-btn · refresh-payment-btn · submitted-case-no · receipt-no · receipt-amount · receipt-paid-at · go-case-btn
 *
 * ค่าธรรมเนียมบนจอคิดจากตาราง feeTable ที่เซิร์ฟเวอร์คำนวณด้วย rules.feeFor (ค่าที่ admin แก้ + BUG_MODE) → จอกับ API ตรงกันเสมอ
 */

const { esc, fmtMoney } = require('../../lib/format');

const PAGE_CSS = `<style>
.wizard-step{display:inline-block;font-weight:700;background:#e9eef7;color:var(--navy-dark);border-radius:999px;padding:2px 12px;margin:0 0 12px}
.wizard section[hidden]{display:none}
.fee-line{font-size:1.15rem}
.fee-line strong{font-size:1.3rem}
.file-list{list-style:none;margin:0;padding:0}
.file-list li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:0 0 6px;background:#fff}
.upload-grid input[type=file]{width:100%}
.qr{margin:0 0 12px;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.qr img{width:200px;height:200px;border:1px solid var(--border);background:#fff}
.receipt dl,.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0 0 12px}
.receipt dt,.kv dt{font-weight:600}
.receipt dd,.kv dd{margin:0}
.pay-PENDING{background:#fff4cc;color:#5c4400;border-color:#e5c95c}
.pay-PAID{background:#e3f4e8;color:#1d5e33;border-color:#9ccfaa}
.pay-EXPIRED{background:#fde2e1;color:#8a1c1c;border-color:#eba9a7}
</style>`;

/** ฝัง JSON ใน <script type="application/json"> อย่างปลอดภัย */
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function step1Html(o) {
  const locked = o.draft && o.draft.status !== 'DRAFT';
  const ro = locked ? ' readonly aria-readonly="true"' : '';
  let input = '';
  if (o.service.id === 'SV-01') {
    input = `<div class="form-row">
<label for="qty-input">จำนวนฉบับ (1–5 ฉบับ · ฉบับละ ${esc(fmtMoney(o.unitFee))})</label>
<input type="number" id="qty-input" name="qty" data-testid="qty-input" inputmode="numeric" min="1" max="5" step="1" value="${esc(o.initialValue)}" required${ro}>
</div>`;
  } else if (o.service.id === 'SV-03') {
    input = `<div class="form-row">
<label for="area-input">พื้นที่ก่อสร้าง/ต่อเติม (ตร.ม. จำนวนเต็ม 1–500)</label>
<input type="number" id="area-input" name="areaSqm" data-testid="area-input" inputmode="numeric" min="1" max="500" step="1" value="${esc(o.initialValue)}" required${ro}>
</div>`;
  } else {
    input = '<p class="muted">บริการนี้มีค่าธรรมเนียมคงที่ ไม่ต้องกรอกข้อมูลเพิ่ม</p>';
  }
  const draftId = o.draft ? o.draft.draftId : '';
  return `<section id="step-1" aria-labelledby="step-1-h">
<h2 id="step-1-h" tabindex="-1">ขั้นที่ 1 กรอกข้อมูล</h2>
${input}
${locked ? '<p class="muted">ยอดค่าธรรมเนียมถูกล็อกแล้วเมื่อสร้าง QR (แก้ข้อมูลไม่ได้)</p>' : ''}
<p class="fee-line">ค่าธรรมเนียม: <strong data-testid="fee-total" id="fee-total" aria-live="polite">${esc(o.initialFeeText)}</strong></p>
<div id="fee-error-box" aria-live="assertive"></div>
<p id="draft-box"${draftId ? '' : ' hidden'}>รหัสร่าง: <strong data-testid="draft-id" id="draft-id">${esc(draftId)}</strong></p>
<div class="row">
<button type="button" class="btn" data-testid="save-draft-btn" id="save-draft-btn"${locked ? ' disabled' : ''}>บันทึกร่าง</button>
<button type="button" class="btn btn-primary" data-testid="to-upload-btn" id="to-upload-btn">ถัดไป: แนบเอกสาร</button>
</div>
</section>`;
}

function step2Html(o) {
  const inputs = o.docs
    .map((d) => {
      const req = d.required ? ' <span aria-hidden="true">✱</span><span class="visually-hidden">(จำเป็น)</span>' : ' <span class="muted">(ไม่บังคับ)</span>';
      const note = d.pdfOnly ? ' <span class="muted">(PDF เท่านั้น)</span>' : '';
      return `<div class="form-row">
<label for="up-${esc(d.key)}">${esc(d.name)}${req}${note}</label>
<input type="file" id="up-${esc(d.key)}" name="${esc(d.key)}" data-testid="upload-input-${esc(d.key)}" data-doc-key="${esc(d.key)}" aria-describedby="upload-hint">
</div>`;
    })
    .join('');
  return `<section id="step-2" aria-labelledby="step-2-h" hidden>
<h2 id="step-2-h" tabindex="-1">ขั้นที่ 2 แนบเอกสาร</h2>
<p id="upload-hint" class="muted">ไฟล์ PDF, JPG หรือ PNG ขนาดไม่เกิน 5 MB ต่อไฟล์ แนบรวมได้สูงสุด 5 ไฟล์ต่อคำขอ (✱ = เอกสารที่ต้องแนบ)</p>
<div id="upload-error-box" aria-live="assertive"></div>
<div class="upload-grid">
${inputs}
<div class="form-row">
<label for="up-extra">เอกสารเพิ่มเติม <span class="muted">(ไม่บังคับ · เลือกได้หลายไฟล์)</span></label>
<input type="file" id="up-extra" name="extra" data-testid="upload-input-extra" data-doc-key="extra" multiple aria-describedby="upload-hint">
</div>
</div>
<h3 id="files-h">ไฟล์ที่แนบแล้ว</h3>
<ul class="file-list" id="file-list" aria-labelledby="files-h"></ul>
<div id="missing-box" aria-live="polite"></div>
<div class="row">
<button type="button" class="btn" id="back-to-1">ย้อนกลับ</button>
<button type="button" class="btn btn-primary" data-testid="to-payment-btn" id="to-payment-btn" disabled>ไปชำระเงิน</button>
</div>
</section>`;
}

function step3Html(o) {
  return `<section id="step-3" aria-labelledby="step-3-h" hidden>
<h2 id="step-3-h" tabindex="-1">ขั้นที่ 3 ชำระเงิน (PromptPay QR จำลอง)</h2>
<p class="fee-line">ยอดที่ต้องชำระ: <strong data-testid="payment-amount" id="payment-amount">${esc(o.amountText)}</strong></p>
<div id="payment-box" aria-live="polite"></div>
<div class="row"><button type="button" class="btn" id="back-to-2">ย้อนกลับ</button></div>
</section>`;
}

const CLIENT = `
(function(){
  var S = JSON.parse(document.getElementById('wizard-data').textContent);
  var TH_M = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var STEP_TEXT = {1:'1/3 กรอกข้อมูล', 2:'2/3 แนบเอกสาร', 3:'3/3 ชำระเงิน'};
  var PAY_TEXT = {PENDING:'รอชำระ', PAID:'ชำระแล้ว', EXPIRED:'QR หมดอายุ'};
  function tid(t){ return document.querySelector('[data-testid="' + t + '"]'); }
  function byId(i){ return document.getElementById(i); }
  function esc(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmtTh(iso){ var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(iso || ''); if (!m) return ''; return (+m[3]) + ' ' + TH_M[+m[2] - 1] + ' ' + (+m[1] + 543) + ' ' + m[4] + ':' + m[5]; }
  function timeTag(iso, testid, prefix){ if (!iso) return '<span data-testid="' + testid + '">–</span>'; return '<time data-testid="' + testid + '" data-iso="' + esc(iso) + '" datetime="' + esc(iso) + '">' + esc((prefix || '') + fmtTh(iso)) + '</time>'; }
  function errMsg(r, fallback){ return (r && r.data && r.data.message) || fallback || 'เกิดข้อผิดพลาด กรุณาลองใหม่'; }

  var st = {
    service: S.serviceId,
    draftId: S.draft ? S.draft.draftId : null,
    status: S.draft ? S.draft.status : 'DRAFT',
    files: S.draft ? S.draft.files.slice() : [],
    payment: S.draft ? S.draft.payment : null,
    amount: S.amount,
    saved: S.draft ? S.draft.inputValue : null,
    step: 1,
    pending: null
  };

  // ---------------- ขั้น 1: ค่าธรรมเนียม ----------------
  var feeInput = tid('qty-input') || tid('area-input');
  function rawValue(){ return feeInput ? String(feeInput.value).trim() : ''; }
  function evalFee(){
    if (!feeInput) return { ok: true, fee: S.fixedFee, value: null };
    var raw = rawValue();
    if (/^[+-]?\\d+(\\.\\d+)?$/.test(raw)) {
      var n = Number(raw);
      if (Number.isInteger(n) && Object.prototype.hasOwnProperty.call(S.feeTable, String(n))) return { ok: true, fee: S.feeTable[String(n)], value: n };
      if (S.serviceId === 'SV-03' && n > S.areaMax) return { ok: false, msg: S.msg.AREA_TOO_LARGE };
    }
    return { ok: false, msg: S.serviceId === 'SV-01' ? S.msg.INVALID_QTY : S.msg.INVALID_AREA };
  }
  function renderFee(){
    var r = evalFee();
    tid('fee-total').textContent = r.ok ? App.fmtMoney(r.fee) : '\\u2013';
    var box = byId('fee-error-box');
    var cur = tid('fee-error');
    if (r.ok) {
      if (cur) cur.parentNode.removeChild(cur);
      if (feeInput) { feeInput.removeAttribute('aria-invalid'); feeInput.removeAttribute('aria-describedby'); }
    } else {
      if (!cur) { cur = document.createElement('p'); cur.id = 'fee-error'; cur.className = 'field-error'; cur.setAttribute('data-testid', 'fee-error'); box.appendChild(cur); }
      cur.textContent = r.msg;
      if (feeInput) { feeInput.setAttribute('aria-invalid', 'true'); feeInput.setAttribute('aria-describedby', 'fee-error'); }
    }
    byId('to-upload-btn').disabled = !r.ok;
    if (st.status === 'DRAFT' && r.ok) st.amount = r.fee;
    return r;
  }
  if (feeInput) { feeInput.addEventListener('input', renderFee); feeInput.addEventListener('change', renderFee); }

  function setDraftId(id){
    st.draftId = id;
    byId('draft-id').textContent = id;
    byId('draft-box').hidden = false;
    try { var u = new URL(window.location.href); u.searchParams.set('draft', id); window.history.replaceState(null, '', u.pathname + u.search); } catch (e) {}
  }

  /** สร้าง/บันทึกร่าง แล้วคืน Promise<draftId> (กันกดซ้ำด้วย promise เดียว) */
  function ensureDraft(forceSave){
    if (st.pending) return st.pending;
    if (st.draftId && st.status !== 'DRAFT') return Promise.resolve(st.draftId);
    var r = renderFee();
    if (!r.ok) return Promise.reject(new Error(r.msg));
    var body = {};
    if (S.serviceId === 'SV-01') body.qty = r.value;
    if (S.serviceId === 'SV-03') body.areaSqm = r.value;
    if (st.draftId && !forceSave && st.saved === r.value) return Promise.resolve(st.draftId);
    var req = st.draftId
      ? App.api('PATCH', '/api/drafts/' + encodeURIComponent(st.draftId), body)
      : App.api('POST', '/api/drafts', Object.assign({ serviceId: S.serviceId }, body));
    st.pending = req.then(function(res){
      st.pending = null;
      if (!res.ok) throw new Error(errMsg(res, 'บันทึกร่างไม่สำเร็จ'));
      if (res.data && res.data.draftId) setDraftId(res.data.draftId);
      if (res.data && typeof res.data.fee === 'number') st.amount = res.data.fee;
      st.saved = r.value;
      renderAmount();
      return st.draftId;
    }, function(e){ st.pending = null; throw e; });
    return st.pending;
  }

  byId('save-draft-btn').addEventListener('click', function(){
    ensureDraft(true).then(function(id){ App.showSuccess('บันทึกร่าง ' + id + ' แล้ว'); }, function(e){ App.showError(e.message); });
  });
  byId('to-upload-btn').addEventListener('click', function(){
    if (this.disabled) return;
    ensureDraft(false).then(function(){ App.clearFlash(); showStep(2, true); }, function(e){ App.showError(e.message); });
  });

  // ---------------- ขั้น 2: แนบเอกสาร ----------------
  function docName(key){ return S.docLabels[key] || key; }
  function clearUploadError(){ var e = tid('upload-error'); if (e) e.parentNode.removeChild(e); }
  function showUploadError(msg){
    var e = tid('upload-error');
    if (!e) { e = document.createElement('p'); e.className = 'alert alert-error'; e.setAttribute('role', 'alert'); e.setAttribute('data-testid', 'upload-error'); byId('upload-error-box').appendChild(e); }
    e.textContent = msg;
  }
  function missingDocs(){
    var have = {};
    st.files.forEach(function(f){ have[f.docKey] = true; });
    return S.requiredDocs.filter(function(d){ return !have[d.key]; }).map(function(d){ return d.name; });
  }
  function renderFiles(){
    var ul = byId('file-list');
    ul.innerHTML = st.files.map(function(f){
      return '<li data-testid="file-item" data-name="' + esc(f.name) + '" data-doc-key="' + esc(f.docKey) + '" data-file-id="' + esc(f.fileId) + '">'
        + '<span>' + esc(docName(f.docKey)) + ': ' + esc(f.name) + ' <span class="muted">(' + esc(Number(f.size).toLocaleString('en-US')) + ' ไบต์)</span></span>'
        + '<button type="button" class="btn btn-secondary" data-testid="file-remove-btn" data-file-id="' + esc(f.fileId) + '" aria-label="ลบไฟล์ ' + esc(f.name) + '">ลบ</button></li>';
    }).join('');
    var miss = missingDocs();
    var box = byId('missing-box');
    var cur = tid('missing-docs');
    if (miss.length) {
      if (!cur) { cur = document.createElement('p'); cur.className = 'alert alert-error'; cur.setAttribute('data-testid', 'missing-docs'); box.appendChild(cur); }
      cur.textContent = 'ยังขาดเอกสาร: ' + miss.join(', ');
    } else if (cur) { cur.parentNode.removeChild(cur); }
    byId('to-payment-btn').disabled = miss.length > 0;
  }
  function uploadOne(file, key){
    var fd = new FormData();
    fd.append('docKey', key);
    fd.append('file', file, file.name);
    return App.api('POST', '/api/drafts/' + encodeURIComponent(st.draftId) + '/files', fd);
  }
  function handleFiles(input){
    var key = input.getAttribute('data-doc-key');
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    clearUploadError();
    App.clearFlash();
    var chain = ensureDraft(false);
    files.forEach(function(file){
      chain = chain.then(function(){
        return uploadOne(file, key).then(function(res){
          if (!res.ok) throw new Error(errMsg(res, 'แนบไฟล์ไม่สำเร็จ'));
          st.files.push(res.data);
          renderFiles();
        });
      });
    });
    chain.catch(function(e){ showUploadError(e.message); }).then(function(){
      try { input.value = ''; } catch (e) {}
      renderFiles();
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('#step-2 input[type=file]'), function(inp){
    inp.addEventListener('change', function(){ handleFiles(inp); });
  });
  byId('file-list').addEventListener('click', function(ev){
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-testid="file-remove-btn"]') : null;
    if (!b) return;
    var fileId = b.getAttribute('data-file-id');
    b.disabled = true;
    App.api('DELETE', '/api/drafts/' + encodeURIComponent(st.draftId) + '/files/' + encodeURIComponent(fileId)).then(function(res){
      if (!res.ok && res.status !== 404) { b.disabled = false; App.showError(errMsg(res, 'ลบไฟล์ไม่สำเร็จ')); return; }
      st.files = st.files.filter(function(f){ return f.fileId !== fileId; });
      if (res.data && res.data.paymentVoided && st.payment && st.payment.status === 'PENDING') st.payment.status = 'EXPIRED';
      renderFiles();
      byId('step-2-h').focus();
    });
  });
  byId('back-to-1').addEventListener('click', function(){ showStep(1, true); });
  byId('to-payment-btn').addEventListener('click', function(){
    if (this.disabled) return;
    App.clearFlash();
    showStep(3, true);
  });

  // ---------------- ขั้น 3: ชำระเงิน ----------------
  function renderAmount(){ byId('payment-amount').textContent = App.fmtMoney(st.amount); }
  function renderPayment(){
    renderAmount();
    var p = st.payment;
    var h = '';
    if (!p) {
      h = '<p>กด “สร้าง QR” เพื่อรับ QR พร้อมเพย์จำลอง (ใช้ได้ 15 นาที)</p>'
        + '<button type="button" class="btn btn-primary" data-testid="create-qr-btn" id="create-qr-btn">สร้าง QR</button>';
    } else {
      var s = p.status;
      h += '<p>สถานะการชำระ: <span data-testid="payment-status" data-status="' + esc(s) + '" class="badge pay-' + esc(s) + '">' + esc(PAY_TEXT[s] || s) + '</span></p>';
      if (s !== 'PAID') {
        h += '<div class="qr"><img data-testid="qr-image" src="/api/payments/' + encodeURIComponent(p.ref) + '/qr.svg" width="200" height="200" alt="QR พร้อมเพย์จำลอง เลขอ้างอิง ' + esc(p.ref) + ' ยอด ' + esc(App.fmtMoney(p.amount)) + '">'
          + '<p>เลขอ้างอิง <strong data-testid="qr-ref">' + esc(p.ref) + '</strong><br>' + timeTag(p.qrExpiresAt, 'qr-expires', 'หมดอายุ ') + '</p></div>';
      }
      if (s === 'EXPIRED') {
        h += '<p class="alert alert-error" data-testid="qr-expired-msg">QR หมดอายุ กรุณาสร้าง QR ใหม่</p>'
          + '<button type="button" class="btn btn-primary" data-testid="regenerate-qr-btn" id="regenerate-qr-btn">สร้าง QR ใหม่</button>';
      } else if (s === 'PENDING') {
        h += '<p class="muted">ชำระผ่านแอปธนาคารแล้วกด “ตรวจสอบการชำระเงิน”</p>'
          + '<button type="button" class="btn" data-testid="refresh-payment-btn" id="refresh-payment-btn">ตรวจสอบการชำระเงิน</button>';
      } else if (s === 'PAID') {
        h += '<div class="card receipt"><h3>ใบเสร็จรับเงิน (ส่งคำขอแล้ว)</h3><dl>'
          + '<dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">' + esc(p.caseNo) + '</dd>'
          + '<dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">' + esc(p.receiptNo) + '</dd>'
          + '<dt>ยอดชำระ</dt><dd data-testid="receipt-amount">' + esc(App.fmtMoney(p.paidAmount != null ? p.paidAmount : p.amount)) + '</dd>'
          + '<dt>ชำระเมื่อ</dt><dd>' + timeTag(p.paidAt, 'receipt-paid-at') + '</dd>'
          + '<dt>เลขอ้างอิง</dt><dd><span data-testid="qr-ref">' + esc(p.ref) + '</span></dd>'
          + '</dl><a class="btn btn-primary" data-testid="go-case-btn" href="/citizen/cases/' + encodeURIComponent(p.caseNo) + '">ดูคำขอ</a></div>';
      }
    }
    byId('payment-box').innerHTML = h;
    byId('back-to-2').hidden = !!(p && p.status === 'PAID');
  }
  function createQr(btn){
    if (btn) btn.disabled = true;
    App.clearFlash();
    ensureDraft(false).then(function(id){
      return App.api('POST', '/api/drafts/' + encodeURIComponent(id) + '/payment').then(function(res){
        if (!res.ok) {
          if (btn) btn.disabled = false;
          App.showError(errMsg(res, 'สร้าง QR ไม่สำเร็จ'));
          if (res.data && res.data.code === 'MISSING_DOCS') showStep(2, true);
          return;
        }
        st.status = 'PENDING_PAYMENT';
        st.amount = res.data.amount;
        st.payment = { ref: res.data.ref, amount: res.data.amount, status: 'PENDING', qrCreatedAt: res.data.qrCreatedAt, qrExpiresAt: res.data.qrExpiresAt, caseNo: null, receiptNo: null };
        lockInputs();
        renderPayment();
        var r = tid('qr-ref'); if (r) byId('step-3-h').focus();
      });
    }, function(e){ if (btn) btn.disabled = false; App.showError(e.message); });
  }
  function refreshPayment(btn){
    if (!st.payment) return;
    if (btn) btn.disabled = true;
    App.api('GET', '/api/payments/' + encodeURIComponent(st.payment.ref)).then(function(res){
      if (!res.ok) { if (btn) btn.disabled = false; App.showError(errMsg(res, 'ตรวจสอบการชำระเงินไม่สำเร็จ')); return; }
      st.payment = res.data;
      if (res.data.status === 'PAID') { st.status = 'SUBMITTED'; App.showSuccess('ชำระเงินสำเร็จ ได้เลขคำขอ ' + res.data.caseNo); }
      renderPayment();
      byId('step-3-h').focus();
    });
  }
  byId('payment-box').addEventListener('click', function(ev){
    var t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!t) return;
    var id = t.getAttribute('data-testid');
    if (id === 'create-qr-btn' || id === 'regenerate-qr-btn') createQr(t);
    else if (id === 'refresh-payment-btn') refreshPayment(t);
  });
  byId('back-to-2').addEventListener('click', function(){ showStep(2, true); });

  function lockInputs(){
    if (feeInput) { feeInput.readOnly = true; feeInput.setAttribute('aria-readonly', 'true'); }
    byId('save-draft-btn').disabled = true;
  }

  function showStep(n, focus){
    st.step = n;
    [1, 2, 3].forEach(function(i){ byId('step-' + i).hidden = (i !== n); });
    tid('wizard-step').textContent = STEP_TEXT[n];
    if (n === 2) renderFiles();
    if (n === 3) renderPayment();
    if (focus) { var h = byId('step-' + n + '-h'); if (h) h.focus(); }
  }

  if (st.status !== 'DRAFT') lockInputs();
  renderFee();
  renderFiles();
  showStep(S.initialStep, false);
})();
`;

/**
 * @param {object} o
 * @param {{id:string, name:string}} o.service
 * @param {Array<{key,name,required,pdfOnly}>} o.docs
 * @param {object|null} o.draft  {draftId,status,files,payment,inputValue}
 * @param {object} o.clientData  ข้อมูลที่ฝังให้สคริปต์ฝั่ง browser
 * @param {string|number} o.initialValue
 * @param {string} o.initialFeeText
 * @param {string} o.amountText
 * @param {number} o.unitFee
 * @returns {{title:string, body:string, head:string, scripts:string}}
 */
function renderWizard(o) {
  const step = o.clientData.initialStep;
  const stepText = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' }[step];
  const body = `<h1>ยื่นคำขอ: <span data-testid="service-name">${esc(o.service.name)}</span> <span class="muted">(${esc(o.service.id)})</span></h1>
<p class="wizard-step" data-testid="wizard-step" aria-live="polite">${esc(stepText)}</p>
<div class="wizard">
${step1Html(o)}
${step2Html(o)}
${step3Html(o)}
</div>
<p><a href="/citizen">กลับไปหน้าคำขอของฉัน</a></p>
<script type="application/json" id="wizard-data">${jsonForScript(o.clientData)}</script>`;
  return { title: `ยื่นคำขอ ${o.service.name}`, body, head: PAGE_CSS, scripts: `<script>${CLIENT}</script>` };
}

module.exports = { renderWizard };
