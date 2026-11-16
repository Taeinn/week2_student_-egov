'use strict';
/**
 * B07 · เอกสารดิจิทัล: ออกเอกสาร · PDF · ลายเซ็น HMAC · /verify
 *
 * ที่มา: REQUIREMENTS FR-17 FR-18 BR-23 (A-22 A-23 A-27 A-43 A-54 A-63)
 *        CONTRACT §1 (/verify/:code) §2.6 (ส่วนเอกสาร) §2.13 §3 §6.2 (pdf) §6.3 (issue) §6.4 (verify) §6.8 (ISSUE) §8 (tamper)
 *        TEST-DATA §5 (DOC-2569-000001 · K7M2Q9XA)
 *
 * Endpoint ของไฟล์นี้:
 *   POST /api/officer/cases/:caseNo/issue      ผู้ออกเอกสาร (A-27) → 200 {docNo, verifyCode, status:'COMPLETED'} · 403 · 404 · 409 INVALID_STATE
 *   GET  /api/documents/:docNo/pdf             citizen เจ้าของ · officer · head → application/pdf · ของคนอื่น/ไม่มี → 404
 *   GET  /api/verify/:code                     ไม่ต้องล็อกอิน → 200 {result, ...} · 404 {result:'NOT_FOUND'}
 *   GET  /verify/:code                         หน้า HTML ไม่ต้องล็อกอิน (verify-result ...) · ไม่พบ → HTTP 404
 *   POST /api/test/documents/:docNo/tamper     (TEST_MODE · server.js กั้นให้แล้ว) แก้ applicant โดยไม่เซ็นใหม่
 *
 * ตัวช่วยสำหรับหน้าคำขอของบล็อกอื่น (B05 citizen / B06 officer) — require('./documents'):
 *   docs.docForCase(caseIdOrRow)               → แถว documents หรือ null
 *   docs.caseDocFields(caseIdOrRow)            → { docNo, verifyCode } (null ถ้ายังไม่ออก) สำหรับ JSON §6.7
 *   docs.canIssue(user, caseRow)               → true ถ้า user เป็นผู้ออกเอกสารของคำขอนี้และสถานะ APPROVED (ใช้ตัดสินใจ render issue-btn)
 *   docs.issueButtonHtml(user, caseRow)        → '<button data-testid="issue-btn">ออกเอกสาร</button>+script' หรือ '' (กดแล้ว reload)
 *   docs.renderDocSection(req, caseRow, { view: 'officer'|'citizen' })
 *                                              → HTML: doc-no · verify-code · doc-qr (data-url + QR SVG) · download-doc-btn (citizen)
 *   docs.verifyUrl(code, req)                  → '<BASE_URL>/verify/<code>'
 *   docs.maskApplicantName('สมชาย ใจดี')        → 'สมชาย ใ***'
 *   docs.evaluate(code, now?)                  → { result, doc }
 *
 * ลายเซ็นจำลอง (CONTRACT §3 · A-22): HMAC-SHA256(docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer) ด้วยคีย์ทดสอบ
 * ลำดับตรวจ (A-43): ไม่พบ → ลายเซ็นไม่ตรง (TAMPERED) → หมดอายุ (EXPIRED) → ถูกต้อง (VALID)
 */

const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const db = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const crypto = require('../lib/crypto');
const rbac = require('../lib/rbac');
const { sendError } = require('../lib/errors');
const { SERVICES } = require('../lib/constants');
const { esc, fmtDate, fmtDateTime, timeTag } = require('../lib/format');
const layout = require('../views/layout');

const router = express.Router();

// ---------------------------------------------------------------------------
// ค่าคงที่
// ---------------------------------------------------------------------------
const VERIFY_CODE_RE = /^[A-Z0-9]{8}$/;
const VERIFY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DOC_NO_RE = /^DOC-\d{4}-\d{6}$/;

const RESULT_TEXT = Object.freeze({
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
});

