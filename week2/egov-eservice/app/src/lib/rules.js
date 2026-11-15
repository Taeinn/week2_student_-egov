'use strict';
/**
 * กฎตัวเลขกลาง (บล็อก B03) · ฟังก์ชันบริสุทธิ์: ไม่อ่านนาฬิกา ไม่แตะ DB (ผู้เรียกส่ง now / holidays / db เข้ามาเอง)
 *
 * ที่มา: REQUIREMENTS §2 BR-04 BR-05 BR-09 BR-10 BR-12 BR-13 BR-14 BR-20 BR-23 BR-25
 *        DECISIONS §0 §3 §6 §7 §8 §10 §12 §18 · CONTRACT §4.2 §5 §6.4 · BUGS.md (B01 B03 B04)
 *
 * ใช้:
 *   const rules = require('../lib/rules');
 *   const clock = require('../lib/clock');
 *   const holidays = rules.holidayList(db);                  // ['2026-12-07', ...] (อ่านจากตาราง holidays)
 *
 *   rules.feeFor('SV-03', { area: 101 })                      → { ok: true, fee: 1010, ... }
 *   rules.feeFor(serviceRow, { qty: 6 })                      → { ok: false, code: 'INVALID_QTY', status: 400, message: 'จำนวนฉบับต้อง 1–5 ฉบับ' }
 *   rules.computeDueAt(clock.nowIso(), 3, holidays)           → '2026-12-04T16:30:00+07:00'
 *   rules.pauseExtend(dueAt, returnedAt, clock.nowIso(), holidays) → dueAt ใหม่ (ใช้ตารางวันหยุด ณ เวลาที่ส่งแก้)
 *   rules.slaLevel(clock.now(), dueAt, holidays)              → 'normal' | 'near' | 'overdue'
 *   rules.slaLevel(clock.now(), dueAt, holidays, status)      → + 'paused' (NEED_FIX) | 'closed' (COMPLETED/REJECTED/CANCELLED)
 *   rules.qrValid(createdAt, clock.now())                     → true ถ้าอายุ < 15:00
 *   rules.docValidUntil('SV-01', issuedAt)                    → '2027-02-28'
 *   rules.onTimePct(7, 6)                                     → 85.7  · rules.fmtPct(null) → '–'
 *   rules.nextNumber(db, 'case', paidAt)                      → 'EG-2569-000031' (ต้องเรียกใน transaction เดียวกับการ UPDATE)
 *
 * รูปแบบค่า: เวลา = ISO '+07:00' (clock.toIso) · วันที่ = 'YYYY-MM-DD' (เวลาไทย)
 * พารามิเตอร์เวลา รับได้ทุกแบบที่ clock.toMs รับ (Date | ms | ISO มี offset | 'YYYY-MM-DD')
 * holidays รับได้: ['YYYY-MM-DD', ...] | [{date: 'YYYY-MM-DD'}, ...] (แถวจาก DB) | Set | null
 *
 * บั๊ก (BUG_MODE · อ่าน env ทุกครั้งที่เรียก):
 *   B01  feeFor SV-03 ใช้ area > 101 แทน ≥ 101 → พื้นที่ 101 = ฿1,000 (102 ยัง ฿1,020)
 *   B03  isWorkingDay ไม่ดูตารางวันหยุด (ข้ามแค่ ส-อา) → กระทบ computeDueAt / pauseExtend / slaLevel (ฟังก์ชันวันทำการตัวเดียว · DECISIONS §18)
 *   B04  pauseExtend คืนกำหนดเดิม (ไม่หยุดนับระหว่าง NEED_FIX) · pausedDays = 0
 *   ไม่ฝัง: B05 (อายุ QR · citizen.js ฝังเอง: isBug('B05') ? qrAgeMs(c, p) <= QR_TTL_MS : qrValid(c, p))
 *           B10 (ทันกำหนด % หารด้วยรับเรื่อง · dashboard ฝังเอง)
 */

const clock = require('./clock');
const { isBug } = require('./bugs');
const { ERRORS, HttpError } = require('./errors');
const { LIMITS, FINAL_STATUSES } = require('./constants');

// ---------------------------------------------------------------------------
// ค่าคงที่ของกฎ
// ---------------------------------------------------------------------------

