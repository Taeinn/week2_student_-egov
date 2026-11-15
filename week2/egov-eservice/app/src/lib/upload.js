'use strict';
/**
 * ไฟล์แนบ (บล็อก B05) · REQUIREMENTS FR-05 BR-06 BR-07 BR-08 · CONTRACT §0 ข้อ 10 · §5 · §6.2 · A-49
 *
 *   const upload = require('../lib/upload');
 *   router.post('/api/drafts/:id/files', requireRole('citizen'), upload.accept(), handler);   // req.files · req.uploadError
 *   const kind = upload.detectType(buf);              // 'pdf' | 'jpeg' | 'png' | null (ดูเฉพาะ magic bytes)
 *   const err  = upload.checkFile({ size, buffer, docKey, existingCount });  // null หรือรหัส error (CONTRACT §5)
 *
 * กติกา:
 *   - ชนิดไฟล์ตรวจจากเนื้อไฟล์เท่านั้น (PDF `%PDF` · JPEG `FF D8 FF` · PNG `89 50 4E 47 0D 0A 1A 0A`) ไม่ดูนามสกุล/Content-Type
 *   - ขนาด ≤ 5,242,880 ไบต์ (รวมค่านี้) · BUG_MODE=B02 → ใช้ `<` (5,242,880 พอดีถูกปฏิเสธ)
 *   - ไม่เกิน 5 ไฟล์ต่อคำขอ (นับรวมทุกช่อง · ไฟล์ที่ถูกปฏิเสธไม่นับ)
 *   - ช่องแบบแปลน (docKey 'plan') ต้องเป็น PDF
 *   - รับ multipart ใหญ่ได้ถึง 12 MB เพื่อให้ไฟล์ 5,242,881 ไบต์ได้ 400 FILE_TOO_LARGE (ไม่ใช่ 413 ของเฟรมเวิร์ก)
 */

const multer = require('multer');
const { isBug } = require('./bugs');
const { LIMITS } = require('./constants');

const MAX_FILE_BYTES = LIMITS.MAX_FILE_BYTES; // 5,242,880
const MAX_FILES_PER_CASE = LIMITS.MAX_FILES_PER_CASE; // 5
/** เพดานของตัวแยก multipart (ใหญ่กว่า 5 MB มาก เพื่อให้เราตอบ FILE_TOO_LARGE เอง) */
const PARSER_FILE_LIMIT = 12 * 1024 * 1024;

const MIME = Object.freeze({ pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png' });
const DOC_KEYS = Object.freeze(['id-card', 'map', 'site-photo', 'plan', 'deed', 'extra']);

/** ชนิดไฟล์จาก magic bytes → 'pdf' | 'jpeg' | 'png' | null */
function detectType(buf) {
  if (!buf || buf.length < 3) return null;
  // PDF: "%PDF" (25 50 44 46)
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'png';
  return null;
}

function mimeOf(kind) {
  return MIME[kind] || 'application/octet-stream';
}

/** ขนาดไม่เกินเพดาน · ≤ 5,242,880 (B02: < 5,242,880) */
function sizeOk(size) {
  return isBug('B02') ? size < MAX_FILE_BYTES : size <= MAX_FILE_BYTES;
}

/**
 * ตรวจไฟล์ 1 ไฟล์ → null (ผ่าน) หรือรหัส error ตาม CONTRACT §5
 * ลำดับ: ขนาด → ชนิด (magic bytes) → แบบแปลนต้องเป็น PDF → จำนวนไฟล์
 * @param {{size:number, buffer:Buffer, docKey:string, existingCount:number}} f
 */
function checkFile(f) {
  const size = Number(f.size != null ? f.size : f.buffer ? f.buffer.length : 0);
  if (f.truncated || !sizeOk(size)) return 'FILE_TOO_LARGE';
  const kind = detectType(f.buffer);
  if (!kind) return 'FILE_TYPE';
  if (f.docKey === 'plan' && kind !== 'pdf') return 'PLAN_NOT_PDF';
  if (Number(f.existingCount || 0) >= MAX_FILES_PER_CASE) return 'FILE_COUNT';
  return null;
}

/**
 * ชื่อไฟล์จาก multipart (busboy ใช้ utf8 ตามที่ตั้งไว้) · ตัดพาธ และอักขระควบคุมออก
 */
function cleanName(name) {
  let s = String(name == null ? '' : name);
  s = s.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) s = 'file';
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PARSER_FILE_LIMIT, files: 10, fields: 20, fieldSize: 64 * 1024 },
  defParamCharset: 'utf8',
});

/**
 * แปลง error ของ multer เป็นรหัสตาม CONTRACT (ไฟล์ใหญ่ → FILE_TOO_LARGE · จำนวนเกิน → FILE_COUNT · อื่น ๆ → BAD_REQUEST)
 */
function mapMulterError(err) {
  if (!err) return null;
  if (err.code === 'LIMIT_FILE_SIZE') return 'FILE_TOO_LARGE';
  if (err.code === 'LIMIT_FILE_COUNT') return 'FILE_COUNT';
  return 'BAD_REQUEST';
}

/**
 * middleware รับ multipart (ทุกชื่อฟิลด์) · ไม่โยน error: เก็บรหัสไว้ที่ req.uploadError ให้ handler ตัดสินเอง
 * (ต้องตรวจเจ้าของ/สถานะก่อนจึงตอบ error ของไฟล์ได้ถูกลำดับ) · ไม่ใช่ multipart → ข้าม (req.files = [])
 * ไฟล์อยู่ที่ req.files (เรียงตามลำดับที่ส่ง) · ใช้ filesOf(req, 'file') เพื่อเลือกฟิลด์ที่ต้องการก่อน
 */
function accept() {
  const mw = parser.any();
  return function uploadMiddleware(req, res, next) {
    mw(req, res, (err) => {
      if (err) {
        req.uploadError = mapMulterError(err);
        if (!req.body || typeof req.body !== 'object') req.body = {};
      }
      if (!Array.isArray(req.files)) req.files = [];
      next();
    });
  };
}

/** ไฟล์จากฟิลด์ที่ต้องการ (ค่าเริ่ม 'file' / 'files' / 'file[]') · ถ้าไม่มีฟิลด์ชื่อนั้นเลยใช้ทุกไฟล์ */
function filesOf(req, ...names) {
  const all = Array.isArray(req.files) ? req.files : [];
  const want = names.length ? names : ['file', 'files', 'file[]', 'files[]'];
  const picked = all.filter((f) => want.includes(f.fieldname));
  return picked.length ? picked : all;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_FILES_PER_CASE,
  MIME,
  DOC_KEYS,
  detectType,
  mimeOf,
  sizeOk,
  checkFile,
  cleanName,
  accept,
  filesOf,
  mapMulterError,
};
