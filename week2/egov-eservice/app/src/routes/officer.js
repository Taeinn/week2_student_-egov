'use strict';
/**
 * ฝั่งเจ้าหน้าที่ / หัวหน้า (บล็อก B06)
 *
 * ที่มา: REQUIREMENTS FR-12..16 FR-21 FR-29 · BR-16..19 BR-21 BR-24 BR-29 · A-19 A-20 A-27 A-28 A-29 A-32 A-34 A-39 A-40 A-59
 *        CONTRACT §2.6 §2.7 §2.8 §5 §6.2 (ไฟล์แนบ) §6.3 §6.7 §6.8 · BUGS.md B07 B08 B09 B11 B12
 *
 * หน้า
 *   GET  /officer/queue                       officer · head (อ่านอย่างเดียว)   คิวงาน (queue-filter all/unclaimed/mine)
 *   GET  /officer/cases/:caseNo               officer (ขอบเขตแผนก) · head        รายละเอียด + ปุ่มดำเนินการ
 *   GET  /head/approvals                      head                               รายการรออนุมัติ
 * API
 *   GET  /api/officer/queue?filter=all|unclaimed|mine                            ห้ามมี idNo / เลข 13 หลัก (B09 เปิดแล้วรั่ว)
 *   POST /api/officer/cases/:caseNo/claim      officer แผนกที่ถือเรื่อง            UPDATE แบบมีเงื่อนไขใน transaction (B08 ข้ามการตรวจผู้ถือ)
 *   POST /api/officer/cases/:caseNo/return     ผู้ถือเรื่อง {reason ≥ 10}          ≤ 2 ครั้ง (B12 ให้ครั้งที่ 3)
 *   POST /api/officer/cases/:caseNo/forward    ผู้ถือเรื่อง {note?}                เส้นทางอัตโนมัติตามบริการ
 *   POST /api/cases/:caseNo/approve            SV-01 ผู้ถือ · SV-02/03 head ที่ PENDING_APPROVAL (B07 ให้ officer อนุมัติ SV-02/03)
 *   POST /api/cases/:caseNo/reject             เหมือน approve {reason ≥ 10}
 *   POST /api/officer/cases/:caseNo/unmask     officer · head {reason ไม่ว่าง} + Audit UNMASK (B11 ไม่บันทึก)
 *   GET  /api/head/approvals                   head (JSON ของหน้า /head/approvals)
 *   GET  /api/cases/:caseNo                    (สำรอง) รูปแบบ §6.7 · staff ได้ idMasked เท่านั้น · citizen เจ้าของได้ idNo
 *   GET  /api/cases/:caseNo/files              ไฟล์แนบ (BR-29)
 *   GET  /api/files/:fileId                    เนื้อไฟล์ (BR-29)
 *   (ออกเอกสาร POST /api/officer/cases/:caseNo/issue อยู่ใน src/routes/documents.js ของ B07 · หน้านี้ใช้
 *    docs.issueButtonHtml / docs.renderDocSection ของ B07 แสดง issue-btn และ doc-no/verify-code/doc-qr)
 *
 * หน้า (browser): ปุ่มทั้งหมดใช้ event delegation · ทำรายการสำเร็จแล้ว "รีเฟรชในที่" (fetch หน้าเดิมแทน #officer-view)
 *   ไม่ใช้ location.reload() เพราะการ navigate ที่ค้างอยู่จะชนกับ page.goto ถัดไปของผู้ใช้/test
 *   doc-download-link ดาวน์โหลดด้วย fetch + blob (page.route ของ Playwright ดัก <a download>/แท็บใหม่ไม่ได้)
 *
 * ข้อตกลงข้อมูล (schema.sql ของ B01):
 *   cases.owner_id  = ผู้ถือเรื่องขั้นปัจจุบัน (IN_REVIEW/NEED_FIX) · ไม่มีผู้รับ/รออนุมัติ/APPROVED/ปิดแล้ว = NULL
 *   cases.dept      = แผนกของขั้นปัจจุบัน ('registry' / 'works' เมื่อ SV-03 ขั้น 2) · PENDING_APPROVAL/ปิดแล้ว = NULL
 *   cases.step      = 1..3 เฉพาะ SV-03
 *   cases.issuer_id = ผู้ออกเอกสาร (A-27): SV-02/03 = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก · SV-01 = ผู้ถือเรื่องที่อนุมัติ
 *   cases.approver_id = ผู้อนุมัติ/ไม่อนุมัติ (ผู้ลงนาม)
 */

const express = require('express');

const db = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const rbac = require('../lib/rbac');
const appCrypto = require('../lib/crypto');
const { isBug } = require('../lib/bugs');
const { sendError } = require('../lib/errors');
const { LIMITS, SV03_STEP_LABELS, DOC_LABELS, DEPT_LABELS } = require('../lib/constants');
const fmt = require('../lib/format');
const layout = require('../views/layout');

let QRCode = null;
try {
  // eslint-disable-next-line global-require
  QRCode = require('qrcode');
} catch (_) {
  QRCode = null;
}

// ตัวช่วยหน้าคำขอของ B07 (doc-no · verify-code · doc-qr · issue-btn ตาม A-27) · ถ้าโหลดไม่ได้ใช้ของไฟล์นี้แทน
let docs = null;
try {
  // eslint-disable-next-line global-require
  docs = require('./documents');
  if (typeof docs.renderDocSection !== 'function' || typeof docs.issueButtonHtml !== 'function') docs = null;
} catch (_) {
  docs = null;
}

const router = express.Router();

const { esc } = fmt;
const CASE_NO_RE = /^EG-\d{4}-\d{6}$/;
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];
const FILTERS = ['all', 'unclaimed', 'mine'];
const MAX_WORKLOAD = LIMITS.MAX_WORKLOAD; // 10
const MAX_RETURNS = LIMITS.MAX_RETURNS; // 2
const MIN_REASON_LEN = LIMITS.MIN_REASON_LEN; // 10

// ===========================================================================
// ตัวช่วยข้อมูล
// ===========================================================================

const CASE_SELECT = `
  SELECT c.*,
         a.name       AS applicant_name,
         a.id_masked  AS applicant_id_masked,
         o.username   AS owner_username,
         o.name       AS owner_name,
         i.username   AS issuer_username,
         p.username   AS approver_username
    FROM cases c
    JOIN users a      ON a.id = c.applicant_id
    LEFT JOIN users o ON o.id = c.owner_id
    LEFT JOIN users i ON i.id = c.issuer_id
    LEFT JOIN users p ON p.id = c.approver_id`;

function loadCase(caseNo) {
  if (typeof caseNo !== 'string' || !CASE_NO_RE.test(caseNo)) return null;
  return db.prepare(`${CASE_SELECT} WHERE c.case_no = ?`).get(caseNo) || null;
}

function reloadCaseById(id) {
  return db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) || null;
}

/** ขั้นตอนของ SV-03 (1 ทะเบียน · 2 โยธา · 3 หัวหน้า) · บริการอื่น null */
function svcStep(c) {
  if (!c || c.service_id !== 'SV-03') return null;
  const s = Number(c.step);
  if (s >= 1 && s <= 3) return s;
  if (['PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED'].includes(c.status)) return 3;
  return 1;
}

/** แผนกที่รับผิดชอบงานแผนกล่าสุดของคำขอ (ใช้ตรวจสิทธิ์รับเรื่อง/คิว) */
function stepDept(c) {
  return c.service_id === 'SV-03' && svcStep(c) === 2 ? 'works' : 'registry';
}