/** ค่า seed ของบริการ (DECISIONS §3 · TEST-DATA) · ค่าจริงอยู่ในตาราง services (admin แก้ได้) */
const DEFAULT_SERVICES = Object.freeze({
  'SV-01': Object.freeze({ id: 'SV-01', fee: 20, feePerSqm: null, slaDays: 3 }), // fee = ต่อฉบับ
  'SV-02': Object.freeze({ id: 'SV-02', fee: 500, feePerSqm: null, slaDays: 10 }), // fee = คงที่
  'SV-03': Object.freeze({ id: 'SV-03', fee: 1000, feePerSqm: 10, slaDays: 15 }), // fee = ฐาน 1–100 ตร.ม.
});

const QTY_MIN = 1;
const QTY_MAX = 5;
const QTY_DEFAULT = 1; // A-56
const AREA_MIN = 1;
const AREA_MAX = 500;
const AREA_BASE = 100; // 1–100 ตร.ม. = ค่าฐาน · 101–500 = ฐาน + feePerSqm × (พื้นที่ − 100)

const CUTOFF_MIN = LIMITS.CUTOFF_HOUR * 60 + LIMITS.CUTOFF_MINUTE; // 16:30 → 990 นาที
const DUE_TIME = '16:30:00';
const QR_TTL_MS = LIMITS.QR_TTL_MS; // 15 นาที
const FIX_WINDOW_MS = LIMITS.FIX_WINDOW_MS; // 168 ชม.
const DOC_DAYS_SV01 = 90; // วันสุดท้าย = ออก + 89 วัน

const NUMBER_PREFIX = Object.freeze({ case: 'EG', receipt: 'RC', doc: 'DOC' });

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SCAN_DAYS = 3700; // กันวนไม่รู้จบถ้าตารางวันหยุดผิดปกติ (~10 ปี)

// ---------------------------------------------------------------------------
// ตัวช่วยภายใน
// ---------------------------------------------------------------------------

function serviceIdOf(service) {
  if (typeof service === 'string') return service.trim().toUpperCase();
  if (service && typeof service === 'object') {
    const id = service.id || service.serviceId || service.service_id;
    return typeof id === 'string' ? id.trim().toUpperCase() : null;
  }
  return null;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

/**
 * รวมค่าบริการจาก DB/อ็อบเจกต์กับค่า seed → {id, fee, feePerSqm, slaDays} · ไม่รู้จักบริการ → null
 * รับได้ทั้ง 'SV-01', แถวจาก DB ({id, fee, fee_per_sqm, sla_days}) และ {id, fee, feePerSqm, slaDays}
 */
function resolveService(service) {
  const id = serviceIdOf(service);
  const def = id && DEFAULT_SERVICES[id];
  if (!def) return null;
  const src = service && typeof service === 'object' ? service : {};
  return {
    id,
    fee: Number(firstDefined(src.fee, def.fee)),
    feePerSqm: firstDefined(src.feePerSqm, src.fee_per_sqm, def.feePerSqm),
    slaDays: Number(firstDefined(src.slaDays, src.sla_days, def.slaDays)),
  };
}

/** แปลงค่าที่ผู้ใช้กรอกเป็นตัวเลข · ว่าง/ไม่ใช่ตัวเลข → null */
function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  return null;
}

/** ดึงค่าจาก input: ส่งเป็นตัวเลข/สตริงตรง ๆ หรืออ็อบเจกต์ที่มีคีย์ใดคีย์หนึ่ง */
function pickInput(input, keys) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return input;
  for (const k of keys) if (input[k] !== undefined) return input[k];
  return undefined;
}

function feeOk(svc, fee, extra) {
  return { ok: true, serviceId: svc.id, fee, code: null, status: 200, message: null, ...extra };
}

function feeFail(svc, code) {
  const def = ERRORS[code];
  return { ok: false, serviceId: svc ? svc.id : null, fee: null, code, status: def.status, message: def.message };
}

function mustMs(v, name) {
  const ms = clock.toMs(v);
  if (!Number.isFinite(ms)) throw new TypeError(`rules: ${name} ไม่ใช่เวลาที่ถูกต้อง (${v})`);
  return ms;
}

function ymdOf(v, name) {
  if (typeof v === 'string' && YMD_RE.test(v.trim())) return v.trim();
  return clock.dateStr(mustMs(v, name));
}

