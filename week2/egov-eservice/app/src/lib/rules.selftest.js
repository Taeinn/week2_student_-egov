'use strict';
/**
 * selftest ของ src/lib/rules.js (บล็อก B03) · รัน: node src/lib/rules.selftest.js
 * ตรวจทุกแถวค่าขอบของ BR-04 BR-05 BR-09 BR-10 BR-12 BR-13 BR-14 BR-20 BR-23 BR-25
 * + TEST-PLAN TC-FEE-01 TC-PAY-01 TC-PAY-04 TC-SLA-01 TC-SLA-02 TC-SLA-03 TC-WORKFLOW-06 TC-DOC-01..03 TC-DASH-02 TC-DASH-04
 * + พฤติกรรมเมื่อเปิด BUG_MODE B01 B03 B04 (BUGS.md)
 * ผ่านหมด → exit 0 · ล้ม → พิมพ์ expected/actual แล้ว exit 1
 */

const assert = require('assert');
const rules = require('./rules');

const ORIGINAL_BUG_MODE = process.env.BUG_MODE;
process.env.BUG_MODE = '';

// วันหยุดใน seed (DECISIONS §0)
const HOLIDAYS = ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'];
const HOLIDAY_ROWS = HOLIDAYS.map((date) => ({ date, name: 'x' })); // รูปแบบแถวจาก DB
const T = (s) => `${s}+07:00`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, msg: e.message });
  }
}

function eq(name, actual, expected) {
  check(name, () => assert.deepStrictEqual(actual, expected, `${name}: expected ${JSON.stringify(expected)} received ${JSON.stringify(actual)}`));
}

function withBugs(mode, fn) {
  const prev = process.env.BUG_MODE;
  process.env.BUG_MODE = mode;
  try {
    fn();
  } finally {
    process.env.BUG_MODE = prev;
  }
}

// ---------------------------------------------------------------------------
// BR-04 · SV-01 ฿20 ต่อฉบับ 1–5 ฉบับ (TC-FEE-01)
// ---------------------------------------------------------------------------
const QTY_MSG = 'จำนวนฉบับต้อง 1–5 ฉบับ';
for (const [qty, fee] of [[1, 20], [2, 40], [3, 60], [4, 80], [5, 100]]) {
  eq(`BR-04 qty ${qty}`, rules.feeFor('SV-01', { qty }).fee, fee);
}
for (const qty of [0, 6, -1, 2.5, '', 'abc', '1.5']) {
  const r = rules.feeFor('SV-01', { qty });
  eq(`BR-04 qty ${JSON.stringify(qty)} ✗`, [r.ok, r.code, r.status, r.message, r.fee], [false, 'INVALID_QTY', 400, QTY_MSG, null]);
}
eq('BR-04 qty "3" (สตริงจากฟอร์ม)', rules.feeFor('SV-01', { qty: '3' }).fee, 60);
eq('BR-04 qty ไม่ส่ง → ค่าตั้งต้น 1 (A-56)', rules.feeFor('SV-01', {}).fee, 20);
eq('BR-04 qty ไม่ส่ง input เลย', rules.feeFor('SV-01').fee, 20);
eq('BR-04 รับตัวเลขตรง ๆ', rules.feeFor('SV-01', 5).fee, 100);
eq('BR-04 แถว DB ที่ admin แก้ fee 25', rules.feeFor({ id: 'SV-01', fee: 25, fee_per_sqm: null, sla_days: 3 }, { qty: 2 }).fee, 50);

