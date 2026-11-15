'use strict';
/**
 * ฝั่งประชาชน (บล็อก B05): ยื่นคำขอ · แนบไฟล์ · ชำระ QR · ติดตาม · ยกเลิก · ส่งแก้
 * REQUIREMENTS FR-04..FR-11 · BR-04..BR-11 BR-20 BR-22 · CONTRACT §2.4 §2.5 §2.6 §5 §6.2 §6.7 §8 (pay hook)
 *
 * หน้า
 *   GET  /citizen                          รายการคำขอ/ร่างของฉัน + เริ่มบริการ
 *   GET  /citizen/new/:service[?draft=DR-xxxx]   ขั้นตอนยื่น 3 ขั้น
 *   GET  /citizen/cases/:caseNo            รายละเอียดคำขอ (ของคนอื่น/ไม่มี → 404 not-found-msg)
 * API (CONTRACT §6.2)
 *   POST   /api/drafts                     {serviceId, qty?, areaSqm?} → 201 {draftId, fee}
 *   GET    /api/drafts · /api/drafts/:id
 *   PATCH  /api/drafts/:id                 {qty?, areaSqm?} (เฉพาะ DRAFT · ใช้โดยหน้าขั้นตอนยื่น)
 *   DELETE /api/drafts/:id                 204 (DRAFT/PENDING_PAYMENT) · ชำระแล้ว 409 INVALID_STATE
 *   POST   /api/drafts/:id/files           multipart file + docKey → 201 {fileId,name,docKey,size}
 *   DELETE /api/drafts/:id/files/:fileId   204
 *   POST   /api/drafts/:id/payment         201 {ref, amount, qrCreatedAt, qrExpiresAt} · 409 MISSING_DOCS
 *   GET    /api/payments/:ref              {ref, amount, status, qrCreatedAt, qrExpiresAt, caseNo, receiptNo, paidAt, paidAmount}
 *   GET    /api/payments/:ref/qr.svg       รูป QR จำลอง
 *   GET    /api/cases                      {items:[{caseNo, serviceId, status, dueAt, slaLevel}]} (ของฉันที่มีเลขแล้ว)
 *   GET    /api/cases/:caseNo              รูปแบบ §6.7 (citizen เจ้าของได้ idNo · บทบาทอื่นส่งต่อให้ officer.js ของ B06)
 *   POST   /api/cases/:caseNo/cancel       200 {status:"CANCELLED"} · 409 CANNOT_CANCEL
 *   POST   /api/cases/:caseNo/resubmit     200 {status:"IN_REVIEW", dueAt} · 409 FIX_WINDOW_EXPIRED / INVALID_STATE
 *   GET    /api/cases/:caseNo/files · GET /api/files/:fileId   (ส่วนของประชาชนเจ้าของ · บทบาทอื่นส่งต่อให้ route ถัดไป)
 * Test hook (TEST_MODE=1)
 *   POST   /api/test/payments/:ref/pay     {amount} → 200 {status:"PAID", caseNo, receiptNo, duplicate}
 *
 * บั๊ก: B02 (ขนาดไฟล์ <) ใน src/lib/upload.js · B05 (QR อายุ ≤ 15:00 ยังจ่ายได้) ในไฟล์นี้ · B06 (IDOR) ผ่าน rbac.canCitizenViewCase
 */

const express = require('express');
const QRCode = require('qrcode');

const db = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const rbac = require('../lib/rbac');
const pii = require('../lib/crypto');
const upload = require('../lib/upload');
const { isBug } = require('../lib/bugs');
const { sendError, ERRORS } = require('../lib/errors');
const { SERVICES, DOC_LABELS, STATUS_LABELS } = require('../lib/constants');
const fmt = require('../lib/format');
const layout = require('../views/layout');
const { renderHome } = require('../views/citizen/home');
const { renderWizard } = require('../views/citizen/wizard');
const { renderCase } = require('../views/citizen/case');
const docs = require('./documents');

const router = express.Router();

const requireCitizen = rbac.requireRole('citizen');

const DRAFT_ID_RE = /^DR-\d{4,}$/;
const CASE_NO_RE = /^EG-\d{4}-\d{6}$/;
const OPEN_DRAFT_STATUSES = ['DRAFT', 'PENDING_PAYMENT'];

// ---------------------------------------------------------------------------
// ตัวช่วยข้อมูล
// ---------------------------------------------------------------------------

const nowIso = () => clock.nowIso();

function serviceRow(id) {
  return db.prepare('SELECT id, name, fee, fee_per_sqm, sla_days FROM services WHERE id = ?').get(id) || null;
}

function allServices() {
  return db.prepare('SELECT id, name, fee, fee_per_sqm, sla_days FROM services ORDER BY sort, id').all();
}

function holidays() {
  return rules.holidayList(db);
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function caseByDraftId(draftId) {
  if (!DRAFT_ID_RE.test(String(draftId || ''))) return null;
  return db.prepare('SELECT * FROM cases WHERE draft_id = ?').get(draftId) || null;
}

function caseByNo(caseNo) {
  if (!CASE_NO_RE.test(String(caseNo || ''))) return null;
  return db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo) || null;
}

function userById(id) {
  if (id == null) return null;
  return db.prepare('SELECT id, username, name, role, dept, id_no_enc, id_masked FROM users WHERE id = ?').get(id) || null;
}