const THAI_FONT_CANDIDATES = [
  process.env.THAI_FONT_PATH,
  '/usr/share/fonts/truetype/tlwg/Garuda.ttf',
  '/usr/share/fonts/truetype/tlwg/Loma.ttf',
  '/usr/share/fonts/truetype/tlwg/Norasi.ttf',
].filter(Boolean);
const THAI_FONT_BOLD_CANDIDATES = [process.env.THAI_FONT_BOLD_PATH, '/usr/share/fonts/truetype/tlwg/Garuda-Bold.ttf'].filter(
  Boolean
);

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.statSync(p).isFile()) return p;
    } catch (_) {
      /* ไม่มีไฟล์ */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ตัวช่วยข้อมูล
// ---------------------------------------------------------------------------

/** 'SV-01 ขอหนังสือรับรอง' */
function serviceLabel(id) {
  return SERVICES[id] ? `${id} ${SERVICES[id].name}` : String(id || '');
}

/**
 * ปิดบังชื่อผู้ยื่น (BR-23 · A-54): ชื่อเต็ม + อักษรแรกของนามสกุล + '***'
 * 'สมชาย ใจดี' → 'สมชาย ใ***' · ไม่มีนามสกุล → 'สมชาย ***'
 */
function maskApplicantName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '***';
  if (parts.length === 1) return `${parts[0]} ***`;
  const surname = parts.slice(1).join(' ');
  return `${parts[0]} ${Array.from(surname)[0]}***`;
}

/** ฟิลด์ที่ลงนามตามลำดับ CONTRACT §3 */
function signedFields(d) {
  return [d.doc_no, d.case_no, d.applicant, d.service_id, d.issued_at, d.valid_until, d.signer];
}

function signatureValid(d) {
  return crypto.safeEqualHex(crypto.signFields(signedFields(d)), d.signature);
}

/** BASE_URL ของเว็บ (env BASE_URL ถ้าตั้ง ไม่งั้นใช้ host ของ request) ไม่มี / ท้าย */
function baseUrl(req) {
  const env = String(process.env.BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  if (req && typeof req.get === 'function' && req.get('host')) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

function verifyUrl(code, req) {
  return `${baseUrl(req)}/verify/${encodeURIComponent(code)}`;
}

function caseIdOf(caseIdOrRow) {
  if (caseIdOrRow && typeof caseIdOrRow === 'object') return caseIdOrRow.id;
  return caseIdOrRow;
}

function docForCase(caseIdOrRow) {
  const id = caseIdOf(caseIdOrRow);
  if (id == null) return null;
  return db.prepare('SELECT * FROM documents WHERE case_id = ?').get(id) || null;
}

function caseDocFields(caseIdOrRow) {
  const d = docForCase(caseIdOrRow);
  return { docNo: d ? d.doc_no : null, verifyCode: d ? d.verify_code : null };
}

function userById(id) {
  if (id == null) return null;
  return db.prepare('SELECT id, username, name, role, dept, active FROM users WHERE id = ?').get(id) || null;
}

/**
 * ผู้ออกเอกสารของคำขอ (A-27)
 *   SV-01: ผู้ถือเรื่องที่อนุมัติ (approver_id) · ถ้ายังไม่มี → owner_id → issuer_id
 *   SV-02/03: เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก (issuer_id) · ถ้าว่าง → ผู้ CLAIM ขั้นแรกจากไทม์ไลน์
 */
function issuerIdOf(c) {
  if (!c) return null;
  if (c.service_id === 'SV-01') {
    const approver = userById(c.approver_id);
    if (approver && approver.role === 'officer') return approver.id;
    return c.owner_id || c.issuer_id || null;
  }
  if (c.issuer_id) return c.issuer_id;
  const ev = db
    .prepare(
      `SELECT e.actor_id FROM case_events e JOIN users u ON u.id = e.actor_id
       WHERE e.case_id = ? AND e.type = 'CLAIM' AND u.role = 'officer' AND u.dept = 'registry'
       ORDER BY e.at, e.id LIMIT 1`
    )
    .get(c.id);
  return ev ? ev.actor_id : null;
}

function isIssuer(user, c) {
  if (!user || user.role !== 'officer' || user.id == null) return false;
  const issuer = issuerIdOf(c);
  return issuer != null && Number(issuer) === Number(user.id);
}

/** ปุ่มออกเอกสารแสดงได้หรือไม่ (APPROVED + ผู้ออกเอกสาร) */
function canIssue(user, c) {
  return !!c && c.status === 'APPROVED' && isIssuer(user, c) && !docForCase(c);
}

/** ชื่อผู้ลงนาม (DECISIONS §10 · A-27): SV-01 เจ้าหน้าที่ผู้อนุมัติ · SV-02/03 หัวหน้าผู้อนุมัติ */
function signerOf(c, issuerUser) {
  const approver = userById(c.approver_id);
  if (approver) return approver;
  if (c.service_id === 'SV-01') return issuerUser;
  return (
    db.prepare("SELECT id, username, name, role FROM users WHERE role = 'head' AND active = 1 ORDER BY id LIMIT 1").get() ||
    issuerUser
  );
}

function newVerifyCode() {
  const exists = db.prepare('SELECT 1 FROM documents WHERE verify_code = ?');
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) code += VERIFY_ALPHABET[nodeCrypto.randomInt(VERIFY_ALPHABET.length)];
    if (!exists.get(code)) return code;
  }
  throw new Error('documents: สร้างรหัสตรวจสอบไม่สำเร็จ');
}