// ---------------------------------------------------------------------------
// BR-05 · SV-03 ตามพื้นที่ · SV-02 ฿500 (TC-FEE-01)
// ---------------------------------------------------------------------------
const AREA_MSG = 'กรุณาระบุพื้นที่ 1–500 ตร.ม.';
const BIG_MSG = 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน';
for (const [area, fee] of [[1, 1000], [100, 1000], [101, 1010], [102, 1020], [250, 2500], [300, 3000], [499, 4990], [500, 5000]]) {
  eq(`BR-05 area ${area}`, rules.feeFor('SV-03', { area }).fee, fee);
}
for (const area of [0, -1, '', null, undefined, 'abc', 100.5]) {
  const r = rules.feeFor('SV-03', { area });
  eq(`BR-05 area ${JSON.stringify(area)} ✗`, [r.ok, r.code, r.status, r.message], [false, 'INVALID_AREA', 400, AREA_MSG]);
}
for (const area of [501, 1000, '501']) {
  const r = rules.feeFor('SV-03', { area });
  eq(`BR-05 area ${JSON.stringify(area)} ✗ เกิน`, [r.ok, r.code, r.status, r.message], [false, 'AREA_TOO_LARGE', 400, BIG_MSG]);
}
eq('BR-05 area "101" (สตริง)', rules.feeFor('SV-03', { area: '101' }).fee, 1010);
eq('BR-05 แถว DB SV-03', rules.feeFor({ id: 'SV-03', fee: 1000, fee_per_sqm: 10, sla_days: 15 }, { area: 101 }).fee, 1010);
eq('BR-05 SV-02 ฿500', rules.feeFor('SV-02').fee, 500);
eq('BR-05 SV-02 ไม่สน input', rules.feeFor('SV-02', { qty: 99, area: 999 }).fee, 500);
eq('BR-11 SV-02 หลัง admin แก้เป็น ฿600', rules.feeFor({ id: 'SV-02', fee: 600, sla_days: 10 }).fee, 600);
eq('feeFor บริการไม่รู้จัก', rules.feeFor('SV-09', {}).code, 'BAD_REQUEST');
check('feeOrThrow ✗ → HttpError 400', () => {
  assert.throws(() => rules.feeOrThrow('SV-03', { area: 501 }), (e) => e.code === 'AREA_TOO_LARGE' && e.status === 400 && e.message === BIG_MSG);
});
eq('feeOrThrow ✓', rules.feeOrThrow('SV-03', { area: 101 }), 1010);

// B01: area > 101 แทน ≥ 101
withBugs('B01', () => {
  eq('B01 area 101 → ฿1,000 (ผิดตามบั๊ก)', rules.feeFor('SV-03', { area: 101 }).fee, 1000);
  eq('B01 area 102 → ฿1,020 (ยังถูก)', rules.feeFor('SV-03', { area: 102 }).fee, 1020);
  eq('B01 area 100 → ฿1,000', rules.feeFor('SV-03', { area: 100 }).fee, 1000);
  eq('B01 area 500 → ฿5,000', rules.feeFor('SV-03', { area: 500 }).fee, 5000);
  eq('B01 ไม่กระทบ SV-01', rules.feeFor('SV-01', { qty: 3 }).fee, 60);
});

// ---------------------------------------------------------------------------
// BR-09 · เลขคำขอ EG-<พ.ศ.>-<6 หลัก> (TC-PAY-04)
// ---------------------------------------------------------------------------
eq('BR-09 ชำระ 31 ธ.ค. 2569 23:59 → EG-2569-000031', rules.caseNoFor(T('2026-12-31T23:59:00'), 31), 'EG-2569-000031');
eq('BR-09 31 ธ.ค. 23:59:59 ยังปี 2569', rules.seqName('case', T('2026-12-31T23:59:59')), 'case:2569');
eq('BR-09 ชำระ 1 ม.ค. 2570 00:00 → EG-2570-000001', rules.caseNoFor(T('2027-01-01T00:00:00'), 1), 'EG-2570-000001');
eq('BR-09 ตัวนับปีใหม่', rules.seqName('case', T('2027-01-01T00:00:00')), 'case:2570');
eq('BR-09 ปีจากเวลาไทย (UTC ยังเป็นปีเก่า)', rules.beYear('2026-12-31T17:00:00Z'), 2570);
eq('BR-11 ใบเสร็จ', rules.receiptNoFor(T('2026-12-01T09:00:00'), 31), 'RC-2569-000031');
eq('BR-23 เลขเอกสาร', rules.docNoFor(T('2028-02-29T10:00:00'), 1), 'DOC-2571-000001');
eq('BR-09 isCaseNo ✓', rules.isCaseNo('EG-2569-000031'), true);
eq('BR-09 isCaseNo ✗', rules.isCaseNo('EG-2569-31'), false);
check('BR-09 nextNumber ใช้ตัวนับแยกปี', () => {
  const counters = { 'case:2569': 30 };
  const fakeDb = { nextSeq: (n) => (counters[n] = (counters[n] || 0) + 1) };
  const got = [
    rules.nextNumber(fakeDb, 'case', T('2026-12-31T23:59:00')),
    rules.nextNumber(fakeDb, 'case', T('2027-01-01T00:00:00')),
    rules.nextNumber(fakeDb, 'case', T('2027-01-01T00:00:00')),
    rules.nextNumber(fakeDb, 'case', T('2026-12-01T09:00:00')),
  ];
  assert.deepStrictEqual(got, ['EG-2569-000031', 'EG-2570-000001', 'EG-2570-000002', 'EG-2569-000032']);
});