/** แผนกของขั้นปัจจุบันที่ทำให้คำขออยู่ในคิว (A-34) · ไม่อยู่ในคิวแผนก → null */
function queueDept(c) {
  if (['SUBMITTED', 'IN_REVIEW', 'NEED_FIX'].includes(c.status)) return stepDept(c);
  if (c.status === 'APPROVED') return 'registry'; // รอออกเอกสารโดยเจ้าหน้าที่ทะเบียน (A-27)
  return null;
}

/** เคยถึงขั้นของแผนกนี้แล้วหรือไม่ (A-59): ทะเบียน = ทุกใบที่ชำระแล้ว · โยธา = SV-03 ที่ถึงขั้น 2 แล้ว */
function reachedDept(c, dept) {
  if (!c || !c.case_no) return false;
  if (dept === 'registry') return true;
  if (dept === 'works') return c.service_id === 'SV-03' && svcStep(c) >= 2;
  return false;
}

/** เจ้าหน้าที่/หัวหน้าเปิดดูคำขอนี้ (หน้า/ไฟล์แนบ/unmask) ได้หรือไม่ (BR-29) */
function canStaffView(user, c) {
  if (!user || !c || !c.case_no) return false;
  if (user.role === 'head') return true;
  if (user.role === 'officer') return reachedDept(c, user.dept);
  return false;
}

function isOwner(user, c) {
  return !!user && !!c && c.owner_id != null && user.id != null && Number(c.owner_id) === Number(user.id);
}

function holidays() {
  try {
    return rules.holidayList(db);
  } catch (_) {
    return [];
  }
}

function slaLevelOf(c, hol) {
  try {
    return rules.caseSlaLevel(c, clock.now(), hol) || (c.status === 'NEED_FIX' ? 'paused' : 'normal');
  } catch (_) {
    return 'normal';
  }
}

/** เลขบัตรปิดบัง X-XXXX-XXXXX-45-6 (ไม่ถอดรหัสถ้ามีค่าที่เก็บไว้แล้ว) */
function maskedIdOf(c) {
  if (c.applicant_id_masked && /^X-XXXX-XXXXX-\d{2}-\d$/.test(c.applicant_id_masked)) return c.applicant_id_masked;
  return fmt.maskId(applicantIdNo(c.applicant_id) || '');
}

/** เลขบัตรเต็ม 13 หลักของผู้ยื่น (ถอดรหัส) — ใช้เฉพาะ unmask / ประชาชนเจ้าของ / BUG B09 */
function applicantIdNo(userId) {
  const row = db.prepare('SELECT id_no_enc FROM users WHERE id = ?').get(userId);
  if (!row || !row.id_no_enc) return null;
  const plain = appCrypto.decrypt(row.id_no_enc);
  return plain ? String(plain).replace(/\D/g, '') : null;
}

function workloadOf(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM cases WHERE owner_id = ? AND status = 'IN_REVIEW'").get(userId).n;
}

function reasonLength(raw) {
  return Array.from(String(raw == null ? '' : raw).trim()).length;
}