/**
 * ผลตรวจเอกสารจากรหัส (A-43): NOT_FOUND → TAMPERED → EXPIRED → VALID
 * @returns {{result: 'VALID'|'EXPIRED'|'TAMPERED'|'NOT_FOUND', doc: object|null}}
 */
function evaluate(code, now = clock.now()) {
  const c = String(code || '').trim();
  const doc = c ? db.prepare('SELECT * FROM documents WHERE verify_code = ?').get(c) : null;
  if (!doc) return { result: 'NOT_FOUND', doc: null };
  if (!signatureValid(doc)) return { result: 'TAMPERED', doc };
  if (rules.docExpired(doc.valid_until, now)) return { result: 'EXPIRED', doc };
  return { result: 'VALID', doc };
}

function verifyJson(ev) {
  if (ev.result === 'NOT_FOUND' || ev.result === 'TAMPERED' || !ev.doc) return { result: ev.result };
  const d = ev.doc;
  return {
    result: ev.result,
    docNo: d.doc_no,
    applicantMasked: maskApplicantName(d.applicant),
    serviceId: d.service_id,
    issuedAt: clock.toIso(d.issued_at),
    validUntil: d.valid_until,
    signer: d.signer,
  };
}

// ---------------------------------------------------------------------------
// QR (สร้างแบบ synchronous จาก matrix ของ qrcode)
// ---------------------------------------------------------------------------
function qrMatrix(text) {
  const qr = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
  return qr.modules; // { size, get(row, col) }
}

/** <svg> ของ QR (ขอบ 4 โมดูล) */
function qrSvg(text, px = 168, label = 'QR ตรวจสอบเอกสาร') {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.size + quiet * 2;
  let d = '';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) if (m.get(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function drawQr(pdf, text, x, y, size) {
  const m = qrMatrix(text);
  const quiet = 2;
  const cell = size / (m.size + quiet * 2);
  pdf.save();
  pdf.rect(x, y, size, size).fill('#ffffff');
  pdf.fillColor('#000000');
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.get(r, c)) pdf.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell, cell);
    }
  }
  pdf.fill('#000000');
  pdf.restore();
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
/** บรรทัด ASCII ที่เครื่องอ่านได้ (CONTRACT §3 · A-63) */
function machineLine(d) {
  return `docNo=${d.doc_no} caseNo=${d.case_no} verify=${d.verify_code} validUntil=${d.valid_until}`;
}

