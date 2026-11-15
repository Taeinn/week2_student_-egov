'use strict';
/**
 * รูปแบบแสดงผล (CONTRACT §0 ข้อ 2–4 · DECISIONS §0 · NFR-10)
 *   fmtDateTime('2026-12-04T16:30:00+07:00') → '4 ธ.ค. 2569 16:30'
 *   fmtDate('2027-02-02')                     → '2 ก.พ. 2570'
 *   fmtMoney(1010)                            → '฿1,010'
 *   isoOf(date)                               → '2026-12-04T16:30:00+07:00'  (ใช้ใส่ data-iso)
 *   timeTag(v, 'sla-due')                     → <time data-testid="sla-due" data-iso="…" datetime="…">4 ธ.ค. 2569 16:30</time>
 *   formatIdFull('1101700123456')             → '1-1017-00123-45-6'
 *   maskId('1101700123456')                   → 'X-XXXX-XXXXX-45-6'
 *   maskName('สมชาย ใจดี')                    → 'สมชาย ใ***'
 */

const clock = require('./clock');
const { STATUS_LABELS, LEVEL_LABELS, ROLE_LABELS, DEPT_LABELS, SERVICES } = require('./constants');

const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const p2 = (n) => String(n).padStart(2, '0');

/** escape สำหรับแทรกใน HTML (ทั้งข้อความและค่า attribute) */
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** '4 ธ.ค. 2569 16:30' · ค่าว่าง/ไม่ถูกต้อง → '' */
function fmtDateTime(v) {
  const p = clock.parts(v);
  if (!p) return '';
  return `${p.day} ${TH_MONTHS_SHORT[p.month - 1]} ${p.year + 543} ${p2(p.hour)}:${p2(p.minute)}`;
}

/** '2 ก.พ. 2570' (รับ 'YYYY-MM-DD' หรือเวลาเต็ม) */
function fmtDate(v) {
  const p = clock.parts(v);
  if (!p) return '';
  return `${p.day} ${TH_MONTHS_SHORT[p.month - 1]} ${p.year + 543}`;
}

/** '1,010' */
function fmtNumber(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
  const v = Math.round(Number(n));
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? `-${s}` : s;
}

/** '฿1,010' · ค่าไม่ถูกต้อง → '–' (en dash ตาม CONTRACT fee-total) */
function fmtMoney(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '–';
  return `฿${fmtNumber(n)}`;
}

/** ISO +07:00 สำหรับ data-iso / API · ค่าว่าง → null */
function isoOf(v) {
  if (v == null || v === '') return null;
  return clock.toIso(v);
}

/**
 * แท็ก <time> พร้อม data-testid และ data-iso
 * @param {*} v  เวลา (ISO/Date/ms) หรือ 'YYYY-MM-DD'
 * @param {string} [testid]
 * @param {{dateOnly?:boolean, prefix?:string, suffix?:string, attrs?:string}} [opts]
 *   dateOnly → ข้อความ '2 ก.พ. 2570' และ data-iso='2027-02-02'
 */
function timeTag(v, testid, opts = {}) {
  const tid = testid ? ` data-testid="${esc(testid)}"` : '';
  const extra = opts.attrs ? ` ${opts.attrs}` : '';
  if (v == null || v === '') return `<span${tid}${extra}>–</span>`;
  const iso = opts.dateOnly ? clock.dateStr(v) : clock.toIso(v);
  const text = opts.dateOnly ? fmtDate(v) : fmtDateTime(v);
  return `<time${tid} data-iso="${esc(iso)}" datetime="${esc(iso)}"${extra}>${esc(opts.prefix || '')}${esc(text)}${esc(opts.suffix || '')}</time>`;
}

function digitsOnly(idNo) {
  return String(idNo == null ? '' : idNo).replace(/\D/g, '');
}

/** '1101700123456' → '1-1017-00123-45-6' */
function formatIdFull(idNo) {
  const d = digitsOnly(idNo);
  if (d.length !== 13) return d;
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

/** '1101700123456' → 'X-XXXX-XXXXX-45-6' (เห็น 3 หลักท้าย · DECISIONS §11) */
function maskId(idNo) {
  const d = digitsOnly(idNo);
  if (d.length < 3) return 'X-XXXX-XXXXX-XX-X';
  const last3 = d.slice(-3);
  return `X-XXXX-XXXXX-${last3.slice(0, 2)}-${last3[2]}`;
}

/** 'สมชาย ใจดี' → 'สมชาย ใ***' (A-54) */
function maskName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const surname = parts.slice(1).join(' ');
  return `${parts[0]} ${Array.from(surname)[0]}***`;
}

/** ปี พ.ศ. ของเวลา (เวลาไทย) */
function beYear(v) {
  return clock.buddhistYear(v);
}

/** pad ลำดับ 6 หลัก: 31 → '000031' */
function seq6(n) {
  return String(n).padStart(6, '0');
}

const statusLabel = (code) => STATUS_LABELS[code] || String(code || '');
const levelLabel = (code) => LEVEL_LABELS[code] || String(code || '');
const roleLabel = (code) => ROLE_LABELS[code] || String(code || '');
const deptLabel = (code) => DEPT_LABELS[code] || '';
/** 'SV-01 ขอหนังสือรับรอง' (case-service) */
const serviceLabel = (id) => (SERVICES[id] ? `${id} ${SERVICES[id].name}` : String(id || ''));
const serviceName = (id) => (SERVICES[id] ? SERVICES[id].name : String(id || ''));

module.exports = {
  TH_MONTHS_SHORT,
  esc,
  fmtDateTime,
  fmtDate,
  fmtNumber,
  fmtMoney,
  isoOf,
  timeTag,
  formatIdFull,
  maskId,
  maskName,
  beYear,
  seq6,
  statusLabel,
  levelLabel,
  roleLabel,
  deptLabel,
  serviceLabel,
  serviceName,
};
