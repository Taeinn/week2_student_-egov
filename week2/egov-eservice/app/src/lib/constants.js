'use strict';
/**
 * ค่าคงที่กลางตาม CONTRACT §1 §2.1 §4 และ DECISIONS §1 §3 §13
 * (ตัวเลขกฎธุรกิจ เช่น ค่าธรรมเนียม/SLA อยู่ในตาราง services ของ DB และฟังก์ชันใน src/lib/rules.js)
 */

const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];

/** ข้อความ user-role (CONTRACT §2.1) */
const ROLE_LABELS = {
  citizen: 'ประชาชน',
  officer: 'เจ้าหน้าที่',
  head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร',
  auditor: 'ผู้ตรวจสอบภายใน',
  admin: 'ผู้ดูแลระบบ',
};

const DEPTS = ['registry', 'works'];
const DEPT_LABELS = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };

/** หน้าตั้งต้นหลังล็อกอิน (CONTRACT §1) · citizen ที่ยังไม่ลงทะเบียน → /register */
const LANDING = {
  citizen: '/citizen',
  officer: '/officer/queue',
  head: '/head/approvals',
  executive: '/dashboard',
  auditor: '/audit',
  admin: '/admin/services',
};

/** สถานะคำขอ (CONTRACT §4.1) */
const STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'SUBMITTED',
  'IN_REVIEW',
  'NEED_FIX',
  'PENDING_APPROVAL',
  'APPROVED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
];
const STATUS_LABELS = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};
/** งานคงค้าง (DECISIONS §12) */
const BACKLOG_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'];
/** ปิดงาน (นับใน Dashboard) */
const CLOSED_STATUSES = ['COMPLETED', 'REJECTED'];
/** ไม่ประเมิน SLA อีก */
const FINAL_STATUSES = ['COMPLETED', 'REJECTED', 'CANCELLED'];

/** ระดับเตือน (CONTRACT §4.2) */
const SLA_LEVELS = ['normal', 'near', 'overdue', 'paused', 'closed'];
const LEVEL_LABELS = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

/** เอกสารแนบ · docKey (CONTRACT §2.5 §4.3) */
const DOC_LABELS = {
  'id-card': 'บัตรประชาชน',
  map: 'แผนที่ตั้ง',
  'site-photo': 'ภาพสถานที่',
  plan: 'แบบแปลน',
  deed: 'โฉนด',
  extra: 'เอกสารเพิ่มเติม',
};

/**
 * บริการ (CONTRACT §4.3 · DECISIONS §3) — ส่วนที่ "ไม่" แก้ผ่าน admin
 * ค่าธรรมเนียม/SLA ที่แก้ได้อยู่ในตาราง services ของ DB
 * docs เรียงตามลำดับที่ใช้ใน missing-docs · route = ขั้นตอนตามลำดับ (แผนก หรือ 'head')
 */
const SERVICES = {
  'SV-01': {
    id: 'SV-01',
    name: 'ขอหนังสือรับรอง',
    approver: 'officer',
    route: ['registry'],
    docs: [{ key: 'id-card', name: 'บัตรประชาชน', required: true }],
  },
  'SV-02': {
    id: 'SV-02',
    name: 'ขออนุญาตประกอบกิจการ',
    approver: 'head',
    route: ['registry', 'head'],
    docs: [
      { key: 'id-card', name: 'บัตรประชาชน', required: true },
      { key: 'map', name: 'แผนที่ตั้ง', required: true },
      { key: 'site-photo', name: 'ภาพสถานที่', required: false },
    ],
  },
  'SV-03': {
    id: 'SV-03',
    name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
    approver: 'head',
    route: ['registry', 'works', 'head'],
    docs: [
      { key: 'id-card', name: 'บัตรประชาชน', required: true },
      { key: 'plan', name: 'แบบแปลน', required: true, pdfOnly: true },
      { key: 'deed', name: 'โฉนด', required: true },
    ],
  },
};
const SERVICE_IDS = Object.keys(SERVICES);

/** ข้อความ case-step ของ SV-03 (CONTRACT §2.6 · A-40) */
const SV03_STEP_LABELS = {
  1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน',
  2: 'ขั้นตอน 2/3 · ฝ่ายโยธา',
  3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย',
};

/** เหตุการณ์ Audit (DECISIONS §13) */
const AUDIT_EVENTS = [
  'STAFF_LOGIN',
  'CLAIM',
  'RETURN',
  'FORWARD',
  'APPROVE',
  'REJECT',
  'ISSUE',
  'UNMASK',
  'EXPORT',
  'ADMIN_CHANGE',
];

/** ตัวเลขกฎที่ใช้หลายบล็อก (DECISIONS) */
const LIMITS = {
  MAX_FILE_BYTES: 5242880, // ≤ 5 MB (รวมค่านี้)
  MAX_FILES_PER_CASE: 5,
  QR_TTL_MS: 15 * 60 * 1000, // ใช้ได้ถ้า (ชำระ − สร้าง) < 15:00
  FIX_WINDOW_MS: 168 * 60 * 60 * 1000, // 168 ชม.
  MAX_WORKLOAD: 10,
  MAX_RETURNS: 2,
  MIN_REASON_LEN: 10,
  OTP_MAX_FAILS: 3,
  OTP_LOCK_MS: 15 * 60 * 1000,
  CUTOFF_HOUR: 16,
  CUTOFF_MINUTE: 30,
  TEST_OTP: '123456',
};

module.exports = {
  ROLES,
  ROLE_LABELS,
  DEPTS,
  DEPT_LABELS,
  LANDING,
  STATUSES,
  STATUS_LABELS,
  BACKLOG_STATUSES,
  CLOSED_STATUSES,
  FINAL_STATUSES,
  SLA_LEVELS,
  LEVEL_LABELS,
  DOC_LABELS,
  SERVICES,
  SERVICE_IDS,
  SV03_STEP_LABELS,
  AUDIT_EVENTS,
  LIMITS,
};