function buildPdf(d, req) {
  // require ตอนใช้ (ไฟล์ route ยังโหลดได้แม้ pdfkit มีปัญหา)
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: { Title: d.doc_no, Subject: 'e-Service document', Producer: 'egov-eservice', Creator: 'egov-eservice' },
    });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const thai = firstExisting(THAI_FONT_CANDIDATES);
    const thaiBold = firstExisting(THAI_FONT_BOLD_CANDIDATES) || thai;
    let hasThai = false;
    try {
      if (thai) {
        pdf.registerFont('TH', thai);
        pdf.registerFont('TH-B', thaiBold);
        hasThai = true;
      }
    } catch (_) {
      hasThai = false;
    }
    const url = verifyUrl(d.verify_code, req);
    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;

    // ธีมเดียวกับเว็บ (DESIGN-visitor): แถบลาเวนเดอร์ · โลโก้ · กรอบเส้นบางมุมโค้ง · ข้อความรองสี Graphite
    const C = { carbon: '#181925', graphite: '#666666', fog: '#e8e8e8', linen: '#fafafa', action: '#5b4fe0', lavender: '#918df6' };
    pdf.save().rect(0, 0, pdf.page.width, 8).fill(C.action).restore();
    pdf.save().rect(pdf.page.width * 0.6, 0, pdf.page.width * 0.4, 8).fill(C.lavender).restore();
    const logo = path.join(__dirname, '..', '..', 'public', 'img', 'logo.png');
    let logoOk = false;
    try {
      if (fs.existsSync(logo)) { pdf.image(logo, left, 40, { width: 52, height: 52 }); logoOk = true; }
    } catch (_) { logoOk = false; }
    const headX = logoOk ? left + 66 : left;
    pdf.y = 44;

    if (hasThai) {
      pdf.fillColor(C.carbon).font('TH-B').fontSize(20).text('เทศบาลนครตัวอย่าง', headX, 42);
      pdf.fillColor(C.graphite).font('TH').fontSize(13).text('เอกสารดิจิทัล (ระบบ e-Service กลาง)', headX);
      pdf.y = 112;
      pdf.save().moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(1).strokeColor(C.fog).stroke().restore();
      pdf.moveDown(1);
      pdf.fillColor(C.carbon).font('TH-B').fontSize(22).text(serviceLabel(d.service_id), left, pdf.y, { width });
      pdf.moveDown(0.8);
      const boxTop = pdf.y;
      pdf.y = boxTop + 14;
      const rows = [
        ['เลขเอกสาร', d.doc_no],
        ['เลขคำขอ', d.case_no],
        ['ชื่อผู้ยื่น', d.applicant],
        ['บริการ', serviceLabel(d.service_id)],
        ['วันออกเอกสาร', fmtDateTime(d.issued_at)],
        ['ใช้ได้ถึง', fmtDate(d.valid_until)],
        ['ผู้ลงนาม', d.signer],
        ['รหัสตรวจสอบ', d.verify_code],
      ];
      const pad = 18;
      for (const [k, v] of rows) {
        const y = pdf.y;
        pdf.fillColor(C.graphite).font('TH').fontSize(13).text(k, left + pad, y, { width: 140 });
        pdf.fillColor(C.carbon).font('TH-B').fontSize(14).text(String(v), left + pad + 150, y, { width: width - 150 - pad * 2 });
        pdf.moveDown(0.35);
      }
      const boxH = pdf.y - boxTop + 10;
      pdf.save().roundedRect(left, boxTop, width, boxH, 14).lineWidth(1).strokeColor(C.fog).stroke().restore();
      pdf.y = boxTop + boxH + 18;
      pdf.fillColor(C.graphite).font('TH').fontSize(12).text(`ตรวจสอบความถูกต้องของเอกสารได้ที่ ${url}`, left, pdf.y, { width });
      pdf.text('ลายเซ็นดิจิทัลจำลอง (HMAC-SHA256) เพื่อการทดสอบ', { width });
      pdf.fillColor(C.carbon);
    } else {
      pdf.y = 112;
      // ไม่มีฟอนต์ไทย: ใช้ป้ายภาษาอังกฤษ (ข้อความไทยตรวจผ่านหน้า /verify · A-63)
      pdf.font('Helvetica-Bold').fontSize(18).text('Sample City Municipality - Digital Document', { align: 'center' });
      pdf.moveDown(1);
      pdf.font('Helvetica').fontSize(12);
      pdf.text(`Document No: ${d.doc_no}`);
      pdf.text(`Case No: ${d.case_no}`);
      pdf.text(`Service: ${d.service_id}`);
      pdf.text(`Issued: ${clock.toIso(d.issued_at)}`);
      pdf.text(`Valid until: ${d.valid_until}`);
      pdf.text(`Verify code: ${d.verify_code}`);
      pdf.text(`Verify at: ${url}`);
    }

    pdf.moveDown(0.8);
    const qrY = pdf.y;
    pdf.save().roundedRect(left - 6, qrY - 6, 140, 140, 12).lineWidth(1).strokeColor(C.fog).stroke().restore();
    drawQr(pdf, url, left, qrY, 128);
    pdf.y = qrY + 146;

    // บรรทัด ASCII ที่เครื่องอ่านได้ บรรทัดเดียว (ฟอนต์มาตรฐาน · ไม่ตัดบรรทัด)
    pdf.font('Courier').fontSize(8).fillColor('#000000');
    pdf.text(machineLine(d), left, pdf.y, { lineBreak: false });
    pdf.y += 14;
    pdf.font('Courier').fontSize(6).fillColor('#555555');
    pdf.text(`sig=${d.signature}`, left, pdf.y, { lineBreak: false });
    pdf.end();
  });
}