function addEvent(caseId, type, user, fromStatus, toStatus, text, detail, step, at) {
  db.prepare(
    `INSERT INTO case_events (case_id, at, type, actor_id, from_status, to_status, step, text, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(caseId, at, type, user && user.id != null ? user.id : null, fromStatus || null, toStatus || null,
    step == null ? null : step, text, detail == null ? '' : String(detail));
}

function documentOf(caseId) {
  try {
    return db.prepare('SELECT doc_no, verify_code, issued_at, valid_until, signer FROM documents WHERE case_id = ?').get(caseId) || null;
  } catch (_) {
    return null;
  }
}

function baseUrl(req) {
  const env = String(process.env.BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

/** JSON ของคำขอสำหรับเจ้าหน้าที่ (§6.7) · ห้ามมี idNo/เลขเต็มเด็ดขาด */
function staffCaseJson(c, hol) {
  const doc = documentOf(c.id);
  return {
    caseNo: c.case_no,
    serviceId: c.service_id,
    status: c.status,
    step: svcStep(c),
    fee: c.fee,
    qty: c.qty == null ? null : c.qty,
    areaSqm: c.area_sqm == null ? null : c.area_sqm,
    paidAt: fmt.isoOf(c.paid_at),
    dueAt: fmt.isoOf(c.due_at),
    slaLevel: slaLevelOf(c, hol),
    owner: c.owner_username || null,
    issuer: c.issuer_username || null,
    returnCount: c.return_count || 0,
    closedAt: fmt.isoOf(c.closed_at),
    applicantName: c.applicant_name,
    idMasked: maskedIdOf(c),
    fixDeadline: c.status === 'NEED_FIX' ? fmt.isoOf(c.fix_deadline) : null,
    docNo: doc ? doc.doc_no : null,
    verifyCode: doc ? doc.verify_code : null,
  };
}

/** JSON ของคำขอสำหรับประชาชนเจ้าของ (§6.7: ได้ idNo แทน idMasked) */
function citizenCaseJson(c, hol) {
  const out = staffCaseJson(c, hol);
  delete out.idMasked;
  delete out.issuer;
  out.idNo = applicantIdNo(c.applicant_id);
  return out;
}

/** ส่ง 403/404 ตามชนิด request */
const forbid = (req, res) => rbac.forbid(req, res);
const notFound = (req, res) => rbac.notFound(req, res);

// ===========================================================================
// สิทธิ์การกระทำ (ใช้ร่วมกันระหว่าง API และการแสดงปุ่ม)
// ===========================================================================

/** ปุ่ม claim: officer แผนกเดียวกับขั้นปัจจุบัน · SUBMITTED หรือ IN_REVIEW ที่ไม่มีผู้ถือ (แสดงแม้งานในมือครบ 10 → กดแล้วได้ 409) */
function canShowClaim(user, c) {
  return !!user && user.role === 'officer' && ['SUBMITTED', 'IN_REVIEW'].includes(c.status)
    && c.owner_id == null && user.dept === stepDept(c);
}

function returnLimitReached(c) {
  return (c.return_count || 0) >= MAX_RETURNS && !isBug('B12');
}

function canShowReturn(user, c) {
  return !!user && user.role === 'officer' && c.status === 'IN_REVIEW' && isOwner(user, c) && !returnLimitReached(c);
}

function canShowForward(user, c) {
  return !!user && user.role === 'officer' && c.status === 'IN_REVIEW' && isOwner(user, c)
    && (c.service_id === 'SV-02' || (c.service_id === 'SV-03' && svcStep(c) <= 2));
}

/** อนุมัติ/ไม่อนุมัติ (ตามหน้าจอ · ไม่รวมบั๊ก B07): SV-01 ผู้ถือเรื่อง IN_REVIEW · SV-02/03 head ที่ PENDING_APPROVAL */
function canShowDecide(user, c) {
  if (!user) return false;
  if (c.service_id === 'SV-01') return user.role === 'officer' && c.status === 'IN_REVIEW' && isOwner(user, c);
  return user.role === 'head' && c.status === 'PENDING_APPROVAL';
}

/** ออกเอกสาร (A-27): APPROVED และผู้ใช้คือผู้ออกเอกสาร (หัวหน้าไม่มีปุ่ม) */
function canShowIssue(user, c) {
  return !!user && user.role === 'officer' && c.status === 'APPROVED' && c.issuer_id != null
    && Number(c.issuer_id) === Number(user.id);
}

/**
 * ตรวจสิทธิ์อนุมัติ/ไม่อนุมัติที่ API → null (ผ่าน) หรือรหัส error
 * @param {'approve'|'reject'} action
 */
function decideError(user, c, action) {
  if (c.service_id === 'SV-01') {
    if (user.role !== 'officer' || !isOwner(user, c)) return 'FORBIDDEN'; // หัวหน้าไม่อนุมัติแทน SV-01 (A-28)
    if (c.status !== 'IN_REVIEW') return 'INVALID_STATE';
    return null;
  }
  // SV-02 / SV-03: ผู้ตัดสินคือ head ที่ขั้นรออนุมัติ
  if (user.role === 'head') {
    return c.status === 'PENDING_APPROVAL' ? null : 'INVALID_STATE';
  }
  if (action === 'approve' && isBug('B07') && user.role === 'officer') {
    // BUG B07: API อนุมัติไม่ตรวจว่าเป็นหัวหน้า (ปุ่มยังซ่อนอยู่)
    return ['PENDING_APPROVAL', 'IN_REVIEW'].includes(c.status) ? null : 'INVALID_STATE';
  }
  return 'FORBIDDEN';
}

// ===========================================================================
// การกระทำ (transaction · UPDATE แบบมีเงื่อนไข)
// ===========================================================================

/** รับเรื่อง · ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT (CONTRACT §6.3) */
function doClaim(user, caseNo) {
  return db.transaction(() => {
    const c = loadCase(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    const bug08 = isBug('B08');

    // 1) สิทธิ์: เจ้าหน้าที่ของแผนกที่ถือขั้นปัจจุบันเท่านั้น
    if (['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'CANCELLED'].includes(c.status)) {
      if (user.dept !== stepDept(c)) return { error: 'FORBIDDEN' };
    } else if (!canStaffView(user, c)) {
      return { error: 'FORBIDDEN' };
    }

    // 2) มีผู้ถือแล้ว (BUG B08: ข้ามการตรวจนี้สำหรับ IN_REVIEW → คนที่ 2 ได้ 200 และกลายเป็นผู้ถือแทน)
    if (c.owner_id != null && (c.status === 'NEED_FIX' || (c.status === 'IN_REVIEW' && !bug08))) {
      return { error: 'ALREADY_CLAIMED' };
    }
    if (!['SUBMITTED', 'IN_REVIEW'].includes(c.status)) return { error: 'INVALID_STATE' };

    // 3) เพดานงานในมือ (ตรวจเฉพาะตอนรับเรื่อง · A-19)
    if (workloadOf(user.id) >= MAX_WORKLOAD) return { error: 'WORKLOAD_LIMIT' };

    const now = clock.nowIso();
    const dept = stepDept(c);
    let step = c.step == null ? null : c.step;
    if (c.service_id === 'SV-03' && step == null) step = 1;
    const ownerCond = bug08 ? '' : ' AND owner_id IS NULL';
    const info = db
      .prepare(
        `UPDATE cases
            SET status = 'IN_REVIEW', owner_id = @me, dept = @dept, step = @step,
                issuer_id = CASE WHEN @registry = 1 THEN @me ELSE issuer_id END,
                updated_at = @now
          WHERE id = @id AND status IN ('SUBMITTED','IN_REVIEW')${ownerCond}`
      )
      .run({ me: user.id, dept, step, registry: dept === 'registry' ? 1 : 0, now, id: c.id });
    if (info.changes !== 1) {
      const fresh = reloadCaseById(c.id);
      if (fresh && fresh.owner_id != null) return { error: 'ALREADY_CLAIMED' };
      return { error: 'INVALID_STATE' };
    }
    const text = `เจ้าหน้าที่${DEPT_LABELS[dept] || ''}รับเรื่อง`;
    addEvent(c.id, 'CLAIM', user, c.status, 'IN_REVIEW', text, '', step, now);
    db.appendAudit({ user, event: 'CLAIM', caseNo: c.case_no, fromStatus: c.status, toStatus: 'IN_REVIEW', detail: '', at: now });
    return { ok: true, owner: user.username, status: 'IN_REVIEW', caseNo: c.case_no, step: svcStep({ ...c, step }) };
  })();
}

/** ตีกลับ · ผู้ถือเรื่องเท่านั้น · ≤ 2 ครั้ง (BUG B12 ให้ครั้งที่ 3) · เหตุผล ≥ 10 ตัวอักษรหลังตัดช่องว่าง */
function doReturn(user, caseNo, rawReason) {
  return db.transaction(() => {
    const c = loadCase(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    if (!isOwner(user, c)) return { error: 'FORBIDDEN' };
    if (c.status !== 'IN_REVIEW') return { error: 'INVALID_STATE' };
    if (returnLimitReached(c)) return { error: 'RETURN_LIMIT' };
    if (reasonLength(rawReason) < MIN_REASON_LEN) return { error: 'REASON_TOO_SHORT' };
    const reason = String(rawReason).trim();
    const now = clock.nowIso();
    const deadline = rules.fixDeadline(now);
    const limitCond = isBug('B12') ? '' : ` AND return_count < ${MAX_RETURNS}`;
    const info = db
      .prepare(
        `UPDATE cases
            SET status = 'NEED_FIX', return_count = return_count + 1, returned_at = @now,
                fix_deadline = @deadline, updated_at = @now
          WHERE id = @id AND status = 'IN_REVIEW' AND owner_id = @me${limitCond}`
      )
      .run({ now, deadline, id: c.id, me: user.id });
    if (info.changes !== 1) return { error: 'INVALID_STATE' };
    const seq = (c.return_count || 0) + 1;
    db.prepare(
      `INSERT INTO case_returns (case_id, seq, returned_at, returned_by, reason, fix_deadline, resubmitted_at, paused_days)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(c.id, seq, now, user.id, reason, deadline);
    addEvent(c.id, 'RETURN', user, 'IN_REVIEW', 'NEED_FIX', `ตีกลับให้แก้ไขเอกสาร (ครั้งที่ ${seq}): ${reason}`, reason, c.step, now);
    db.appendAudit({ user, event: 'RETURN', caseNo: c.case_no, fromStatus: 'IN_REVIEW', toStatus: 'NEED_FIX', detail: reason, at: now });
    return { ok: true, status: 'NEED_FIX', returnCount: seq, fixDeadline: deadline, caseNo: c.case_no };
  })();
}