function usernameOf(id) {
  const u = userById(id);
  return u ? u.username || null : null;
}

function filesOfCase(caseId) {
  return db
    .prepare('SELECT file_id, doc_key, name, size, mime FROM attachments WHERE case_id = ? ORDER BY id')
    .all(caseId)
    .map((f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size }));
}

function countFiles(caseId) {
  return db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE case_id = ?').get(caseId).n;
}

/** เอกสารบังคับที่ยังขาด (ชื่อไทย เรียงตามตาราง CONTRACT §4.3) */
function missingDocs(serviceId, files) {
  const meta = SERVICES[serviceId];
  if (!meta) return [];
  const have = new Set(files.map((f) => f.docKey || f.doc_key));
  return meta.docs.filter((d) => d.required && !have.has(d.key)).map((d) => d.name);
}

/** อินพุตค่าธรรมเนียมของร่างที่เก็บไว้ */
function feeInputOf(row) {
  if (row.service_id === 'SV-01') return { qty: row.qty == null ? undefined : row.qty };
  if (row.service_id === 'SV-03') return { area: row.area_sqm };
  return {};
}

/** ยอดค่าธรรมเนียมปัจจุบันของร่าง: DRAFT = คำนวณใหม่จากค่าบริการล่าสุด · อื่น ๆ = ยอดที่ล็อกไว้ (A-42) */
function currentFee(row) {
  if (row.status !== 'DRAFT') return row.fee;
  const svc = serviceRow(row.service_id);
  const r = rules.feeFor(svc || row.service_id, feeInputOf(row));
  return r.ok ? r.fee : row.fee;
}

/** QR ยังใช้ชำระได้ ณ เวลา at · BR-10: อายุ < 15:00 · B05: อายุ ≤ 15:00 */
function qrUsable(createdAt, at) {
  if (!createdAt) return false;
  if (isBug('B05')) return rules.qrAgeMs(createdAt, at) <= rules.QR_TTL_MS;
  return rules.qrValid(createdAt, at);
}

/** สถานะที่แสดงของการชำระ: PAID · PENDING · EXPIRED (VOID = ถูกแทนด้วย QR ใหม่ → แสดงเป็นหมดอายุ) */
function paymentStatus(p) {
  if (p.status === 'PAID') return 'PAID';
  if (p.status === 'VOID') return 'EXPIRED';
  return qrUsable(p.qr_created_at, nowIso()) ? 'PENDING' : 'EXPIRED';
}

function paymentJson(p, caseRow) {
  const paid = p.status === 'PAID';
  return {
    ref: p.ref,
    amount: p.amount,
    status: paymentStatus(p),
    qrCreatedAt: p.qr_created_at || null,
    qrExpiresAt: p.qr_expires_at || (p.qr_created_at ? rules.qrExpiresAt(p.qr_created_at) : null),
    caseNo: paid && caseRow ? caseRow.case_no || null : null,
    receiptNo: paid ? p.receipt_no || null : null,
    paidAt: paid ? p.paid_at || null : null,
    paidAmount: paid ? p.paid_amount : null,
  };
}

function latestPayment(caseId) {
  return (
    db.prepare("SELECT * FROM payments WHERE case_id = ? AND ref IS NOT NULL ORDER BY id DESC LIMIT 1").get(caseId) || null
  );
}