// ---------------------------------------------------------------------------
// หน้า /verify
// ---------------------------------------------------------------------------
function renderVerifyBody(ev, code) {
  const result = ev.result;
  const cls = result === 'VALID' ? 'alert-success' : 'alert-error';
  const head = `<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<p class="muted">รหัสตรวจสอบ: <code>${esc(code)}</code></p>
<p class="alert ${cls}" role="status"><strong data-testid="verify-result" data-result="${esc(result)}">${esc(RESULT_TEXT[result])}</strong></p>`;
  if (result !== 'VALID' && result !== 'EXPIRED') {
    const hint =
      result === 'TAMPERED'
        ? 'ข้อมูลในเอกสารไม่ตรงกับลายเซ็นดิจิทัล เอกสารนี้อาจถูกแก้ไข กรุณาติดต่อเทศบาล'
        : 'ไม่พบเอกสารที่มีรหัสตรวจสอบนี้ กรุณาตรวจสอบรหัสอีกครั้ง';
    return `<section class="card stack verify-card">${head}<p>${esc(hint)}</p></section>`;
  }
  const d = ev.doc;
  return `<section class="card stack verify-card">${head}
<div class="table-wrap"><table>
<caption class="visually-hidden">รายละเอียดเอกสาร</caption>
<tbody>
<tr><th scope="row">เลขเอกสาร</th><td data-testid="verify-doc-no">${esc(d.doc_no)}</td></tr>
<tr><th scope="row">ชื่อผู้ยื่น</th><td data-testid="verify-applicant">${esc(maskApplicantName(d.applicant))}</td></tr>
<tr><th scope="row">บริการ</th><td data-testid="verify-service">${esc(serviceLabel(d.service_id))}</td></tr>
<tr><th scope="row">วันออกเอกสาร</th><td>${timeTag(d.issued_at, 'verify-issued')}</td></tr>
<tr><th scope="row">ใช้ได้ถึง</th><td>${timeTag(d.valid_until, 'verify-expires', { dateOnly: true })}</td></tr>
<tr><th scope="row">ผู้ลงนาม</th><td data-testid="verify-signer">${esc(d.signer)}</td></tr>
</tbody></table></div>
${result === 'EXPIRED' ? '<p class="muted">เอกสารนี้พ้นวันสุดท้ายที่ใช้ได้แล้ว</p>' : ''}
</section>`;
}

// ---------------------------------------------------------------------------
// ส่วนเอกสารบนหน้าคำขอ (ให้ B05/B06 เรียก)
// ---------------------------------------------------------------------------
const ISSUE_SCRIPT = `<script>
(function(){
  var b=document.querySelector('[data-testid="issue-btn"]'); if(!b) return;
  b.addEventListener('click', async function(){
    b.disabled=true;
    var r=await App.api('POST','/api/officer/cases/'+encodeURIComponent(b.getAttribute('data-case-no'))+'/issue');
    if(r.ok){ location.reload(); return; }
    b.disabled=false; App.showError((r.data&&r.data.message)||'ออกเอกสารไม่สำเร็จ');
  });
})();
</script>`;

const DOWNLOAD_SCRIPT = `<script>
(function(){
  var a=document.querySelector('[data-testid="download-doc-btn"]'); if(!a) return;
  a.addEventListener('click', async function(e){
    if(!window.fetch||!window.URL||!URL.createObjectURL) return;
    e.preventDefault();
    try{
      var r=await fetch(a.getAttribute('href'),{credentials:'same-origin'});
      if(!r.ok){ App.showError('ดาวน์โหลดเอกสารไม่สำเร็จ'); return; }
      var blob=await r.blob(); var u=URL.createObjectURL(blob);
      var t=document.createElement('a'); t.href=u; t.download=a.getAttribute('data-file')||'document.pdf';
      document.body.appendChild(t); t.click(); t.remove(); setTimeout(function(){URL.revokeObjectURL(u);},10000);
    }catch(err){ App.showError('ดาวน์โหลดเอกสารไม่สำเร็จ'); }
  });
})();
</script>`;