/** ส่งต่ออัตโนมัติตามเส้นทางบริการ (ไม่มีช่องเลือกปลายทาง · FR-15) */
function doForward(user, caseNo, rawNote) {
  return db.transaction(() => {
    const c = loadCase(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    if (!isOwner(user, c)) return { error: 'FORBIDDEN' };
    if (c.status !== 'IN_REVIEW') return { error: 'INVALID_STATE' };
    const note = String(rawNote == null ? '' : rawNote).trim();
    const now = clock.nowIso();
    let next;
    if (c.service_id === 'SV-03' && svcStep(c) === 1) {
      next = { status: 'IN_REVIEW', step: 2, dept: 'works', text: 'ส่งต่อฝ่ายโยธา (ขั้นตอน 2/3)' };
    } else if (c.service_id === 'SV-03' && svcStep(c) === 2) {
      next = { status: 'PENDING_APPROVAL', step: 3, dept: null, text: 'ส่งต่อหัวหน้าฝ่ายพิจารณาอนุมัติ (ขั้นตอน 3/3)' };
    } else if (c.service_id === 'SV-02') {
      next = { status: 'PENDING_APPROVAL', step: null, dept: null, text: 'ส่งต่อหัวหน้าฝ่ายพิจารณาอนุมัติ' };
    } else {
      return { error: 'INVALID_STATE' }; // SV-01 ตัดสินโดยเจ้าหน้าที่ ไม่มีการส่งต่อ
    }
    const info = db
      .prepare(
        `UPDATE cases SET status = @status, step = @step, dept = @dept, owner_id = NULL, updated_at = @now
          WHERE id = @id AND status = 'IN_REVIEW' AND owner_id = @me`
      )
      .run({ status: next.status, step: next.step, dept: next.dept, now, id: c.id, me: user.id });
    if (info.changes !== 1) return { error: 'INVALID_STATE' };
    addEvent(c.id, 'FORWARD', user, 'IN_REVIEW', next.status, note ? `${next.text} · หมายเหตุ: ${note}` : next.text, note, next.step, now);
    db.appendAudit({ user, event: 'FORWARD', caseNo: c.case_no, fromStatus: 'IN_REVIEW', toStatus: next.status, detail: note, at: now });
    const out = { ok: true, status: next.status, caseNo: c.case_no };
    if (next.step != null) out.step = next.step;
    return out;
  })();
}

/** อนุมัติ (SV-01 ผู้ถือ · SV-02/03 head) */
function doApprove(user, caseNo) {
  return db.transaction(() => {
    const c = loadCase(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    const err = decideError(user, c, 'approve');
    if (err) return { error: err };
    const now = clock.nowIso();
    const from = c.status;
    const step = c.service_id === 'SV-03' ? 3 : c.step == null ? null : c.step;
    const info = db
      .prepare(
        `UPDATE cases
            SET status = 'APPROVED', approved_at = @now, approver_id = @me, owner_id = NULL, dept = 'registry',
                step = @step,
                issuer_id = CASE WHEN @sv01 = 1 THEN @me ELSE issuer_id END,
                updated_at = @now
          WHERE id = @id AND status = @from`
      )
      .run({ now, me: user.id, step, sv01: c.service_id === 'SV-01' ? 1 : 0, id: c.id, from });
    if (info.changes !== 1) return { error: 'INVALID_STATE' };
    addEvent(c.id, 'APPROVE', user, from, 'APPROVED', user.role === 'head' ? 'หัวหน้าฝ่ายอนุมัติ' : 'เจ้าหน้าที่อนุมัติ', '', step, now);
    db.appendAudit({ user, event: 'APPROVE', caseNo: c.case_no, fromStatus: from, toStatus: 'APPROVED', detail: '', at: now });
    return { ok: true, status: 'APPROVED', caseNo: c.case_no };
  })();
}

/** ไม่อนุมัติ (สิทธิ์เหมือนอนุมัติ ไม่มีบั๊ก B07) · เหตุผล ≥ 10 ตัวอักษร · ปิดงาน closed_at */
function doReject(user, caseNo, rawReason) {
  return db.transaction(() => {
    const c = loadCase(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    const err = decideError(user, c, 'reject');
    if (err) return { error: err };
    if (reasonLength(rawReason) < MIN_REASON_LEN) return { error: 'REASON_TOO_SHORT' };
    const reason = String(rawReason).trim();
    const now = clock.nowIso();
    const from = c.status;
    const info = db
      .prepare(
        `UPDATE cases
            SET status = 'REJECTED', closed_at = @now, reject_reason = @reason, approver_id = @me,
                owner_id = NULL, dept = NULL, updated_at = @now
          WHERE id = @id AND status = @from`
      )
      .run({ now, reason, me: user.id, id: c.id, from });
    if (info.changes !== 1) return { error: 'INVALID_STATE' };
    addEvent(c.id, 'REJECT', user, from, 'REJECTED', `ไม่อนุมัติ: ${reason}`, reason, c.step, now);
    db.appendAudit({ user, event: 'REJECT', caseNo: c.case_no, fromStatus: from, toStatus: 'REJECTED', detail: reason, at: now });
    return { ok: true, status: 'REJECTED', closedAt: now, caseNo: c.case_no };
  })();
}

function sendResult(res, result) {
  if (result.error) return sendError(res, result.error);
  const { ok, ...body } = result; // eslint-disable-line no-unused-vars
  return res.status(200).json(body);
}

function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

// ===========================================================================
// คิว
// ===========================================================================

function queueRows(user, filter, hol) {
  const rows = db
    .prepare(`${CASE_SELECT} WHERE c.case_no IS NOT NULL AND c.status IN ('SUBMITTED','IN_REVIEW','APPROVED')
              ORDER BY c.due_at ASC, c.case_no ASC`)
    .all();
  return rows
    .filter((c) => {
      const d = queueDept(c);
      if (!d || !QUEUE_STATUSES.includes(c.status)) return false;
      if (user.role === 'officer' && d !== user.dept) return false;
      if (filter === 'unclaimed') return ['SUBMITTED', 'IN_REVIEW'].includes(c.status) && c.owner_id == null;
      if (filter === 'mine') return c.status === 'IN_REVIEW' && isOwner(user, c);
      return true;
    })
    .map((c) => ({ c, level: slaLevelOf(c, hol) }));
}

function queueItemJson(c, level) {
  const item = {
    caseNo: c.case_no,
    serviceId: c.service_id,
    applicantName: c.applicant_name,
    idMasked: maskedIdOf(c),
    status: c.status,
    step: svcStep(c),
    owner: c.status === 'APPROVED' ? null : c.owner_username || null,
    dueAt: fmt.isoOf(c.due_at),
    slaLevel: level,
  };
  if (isBug('B09')) item.idNo = applicantIdNo(c.applicant_id); // BUG B09: API รั่วเลขบัตรเต็ม (จอยังปิดบัง)
  return item;
}

function normFilter(v) {
  const f = String(v || 'all');
  return FILTERS.includes(f) ? f : 'all';
}

router.get(
  '/api/officer/queue',
  rbac.requireRole('officer', 'head'),
  wrap((req, res) => {
    const user = req.user;
    const filter = normFilter(req.query.filter);
    const hol = holidays();
    const items = queueRows(user, filter, hol).map(({ c, level }) => queueItemJson(c, level));
    const body = { filter, items };
    if (user.role === 'officer') body.workload = workloadOf(user.id);
    res.status(200).json(body);
  })
);

const FILTER_LABELS = { all: 'ทั้งหมด', unclaimed: 'ยังไม่มีผู้รับ', mine: 'ของฉัน' };

function renderQueuePage(user, filter, list) {
  const options = FILTERS.map(
    (f) => `<option value="${f}"${f === filter ? ' selected' : ''}>${esc(FILTER_LABELS[f])}</option>`
  ).join('');
  const isOfficer = user.role === 'officer';
  const workload = isOfficer
    ? `<p>งานในมือของฉัน: <strong data-testid="workload-count">${workloadOf(user.id)}</strong> / ${MAX_WORKLOAD} เรื่อง</p>`
    : '<p class="muted">หัวหน้าฝ่ายดูคิวทุกแผนกแบบอ่านอย่างเดียว</p>';
  const scope = isOfficer ? esc(DEPT_LABELS[user.dept] || '') : 'ทุกแผนก';
  const rows = list
    .map(({ c, level }) => {
      const owner = c.status === 'APPROVED' ? '' : c.owner_username || '';
      const claim = canShowClaim(user, c)
        ? `<button type="button" class="btn btn-primary" data-testid="claim-btn" data-case-no="${esc(c.case_no)}">รับเรื่อง</button>`
        : '';
      return `<tr data-testid="queue-row" data-case-no="${esc(c.case_no)}" data-owner="${esc(owner)}" data-status="${esc(c.status)}" data-sla-level="${esc(level)}">
<td><a data-testid="row-case-no" href="/officer/cases/${esc(c.case_no)}">${esc(c.case_no)}</a></td>
<td data-testid="row-service">${esc(fmt.serviceLabel(c.service_id))}${c.service_id === 'SV-03' ? `<br><span class="muted">${esc(SV03_STEP_LABELS[svcStep(c)] || '')}</span>` : ''}</td>
<td data-testid="row-applicant">${esc(c.applicant_name)}</td>
<td data-testid="row-id-masked">${esc(maskedIdOf(c))}</td>
<td>${layout.statusBadge(c.status, 'row-status')}</td>
<td>${fmt.timeTag(c.due_at, 'row-due')}</td>
<td>${layout.levelBadge(level, 'row-sla-level')}</td>
<td data-testid="row-owner">${esc(owner)}</td>
<td>${claim}</td>
</tr>`;
    })
    .join('\n');
  const table = list.length
    ? `<div class="table-wrap"><table data-testid="queue-table">
<caption class="visually-hidden">คิวงาน เรียงตามกำหนดเสร็จ แล้วเลขคำขอ</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตร</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
    : `<div class="table-wrap"><table data-testid="queue-table"><caption class="visually-hidden">คิวงาน</caption><thead><tr><th scope="col">คิวงาน</th></tr></thead><tbody><tr><td><p data-testid="queue-empty">ไม่มีงานในคิว</p></td></tr></tbody></table></div>`;
  return `<h1>คิวงาน · ${scope}</h1>
${workload}
<form class="row" method="get" action="/officer/queue" id="queue-filter-form">
<label for="queue-filter">ตัวกรอง</label>
<select id="queue-filter" name="filter" data-testid="queue-filter">${options}</select>
<button type="submit" class="btn btn-secondary">แสดง</button>
</form>
${table}`;
}


router.get(
  '/officer/queue',
  rbac.requireRole('officer', 'head'),
  wrap((req, res) => {
    const user = req.user;
    const filter = normFilter(req.query.filter);
    const list = queueRows(user, filter, holidays());
    return layout.sendPage(req, res, {
      title: 'คิวงาน',
      body: `<div id="officer-view">${renderQueuePage(user, filter, list)}</div>`,
      scripts: officerScript(null),
    });
  })
);

// ===========================================================================
// รายการรออนุมัติของหัวหน้า
// ===========================================================================

function approvalRows(hol) {
  return db
    .prepare(`${CASE_SELECT} WHERE c.case_no IS NOT NULL AND c.status = 'PENDING_APPROVAL' ORDER BY c.due_at ASC, c.case_no ASC`)
    .all()
    .map((c) => ({ c, level: slaLevelOf(c, hol) }));
}

router.get(
  '/api/head/approvals',
  rbac.requireRole('head'),
  wrap((req, res) => {
    const items = approvalRows(holidays()).map(({ c, level }) => ({
      caseNo: c.case_no,
      serviceId: c.service_id,
      applicantName: c.applicant_name,
      idMasked: maskedIdOf(c),
      status: c.status,
      step: svcStep(c),
      dueAt: fmt.isoOf(c.due_at),
      slaLevel: level,
    }));
    res.status(200).json({ items });
  })
);

router.get(
  '/head/approvals',
  rbac.requireRole('head'),
  wrap((req, res) => {
    const list = approvalRows(holidays());
    const rows = list
      .map(({ c, level }) => `<tr data-testid="approval-row" data-case-no="${esc(c.case_no)}">
<td data-testid="row-case-no">${esc(c.case_no)}</td>
<td data-testid="row-service">${esc(fmt.serviceLabel(c.service_id))}</td>
<td data-testid="row-applicant">${esc(c.applicant_name)}</td>
<td>${fmt.timeTag(c.due_at, 'row-due')}</td>
<td>${layout.levelBadge(level, 'row-sla-level')}</td>
<td><a class="btn btn-primary" data-testid="approval-open" href="/officer/cases/${esc(c.case_no)}">เปิดคำขอ</a></td>
</tr>`)
      .join('\n');
    const body = list.length
      ? `<h1>รายการรออนุมัติ</h1>
<div class="table-wrap"><table data-testid="approval-table">
<caption class="visually-hidden">คำขอที่รอหัวหน้าฝ่ายอนุมัติ เรียงตามกำหนดเสร็จ แล้วเลขคำขอ</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
      : `<h1>รายการรออนุมัติ</h1><p data-testid="approval-empty">ไม่มีคำขอรออนุมัติ</p>`;
    return layout.sendPage(req, res, { title: 'รายการรออนุมัติ', body });
  })
);

// ===========================================================================
// รายละเอียดคำขอ (เจ้าหน้าที่/หัวหน้า)
// ===========================================================================

function attachmentsOf(caseId) {
  return db
    .prepare('SELECT file_id, doc_key, name, mime, size, round FROM attachments WHERE case_id = ? ORDER BY round ASC, id ASC')
    .all(caseId);
}

function eventsOf(caseId) {
  return db
    .prepare(
      `SELECT e.at, e.type, e.text, e.detail, u.username AS actor_username, u.role AS actor_role
         FROM case_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.case_id = ? ORDER BY e.at ASC, e.id ASC`
    )
    .all(caseId);
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} ไบต์`;
}

async function docQrHtml(url) {
  if (QRCode) {
    try {
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 160 });
      return `<img data-testid="doc-qr" data-url="${esc(url)}" src="${esc(dataUrl)}" alt="QR สำหรับตรวจสอบเอกสาร ${esc(url)}" width="160" height="160">`;
    } catch (_) {
      /* ใช้ลิงก์แทน */
    }
  }
  return `<a data-testid="doc-qr" data-url="${esc(url)}" href="${esc(url)}">${esc(url)}</a>`;
}

async function renderCasePage(req, c) {
  const user = req.user;
  const hol = holidays();
  const level = slaLevelOf(c, hol);
  const step = svcStep(c);
  const doc = documentOf(c.id);
  const files = attachmentsOf(c.id);
  const events = eventsOf(c.id);

  const stepHtml = c.service_id === 'SV-03' && SV03_STEP_LABELS[step]
    ? `<div><dt>ขั้นตอน</dt><dd data-testid="case-step">${esc(SV03_STEP_LABELS[step])}</dd></div>`
    : '';
  const detailExtra = c.service_id === 'SV-01' && c.qty != null
    ? `<div><dt>จำนวนฉบับ</dt><dd>${esc(c.qty)} ฉบับ</dd></div>`
    : c.service_id === 'SV-03' && c.area_sqm != null
      ? `<div><dt>พื้นที่</dt><dd>${esc(fmt.fmtNumber(c.area_sqm))} ตร.ม.</dd></div>`
      : '';
  const closed = ['COMPLETED', 'REJECTED'].includes(c.status)
    ? `<div><dt>ปิดงานเมื่อ</dt><dd>${fmt.timeTag(c.closed_at, 'closed-at')}</dd></div>`
    : '';
  const fixDl = c.status === 'NEED_FIX' && c.fix_deadline
    ? `<div><dt>เส้นตายประชาชนส่งแก้ไข</dt><dd>${fmt.timeTag(c.fix_deadline)}</dd></div>`
    : '';
  const rejectReason = c.status === 'REJECTED' && c.reject_reason
    ? `<div><dt>เหตุผลที่ไม่อนุมัติ</dt><dd>${esc(c.reject_reason)}</dd></div>`
    : '';

  // ── ข้อมูลผู้ยื่น + ปิดบังเลขบัตร (BR-24)
  const applicant = `<section class="card" aria-labelledby="h-applicant">
<h2 id="h-applicant">ผู้ยื่นคำขอ</h2>
<dl class="grid">
<div><dt>ชื่อ-สกุล</dt><dd data-testid="applicant-name">${esc(c.applicant_name)}</dd></div>
<div><dt>เลขบัตรประชาชน</dt><dd><span data-testid="applicant-id">${esc(maskedIdOf(c))}</span> <span id="full-id-slot"></span></dd></div>
</dl>
<div class="row"><button type="button" class="btn btn-secondary" data-testid="show-full-id-btn" aria-controls="unmask-form" aria-expanded="false">แสดงเลขเต็ม</button></div>
<div id="unmask-form" class="stack" hidden>
<div class="form-row">
<label for="unmask-reason">เหตุผลที่ต้องดูเลขบัตรเต็ม (บันทึกใน Audit)</label>
<input type="text" id="unmask-reason" data-testid="unmask-reason" autocomplete="off" aria-describedby="unmask-error">
<p class="field-error" id="unmask-error" data-testid="unmask-error" role="alert" hidden></p>
</div>
<div class="row"><button type="button" class="btn btn-primary" data-testid="unmask-submit">ยืนยันแสดงเลขเต็ม</button></div>
</div>
</section>`;

  // ── ปุ่มดำเนินการ
  const actions = [];
  if (canShowClaim(user, c)) {
    actions.push('<div class="row"><button type="button" class="btn btn-primary" data-testid="claim-btn">รับเรื่อง</button></div>');
  }
  if (canShowForward(user, c)) {
    const target = c.service_id === 'SV-03' && step === 1 ? 'ฝ่ายโยธา (ขั้นตอน 2/3)' : 'หัวหน้าฝ่าย (พิจารณาอนุมัติ)';
    actions.push(`<div class="stack">
<p class="muted">ส่งต่ออัตโนมัติตามเส้นทางของบริการไปยัง: <strong>${esc(target)}</strong></p>
<div class="form-row">
<label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
<input type="text" id="forward-note" data-testid="forward-note" autocomplete="off">
</div>
<div class="row"><button type="button" class="btn btn-primary" data-testid="forward-btn">ผ่าน/ส่งต่อ</button></div>
</div>`);
  }
  if (canShowDecide(user, c)) {
    actions.push(`<div class="row">
<button type="button" class="btn btn-primary" data-testid="approve-btn">อนุมัติ</button>
<button type="button" class="btn btn-danger" data-testid="reject-btn" aria-controls="reject-form" aria-expanded="false">ไม่อนุมัติ</button>
</div>
<div id="reject-form" class="stack" hidden>
<div class="form-row">
<label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย 10 ตัวอักษร)</label>
<textarea id="reject-reason" data-testid="reject-reason" rows="3" aria-describedby="reject-reason-error"></textarea>
<p class="field-error" id="reject-reason-error" data-testid="reject-reason-error" role="alert" hidden></p>
</div>
<div class="row"><button type="button" class="btn btn-danger" data-testid="reject-submit">ยืนยันไม่อนุมัติ</button></div>
</div>`);
  }
  if (canShowReturn(user, c)) {
    actions.push(`<div class="row"><button type="button" class="btn btn-secondary" data-testid="return-btn" aria-controls="return-form" aria-expanded="false">ตีกลับ</button></div>