/** holidays → Set ของ 'YYYY-MM-DD' */
function toHolidaySet(holidays) {
  if (!holidays) return new Set();
  const items = holidays instanceof Set ? [...holidays] : Array.isArray(holidays) ? holidays : [];
  const out = new Set();
  for (const h of items) {
    const raw = h && typeof h === 'object' && !(h instanceof Date) ? h.date : h;
    if (raw == null || raw === '') continue;
    if (typeof raw === 'string' && YMD_RE.test(raw.trim())) {
      out.add(raw.trim());
    } else {
      const d = clock.dateStr(raw);
      if (d) out.add(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BR-04 · BR-05 ค่าธรรมเนียม (DECISIONS §3 · CONTRACT §5)
// ---------------------------------------------------------------------------

/**
 * คำนวณค่าธรรมเนียม
 * @param {string|object} service  'SV-01' | แถว services จาก DB (ใช้ fee / fee_per_sqm ที่ admin แก้)
 * @param {object|number|string} [input]  SV-01: {qty} (ไม่ส่ง = 1 ตาม A-56 · สตริงว่าง = ผิด) · SV-03: {area} · SV-02: ไม่ใช้
 * @returns {{ok:boolean, serviceId:string|null, fee:number|null, code:string|null, status:number, message:string|null, qty?:number, area?:number}}
 *   error: INVALID_QTY 'จำนวนฉบับต้อง 1–5 ฉบับ' · INVALID_AREA 'กรุณาระบุพื้นที่ 1–500 ตร.ม.' ·
 *          AREA_TOO_LARGE 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' · BAD_REQUEST (ไม่รู้จักบริการ) — ทั้งหมด HTTP 400
 */
function feeFor(service, input) {
  const svc = resolveService(service);
  if (!svc) return feeFail(null, 'BAD_REQUEST');

  if (svc.id === 'SV-01') {
    let raw = pickInput(input, ['qty', 'quantity', 'copies']);
    if (raw === undefined || raw === null) raw = QTY_DEFAULT;
    const qty = toNumber(raw);
    if (qty === null || !Number.isInteger(qty) || qty < QTY_MIN || qty > QTY_MAX) return feeFail(svc, 'INVALID_QTY');
    return feeOk(svc, svc.fee * qty, { qty });
  }

  if (svc.id === 'SV-02') return feeOk(svc, svc.fee);

  // SV-03 ตามพื้นที่ (จำนวนเต็ม ตร.ม.)
  const area = toNumber(pickInput(input, ['area', 'areaSqm', 'area_sqm']));
  if (area === null) return feeFail(svc, 'INVALID_AREA');
  if (area > AREA_MAX) return feeFail(svc, 'AREA_TOO_LARGE');
  if (area < AREA_MIN || !Number.isInteger(area)) return feeFail(svc, 'INVALID_AREA');
  const perSqm = Number(svc.feePerSqm != null ? svc.feePerSqm : DEFAULT_SERVICES['SV-03'].feePerSqm);
  // B01: ใช้ > 101 แทน ≥ 101 → พื้นที่ 101 คิดแค่ค่าฐาน
  const overBase = isBug('B01') ? area > AREA_BASE + 1 : area >= AREA_BASE + 1;
  const fee = overBase ? svc.fee + perSqm * (area - AREA_BASE) : svc.fee;
  return feeOk(svc, fee, { area });
}

/** เหมือน feeFor แต่คืนตัวเลข หรือ throw HttpError (400 + ข้อความตาม CONTRACT §5) */
function feeOrThrow(service, input) {
  const r = feeFor(service, input);
  if (!r.ok) throw new HttpError(r.code);
  return r.fee;
}

// ---------------------------------------------------------------------------
// วันทำการ (DECISIONS §0 · A-02) · ฟังก์ชันเดียวใช้ทั้งกำหนดเสร็จ หยุดนับ และวันคงเหลือ
// ---------------------------------------------------------------------------

/** จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด · B03: ไม่ดูตารางวันหยุด */
function isWorkingDayIn(ymd, holidaySet) {
  const wd = clock.weekdayOf(ymd);
  if (!(wd >= 1 && wd <= 5)) return false;
  if (isBug('B03')) return true;
  return !holidaySet.has(ymd);
}

function nextWorkingDayIn(ymd, holidaySet) {
  let d = ymd;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    d = clock.addDaysToDateStr(d, 1);
    if (isWorkingDayIn(d, holidaySet)) return d;
  }
  throw new Error('rules: ไม่พบวันทำการถัดไป (ตารางวันหยุดผิดปกติ)');
}

function addWorkingDaysIn(ymd, n, holidaySet) {
  let d = ymd;
  for (let i = 0; i < n; i++) d = nextWorkingDayIn(d, holidaySet);
  return d;
}

/** จำนวนวันทำการ d ที่ fromExcl < d ≤ toIncl */
function countWorkingDaysIn(fromExcl, toIncl, holidaySet) {
  if (!(toIncl > fromExcl)) return 0;
  let n = 0;
  let d = fromExcl;
  for (let i = 0; i < MAX_SCAN_DAYS * 10 && d < toIncl; i++) {
    d = clock.addDaysToDateStr(d, 1);
    if (isWorkingDayIn(d, holidaySet)) n++;
  }
  return n;
}

/** วันนี้ (เวลา/วันที่ใดก็ได้) เป็นวันทำการหรือไม่ */
function isWorkingDay(day, holidays) {
  return isWorkingDayIn(ymdOf(day, 'day'), toHolidaySet(holidays));
}

/** วันทำการแรกที่อยู่ "หลัง" day → 'YYYY-MM-DD' */
function nextWorkingDay(day, holidays) {
  return nextWorkingDayIn(ymdOf(day, 'day'), toHolidaySet(holidays));
}

/** วันทำการที่ n หลัง day → 'YYYY-MM-DD' (n = 0 → day เดิม) */
function addWorkingDays(day, n, holidays) {
  return addWorkingDaysIn(ymdOf(day, 'day'), n, toHolidaySet(holidays));
}

/** จำนวนวันทำการในช่วง (from, to] ตามวันที่ (ไม่ขึ้นกับเวลา) */
function countWorkingDays(fromExcl, toIncl, holidays) {
  return countWorkingDaysIn(ymdOf(fromExcl, 'from'), ymdOf(toIncl, 'to'), toHolidaySet(holidays));
}

// ---------------------------------------------------------------------------
// BR-12 กำหนดเสร็จ (DECISIONS §8)
// ---------------------------------------------------------------------------

function resolveSlaDays(slaDays) {
  if (typeof slaDays === 'number') return slaDays;
  if (typeof slaDays === 'string' && /^\s*\d+\s*$/.test(slaDays)) return Number(slaDays);
  const svc = resolveService(slaDays); // 'SV-01' หรือแถวบริการ
  return svc ? svc.slaDays : NaN;
}

/**
 * D0 = วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 · ไม่เช่นนั้นวันทำการถัดไป → 'YYYY-MM-DD'
 */
function slaStartDay(paidAt, holidays) {
  return startDayIn(mustMs(paidAt, 'paidAt'), toHolidaySet(holidays));
}

function startDayIn(paidMs, holidaySet) {
  const p = clock.parts(paidMs);
  const ymd = clock.dateStr(paidMs);
  const beforeCutoff = p.hour * 60 + p.minute < CUTOFF_MIN; // 16:29:59 ก่อน · 16:30:00 ไม่ก่อน
  return isWorkingDayIn(ymd, holidaySet) && beforeCutoff ? ymd : nextWorkingDayIn(ymd, holidaySet);
}

/**
 * กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 (คำนวณครั้งเดียวตอนชำระ · A-42)
 * @param {*} paidAt  เวลาชำระสำเร็จ
 * @param {number|string|object} slaDays  N (หรือ 'SV-01' / แถวบริการที่มี sla_days)
 * @param {*} holidays  ตารางวันหยุด ณ เวลาชำระ
 * @returns {string|null}  '2026-12-04T16:30:00+07:00' · paidAt ว่าง → null
 */
function computeDueAt(paidAt, slaDays, holidays) {
  if (paidAt === undefined || paidAt === null || paidAt === '') return null;
  const paidMs = mustMs(paidAt, 'paidAt');
  const n = resolveSlaDays(slaDays);
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`rules: slaDays ไม่ถูกต้อง (${slaDays})`);
  const set = toHolidaySet(holidays);
  const due = addWorkingDaysIn(startDayIn(paidMs, set), n, set);
  return `${due}T${DUE_TIME}+07:00`;
}

// ---------------------------------------------------------------------------
// BR-13 หยุดนับระหว่าง NEED_FIX (DECISIONS §8)
// ---------------------------------------------------------------------------

/**
 * กำหนดเสร็จใหม่เมื่อประชาชนส่งแก้ = กำหนดเดิม + จำนวนวันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้]
 * (นับตามวันที่ ไม่ขึ้นกับเวลา · ใช้ตารางวันหยุด ณ เวลาที่ส่งแก้)
 * @returns {{dueAt:string, pausedDays:number}}  B04 → กำหนดเดิม และ pausedDays = 0
 */
function pauseDetail(dueAt, returnedAt, resubmittedAt, holidays) {
  const dueMs = mustMs(dueAt, 'dueAt');
  const dueIso = clock.toIso(dueMs);
  if (isBug('B04')) return { dueAt: dueIso, pausedDays: 0 };
  const set = toHolidaySet(holidays);
  const pausedDays = countWorkingDaysIn(ymdOf(returnedAt, 'returnedAt'), ymdOf(resubmittedAt, 'resubmittedAt'), set);
  if (pausedDays === 0) return { dueAt: dueIso, pausedDays: 0 };
  const newDay = addWorkingDaysIn(clock.dateStr(dueMs), pausedDays, set);
  return { dueAt: `${newDay}${dueIso.slice(10)}`, pausedDays }; // คงเวลาเดิมของกำหนด (16:30:00+07:00)
}

/** เหมือน pauseDetail แต่คืนเฉพาะ dueAt ใหม่ (ISO) */
function pauseExtend(dueAt, returnedAt, resubmittedAt, holidays) {
  return pauseDetail(dueAt, returnedAt, resubmittedAt, holidays).dueAt;
}

// ---------------------------------------------------------------------------
// BR-14 ระดับเตือน (DECISIONS §8 · CONTRACT §4.2)
// ---------------------------------------------------------------------------

/** วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนดเสร็จ (รวมวันกำหนด) · เลยวันกำหนดแล้ว = 0 */
function remainingWorkingDays(now, dueAt, holidays) {
  return countWorkingDaysIn(ymdOf(now, 'now'), ymdOf(dueAt, 'dueAt'), toHolidaySet(holidays));
}

/**
 * ระดับเตือน
 * - ไม่ส่ง status: 'overdue' ถ้า now > dueAt · 'normal' ถ้าวันคงเหลือ ≥ 2 · ไม่เช่นนั้น 'near'
 * - ส่ง status: COMPLETED/REJECTED/CANCELLED → 'closed' · NEED_FIX → 'paused' · DRAFT/PENDING_PAYMENT → null
 * - dueAt ว่าง → null
 */
function slaLevel(now, dueAt, holidays, status) {
  if (status) {
    if (FINAL_STATUSES.includes(status)) return 'closed';
    if (status === 'NEED_FIX') return 'paused';
    if (status === 'DRAFT' || status === 'PENDING_PAYMENT') return null;
  }
  if (dueAt === undefined || dueAt === null || dueAt === '') return null;
  const nowMs = mustMs(now, 'now');
  const dueMs = mustMs(dueAt, 'dueAt');
  if (nowMs > dueMs) return 'overdue';
  const left = countWorkingDaysIn(clock.dateStr(nowMs), clock.dateStr(dueMs), toHolidaySet(holidays));
  return left >= 2 ? 'normal' : 'near';
}

/** ระดับเตือนของแถวคำขอ ({status, due_at|dueAt}) */
function caseSlaLevel(caseRow, now, holidays) {
  if (!caseRow) return null;
  return slaLevel(now, firstDefined(caseRow.dueAt, caseRow.due_at), holidays, caseRow.status);
}

// ---------------------------------------------------------------------------
// BR-10 อายุ QR (DECISIONS §7)
// ---------------------------------------------------------------------------

/** อายุ QR ณ เวลาชำระ (ms) */
function qrAgeMs(createdAt, paidAt) {
  return mustMs(paidAt, 'paidAt') - mustMs(createdAt, 'createdAt');
}

/** QR ใช้ได้ถ้า (เวลาชำระ − เวลาสร้าง) < 15:00 นาที · 14:59 ✓ · 15:00 ✗ · (ไม่ฝัง B05) */
function qrValid(createdAt, paidAt) {
  return qrAgeMs(createdAt, paidAt) < QR_TTL_MS;
}

/** เวลาหมดอายุของ QR (ISO) = สร้าง + 15:00 (ตั้งแต่เวลานี้ใช้ไม่ได้) */
function qrExpiresAt(createdAt) {
  return clock.toIso(mustMs(createdAt, 'createdAt') + QR_TTL_MS);
}

// ---------------------------------------------------------------------------
// BR-20 เวลาแก้ไข 168 ชม. (DECISIONS §9 · A-21)
// ---------------------------------------------------------------------------

/** เส้นตายส่งแก้ (ISO) = เวลาตีกลับ + 168 ชม. */
function fixDeadline(returnedAt) {
  return clock.toIso(mustMs(returnedAt, 'returnedAt') + FIX_WINDOW_MS);
}

/** ยังส่งแก้ได้ไหม: now < ตีกลับ + 168:00 (167:59 ✓ · 168:00 ✗ ยกเลิก) */
function fixWindowOpen(returnedAt, now) {
  return mustMs(now, 'now') < mustMs(returnedAt, 'returnedAt') + FIX_WINDOW_MS;
}

/** หมดเวลาแก้ไขแล้ว (ระบบยกเลิกอัตโนมัติ · เวลายกเลิก = fixDeadline) */
function fixExpired(returnedAt, now) {
  return !fixWindowOpen(returnedAt, now);
}

// ---------------------------------------------------------------------------
// BR-23 อายุเอกสาร (DECISIONS §10 · A-23)
// ---------------------------------------------------------------------------

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * วันสุดท้ายที่เอกสารใช้ได้ → 'YYYY-MM-DD'
 * SV-01: วันออก + 89 วัน (90 วันรวมวันออก) · SV-02/03: วันครบรอบปีถัดไป − 1 วัน
 * (ออก 29 ก.พ. แล้วปีถัดไปไม่มี 29 ก.พ. → ใช้ 28 ก.พ. เป็นวันครบรอบ → ใช้ได้ถึง 27 ก.พ.)
 */
function docValidUntil(service, issuedAt) {
  const id = serviceIdOf(service);
  const issued = ymdOf(issuedAt, 'issuedAt');
  if (id === 'SV-01') return clock.addDaysToDateStr(issued, DOC_DAYS_SV01 - 1);
  if (id === 'SV-02' || id === 'SV-03') {
    const y = Number(issued.slice(0, 4)) + 1;
    let md = issued.slice(5);
    if (md === '02-29' && !isLeapYear(y)) md = '02-28';
    return clock.addDaysToDateStr(`${String(y).padStart(4, '0')}-${md}`, -1);
  }
  throw new TypeError(`rules: ไม่รู้จักบริการ (${service})`);
}

/** เอกสารหมดอายุ ⇔ วันที่ (เวลาไทย) ของ now > วันสุดท้ายที่ใช้ได้ (28 ก.พ. 23:59 ✓ · 1 มี.ค. 00:00 ✗) */
function docExpired(validUntil, now) {
  return clock.dateStr(mustMs(now, 'now')) > ymdOf(validUntil, 'validUntil');
}

// ---------------------------------------------------------------------------
// BR-25 ทันกำหนด (DECISIONS §12 §18)
// ---------------------------------------------------------------------------

/** ทันกำหนด ⇔ closed_at ≤ กำหนดเสร็จ (16:30:00 ทัน · 16:30:01 ไม่ทัน) */
function isOnTime(closedAt, dueAt) {
  return mustMs(closedAt, 'closedAt') <= mustMs(dueAt, 'dueAt');
}

/**
 * ทันกำหนด % = ทัน ÷ ปิดงาน × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (คำนวณด้วยจำนวนเต็ม ไม่มีเศษทศนิยมลอย)
 * @param {number} closed  จำนวนปิดงาน (COMPLETED + REJECTED)
 * @param {number} onTime  จำนวนที่ทันกำหนด
 * @returns {number|null}  85.7 · ปิดงาน 0 → null (จอแสดง '–')
 */
function onTimePct(closed, onTime) {
  const c = Number(closed);
  const t = Number(onTime);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(t)) return null;
  const tenths = Math.floor((2000 * t + c) / (2 * c)); // round-half-up ของ t×1000/c
  return tenths / 10;
}

/** 85.7 → '85.7%' · 100 → '100.0%' · null → '–' */
function fmtPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return '–';
  return `${Number(pct).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// BR-09 เลขคำขอ / ใบเสร็จ / เอกสาร (DECISIONS §6 §7 §10)
// ---------------------------------------------------------------------------

/** ปี พ.ศ. ของเวลา (เวลาไทย) · 2026-12-31T23:59 → 2569 · 2027-01-01T00:00 → 2570 */
function beYear(at) {
  return clock.buddhistYear(mustMs(at, 'at'));
}

/** ชื่อตัวนับใน DB: seqName('case', paidAt) → 'case:2569' (kind = case | receipt | doc) */
function seqName(kind, at) {
  if (!NUMBER_PREFIX[kind]) throw new TypeError(`rules: ไม่รู้จักชนิดเลข (${kind})`);
  return `${kind}:${beYear(at)}`;
}

/** formatNumber('case', 2569, 31) → 'EG-2569-000031' */
function formatNumber(kind, year, seq) {
  const prefix = NUMBER_PREFIX[kind];
  if (!prefix) throw new TypeError(`rules: ไม่รู้จักชนิดเลข (${kind})`);
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

/** เลขคำขอจากเวลาชำระ + ลำดับ: caseNoFor('2027-01-01T00:00:00+07:00', 1) → 'EG-2570-000001' */
function caseNoFor(paidAt, seq) {
  return formatNumber('case', beYear(paidAt), seq);
}

function receiptNoFor(paidAt, seq) {
  return formatNumber('receipt', beYear(paidAt), seq);
}

function docNoFor(issuedAt, seq) {
  return formatNumber('doc', beYear(issuedAt), seq);
}

/**
 * ออกเลขถัดไปแบบ atomic: nextNumber(db, 'case', paidAt) → 'EG-2569-000031'
 * (db = โมดูล src/db ที่มี nextSeq · เรียกใน db.tx เดียวกับการ UPDATE เพื่อไม่ให้เลขซ้ำ/ข้าม)
 */
function nextNumber(db, kind, at) {
  const year = beYear(at);
  return formatNumber(kind, year, db.nextSeq(`${kind}:${year}`));
}

const CASE_NO_RE = /^EG-\d{4}-\d{6}$/;
function isCaseNo(s) {
  return typeof s === 'string' && CASE_NO_RE.test(s);
}

// ---------------------------------------------------------------------------
// ตัวช่วยอ่านวันหยุดจาก DB (ไม่ require db เอง เพื่อให้ไฟล์นี้ทดสอบได้โดยไม่มี DB)
// ---------------------------------------------------------------------------

/** ['2026-12-07', ...] จากตาราง holidays */
function holidayList(db) {
  return db
    .prepare('SELECT date FROM holidays ORDER BY date')
    .all()
    .map((r) => r.date);
}

module.exports = {
  // ค่าคงที่
  DEFAULT_SERVICES,
  QTY_MIN,
  QTY_MAX,
  QTY_DEFAULT,
  AREA_MIN,
  AREA_MAX,
  AREA_BASE,
  QR_TTL_MS,
  FIX_WINDOW_MS,
  DOC_DAYS_SV01,
  NUMBER_PREFIX,
  // ค่าธรรมเนียม
  resolveService,
  feeFor,
  feeOrThrow,
  // วันทำการ + SLA
  toHolidaySet,
  isWorkingDay,
  nextWorkingDay,
  addWorkingDays,
  countWorkingDays,
  slaStartDay,
  computeDueAt,
  pauseDetail,
  pauseExtend,
  remainingWorkingDays,
  slaLevel,
  caseSlaLevel,
  // QR + เวลาแก้ไข
  qrAgeMs,
  qrValid,
  qrExpiresAt,
  fixDeadline,
  fixWindowOpen,
  fixExpired,
  // เอกสาร
  docValidUntil,
  docExpired,
  // Dashboard
  isOnTime,
  onTimePct,
  fmtPct,
  // เลขเอกสาร
  beYear,
  seqName,
  formatNumber,
  caseNoFor,
  receiptNoFor,
  docNoFor,
  nextNumber,
  isCaseNo,
  // DB helper
  holidayList,
};