/** ปุ่มออกเอกสาร (render เฉพาะเมื่อ canIssue) + script */
function issueButtonHtml(user, c) {
  if (!canIssue(user, c)) return '';
  return `<button type="button" class="btn btn-primary" data-testid="issue-btn" data-case-no="${esc(c.case_no)}">ออกเอกสาร</button>${ISSUE_SCRIPT}`;
}

/**
 * ส่วนแสดงเอกสารบนหน้าคำขอ: doc-no · verify-code · doc-qr · download-doc-btn (citizen)
 * ยังไม่ออกเอกสาร → '' · opts.view = 'citizen' | 'officer' (ค่าเริ่มต้นดูจาก req.user.role)
 */
function renderDocSection(req, c, opts = {}) {
  const d = docForCase(c);
  if (!d) return '';
  const view = opts.view || (req && req.user && req.user.role === 'citizen' ? 'citizen' : 'officer');
  const url = verifyUrl(d.verify_code, req);
  const href = `/api/documents/${encodeURIComponent(d.doc_no)}/pdf`;
  const download =
    view === 'citizen'
      ? `<p><a class="btn btn-primary" data-testid="download-doc-btn" href="${esc(href)}" data-file="${esc(d.doc_no)}.pdf" download="${esc(d.doc_no)}.pdf">ดาวน์โหลดเอกสาร</a></p>${DOWNLOAD_SCRIPT}`
      : `<p><a class="btn btn-secondary" href="${esc(href)}" download="${esc(d.doc_no)}.pdf">เปิดไฟล์ PDF</a></p>`;
  return `<section class="card stack" aria-labelledby="doc-heading">
<h2 id="doc-heading">เอกสารดิจิทัล</h2>
<div class="doc-body">
<dl class="kv">
<div><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(d.doc_no)}</dd></div>
<div><dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(d.verify_code)}</dd></div>
<div><dt>วันออกเอกสาร</dt><dd>${timeTag(d.issued_at)}</dd></div>
<div><dt>ใช้ได้ถึง</dt><dd>${timeTag(d.valid_until, null, { dateOnly: true })}</dd></div>
<div><dt>ผู้ลงนาม</dt><dd>${esc(d.signer)}</dd></div>
</dl>
<figure data-testid="doc-qr" data-url="${esc(url)}">${qrSvg(url)}<figcaption>สแกนเพื่อตรวจสอบ: <a href="/verify/${esc(encodeURIComponent(d.verify_code))}">${esc(url)}</a></figcaption></figure>
</div>
</div>
${download}
</section>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** POST /api/officer/cases/:caseNo/issue (CONTRACT §6.3 · A-27) */
router.post('/api/officer/cases/:caseNo/issue', rbac.requireLogin, (req, res, next) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'officer') return sendError(res, 'FORBIDDEN');
    const caseNo = String(req.params.caseNo || '');
    const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
    if (!c) return sendError(res, 'NOT_FOUND');
    if (!isIssuer(user, c)) return sendError(res, 'FORBIDDEN');
    if (c.status !== 'APPROVED' || docForCase(c)) return sendError(res, 'INVALID_STATE');

    const out = db.tx(() => {
      const cur = db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id);
      if (!cur || cur.status !== 'APPROVED' || docForCase(cur)) return null;
      const nowIso = clock.nowIso();
      const applicantRow = userById(cur.applicant_id);
      const issuerUser = userById(user.id) || user;
      const signer = signerOf(cur, issuerUser);
      const d = {
        doc_no: rules.nextNumber(db, 'doc', nowIso),
        case_no: cur.case_no,
        verify_code: newVerifyCode(),
        applicant: (applicantRow && applicantRow.name) || '',
        service_id: cur.service_id,
        issued_at: nowIso,
        valid_until: rules.docValidUntil(cur.service_id, nowIso),
        signer: (signer && signer.name) || '',
      };
      d.signature = crypto.signFields(signedFields(d));
      db.prepare(
        `INSERT INTO documents (doc_no, case_id, case_no, verify_code, applicant, service_id, issued_at, valid_until, signer, signer_id, issued_by, signature)
         VALUES (@doc_no, @case_id, @case_no, @verify_code, @applicant, @service_id, @issued_at, @valid_until, @signer, @signer_id, @issued_by, @signature)`
      ).run({ ...d, case_id: cur.id, signer_id: signer ? signer.id : null, issued_by: user.id });
      const upd = db
        .prepare(
          `UPDATE cases SET status = 'COMPLETED', closed_at = @now, dept = NULL, owner_id = NULL, updated_at = @now
           WHERE id = @id AND status = 'APPROVED'`
        )
        .run({ id: cur.id, now: nowIso });
      if (upd.changes !== 1) throw new Error('documents: อัปเดตสถานะคำขอไม่สำเร็จ');
      db.prepare(
        `INSERT INTO case_events (case_id, at, type, actor_id, from_status, to_status, step, text, detail)
         VALUES (?, ?, 'ISSUE', ?, 'APPROVED', 'COMPLETED', ?, ?, ?)`
      ).run(cur.id, nowIso, user.id, cur.step, `ออกเอกสาร ${d.doc_no}`, d.doc_no);
      db.appendAudit({
        user,
        event: 'ISSUE',
        caseNo: cur.case_no,
        fromStatus: 'APPROVED',
        toStatus: 'COMPLETED',
        detail: d.doc_no,
        at: nowIso,
      });
      return d;
    });
    if (!out) return sendError(res, 'INVALID_STATE');
    return res.status(200).json({ docNo: out.doc_no, verifyCode: out.verify_code, status: 'COMPLETED' });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/documents/:docNo/pdf (CONTRACT §3 §6.2) */
router.get('/api/documents/:docNo/pdf', rbac.requireRole('citizen', 'officer', 'head'), async (req, res, next) => {
  try {
    const docNo = String(req.params.docNo || '');
    const d = DOC_NO_RE.test(docNo) ? db.prepare('SELECT * FROM documents WHERE doc_no = ?').get(docNo) : null;
    if (!d) return sendError(res, 'NOT_FOUND');
    if (req.user.role === 'citizen') {
      const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(d.case_id);
      if (!c || !rbac.isCaseOwner(req.user, c)) return sendError(res, 'NOT_FOUND');
    }
    const buf = await buildPdf(d, req);
    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${d.doc_no}.pdf"`);
    res.set('Content-Length', String(buf.length));
    res.set('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (err) {
    return next(err);
  }
});