<div id="return-form" class="stack" hidden>
<div class="form-row">
<label for="return-reason">เหตุผลที่ตีกลับให้ประชาชนแก้ไข (อย่างน้อย 10 ตัวอักษร)</label>
<textarea id="return-reason" data-testid="return-reason" rows="3" aria-describedby="return-reason-error"></textarea>
<p class="field-error" id="return-reason-error" data-testid="return-reason-error" role="alert" hidden></p>
</div>
<div class="row"><button type="button" class="btn btn-secondary" data-testid="return-submit">ยืนยันตีกลับ</button></div>
</div>`);
  }
  if (docs) {
    // ปุ่มออกเอกสาร + สคริปต์ของ B07 (ผู้ออกเอกสารตาม A-27 · ซ่อนเมื่อออกแล้ว)
    const issueHtml = String(docs.issueButtonHtml(user, c) || '').replace(/<script[\s\S]*?<\/script>/gi, '');
    if (issueHtml) actions.push(`<div class="row">${issueHtml}</div>`);
  } else if (canShowIssue(user, c)) {
    actions.push('<div class="row"><button type="button" class="btn btn-primary" data-testid="issue-btn">ออกเอกสาร</button></div>');
  }
  const actionsHtml = `<section class="card" aria-labelledby="h-actions">