// ---------------------------------------------------------------------------
// BR-10 · QR ใช้ได้ถ้าอายุ < 15:00 (TC-PAY-01 · PP-0001 สร้าง 08:55:00)
// ---------------------------------------------------------------------------
const QR_CREATED = T('2026-12-01T08:55:00');
for (const [paid, ok] of [['09:00:00', true], ['09:09:59', true], ['09:10:00', false], ['09:10:01', false]]) {
  eq(`BR-10 ชำระ ${paid}`, rules.qrValid(QR_CREATED, T(`2026-12-01T${paid}`)), ok);
}
eq('BR-10 qrExpiresAt PP-0001', rules.qrExpiresAt(QR_CREATED), T('2026-12-01T09:10:00'));
eq('BR-10 qrExpiresAt QR ใหม่ 09:10 → 09:25', rules.qrExpiresAt(T('2026-12-01T09:10:00')), T('2026-12-01T09:25:00'));
eq('BR-10 qrAgeMs 15:00', rules.qrAgeMs(QR_CREATED, T('2026-12-01T09:10:00')), 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// BR-12 · กำหนดเสร็จ (DECISIONS §8 · TC-SLA-01 แถว a–i)
// ---------------------------------------------------------------------------
const SLA01 = [
  // [แถว, ชำระเมื่อ, N, dueAt ที่คาด, dueAt เมื่อเปิด B03 (null = ไม่ระบุใน BUGS)]
  ['a', '2026-12-01T09:00:00', 3, '2026-12-04', '2026-12-04'],
  ['b', '2026-12-01T16:29:00', 3, '2026-12-04', '2026-12-04'],
  ['c', '2026-12-01T16:30:00', 3, '2026-12-08', '2026-12-07'],
  ['d', '2026-12-04T10:00:00', 3, '2026-12-11', '2026-12-09'],
  ['e', '2026-12-05T10:00:00', 3, '2026-12-14', '2026-12-10'],
  ['f', '2026-12-01T09:00:00', 10, '2026-12-17', null],
  ['g', '2026-12-01T09:00:00', 15, '2026-12-24', null],
  ['h', '2026-12-29T10:00:00', 3, '2027-01-05', '2027-01-01'],
  ['i', '2026-12-31T23:59:00', 3, '2027-01-07', '2027-01-06'],
];
for (const [row, paid, n, due] of SLA01) {
  eq(`TC-SLA-01 แถว ${row}`, rules.computeDueAt(T(paid), n, HOLIDAYS), T(`${due}T16:30:00`));
}
eq('BR-12 ขอบวินาที 16:29:59 → ศ.4', rules.computeDueAt(T('2026-12-01T16:29:59'), 3, HOLIDAYS), T('2026-12-04T16:30:00'));
eq('BR-12 ขอบวินาที 16:30:00 → อ.8', rules.computeDueAt(T('2026-12-01T16:30:00'), 3, HOLIDAYS), T('2026-12-08T16:30:00'));
eq('BR-12 D0 16:30 = พ.2', rules.slaStartDay(T('2026-12-01T16:30:00'), HOLIDAYS), '2026-12-02');
eq('BR-12 D0 ส.5 = อ.8 (ข้าม จ.7)', rules.slaStartDay(T('2026-12-05T10:00:00'), HOLIDAYS), '2026-12-08');
eq('BR-12 D0 31 ธ.ค. 23:59 = จ.4 ม.ค.', rules.slaStartDay(T('2026-12-31T23:59:00'), HOLIDAYS), '2027-01-04');
eq('BR-12 รับวันหยุดแบบแถว DB', rules.computeDueAt(T('2026-12-04T10:00:00'), 3, HOLIDAY_ROWS), T('2026-12-11T16:30:00'));
eq('BR-12 รับวันหยุดแบบ Set', rules.computeDueAt(T('2026-12-04T10:00:00'), 3, new Set(HOLIDAYS)), T('2026-12-11T16:30:00'));
eq('BR-12 slaDays เป็นแถวบริการ', rules.computeDueAt(T('2026-12-01T09:00:00'), { id: 'SV-02', sla_days: 10 }, HOLIDAYS), T('2026-12-17T16:30:00'));
eq('BR-12 slaDays เป็นรหัสบริการ', rules.computeDueAt(T('2026-12-01T09:00:00'), 'SV-03', HOLIDAYS), T('2026-12-24T16:30:00'));
eq('BR-12 รับเวลา UTC (02:00Z = 09:00 ไทย)', rules.computeDueAt('2026-12-01T02:00:00Z', 3, HOLIDAYS), T('2026-12-04T16:30:00'));
eq('BR-12 รับ Date', rules.computeDueAt(new Date('2026-12-01T09:30:00+07:00'), 3, HOLIDAYS), T('2026-12-04T16:30:00'));
eq('BR-12 paidAt ว่าง → null', rules.computeDueAt(null, 3, HOLIDAYS), null);
eq('BR-12 วันหยุดเพิ่ม 2 ธ.ค. (TC-RBAC-04)', rules.computeDueAt(T('2026-12-01T09:00:00'), 3, [...HOLIDAYS, '2026-12-02']), T('2026-12-08T16:30:00'));

// B03: ไม่ข้ามวันหยุดในตาราง
withBugs('B03', () => {
  for (const [row, paid, n, , bugDue] of SLA01) {
    if (!bugDue) continue;
    eq(`B03 TC-SLA-01 แถว ${row}`, rules.computeDueAt(T(paid), n, HOLIDAYS), T(`${bugDue}T16:30:00`));
  }
  eq('B03 ยังข้าม ส-อา', rules.computeDueAt(T('2026-12-03T09:00:00'), 3, HOLIDAYS), T('2026-12-08T16:30:00'));
});

// ---------------------------------------------------------------------------
// BR-13 · หยุดนับระหว่าง NEED_FIX (TC-SLA-02)
// ---------------------------------------------------------------------------
const DUE_1204 = T('2026-12-04T16:30:00');
eq('TC-SLA-02 ส่วน 1 ตีกลับ พ.2 11:00 ส่งแก้ พฤ.3 10:00 → อ.8',
  rules.pauseExtend(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOLIDAYS), T('2026-12-08T16:30:00'));
eq('TC-SLA-02 ส่วน 1 pausedDays 1',
  rules.pauseDetail(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOLIDAYS).pausedDays, 1);
const SEED17_DUE = T('2026-11-27T16:30:00');
const SEED17_RET = T('2026-11-27T14:00:00');
eq('TC-SLA-02 ส่วน 2 seed 017 ส่งแก้ 1 ธ.ค. 09:00 → 1 ธ.ค. (2 วัน)',
  rules.pauseDetail(SEED17_DUE, SEED17_RET, T('2026-12-01T09:00:00'), HOLIDAYS), { dueAt: T('2026-12-01T16:30:00'), pausedDays: 2 });
eq('TC-SLA-02 ส่วน 3 seed 017 ส่งแก้ 4 ธ.ค. 10:00 → 4 ธ.ค. (5 วัน)',
  rules.pauseDetail(SEED17_DUE, SEED17_RET, T('2026-12-04T10:00:00'), HOLIDAYS), { dueAt: T('2026-12-04T16:30:00'), pausedDays: 5 });
eq('TC-SLA-02 ส่วน 4 ตีกลับและส่งแก้วันเดียวกัน → หยุด 0',
  rules.pauseDetail(DUE_1204, T('2026-12-02T09:00:00'), T('2026-12-02T15:00:00'), HOLIDAYS), { dueAt: DUE_1204, pausedDays: 0 });
eq('TC-SLA-02 ส่วน 5 ตีกลับ ศ.4 ส่งแก้ อ.8 17:00 → อ.8 (1 วัน)',
  rules.pauseDetail(DUE_1204, T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00'), HOLIDAYS), { dueAt: T('2026-12-08T16:30:00'), pausedDays: 1 });
eq('TC-SLA-02 ส่วน 5 ระดับหลังส่งแก้ = เกินกำหนด',
  rules.slaLevel(T('2026-12-08T17:00:00'), T('2026-12-08T16:30:00'), HOLIDAYS, 'IN_REVIEW'), 'overdue');
eq('BR-13 countWorkingDays (2 ธ.ค., 3 ธ.ค.]', rules.countWorkingDays('2026-12-02', '2026-12-03', HOLIDAYS), 1);
eq('BR-13 countWorkingDays ช่วงกลับด้าน = 0', rules.countWorkingDays('2026-12-05', '2026-12-01', HOLIDAYS), 0);
eq('BR-13 ใช้ตารางวันหยุด ณ ส่งแก้ (เพิ่ม 3 ธ.ค.)',
  rules.pauseExtend(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), [...HOLIDAYS, '2026-12-03']), DUE_1204);

// B04: ไม่หยุดนับ
withBugs('B04', () => {
  eq('B04 ส่วน 1 dueAt ยัง 4 ธ.ค.', rules.pauseExtend(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOLIDAYS), DUE_1204);
  eq('B04 seed 017 ยัง 27 พ.ย.', rules.pauseDetail(SEED17_DUE, SEED17_RET, T('2026-12-01T09:00:00'), HOLIDAYS), { dueAt: SEED17_DUE, pausedDays: 0 });
  eq('B04 seed 017 ระดับ = เกินกำหนด', rules.slaLevel(T('2026-12-01T09:00:00'), SEED17_DUE, HOLIDAYS, 'IN_REVIEW'), 'overdue');
  eq('B04 ไม่กระทบ computeDueAt', rules.computeDueAt(T('2026-12-01T16:30:00'), 3, HOLIDAYS), T('2026-12-08T16:30:00'));
});
// B03 กระทบหยุดนับ (BUGS: แถวที่ 6 ได้ 7 ธ.ค.)
withBugs('B03', () => {
  eq('B03 หยุดนับแถว 6 → 7 ธ.ค.', rules.pauseExtend(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOLIDAYS), T('2026-12-07T16:30:00'));
});
withBugs('B03,B04', () => {
  eq('B03+B04 รวมกัน: computeDueAt ผิดแบบ B03', rules.computeDueAt(T('2026-12-01T16:30:00'), 3, HOLIDAYS), T('2026-12-07T16:30:00'));
  eq('B03+B04 รวมกัน: pauseExtend ไม่ขยาย', rules.pauseExtend(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOLIDAYS), DUE_1204);
});

// ---------------------------------------------------------------------------
// BR-14 · ระดับเตือน (TC-SLA-03)
// ---------------------------------------------------------------------------
for (const [now, left, level] of [
  ['2026-12-01T09:00:00', 3, 'normal'],
  ['2026-12-02T09:00:00', 2, 'normal'],
  ['2026-12-03T09:00:00', 1, 'near'],
  ['2026-12-04T16:30:00', 0, 'near'],
  ['2026-12-04T16:30:01', 0, 'overdue'],
  ['2026-12-04T16:31:00', 0, 'overdue'],
  ['2026-12-05T10:00:00', 0, 'overdue'],
]) {
  eq(`TC-SLA-03 A ${now} level`, rules.slaLevel(T(now), DUE_1204, HOLIDAYS), level);
  eq(`TC-SLA-03 A ${now} วันคงเหลือ`, rules.remainingWorkingDays(T(now), DUE_1204, HOLIDAYS), left);
}
const DUE_1208 = T('2026-12-08T16:30:00');
for (const [now, left, level] of [
  ['2026-12-03T09:00:00', 2, 'normal'],
  ['2026-12-04T09:00:00', 1, 'near'],
  ['2026-12-08T16:30:00', 0, 'near'],
  ['2026-12-08T16:31:00', 0, 'overdue'],
]) {
  eq(`TC-SLA-03 B ${now} level`, rules.slaLevel(T(now), DUE_1208, HOLIDAYS), level);
  eq(`TC-SLA-03 B ${now} วันคงเหลือ`, rules.remainingWorkingDays(T(now), DUE_1208, HOLIDAYS), left);
}
const NOW0 = T('2026-12-01T09:00:00');
for (const [no, due, level] of [
  ['020', '2026-11-30', 'overdue'],
  ['022', '2026-12-01', 'near'],
  ['024', '2026-12-02', 'near'],
  ['025', '2026-12-03', 'normal'],
]) {
  eq(`TC-SLA-03 C …000${no}`, rules.slaLevel(NOW0, T(`${due}T16:30:00`), HOLIDAYS, 'IN_REVIEW'), level);
}
eq('TC-SLA-03 C …000022 16:30:00 ใกล้', rules.slaLevel(T('2026-12-01T16:30:00'), T('2026-12-01T16:30:00'), HOLIDAYS), 'near');
eq('TC-SLA-03 C …000022 16:31:00 เกิน', rules.slaLevel(T('2026-12-01T16:31:00'), T('2026-12-01T16:30:00'), HOLIDAYS), 'overdue');
eq('TC-SLA-03 C NEED_FIX → paused', rules.slaLevel(NOW0, SEED17_DUE, HOLIDAYS, 'NEED_FIX'), 'paused');
for (const st of ['COMPLETED', 'REJECTED', 'CANCELLED']) {
  eq(`TC-SLA-03 C ${st} → closed`, rules.slaLevel(NOW0, DUE_1204, HOLIDAYS, st), 'closed');
}
eq('BR-14 DRAFT → null', rules.slaLevel(NOW0, null, HOLIDAYS, 'DRAFT'), null);
eq('BR-14 ไม่มี dueAt → null', rules.slaLevel(NOW0, null, HOLIDAYS), null);
eq('BR-14 caseSlaLevel แถว DB', rules.caseSlaLevel({ status: 'IN_REVIEW', due_at: T('2026-12-02T16:30:00') }, NOW0, HOLIDAY_ROWS), 'near');
eq('TC-SLA-02 ส่วน 1 หลังส่งแก้ = ปกติ (ศ.4, อ.8)', rules.slaLevel(T('2026-12-03T10:00:00'), DUE_1208, HOLIDAYS, 'IN_REVIEW'), 'normal');
eq('TC-SLA-02 ส่วน 2 หลังส่งแก้ = ใกล้ (เหลือ 0)', rules.slaLevel(T('2026-12-01T09:00:00'), T('2026-12-01T16:30:00'), HOLIDAYS, 'IN_REVIEW'), 'near');
eq('TC-SLA-02 ส่วน 3 หลังส่งแก้ = ใกล้', rules.slaLevel(T('2026-12-04T10:00:00'), DUE_1204, HOLIDAYS, 'IN_REVIEW'), 'near');
withBugs('B03', () => {
  eq('B03 TC-SLA-03 B ศ.4 09:00 → ปกติ (นับ จ.7)', rules.slaLevel(T('2026-12-04T09:00:00'), DUE_1208, HOLIDAYS), 'normal');
  eq('B03 TC-SLA-03 A ไม่กระทบ', rules.slaLevel(T('2026-12-03T09:00:00'), DUE_1204, HOLIDAYS), 'near');
});

// ---------------------------------------------------------------------------
// BR-20 · เวลาแก้ไข 168 ชม. (TC-WORKFLOW-06 · seed 017 ตีกลับ 27 พ.ย. 14:00)
// ---------------------------------------------------------------------------
eq('BR-20 fixDeadline', rules.fixDeadline(SEED17_RET), T('2026-12-04T14:00:00'));
eq('BR-20 167:59 ส่งแก้ได้', rules.fixWindowOpen(SEED17_RET, T('2026-12-04T13:59:00')), true);
eq('BR-20 167:59:59 ส่งแก้ได้', rules.fixWindowOpen(SEED17_RET, T('2026-12-04T13:59:59')), true);
eq('BR-20 168:00 หมดเวลา', rules.fixWindowOpen(SEED17_RET, T('2026-12-04T14:00:00')), false);
eq('BR-20 168:00 fixExpired', rules.fixExpired(SEED17_RET, T('2026-12-04T14:00:00')), true);
eq('BR-20 ตีกลับ 2 ธ.ค. 11:00 → เส้นตาย 9 ธ.ค. 11:00', rules.fixDeadline(T('2026-12-02T11:00:00')), T('2026-12-09T11:00:00'));

// ---------------------------------------------------------------------------
// BR-23 · อายุเอกสาร (TC-DOC-01 · TC-DOC-02 · TC-DOC-03)
// ---------------------------------------------------------------------------
eq('BR-23 SV-01 ออก 1 ธ.ค. 69 → 28 ก.พ. 70', rules.docValidUntil('SV-01', T('2026-12-01T09:00:00')), '2027-02-28');
eq('BR-23 SV-02 ออก 1 ธ.ค. 69 → 30 พ.ย. 70', rules.docValidUntil('SV-02', T('2026-12-01T09:00:00')), '2027-11-30');
eq('BR-23 SV-03 ออก 1 ธ.ค. 69 → 30 พ.ย. 70', rules.docValidUntil('SV-03', T('2026-12-01T09:00:00')), '2027-11-30');
eq('BR-23 SV-02 ออก 29 ก.พ. 2571 → 27 ก.พ. 2572', rules.docValidUntil('SV-02', T('2028-02-29T10:00:00')), '2029-02-27');
eq('BR-23 SV-01 ออก 29 ก.พ. 2571 → 28 พ.ค. 2571', rules.docValidUntil('SV-01', T('2028-02-29T10:00:00')), '2028-05-28');
eq('BR-23 seed K7M2Q9XA ออก 5 พ.ย. 69 → 2 ก.พ. 70', rules.docValidUntil('SV-01', T('2026-11-05T10:00:00')), '2027-02-02');
eq('BR-23 รับแถวบริการ', rules.docValidUntil({ id: 'SV-02' }, '2026-12-01'), '2027-11-30');
eq('BR-23 ออก 28 ก.พ. (ปีอธิกสุรทิน) SV-02 → 27 ก.พ. ปีถัดไป', rules.docValidUntil('SV-02', '2027-02-28'), '2028-02-27');
for (const [validUntil, now, expired] of [
  ['2027-02-28', '2027-02-28T23:59:00', false],
  ['2027-02-28', '2027-02-28T23:59:59', false],
  ['2027-02-28', '2027-03-01T00:00:00', true],
  ['2027-11-30', '2027-11-30T23:59:00', false],
  ['2027-11-30', '2027-12-01T00:00:00', true],
  ['2027-02-02', '2027-02-02T23:59:00', false],
  ['2027-02-02', '2027-02-03T00:00:00', true],
  ['2028-05-28', '2028-05-28T23:59:00', false],
  ['2028-05-28', '2028-05-29T00:00:00', true],
  ['2029-02-27', '2029-02-27T23:59:00', false],
  ['2029-02-27', '2029-02-28T00:00:00', true],
]) {
  eq(`BR-23 docExpired ${validUntil} @ ${now}`, rules.docExpired(validUntil, T(now)), expired);
}
eq('BR-23 docExpired ใช้วันที่ไทย (2027-02-28T17:00Z = 1 มี.ค. 00:00 ไทย)', rules.docExpired('2027-02-28', '2027-02-28T17:00:00Z'), true);

// ---------------------------------------------------------------------------
// BR-25 · ทันกำหนด (TC-DASH-04 · TC-DASH-02)
// ---------------------------------------------------------------------------
const DUE_1203 = T('2026-12-03T16:30:00');
eq('BR-25 ปิด 16:29:59 ทัน', rules.isOnTime(T('2026-12-03T16:29:59'), DUE_1203), true);
eq('BR-25 ปิด 16:30:00 ทัน (ที่ขอบ)', rules.isOnTime(T('2026-12-03T16:30:00'), DUE_1203), true);
eq('BR-25 ปิด 16:30:01 ไม่ทัน', rules.isOnTime(T('2026-12-03T16:30:01'), DUE_1203), false);
eq('BR-25 ปิด 16:31 ไม่ทัน', rules.isOnTime(T('2026-12-03T16:31:00'), DUE_1203), false);
for (const [closed, onTime, pct, text] of [
  [0, 0, null, '–'],
  [7, 6, 85.7, '85.7%'],
  [3, 2, 66.7, '66.7%'],
  [1, 1, 100, '100.0%'],
  [8, 7, 87.5, '87.5%'],
  [3, 3, 100, '100.0%'],
  [3, 0, 0, '0.0%'],
  [16, 1, 6.3, '6.3%'], // 6.25 → ปัดครึ่งขึ้น
  [3, 1, 33.3, '33.3%'],
]) {
  eq(`BR-25 onTimePct ${onTime}/${closed}`, rules.onTimePct(closed, onTime), pct);
  eq(`BR-25 fmtPct ${onTime}/${closed}`, rules.fmtPct(rules.onTimePct(closed, onTime)), text);
}
eq('BR-26 ปีไม่ใช่ค่าเฉลี่ย (ไม่ใช่ 92.9)', rules.onTimePct(1 + 7, 1 + 6) !== 92.9, true);
eq('BR-25 TC-DASH-04 3 ใบ ทัน 2 → 66.7', rules.onTimePct(3, 2), 66.7);
eq('BR-25 B10 oracle 6/26 = 23.1 (ค่าที่บั๊กให้ · คำนวณใน dashboard)', rules.onTimePct(26, 6), 23.1);

// ---------------------------------------------------------------------------
// วันทำการพื้นฐาน
// ---------------------------------------------------------------------------
eq('วันทำการ อ.1 ธ.ค.', rules.isWorkingDay('2026-12-01', HOLIDAYS), true);
eq('วันหยุด จ.7 ธ.ค.', rules.isWorkingDay('2026-12-07', HOLIDAYS), false);
eq('เสาร์ไม่ใช่วันทำการ', rules.isWorkingDay('2026-12-05', HOLIDAYS), false);
eq('nextWorkingDay ศ.4 → อ.8', rules.nextWorkingDay('2026-12-04', HOLIDAYS), '2026-12-08');
eq('addWorkingDays 0 วัน', rules.addWorkingDays('2026-12-05', 0, HOLIDAYS), '2026-12-05');
withBugs('B03', () => {
  eq('B03 จ.7 นับเป็นวันทำการ', rules.isWorkingDay('2026-12-07', HOLIDAYS), true);
  eq('B03 เสาร์ยังไม่ใช่วันทำการ', rules.isWorkingDay('2026-12-05', HOLIDAYS), false);
});
withBugs('B01,B05,B09', () => {
  eq('BUG_MODE อื่นไม่กระทบ SLA', rules.computeDueAt(T('2026-12-01T16:30:00'), 3, HOLIDAYS), T('2026-12-08T16:30:00'));
  eq('BUG_MODE อื่นไม่กระทบหยุดนับ', rules.pauseExtend(DUE_1204, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOLIDAYS), T('2026-12-08T16:30:00'));
});

// ---------------------------------------------------------------------------
if (ORIGINAL_BUG_MODE === undefined) delete process.env.BUG_MODE;
else process.env.BUG_MODE = ORIGINAL_BUG_MODE;

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f.name}\n    ${f.msg}`);
  console.error(`\nrules.selftest: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`rules.selftest: ${passed} passed, 0 failed`);