function addEvent(caseId, at, type, actorId, fromStatus, toStatus, text, detail) {
  db.prepare(
    `INSERT INTO case_events (case_id, at, type, actor_id, from_status, to_status, step, text, detail)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(caseId, at, type, actorId == null ? null : actorId, fromStatus || null, toStatus || null, text || type, detail || '');
}

/** แถวตีกลับล่าสุด (case_returns) */
function latestReturn(caseId) {
  return db.prepare('SELECT * FROM case_returns WHERE case_id = ? ORDER BY seq DESC, id DESC LIMIT 1').get(caseId) || null;
}

/** เส้นตายแก้ไขของคำขอ NEED_FIX = เวลาตีกลับ + 168 ชม. */
function fixDeadlineOf(row) {
  if (row.fix_deadline) return row.fix_deadline;
  const returnedAt = row.returned_at || (latestReturn(row.id) || {}).returned_at;
  return returnedAt ? rules.fixDeadline(returnedAt) : null;
}

function decryptId(enc) {
  if (!enc) return null;
  try {
    return pii.decrypt(enc);
  } catch (_) {
    return null;
  }
}

function slaLevelOf(row) {
  if (!row.due_at && !['COMPLETED', 'REJECTED', 'CANCELLED', 'NEED_FIX'].includes(row.status)) return null;
  return rules.caseSlaLevel(row, nowIso(), holidays());
}

function documentOf(caseId) {
  return (
    db.prepare('SELECT doc_no, verify_code, valid_until, issued_at FROM documents WHERE case_id = ?').get(caseId) || null
  );
}

/** JSON คำขอ (CONTRACT §6.7) · forCitizen → idNo เต็ม · เจ้าหน้าที่ → idMasked เท่านั้น */
function caseJson(row, forCitizen) {
  const applicant = userById(row.applicant_id) || {};
  const doc = documentOf(row.id);
  const pay = db.prepare("SELECT receipt_no FROM payments WHERE case_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1").get(row.id);
  const out = {
    caseNo: row.case_no,
    serviceId: row.service_id,
    status: row.status,
    step: row.service_id === 'SV-03' && row.step != null ? row.step : null,
    fee: row.fee,
    paidAt: row.paid_at || null,
    dueAt: row.due_at || null,
    slaLevel: slaLevelOf(row),
    owner: usernameOf(row.owner_id),
    returnCount: row.return_count || 0,
    closedAt: row.closed_at || null,
    applicantName: applicant.name || null,
  };
  if (forCitizen) out.idNo = decryptId(applicant.id_no_enc);
  else out.idMasked = applicant.id_masked || fmt.maskId(decryptId(applicant.id_no_enc) || '');
  out.fixDeadline = row.status === 'NEED_FIX' ? fixDeadlineOf(row) : null;
  out.docNo = doc ? doc.doc_no : null;
  out.verifyCode = doc ? doc.verify_code : null;
  out.qty = row.service_id === 'SV-01' ? row.qty : null;
  out.areaSqm = row.service_id === 'SV-03' ? row.area_sqm : null;
  out.receiptNo = pay ? pay.receipt_no : null;
  out.cancelledAt = row.cancelled_at || null;
  return out;
}

function draftJson(row, withDetail) {
  const out = {
    draftId: row.draft_id,
    serviceId: row.service_id,
    status: row.status,
    fee: currentFee(row),
  };
  if (!withDetail) return out;
  const files = filesOfCase(row.id);
  const p = latestPayment(row.id);
  out.qty = row.service_id === 'SV-01' ? row.qty : null;
  out.areaSqm = row.service_id === 'SV-03' ? row.area_sqm : null;
  out.files = files;
  out.missing = missingDocs(row.service_id, files);
  out.payment = p ? paymentJson(p, row) : null;
  out.caseNo = row.case_no || null;
  return out;
}

/** ร่างของผู้ใช้ (ไม่ใช่เจ้าของ/ไม่มี → null) */
function ownDraft(req) {
  const row = caseByDraftId(req.params.id);
  if (!row || !rbac.isCaseOwner(req.user, row)) return null;
  return row;
}

/** ค่าธรรมเนียมจาก body ของ API (SV-01 qty · SV-03 areaSqm) */
function feeFromBody(svc, body) {
  const b = body && typeof body === 'object' ? body : {};
  const input = {};
  if (svc.id === 'SV-01') input.qty = b.qty !== undefined ? b.qty : b.quantity;
  if (svc.id === 'SV-03') input.area = b.areaSqm !== undefined ? b.areaSqm : b.area;
  return rules.feeFor(svc, input);
}

function isApi(req) {
  return rbac.isApiRequest(req);
}

// ---------------------------------------------------------------------------
// หน้า /citizen
// ---------------------------------------------------------------------------

router.get('/citizen', requireCitizen, (req, res) => {
  const now = nowIso();
  const hol = holidays();
  const cases = db
    .prepare('SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NOT NULL ORDER BY case_no DESC')
    .all(req.user.id)
    .map((r) => ({
      caseNo: r.case_no,
      serviceId: r.service_id,
      status: r.status,
      dueAt: r.due_at,
      slaLevel: rules.caseSlaLevel(r, now, hol),
    }));
  const drafts = db
    .prepare(
      `SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY draft_id`
    )
    .all(req.user.id)
    .map((r) => draftJson(r, false));
  const view = renderHome({ user: req.user, services: allServices(), cases, drafts });
  return layout.sendPage(req, res, view);
});

// ---------------------------------------------------------------------------
// หน้า /citizen/new/:service
// ---------------------------------------------------------------------------

router.get('/citizen/new/:service', requireCitizen, (req, res) => {
  const serviceId = String(req.params.service || '').toUpperCase();
  const meta = SERVICES[serviceId];
  const svc = meta && serviceRow(serviceId);
  if (!meta || !svc) {
    return layout.sendPage(req, res, {
      status: 404,
      title: 'ไม่พบบริการ',
      body: '<h1>ไม่พบบริการ</h1><p class="alert alert-error" data-testid="not-found-msg">ไม่พบบริการที่ต้องการ</p><p><a href="/citizen">กลับไปหน้าคำขอของฉัน</a></p>',
    });
  }

  let draft = null;
  if (req.query.draft !== undefined) {
    const row = caseByDraftId(String(req.query.draft));
    if (!row || !rbac.isCaseOwner(req.user, row)) return layout.sendNotFound(req, res);
    if (row.service_id !== serviceId) {
      return res.redirect(302, `/citizen/new/${row.service_id}?draft=${encodeURIComponent(row.draft_id)}`);
    }
    draft = row;
  }

  // ตาราง fee ที่คำนวณด้วยกฎกลาง (รวมค่าที่ admin แก้และ BUG_MODE) → จอกับ API ตรงกัน
  const feeTable = {};
  if (serviceId === 'SV-01') {
    for (let q = rules.QTY_MIN; q <= rules.QTY_MAX; q++) {
      const r = rules.feeFor(svc, { qty: q });
      if (r.ok) feeTable[String(q)] = r.fee;
    }
  } else if (serviceId === 'SV-03') {
    for (let a = rules.AREA_MIN; a <= rules.AREA_MAX; a++) {
      const r = rules.feeFor(svc, { area: a });
      if (r.ok) feeTable[String(a)] = r.fee;
    }
  }
  const fixedFee = serviceId === 'SV-02' ? rules.feeFor(svc, {}).fee : null;

  let initialValue = '';
  if (serviceId === 'SV-01') initialValue = draft && draft.qty != null ? draft.qty : rules.QTY_DEFAULT;
  if (serviceId === 'SV-03') initialValue = draft && draft.area_sqm != null ? draft.area_sqm : '';

  let draftData = null;
  let amount;
  let initialStep = 1;
  if (draft) {
    const d = draftJson(draft, true);
    draftData = {
      draftId: d.draftId,
      status: d.status,
      files: d.files,
      payment: d.payment,
      inputValue: serviceId === 'SV-01' ? draft.qty : serviceId === 'SV-03' ? draft.area_sqm : null,
    };
    amount = d.fee;
    if (draft.status !== 'DRAFT') initialStep = 3;
  } else if (serviceId === 'SV-02') {
    amount = fixedFee;
  } else if (serviceId === 'SV-01') {
    amount = feeTable[String(initialValue)];
  } else {
    amount = null;
  }

  // ข้อความ fee-total เริ่มต้น (ฝั่ง browser คำนวณซ้ำทันทีที่โหลด)
  let initialFee = null;
  if (serviceId === 'SV-02') initialFee = fixedFee;
  else if (feeTable[String(initialValue)] !== undefined) initialFee = feeTable[String(initialValue)];
  if (draft && draft.status !== 'DRAFT') initialFee = draft.fee;

  const docs = meta.docs.map((d) => ({ key: d.key, name: d.name, required: !!d.required, pdfOnly: !!d.pdfOnly }));
  const clientData = {
    serviceId,
    feeTable,
    fixedFee,
    areaMax: rules.AREA_MAX,
    msg: {
      INVALID_QTY: ERRORS.INVALID_QTY.message,
      INVALID_AREA: ERRORS.INVALID_AREA.message,
      AREA_TOO_LARGE: ERRORS.AREA_TOO_LARGE.message,
    },
    docLabels: DOC_LABELS,
    requiredDocs: docs.filter((d) => d.required).map((d) => ({ key: d.key, name: d.name })),
    draft: draftData,
    amount: amount == null ? null : amount,
    initialStep,
  };
  const view = renderWizard({
    service: { id: serviceId, name: meta.name },
    docs,
    draft: draftData,
    clientData,
    initialValue,
    initialFeeText: fmt.fmtMoney(initialFee),
    amountText: fmt.fmtMoney(amount),
    unitFee: svc.fee,
  });
  return layout.sendPage(req, res, view);
});

// ---------------------------------------------------------------------------
// หน้า /citizen/cases/:caseNo
// ---------------------------------------------------------------------------

router.get('/citizen/cases/:caseNo', requireCitizen, async (req, res, next) => {
  try {
    const row = caseByNo(req.params.caseNo);
    if (!row || !rbac.canCitizenViewCase(req.user, row)) return layout.sendNotFound(req, res);
    const j = caseJson(row, true);
    const applicant = userById(row.applicant_id) || {};

    // ไทม์ไลน์ (case_events) + รายการยกเลิกที่อนุมานได้ถ้ายังไม่มีเหตุการณ์ยกเลิก
    const events = db
      .prepare('SELECT at, type, text, to_status FROM case_events WHERE case_id = ? ORDER BY at, id')
      .all(row.id)
      .map((e) => ({ at: e.at, type: e.type, text: e.text || STATUS_LABELS[e.to_status] || e.type, toStatus: e.to_status }));
    if (row.status === 'CANCELLED' && row.cancelled_at && !events.some((e) => e.toStatus === 'CANCELLED')) {
      events.push({
        at: row.cancelled_at,
        type: row.cancel_reason === 'FIX_EXPIRED' ? 'AUTO_CANCEL' : 'CANCEL',
        text: row.cancel_reason === 'FIX_EXPIRED' ? 'ระบบยกเลิกอัตโนมัติ: เลยเวลาแก้ไข 168 ชั่วโมง' : 'ประชาชนยกเลิกคำขอ',
        toStatus: 'CANCELLED',
      });
      events.sort((a, b) => clock.toMs(a.at) - clock.toMs(b.at));
    }

    // ส่วนรอแก้ไข
    let fix = null;
    if (row.status === 'NEED_FIX') {
      const ret = latestReturn(row.id);
      const deadline = fixDeadlineOf(row);
      const open = !!deadline && clock.toMs(nowIso()) < clock.toMs(deadline);
      const meta = SERVICES[row.service_id];
      fix = {
        reason: ret ? ret.reason : '',
        deadline,
        open,
        docOptions: [...meta.docs.map((d) => ({ key: d.key, name: d.name })), { key: 'extra', name: DOC_LABELS.extra }],
      };
    }

    // เอกสารดิจิทัล: ใช้ส่วนแสดงผลกลางของ B07 (doc-no · verify-code · doc-qr · download-doc-btn)
    const docSectionHtml = docs.renderDocSection(req, row, { view: 'citizen' });

    const view = renderCase({
      ...j,
      showStep: ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL'].includes(row.status),
      applicantName: applicant.name || '',
      rejectReason: row.reject_reason || '',
      canCancel: row.status === 'SUBMITTED' && row.owner_id == null,
      fix,
      docSectionHtml,
      files: filesOfCase(row.id),
      timeline: events,
    });
    const done = String(req.query.done || '');
    const success = done === 'cancelled' ? 'ยกเลิกคำขอแล้ว' : done === 'resubmitted' ? 'ส่งแก้ไขแล้ว คำขอกลับไปที่ผู้ตรวจเดิม' : undefined;
    return layout.sendPage(req, res, { ...view, success });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// API: ร่าง
// ---------------------------------------------------------------------------

router.post('/api/drafts', requireCitizen, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const serviceId = String(body.serviceId || body.service || '').trim().toUpperCase();
  const svc = SERVICES[serviceId] ? serviceRow(serviceId) : null;
  if (!svc) return sendError(res, 'BAD_REQUEST');
  const r = feeFromBody(svc, body);
  if (!r.ok) return sendError(res, r.code);
  const now = nowIso();
  const out = db.tx(() => {
    const draftId = `DR-${pad(db.nextSeq('draft'), 4)}`;
    const info = db
      .prepare(
        `INSERT INTO cases (draft_id, service_id, applicant_id, status, qty, area_sqm, fee, created_at, updated_at)
         VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`
      )
      .run(draftId, serviceId, req.user.id, serviceId === 'SV-01' ? r.qty : null, serviceId === 'SV-03' ? r.area : null, r.fee, now, now);
    addEvent(Number(info.lastInsertRowid), now, 'CREATED', req.user.id, null, 'DRAFT', `สร้างร่างคำขอ ${draftId}`);
    return { draftId, fee: r.fee };
  });
  return res.status(201).json(out);
});

router.get('/api/drafts', requireCitizen, (req, res) => {
  const items = db
    .prepare(
      `SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY draft_id`
    )
    .all(req.user.id)
    .map((r) => draftJson(r, false));
  return res.json({ items });
});

router.get('/api/drafts/:id', requireCitizen, (req, res) => {
  const row = ownDraft(req);
  if (!row) return sendError(res, 'NOT_FOUND');
  return res.json(draftJson(row, true));
});

function updateDraft(req, res) {
  const row = ownDraft(req);
  if (!row) return sendError(res, 'NOT_FOUND');
  if (row.status !== 'DRAFT') return sendError(res, 'INVALID_STATE');
  const svc = serviceRow(row.service_id);
  const r = feeFromBody(svc, req.body);
  if (!r.ok) return sendError(res, r.code);
  db.prepare('UPDATE cases SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ? AND status = ?').run(
    row.service_id === 'SV-01' ? r.qty : null,
    row.service_id === 'SV-03' ? r.area : null,
    r.fee,
    nowIso(),
    row.id,
    'DRAFT'
  );
  return res.json({ draftId: row.draft_id, fee: r.fee, status: 'DRAFT' });
}
router.patch('/api/drafts/:id', requireCitizen, updateDraft);
router.put('/api/drafts/:id', requireCitizen, updateDraft);

router.delete('/api/drafts/:id', requireCitizen, (req, res) => {
  const row = ownDraft(req);
  if (!row) return sendError(res, 'NOT_FOUND');
  const result = db.tx(() => {
    const cur = db.prepare('SELECT status, case_no FROM cases WHERE id = ?').get(row.id);
    if (!cur || cur.case_no || !OPEN_DRAFT_STATUSES.includes(cur.status)) return 'INVALID_STATE';
    if (db.prepare("SELECT 1 FROM payments WHERE case_id = ? AND status = 'PAID'").get(row.id)) return 'INVALID_STATE';
    db.prepare('DELETE FROM payments WHERE case_id = ?').run(row.id);
    db.prepare('DELETE FROM attachments WHERE case_id = ?').run(row.id);
    db.prepare('DELETE FROM case_events WHERE case_id = ?').run(row.id);
    db.prepare('DELETE FROM notifications WHERE case_id = ?').run(row.id);
    db.prepare('DELETE FROM case_returns WHERE case_id = ?').run(row.id);
    db.prepare("DELETE FROM cases WHERE id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT')").run(row.id);
    return null;
  });
  if (result) return sendError(res, result);
  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// API: ไฟล์แนบของร่าง
// ---------------------------------------------------------------------------

router.post('/api/drafts/:id/files', requireCitizen, upload.accept(), (req, res) => {
  const row = ownDraft(req);
  if (!row) return sendError(res, 'NOT_FOUND');
  if (!OPEN_DRAFT_STATUSES.includes(row.status) || row.case_no) return sendError(res, 'INVALID_STATE');
  if (req.uploadError) return sendError(res, req.uploadError);
  const meta = SERVICES[row.service_id];
  const docKey = String((req.body && req.body.docKey) || 'extra').trim();
  const allowed = new Set([...meta.docs.map((d) => d.key), 'extra']);
  if (!allowed.has(docKey)) return sendError(res, 'BAD_REQUEST');
  const files = upload.filesOf(req);
  if (!files.length) return sendError(res, 'BAD_REQUEST');
  const file = files[0];

  const out = db.tx(() => {
    const err = upload.checkFile({
      size: file.size,
      buffer: file.buffer,
      docKey,
      existingCount: countFiles(row.id),
    });
    if (err) return { err };
    const kind = upload.detectType(file.buffer);
    const fileId = `F-${pad(db.nextSeq('file'), 6)}`;
    const name = upload.cleanName(file.originalname);
    db.prepare(
      `INSERT INTO attachments (file_id, case_id, doc_key, name, mime, size, data, round, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(fileId, row.id, docKey, name, upload.mimeOf(kind), file.size, file.buffer, req.user.id, nowIso());
    return { ok: { fileId, name, docKey, size: file.size } };
  });
  if (out.err) return sendError(res, out.err);
  return res.status(201).json(out.ok);
});