<h2 id="h-actions">ดำเนินการ</h2>
${actions.length ? actions.join('\n') : '<p class="muted">ไม่มีรายการที่ดำเนินการได้ในขั้นนี้</p>'}
</section>`;

  // ── เอกสารแนบ (FR-29)
  const fileItems = files
    .map((f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.file_id)}" data-doc-key="${esc(f.doc_key)}">
<span>${esc(DOC_LABELS[f.doc_key] || f.doc_key)}:</span>
<a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.file_id)}" download="${esc(f.name)}" data-file="${esc(f.name)}">${esc(f.name)}</a>
<span class="muted">(${esc(fmtSize(f.size))}${f.round ? ` · แนบตอนส่งแก้ไขครั้งที่ ${esc(f.round)}` : ''})</span>
</li>`)
    .join('\n');
  const filesHtml = `<section class="card" aria-labelledby="h-files">
<h2 id="h-files">เอกสารแนบ</h2>
${files.length ? `<ul class="doc-list doc-inline">${fileItems}</ul>` : '<p class="muted">ไม่มีเอกสารแนบ</p>'}
</section>`;

  // ── เอกสารดิจิทัล (หลังออกเอกสาร)
  let docHtml = '';
  if (docs) {
    docHtml = docs.renderDocSection(req, c, { view: 'officer' });
  } else if (doc) {
    const url = `${baseUrl(req)}/verify/${doc.verify_code}`;
    docHtml = `<section class="card" aria-labelledby="h-doc">
<h2 id="h-doc">เอกสารดิจิทัล</h2>
<dl class="grid">
<div><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(doc.doc_no)}</dd></div>
<div><dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(doc.verify_code)}</dd></div>
<div><dt>ใช้ได้ถึง</dt><dd>${fmt.timeTag(doc.valid_until, null, { dateOnly: true })}</dd></div>
<div><dt>ผู้ลงนาม</dt><dd>${esc(doc.signer)}</dd></div>
</dl>
<p>${await docQrHtml(url)}</p>
<p><a href="/api/documents/${encodeURIComponent(doc.doc_no)}/pdf">ดาวน์โหลด PDF ${esc(doc.doc_no)}</a></p>
</section>`;
  }

  // ── ไทม์ไลน์
  const timeline = events
    .map((e) => `<li data-testid="timeline-item" data-iso="${esc(fmt.isoOf(e.at))}">${fmt.timeTag(e.at)} · ${esc(e.text || e.type)}${e.actor_username ? ` <span class="muted">(${esc(e.actor_username)})</span>` : ''}</li>`)
    .join('\n');

  const body = `<div id="officer-view"><p><a href="${user.role === 'head' ? '/head/approvals' : '/officer/queue'}">← กลับ${user.role === 'head' ? 'รายการรออนุมัติ' : 'คิวงาน'}</a></p>
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<section class="card" aria-labelledby="h-summary">
<h2 id="h-summary">ข้อมูลคำขอ</h2>
<dl class="grid">
<div><dt>สถานะ</dt><dd>${layout.statusBadge(c.status, 'case-status')}</dd></div>
<div><dt>บริการ</dt><dd data-testid="case-service">${esc(fmt.serviceLabel(c.service_id))}</dd></div>
${stepHtml}
${detailExtra}
<div><dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${esc(fmt.fmtMoney(c.fee))}</dd></div>
<div><dt>ชำระเมื่อ</dt><dd>${fmt.timeTag(c.paid_at)}</dd></div>
<div><dt>กำหนดเสร็จ</dt><dd>${fmt.timeTag(c.due_at, 'sla-due')}</dd></div>
<div><dt>ระดับเตือน</dt><dd>${layout.levelBadge(level, 'sla-level')}</dd></div>
<div><dt>ผู้ถือเรื่อง</dt><dd data-testid="case-owner">${esc(c.owner_username || 'ยังไม่มีผู้รับ')}</dd></div>
<div><dt>ตีกลับแล้ว (ครั้ง)</dt><dd data-testid="return-count">${esc(c.return_count || 0)}</dd></div>
${fixDl}
${closed}
${rejectReason}
</dl>
</section>
${applicant}
${actionsHtml}
${filesHtml}
${docHtml}
<section class="card" aria-labelledby="h-timeline">
<h2 id="h-timeline">ไทม์ไลน์</h2>
<ol data-testid="case-timeline">
${timeline}
</ol>
</section></div>`;
  return body;
}