/** GET /api/verify/:code (CONTRACT §6.4 · ไม่ต้องล็อกอิน) */
router.get('/api/verify/:code', (req, res) => {
  const ev = evaluate(req.params.code);
  res.set('Cache-Control', 'no-store');
  return res.status(ev.result === 'NOT_FOUND' ? 404 : 200).json(verifyJson(ev));
});

/** GET /verify/:code (CONTRACT §1 §2.13 · ไม่ต้องล็อกอิน · ไม่พบ → HTTP 404) */
router.get('/verify/:code', (req, res) => {
  const code = String(req.params.code || '');
  const ev = evaluate(code);
  return layout.sendPage(req, res, {
    status: ev.result === 'NOT_FOUND' ? 404 : 200,
    title: 'ตรวจสอบเอกสาร',
    body: renderVerifyBody(ev, code),
  });
});

/** POST /api/test/documents/:docNo/tamper (CONTRACT §8 · TEST_MODE กั้นที่ server.js) */
router.post('/api/test/documents/:docNo/tamper', (req, res) => {
  const docNo = String(req.params.docNo || '');
  const d = db.prepare('SELECT id, applicant FROM documents WHERE doc_no = ?').get(docNo);
  if (!d) return sendError(res, 'NOT_FOUND');
  // แก้ฟิลด์ที่ลงนาม (applicant) โดยไม่คำนวณลายเซ็นใหม่ → /verify ได้ TAMPERED
  db.prepare('UPDATE documents SET applicant = ? WHERE id = ?').run(`${d.applicant} (แก้ไข)`, d.id);
  return res.status(200).json({ ok: true });
});

module.exports = router;
// ตัวช่วยให้หน้าคำขอของบล็อกอื่นใช้ (แนบกับ router: server.js ยัง mount เป็น router ตามปกติ)
Object.assign(module.exports, {
  RESULT_TEXT,
  VERIFY_CODE_RE,
  maskApplicantName,
  signedFields,
  signatureValid,
  evaluate,
  verifyJson,
  verifyUrl,
  baseUrl,
  docForCase,
  caseDocFields,
  issuerIdOf,
  isIssuer,
  canIssue,
  issueButtonHtml,
  renderDocSection,
  qrSvg,
  machineLine,
  buildPdf,
});
