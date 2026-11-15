'use strict';
/**
 * รหัสข้อผิดพลาด + ข้อความตรงตัวอักษร (CONTRACT §5 · A-38)
 * รูปแบบ API: {"code":"...","message":"..."} (+ ฟิลด์เสริม เช่น attemptsLeft, lockedUntil, missing)
 *
 * ใช้:
 *   const { sendError, HttpError } = require('../lib/errors');
 *   return sendError(res, 'INVALID_QTY');                                  // 400 + ข้อความตามตาราง
 *   return sendError(res, 'OTP_INVALID', { attemptsLeft: 2 });             // + ฟิลด์เสริม
 *   return sendError(res, 'MISSING_DOCS', { missing }, `ยังขาดเอกสาร: ${missing.join(', ')}`);
 *   throw new HttpError('ALREADY_CLAIMED');   // error handler ของ server.js แปลงเป็น JSON (API) หรือหน้า (HTML)
 */

const ERRORS = {
  // ยืนยันตัวตน
  INVALID_ID: { status: 400, message: 'เลขบัตรประชาชนไม่ถูกต้อง' },
  OTP_INVALID: { status: 401, message: 'รหัส OTP ไม่ถูกต้อง' },
  LOCKED: { status: 423, message: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที' },
  INVALID_CREDENTIALS: { status: 401, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' },
  INVALID_MOBILE: { status: 400, message: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0' },
  CONSENT_REQUIRED: { status: 400, message: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)' },
  UNAUTHENTICATED: { status: 401, message: 'กรุณาเข้าสู่ระบบ' },
  // ค่าธรรมเนียม
  INVALID_QTY: { status: 400, message: 'จำนวนฉบับต้อง 1–5 ฉบับ' },
  INVALID_AREA: { status: 400, message: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.' },
  AREA_TOO_LARGE: { status: 400, message: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' },
  // ไฟล์แนบ
  FILE_TOO_LARGE: { status: 400, message: 'ไฟล์ใหญ่เกิน 5 MB' },
  FILE_TYPE: { status: 400, message: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG' },
  FILE_COUNT: { status: 400, message: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ' },
  PLAN_NOT_PDF: { status: 400, message: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น' },
  MISSING_DOCS: { status: 409, message: 'ยังขาดเอกสาร' }, // ส่งข้อความเต็ม 'ยังขาดเอกสาร: แบบแปลน, โฉนด' เป็น message override
  // ชำระเงิน
  QR_EXPIRED: { status: 410, message: 'QR หมดอายุ กรุณาสร้าง QR ใหม่' },
  AMOUNT_MISMATCH: { status: 422, message: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม' },
  // คำขอ
  NOT_FOUND: { status: 404, message: 'ไม่พบคำขอ' },
  CANNOT_CANCEL: { status: 409, message: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว' },
  FIX_WINDOW_EXPIRED: { status: 409, message: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก' },
  ALREADY_CLAIMED: { status: 409, message: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว' },
  WORKLOAD_LIMIT: { status: 409, message: 'รับงานได้สูงสุด 10 เรื่อง' },
  RETURN_LIMIT: { status: 409, message: 'ตีกลับได้สูงสุด 2 ครั้ง' },
  REASON_TOO_SHORT: { status: 400, message: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร' },
  REASON_REQUIRED: { status: 400, message: 'กรุณากรอกเหตุผล' },
  INVALID_STATE: { status: 409, message: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้' },
  FORBIDDEN: { status: 403, message: 'ไม่มีสิทธิ์ทำรายการนี้' },
  // ผู้ดูแลระบบ
  INVALID_FEE: { status: 400, message: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท' },
  INVALID_SLA: { status: 400, message: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ' },
  DUPLICATE_HOLIDAY: { status: 409, message: 'มีวันหยุดนี้อยู่แล้ว' },
  SELF_ROLE_CHANGE: { status: 409, message: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method Not Allowed' },
  // ระบบ / test hook
  INVALID_TIME: { status: 400, message: 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ISO 8601 พร้อม offset เช่น 2026-12-01T09:00:00+07:00)' },
  BAD_REQUEST: { status: 400, message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'ข้อมูลที่ส่งมาใหญ่เกินกำหนด' },
  INTERNAL: { status: 500, message: 'เกิดข้อผิดพลาดภายในระบบ' },
};

/** ข้อความหน้า 403/404 (CONTRACT §2.1) */
const PAGE_MESSAGES = {
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  NOT_FOUND_CASE: 'ไม่พบคำขอ',
};

class HttpError extends Error {
  /**
   * @param {string} code  รหัสในตาราง ERRORS
   * @param {object} [extra]  ฟิลด์เสริมใน JSON
   * @param {string} [message]  แทนข้อความมาตรฐาน
   */
  constructor(code, extra, message) {
    const def = ERRORS[code] || ERRORS.INTERNAL;
    super(message || def.message);
    this.name = 'HttpError';
    this.code = code;
    this.status = def.status;
    this.extra = extra || {};
  }
}

function errorBody(code, extra, message) {
  const def = ERRORS[code] || ERRORS.INTERNAL;
  return { code, message: message || def.message, ...(extra || {}) };
}

/** ส่ง JSON error ตาม CONTRACT · คืนค่า res */
function sendError(res, code, extra, message) {
  const def = ERRORS[code] || ERRORS.INTERNAL;
  return res.status(def.status).json(errorBody(code, extra, message));
}

module.exports = { ERRORS, PAGE_MESSAGES, HttpError, sendError, errorBody };