/**
 * สคริปต์ฝั่ง browser ของหน้าคิว/หน้าคำขอ (ใช้ event delegation ทั้งหมด)
 * หลังทำรายการสำเร็จ "รีเฟรชในที่" = fetch หน้าเดิมแล้วแทน #officer-view (ไม่ navigate · ไม่ชนกับ page.goto ของผู้ใช้/test)
 * ไม่มี fetch/DOMParser → reload ตามปกติ
 */
function officerScript(caseNo) {
  const cn = JSON.stringify(caseNo || null).replace(/</g, '\\u003c');
  return `<script>
(function(){
  var CASE_NO = ${cn};
  var seq = 0;
  function tidSel(id){ return '[data-testid="' + id + '"]'; }
  function $(id){ return document.querySelector(tidSel(id)); }
  function msgOf(r){ return (r && r.data && r.data.message) || 'เกิดข้อผิดพลาด'; }
  function fieldError(id, msg){ var el = $(id); if (!el) { App.showError(msg); return; } el.textContent = msg; el.hidden = false; }
  function clearField(id){ var el = $(id); if (el) { el.textContent = ''; el.hidden = true; } }
  function caseOf(btn){ return (btn && btn.getAttribute('data-case-no')) || CASE_NO; }
  function refresh(url){
    var target = url || window.location.href;
    if (!window.fetch || !window.DOMParser) { window.location.href = target; return Promise.resolve(); }
    var my = ++seq;
    return fetch(target, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } })
      .then(function(r){ return r.text(); })
      .then(function(html){
        if (my !== seq) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = doc.getElementById('officer-view');
        var cur = document.getElementById('officer-view');
        if (!fresh || !cur) { window.location.href = target; return; }
        cur.parentNode.replaceChild(document.importNode(fresh, true), cur);
        var nb = doc.querySelector(tidSel('bell-count')), ob = $('bell-count');
        if (nb && ob) ob.textContent = nb.textContent;
      })
      .catch(function(){ window.location.href = target; });
  }
  function post(btn, url, body, okMsg, onFail){
    if (btn) btn.disabled = true;
    App.clearFlash();
    return App.api('POST', url, body).then(function(r){
      if (r.ok) { return refresh().then(function(){ if (okMsg) App.showSuccess(okMsg); }); }
      if (btn) btn.disabled = false;
      if (onFail && onFail(r)) return;
      App.showError(msgOf(r));
    }).catch(function(){ if (btn) btn.disabled = false; App.showError('เกิดข้อผิดพลาด'); });
  }
  function api(c, action){ return '/api/officer/cases/' + encodeURIComponent(c) + '/' + action; }
  function openForm(btn, formId, fieldId){
    var f = document.getElementById(formId); if (!f) return;
    f.hidden = false; btn.setAttribute('aria-expanded', 'true');
    var inp = $(fieldId); if (inp) inp.focus();
  }
  function download(a){
    fetch(a.getAttribute('href'), { credentials: 'same-origin' }).then(function(r){
      if (!r.ok) { return r.json().catch(function(){ return {}; }).then(function(d){ App.showError((d && d.message) || 'ดาวน์โหลดไฟล์ไม่สำเร็จ'); }); }
      return r.blob().then(function(blob){
        var u = URL.createObjectURL(blob);
        var t = document.createElement('a');
        t.href = u; t.download = a.getAttribute('data-file') || 'file';
        document.body.appendChild(t); t.click(); t.parentNode.removeChild(t);
        setTimeout(function(){ URL.revokeObjectURL(u); }, 10000);
      });
    }).catch(function(){ App.showError('ดาวน์โหลดไฟล์ไม่สำเร็จ'); });
  }
  function unmask(btn){
    var c = caseOf(btn);
    clearField('unmask-error');
    btn.disabled = true;
    App.clearFlash();
    App.api('POST', api(c, 'unmask'), { reason: ($('unmask-reason') || {}).value || '' }).then(function(r){
      btn.disabled = false;
      if (!r.ok) { if (r.status === 400) fieldError('unmask-error', msgOf(r)); else App.showError(msgOf(r)); return; }
      var slot = document.getElementById('full-id-slot');
      var old = $('full-id'); if (old && old.parentNode) old.parentNode.removeChild(old);
      var s = document.createElement('strong');
      s.setAttribute('data-testid', 'full-id');
      s.textContent = (r.data && r.data.idFull) || '';
      if (slot) slot.appendChild(s);
      var f = document.getElementById('unmask-form'); if (f) f.hidden = true;
      var b = $('show-full-id-btn'); if (b) b.setAttribute('aria-expanded', 'false');
      var inp = $('unmask-reason'); if (inp) inp.value = '';
    }).catch(function(){ btn.disabled = false; App.showError('เกิดข้อผิดพลาด'); });
  }
  document.addEventListener('click', function(ev){
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-testid]') : null;
    if (!el || el.disabled) return;
    var id = el.getAttribute('data-testid');
    switch (id) {
      case 'claim-btn': ev.preventDefault(); post(el, api(caseOf(el), 'claim'), undefined, 'รับเรื่องแล้ว'); break;
      case 'approve-btn': ev.preventDefault(); post(el, '/api/cases/' + encodeURIComponent(caseOf(el)) + '/approve', undefined, 'อนุมัติแล้ว'); break;
      case 'forward-btn': ev.preventDefault(); post(el, api(caseOf(el), 'forward'), { note: ($('forward-note') || {}).value || '' }, 'ส่งต่อแล้ว'); break;
      case 'issue-btn': ev.preventDefault(); post(el, api(caseOf(el), 'issue'), undefined, 'ออกเอกสารแล้ว'); break;
      case 'return-btn': openForm(el, 'return-form', 'return-reason'); break;
      case 'reject-btn': openForm(el, 'reject-form', 'reject-reason'); break;
      case 'show-full-id-btn': openForm(el, 'unmask-form', 'unmask-reason'); break;
      case 'return-submit':
        clearField('return-reason-error');
        post(el, api(caseOf(el), 'return'), { reason: ($('return-reason') || {}).value || '' }, 'ตีกลับแล้ว', function(r){
          if (r.status === 400) { fieldError('return-reason-error', msgOf(r)); return true; }
          return false;
        });
        break;
      case 'reject-submit':
        clearField('reject-reason-error');
        post(el, '/api/cases/' + encodeURIComponent(caseOf(el)) + '/reject', { reason: ($('reject-reason') || {}).value || '' }, 'บันทึกไม่อนุมัติแล้ว', function(r){
          if (r.status === 400) { fieldError('reject-reason-error', msgOf(r)); return true; }
          return false;
        });
        break;
      case 'unmask-submit': unmask(el); break;
      case 'doc-download-link':
        if (!window.fetch || !window.URL || !URL.createObjectURL) return;
        ev.preventDefault(); download(el); break;
      default:
    }
  });
  // ตัวกรองคิว: เปลี่ยนแล้วโหลดตารางใหม่ในที่ (URL อัปเดตด้วย replaceState)
  document.addEventListener('change', function(ev){
    var sel = ev.target;
    if (!sel || sel.getAttribute('data-testid') !== 'queue-filter') return;
    var url = '/officer/queue?filter=' + encodeURIComponent(sel.value);
    if (window.history && history.replaceState) { history.replaceState(null, '', url); refresh(url); }
    else window.location.href = url;
  });
  document.addEventListener('submit', function(ev){
    var f = ev.target;
    if (!f || f.id !== 'queue-filter-form') return;
    ev.preventDefault();
    var sel = $('queue-filter');
    var url = '/officer/queue?filter=' + encodeURIComponent(sel ? sel.value : 'all');
    if (window.history && history.replaceState) { history.replaceState(null, '', url); refresh(url); }
    else window.location.href = url;
  });
})();
</script>`;
}

