'use strict';
/**
 * นาฬิกาของระบบ · แหล่งเวลาเดียวของกฎธุรกิจทั้งหมด (CONTRACT §8 · DECISIONS §0 · A-37)
 *
 * - TEST_MODE=1 → นาฬิกา "แช่แข็ง" เริ่มที่ 2026-12-01T09:00:00+07:00 เปลี่ยนได้ผ่าน PUT /api/test/clock เท่านั้น
 * - ไม่ตั้ง TEST_MODE → เวลาจริงของเครื่อง
 * - เขตเวลา Asia/Bangkok (+07:00 ไม่มี DST) → คำนวณด้วยการบวก 7 ชม. แล้วอ่านค่า UTC (ไม่พึ่ง TZ ของเครื่อง)
 *
 * ห้ามเรียก Date.now() / new Date() ตรง ๆ ในกฎธุรกิจ ให้ใช้ now() / nowIso() จากไฟล์นี้
 * รูปแบบเวลาที่เก็บใน DB และส่งใน API: 'YYYY-MM-DDTHH:mm:ss+07:00' (toIso) · วันที่ล้วน: 'YYYY-MM-DD' (dateStr)
 */

const DEFAULT_NOW_ISO = '2026-12-01T09:00:00+07:00';
const OFFSET_MIN = 7 * 60;
const OFFSET_MS = OFFSET_MIN * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function isTestMode() {
  return /^(1|true|yes|on)$/i.test(String(process.env.TEST_MODE || '').trim());
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** แปลงสตริง ISO ที่ "ต้องมี offset" (Z หรือ ±HH:MM) เป็น ms · ไม่ถูกต้อง → NaN */
function parseStrictIsoMs(str) {
  if (typeof str !== 'string') return NaN;
  const m = ISO_RE.exec(str.trim());
  if (!m) return NaN;
  const [, ys, mos, ds, hs, mis, ss = '0', frac = '0', off] = m;
  const y = +ys, mo = +mos, d = +ds, h = +hs, mi = +mis, s = +ss;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return NaN;
  const ms = Math.floor(+(`0.${frac}`) * 1000);
  let offMin = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = +digits.slice(0, 2), om = +digits.slice(2, 4);
    if (oh > 14 || om > 59) return NaN;
    offMin = sign * (oh * 60 + om);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offMin * MINUTE_MS;
}

/** true ถ้าเป็น ISO 8601 ที่มี offset ชัดเจน (ใช้ตรวจ PUT /api/test/clock → 400 INVALID_TIME) */
function isValidIsoWithOffset(str) {
  return Number.isFinite(parseStrictIsoMs(str));
}

let frozenMs = isTestMode() ? parseStrictIsoMs(DEFAULT_NOW_ISO) : null;

/** เวลาปัจจุบัน (Date) */
function now() {
  return new Date(frozenMs != null ? frozenMs : Date.now());
}

/** เวลาปัจจุบันเป็น ms */
function nowMs() {
  return frozenMs != null ? frozenMs : Date.now();
}

/** เวลาปัจจุบันรูปแบบ '2026-12-01T09:00:00+07:00' */
function nowIso() {
  return toIso(nowMs());
}

/** แช่แข็งนาฬิกาที่ค่า ISO (ต้องมี offset) · ไม่ถูกต้อง → throw Error code INVALID_TIME */
function setNow(iso) {
  const ms = parseStrictIsoMs(iso);
  if (!Number.isFinite(ms)) {
    const err = new Error('INVALID_TIME');
    err.code = 'INVALID_TIME';
    throw err;
  }
  frozenMs = ms;
  return toIso(ms);
}

/** คืนนาฬิกาเป็นค่าเริ่มต้น 2026-12-01T09:00:00+07:00 (แช่แข็ง) */
function resetClock() {
  frozenMs = parseStrictIsoMs(DEFAULT_NOW_ISO);
  return toIso(frozenMs);
}

function isFrozen() {
  return frozenMs != null;
}

/** รับ Date | ms | สตริง ISO (มี offset) | 'YYYY-MM-DD' (= 00:00 เวลาไทย) → ms หรือ NaN */
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    const dm = DATE_RE.exec(s);
    if (dm) return Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) - OFFSET_MS;
    const strict = parseStrictIsoMs(s);
    if (Number.isFinite(strict)) return strict;
    // ไม่มี offset → ถือเป็นเวลาไทย
    const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (local) return Date.UTC(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +(local[6] || 0)) - OFFSET_MS;
    return NaN;
  }
  return NaN;
}

/** แปลงเป็น Date (รับแบบเดียวกับ toMs) */
function toDate(v) {
  return new Date(toMs(v));
}

/** ส่วนประกอบเวลาไทย {year, month(1-12), day, hour, minute, second, weekday(0=อาทิตย์..6=เสาร์)} */
function parts(v) {
  const ms = toMs(v);
  if (!Number.isFinite(ms)) return null;
  const t = new Date(ms + OFFSET_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
    weekday: t.getUTCDay(),
  };
}

const p2 = (n) => String(n).padStart(2, '0');

/** '2026-12-04T16:30:00+07:00' */
function toIso(v) {
  const p = parts(v);
  if (!p) return null;
  return `${String(p.year).padStart(4, '0')}-${p2(p.month)}-${p2(p.day)}T${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}+07:00`;
}

/** 'YYYY-MM-DD' ตามวันที่เวลาไทย */
function dateStr(v) {
  const p = parts(v);
  if (!p) return null;
  return `${String(p.year).padStart(4, '0')}-${p2(p.month)}-${p2(p.day)}`;
}

/** สร้างเวลาไทย: bkk(2026, 12, 4, 16, 30) → Date ของ 2026-12-04T16:30:00+07:00 */
function bkk(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - OFFSET_MS);
}

/** เพิ่มวันปฏิทินให้สตริง 'YYYY-MM-DD' → 'YYYY-MM-DD' */
function addDaysToDateStr(ymd, n) {
  const m = DATE_RE.exec(ymd);
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

/** วันในสัปดาห์ของ 'YYYY-MM-DD' (0=อาทิตย์..6=เสาร์) */
function weekdayOf(ymd) {
  const m = DATE_RE.exec(ymd);
  if (!m) return NaN;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

/** ปี พ.ศ. ของเวลา (เวลาไทย) */
function buddhistYear(v) {
  const p = parts(v);
  return p ? p.year + 543 : null;
}

module.exports = {
  DEFAULT_NOW_ISO,
  OFFSET_MS,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  isTestMode,
  now,
  nowMs,
  nowIso,
  setNow,
  resetClock,
  isFrozen,
  isValidIsoWithOffset,
  parseStrictIsoMs,
  toMs,
  toDate,
  toIso,
  parts,
  dateStr,
  bkk,
  addDaysToDateStr,
  weekdayOf,
  buddhistYear,
};