router.delete('/api/drafts/:id/files/:fileId', requireCitizen, (req, res) => {
  const row = ownDraft(req);
  if (!row) return sendError(res, 'NOT_FOUND');
  if (!OPEN_DRAFT_STATUSES.includes(row.status) || row.case_no) return sendError(res, 'INVALID_STATE');
  const out = db.tx(() => {
    const r = db.prepare('DELETE FROM attachments WHERE case_id = ? AND file_id = ?').run(row.id, String(req.params.fileId));
    if (r.changes !== 1) return { err: 'NOT_FOUND' };
    // รอชำระแล้วแต่เอกสารบังคับไม่ครบ → QR ที่ค้างใช้ไม่ได้ (ต้องแนบครบแล้วสร้าง QR ใหม่)
    let paymentVoided = false;
    if (row.status === 'PENDING_PAYMENT' && missingDocs(row.service_id, filesOfCase(row.id)).length) {
      paymentVoided = db.prepare("UPDATE payments SET status = 'VOID' WHERE case_id = ? AND status = 'PENDING'").run(row.id).changes > 0;
    }
    return { paymentVoided };
  });
  if (out.err) return sendError(res, out.err);
  if (out.paymentVoided) return res.status(200).json({ ok: true, paymentVoided: true });
  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// API: ชำระเงิน (QR จำลอง)
// ---------------------------------------------------------------------------

router.post('/api/drafts/:id/payment', requireCitizen, (req, res) => {
  const row = ownDraft(req);
  if (!row) return sendError(res, 'NOT_FOUND');
  const now = nowIso();
  const out = db.tx(() => {
    const cur = db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id);
    if (!cur || cur.case_no || !OPEN_DRAFT_STATUSES.includes(cur.status)) return { err: 'INVALID_STATE' };
    const missing = missingDocs(cur.service_id, filesOfCase(cur.id));
    if (missing.length) return { err: 'MISSING_DOCS', extra: { missing }, message: `ยังขาดเอกสาร: ${missing.join(', ')}` };
    let amount = cur.fee;
    if (cur.status === 'DRAFT') {
      // ยอดถูกล็อกตอนเข้า PENDING_PAYMENT (ใช้ค่าบริการ ณ ตอนนี้ · A-42)
      const r = rules.feeFor(serviceRow(cur.service_id) || cur.service_id, feeInputOf(cur));
      if (!r.ok) return { err: r.code };
      amount = r.fee;
      db.prepare(
        "UPDATE cases SET status = 'PENDING_PAYMENT', fee = ?, fee_locked_at = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'"
      ).run(amount, now, now, cur.id);
      addEvent(cur.id, now, 'QR', req.user.id, 'DRAFT', 'PENDING_PAYMENT', `สร้าง QR ชำระเงิน ยอด ${fmt.fmtMoney(amount)} (ล็อกยอด)`);
    }
    db.prepare("UPDATE payments SET status = 'VOID' WHERE case_id = ? AND status = 'PENDING'").run(cur.id);
    const ref = `PP-${pad(db.nextSeq('payref'), 4)}`;
    const expires = rules.qrExpiresAt(now);
    db.prepare(
      `INSERT INTO payments (ref, case_id, amount, status, qr_created_at, qr_expires_at, created_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(ref, cur.id, amount, now, expires, now);
    return { ok: { ref, amount, qrCreatedAt: now, qrExpiresAt: expires } };
  });
  if (out.err) return sendError(res, out.err, out.extra, out.message);
  return res.status(201).json(out.ok);
});

function ownPayment(req) {
  const p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(String(req.params.ref || ''));
  if (!p) return null;
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(p.case_id);
  if (!c || !rbac.isCaseOwner(req.user, c)) return null;
  return { p, c };
}

router.get('/api/payments/:ref', requireCitizen, (req, res) => {
  const found = ownPayment(req);
  if (!found) return sendError(res, 'NOT_FOUND');
  return res.json(paymentJson(found.p, found.c));
});

router.get('/api/payments/:ref/qr.svg', requireCitizen, async (req, res, next) => {
  try {
    const found = ownPayment(req);
    if (!found) return sendError(res, 'NOT_FOUND');
    const { p } = found;
    const payload = `MOCK-PROMPTPAY|ref=${p.ref}|amount=${Number(p.amount).toFixed(2)}|biller=EGOV-DEMO`;
    const svg = await QRCode.toString(payload, { type: 'svg', margin: 1, width: 200 });
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    return res.send(svg);
  } catch (err) {
    return next(err);
  }
});

/** test hook: ธนาคารจำลองแจ้งผลชำระ (CONTRACT §8) · idempotent · ออกเลขแบบ atomic */
router.post('/api/test/payments/:ref/pay', (req, res) => {
  if (!clock.isTestMode()) return sendError(res, 'NOT_FOUND');
  const ref = String(req.params.ref || '');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const out = db.tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref);
    if (!p) return { err: 'NOT_FOUND' };
    const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(p.case_id);
    if (!c) return { err: 'NOT_FOUND' };
    if (p.status === 'PAID') {
      return { ok: { status: 'PAID', caseNo: c.case_no, receiptNo: p.receipt_no, duplicate: true } };
    }
    const now = nowIso();
    if (p.status !== 'PENDING' || !qrUsable(p.qr_created_at, now)) return { err: 'QR_EXPIRED' };
    const raw = body.amount;
    const amount = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(amount) || amount !== Number(p.amount)) return { err: 'AMOUNT_MISMATCH' };
    if (c.status !== 'PENDING_PAYMENT' || c.case_no) return { err: 'INVALID_STATE' };

    const caseNo = rules.nextNumber(db, 'case', now);
    const receiptNo = rules.nextNumber(db, 'receipt', now);
    const svc = serviceRow(c.service_id);
    const dueAt = rules.computeDueAt(now, svc ? svc.sla_days : c.service_id, holidays());
    const upd = db
      .prepare(
        `UPDATE cases SET case_no = ?, status = 'SUBMITTED', paid_at = ?, due_at = ?, dept = 'registry', step = ?,
           owner_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'PENDING_PAYMENT' AND case_no IS NULL`
      )
      .run(caseNo, now, dueAt, c.service_id === 'SV-03' ? 1 : null, now, c.id);
    if (upd.changes !== 1) throw new Error('pay: สถานะคำขอเปลี่ยนระหว่างทำรายการ');
    db.prepare("UPDATE payments SET status = 'PAID', paid_at = ?, paid_amount = ?, receipt_no = ? WHERE id = ? AND status = 'PENDING'").run(
      now,
      amount,
      receiptNo,
      p.id
    );
    db.prepare("UPDATE payments SET status = 'VOID' WHERE case_id = ? AND id <> ? AND status = 'PENDING'").run(c.id, p.id);
    addEvent(c.id, now, 'PAID', c.applicant_id, 'PENDING_PAYMENT', 'SUBMITTED', `ชำระเงินสำเร็จ ${fmt.fmtMoney(amount)} · ใบเสร็จ ${receiptNo} · ได้เลขคำขอ ${caseNo}`);
    return { ok: { status: 'PAID', caseNo, receiptNo, duplicate: false } };
  });
  if (out.err) return sendError(res, out.err);
  return res.status(200).json(out.ok);
});

// ---------------------------------------------------------------------------
// API: คำขอ
// ---------------------------------------------------------------------------

router.get('/api/cases', requireCitizen, (req, res) => {
  const now = nowIso();
  const hol = holidays();
  const items = db
    .prepare('SELECT * FROM cases WHERE applicant_id = ? AND case_no IS NOT NULL ORDER BY case_no DESC')
    .all(req.user.id)
    .map((r) => ({
      caseNo: r.case_no,
      serviceId: r.service_id,
      status: r.status,
      dueAt: r.due_at || null,
      slaLevel: rules.caseSlaLevel(r, now, hol),
    }));
  return res.json({ items });
});

// เจ้าหน้าที่/หัวหน้า (และบทบาทอื่นที่ต้องได้ 403) ใช้ GET /api/cases/:caseNo ของ officer.js (B06) · ที่นี่ตอบเฉพาะประชาชน
router.get('/api/cases/:caseNo', citizenOnlyOrNext, (req, res) => {
  const row = caseByNo(req.params.caseNo);
  if (!row || !rbac.canCitizenViewCase(req.user, row)) return sendError(res, 'NOT_FOUND');
  return res.json(caseJson(row, true));
});

router.post('/api/cases/:caseNo/cancel', requireCitizen, (req, res) => {
  const row = caseByNo(req.params.caseNo);
  if (!row || !rbac.isCaseOwner(req.user, row)) return sendError(res, 'NOT_FOUND');
  const now = nowIso();
  const ok = db.tx(() => {
    const r = db
      .prepare(
        `UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = 'CITIZEN', dept = NULL, updated_at = ?
         WHERE id = ? AND status = 'SUBMITTED' AND owner_id IS NULL`
      )
      .run(now, now, row.id);
    if (r.changes !== 1) return false;
    addEvent(row.id, now, 'CANCEL', req.user.id, 'SUBMITTED', 'CANCELLED', 'ประชาชนยกเลิกคำขอ (ค่าธรรมเนียมที่ชำระแล้วไม่คืน)');
    return true;
  });
  if (!ok) return sendError(res, 'CANNOT_CANCEL');
  return res.json({ status: 'CANCELLED', cancelledAt: now });
});

router.post('/api/cases/:caseNo/resubmit', requireCitizen, upload.accept(), (req, res) => {
  // คำขอที่เลย 168 ชม. ถูก notify.js (B08) เปลี่ยนเป็น CANCELLED/FIX_EXPIRED ก่อนถึง route นี้แล้ว
  const row = caseByNo(req.params.caseNo);
  if (!row || !rbac.isCaseOwner(req.user, row)) return sendError(res, 'NOT_FOUND');
  if (row.status === 'CANCELLED' && row.cancel_reason === 'FIX_EXPIRED') return sendError(res, 'FIX_WINDOW_EXPIRED');
  if (row.status !== 'NEED_FIX') return sendError(res, 'INVALID_STATE');
  if (req.uploadError) return sendError(res, req.uploadError);

  const meta = SERVICES[row.service_id];
  const docKey = String((req.body && req.body.docKey) || 'extra').trim();
  const allowed = new Set([...meta.docs.map((d) => d.key), 'extra']);
  if (!allowed.has(docKey)) return sendError(res, 'BAD_REQUEST');
  const files = upload.filesOf(req);

  const now = nowIso();
  const out = db.tx(() => {
    const cur = db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id);
    if (!cur || cur.status !== 'NEED_FIX') return { err: 'INVALID_STATE' };
    const deadline = fixDeadlineOf(cur);
    if (deadline && !(clock.toMs(now) < clock.toMs(deadline))) return { err: 'FIX_WINDOW_EXPIRED' };

    // ตรวจไฟล์ใหม่ทั้งหมดก่อน (ไฟล์ที่ไม่ผ่านไม่ถูกเก็บ)
    let count = countFiles(cur.id);
    for (const f of files) {
      const err = upload.checkFile({ size: f.size, buffer: f.buffer, docKey, existingCount: count });
      if (err) return { err };
      count += 1;
    }

    const ret = latestReturn(cur.id);
    const returnedAt = cur.returned_at || (ret && ret.returned_at) || null;
    let dueAt = cur.due_at;
    let pausedDays = 0;
    if (returnedAt && cur.due_at) {
      const pd = rules.pauseDetail(cur.due_at, returnedAt, now, holidays());
      dueAt = pd.dueAt;
      pausedDays = pd.pausedDays;
    }
    const ownerId = cur.owner_id != null ? cur.owner_id : ret ? ret.returned_by : null;
    const upd = db
      .prepare(
        `UPDATE cases SET status = 'IN_REVIEW', due_at = ?, owner_id = ?, fix_deadline = NULL, updated_at = ?
         WHERE id = ? AND status = 'NEED_FIX'`
      )
      .run(dueAt, ownerId, now, cur.id);
    if (upd.changes !== 1) return { err: 'INVALID_STATE' };
    if (ret && !ret.resubmitted_at) {
      db.prepare('UPDATE case_returns SET resubmitted_at = ?, paused_days = ? WHERE id = ?').run(now, pausedDays, ret.id);
    }
    const round = cur.return_count || (ret ? ret.seq : 1) || 1;
    for (const f of files) {
      const kind = upload.detectType(f.buffer);
      db.prepare(
        `INSERT INTO attachments (file_id, case_id, doc_key, name, mime, size, data, round, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`F-${pad(db.nextSeq('file'), 6)}`, cur.id, docKey, upload.cleanName(f.originalname), upload.mimeOf(kind), f.size, f.buffer, round, req.user.id, now);
    }
    const extra = files.length ? ` · แนบไฟล์ใหม่ ${files.length} ไฟล์` : '';
    addEvent(cur.id, now, 'RESUBMIT', req.user.id, 'NEED_FIX', 'IN_REVIEW', `ประชาชนส่งแก้ไขเอกสาร (หยุดนับ ${pausedDays} วันทำการ)${extra}`);
    return { ok: { status: 'IN_REVIEW', dueAt } };
  });
  if (out.err) return sendError(res, out.err);
  return res.json(out.ok);
});

// ---------------------------------------------------------------------------
// ไฟล์แนบของคำขอ (ส่วนของประชาชน · CONTRACT §6.2 / BR-29: ของคนอื่น 404)
// บทบาทอื่น (officer/head/executive/auditor/admin) ส่งต่อให้ route ของบล็อกเจ้าหน้าที่ด้วย next()
// ---------------------------------------------------------------------------

function citizenOnlyOrNext(req, res, next) {
  if (req.user && req.user.role === 'citizen') return requireCitizen(req, res, next);
  if (!req.user) return rbac.denyUnauthenticated(req, res);
  return next('route');
}

router.get('/api/cases/:caseNo/files', citizenOnlyOrNext, (req, res) => {
  const row = caseByNo(req.params.caseNo);
  if (!row || !rbac.isCaseOwner(req.user, row)) return sendError(res, 'NOT_FOUND');
  return res.json({ items: filesOfCase(row.id) });
});

router.get('/api/files/:fileId', citizenOnlyOrNext, (req, res) => {
  const f = db.prepare('SELECT * FROM attachments WHERE file_id = ?').get(String(req.params.fileId || ''));
  if (!f) return sendError(res, 'NOT_FOUND');
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(f.case_id);
  if (!c || !rbac.isCaseOwner(req.user, c)) return sendError(res, 'NOT_FOUND');
  res.set('Content-Type', f.mime || 'application/octet-stream');
  res.set('Content-Length', String(f.data ? f.data.length : 0));
  res.set('Content-Disposition', `attachment; filename="${String(f.name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  return res.send(f.data);
});

module.exports = router;