router.get(
  '/officer/cases/:caseNo',
  rbac.requireRole('officer', 'head'),
  wrap(async (req, res) => {
    const c = loadCase(req.params.caseNo);
    if (!c) return notFound(req, res);
    if (!canStaffView(req.user, c)) return forbid(req, res);
    const body = await renderCasePage(req, c);
    return layout.sendPage(req, res, {
      title: `คำขอ ${c.case_no}`,
      body,
      scripts: officerScript(c.case_no),
    });
  })
);

// ===========================================================================
// API การกระทำ
// ===========================================================================

router.post(
  '/api/officer/cases/:caseNo/claim',
  rbac.requireRole('officer'),
  wrap((req, res) => sendResult(res, doClaim(req.user, req.params.caseNo)))
);

router.post(
  '/api/officer/cases/:caseNo/return',
  rbac.requireRole('officer'),
  wrap((req, res) => sendResult(res, doReturn(req.user, req.params.caseNo, (req.body || {}).reason)))
);

router.post(
  '/api/officer/cases/:caseNo/forward',
  rbac.requireRole('officer'),
  wrap((req, res) => sendResult(res, doForward(req.user, req.params.caseNo, (req.body || {}).note)))
);

router.post(
  '/api/cases/:caseNo/approve',
  rbac.requireRole('officer', 'head'),
  wrap((req, res) => sendResult(res, doApprove(req.user, req.params.caseNo)))
);

router.post(
  '/api/cases/:caseNo/reject',
  rbac.requireRole('officer', 'head'),
  wrap((req, res) => sendResult(res, doReject(req.user, req.params.caseNo, (req.body || {}).reason)))
);

/** แสดงเลขเต็ม · เหตุผลต้องไม่ว่าง (A-32) · Audit UNMASK (BUG B11 ไม่บันทึก) */
router.post(
  '/api/officer/cases/:caseNo/unmask',
  rbac.requireRole('officer', 'head'),
  wrap((req, res) => {
    const user = req.user;
    const c = loadCase(req.params.caseNo);
    if (!c) return sendError(res, 'NOT_FOUND');
    if (!canStaffView(user, c)) return sendError(res, 'FORBIDDEN');
    const raw = (req.body || {}).reason;
    const reason = String(raw == null ? '' : raw).trim();
    if (!reason) return sendError(res, 'REASON_REQUIRED');
    const idNo = applicantIdNo(c.applicant_id);
    if (!isBug('B11')) {
      db.appendAudit({ user, event: 'UNMASK', caseNo: c.case_no, detail: reason });
    }
    return res.status(200).json({ idNo, idFull: idNo ? fmt.formatIdFull(idNo) : null });
  })
);

// ===========================================================================
// รายละเอียดคำขอ (JSON) · สำรองกรณี route ของฝั่งประชาชนไม่จัดการให้เจ้าหน้าที่
// ===========================================================================

router.get(
  '/api/cases/:caseNo',
  rbac.requireLogin,
  wrap((req, res) => {
    const user = req.user;
    if (!['citizen', 'officer', 'head'].includes(user.role)) return sendError(res, 'FORBIDDEN');
    const c = loadCase(req.params.caseNo);
    if (user.role === 'citizen') {
      if (!c || !rbac.canCitizenViewCase(user, c)) return sendError(res, 'NOT_FOUND');
      return res.status(200).json(citizenCaseJson(c, holidays()));
    }
    if (!c) return sendError(res, 'NOT_FOUND');
    if (!canStaffView(user, c)) return sendError(res, 'FORBIDDEN');
    return res.status(200).json(staffCaseJson(c, holidays()));
  })
);

// ===========================================================================
// ไฟล์แนบ (FR-29 · BR-29 · A-59)
// ===========================================================================

/**
 * ตรวจสิทธิ์ไฟล์ของคำขอ c (อาจเป็น null = ไม่พบ) → null (ผ่าน) หรือรหัส error
 * citizen: ของตัวเอง (ของคนอื่น/ไม่มี → 404) · officer: แผนกตนเองขั้นปัจจุบันหรือเคยผ่าน (นอกขอบเขต → 403)
 * head: ทุกแผนก · executive/auditor/admin → 403
 */
function fileAccessError(user, c) {
  if (user.role === 'citizen') {
    if (!c || !rbac.isCaseOwner(user, c)) return 'NOT_FOUND';
    return null;
  }
  if (user.role !== 'officer' && user.role !== 'head') return 'FORBIDDEN';
  if (!c || !c.case_no) return 'NOT_FOUND';
  return canStaffView(user, c) ? null : 'FORBIDDEN';
}

router.get(
  '/api/cases/:caseNo/files',
  rbac.requireLogin,
  wrap((req, res) => {
    const user = req.user;
    if (!['citizen', 'officer', 'head'].includes(user.role)) return sendError(res, 'FORBIDDEN');
    const c = loadCase(req.params.caseNo);
    const err = fileAccessError(user, c);
    if (err) return sendError(res, err);
    const items = attachmentsOf(c.id).map((f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size }));
    return res.status(200).json({ items });
  })
);

function contentDisposition(name) {
  const safe = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(String(name || 'file'))}`;
}

router.get(
  '/api/files/:fileId',
  rbac.requireLogin,
  wrap((req, res) => {
    const user = req.user;
    if (!['citizen', 'officer', 'head'].includes(user.role)) return sendError(res, 'FORBIDDEN');
    const f = db
      .prepare('SELECT id, file_id, case_id, name, mime, size, data FROM attachments WHERE file_id = ?')
      .get(String(req.params.fileId || ''));
    const c = f ? db.prepare('SELECT id, case_no, applicant_id, service_id, status, step FROM cases WHERE id = ?').get(f.case_id) : null;
    if (!f || !c) return sendError(res, 'NOT_FOUND');
    const err = fileAccessError(user, c);
    if (err) return sendError(res, err);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '');
    res.status(200);
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Length', String(data.length));
    res.set('Content-Disposition', contentDisposition(f.name));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    return res.end(data);
  })
);

module.exports = router;
// ตัวช่วยสำหรับบล็อกอื่น (เช่น หน้า citizen/documents) — ไม่จำเป็นต้องใช้
module.exports.helpers = { loadCase, svcStep, stepDept, queueDept, canStaffView, staffCaseJson, workloadOf, maskedIdOf };
