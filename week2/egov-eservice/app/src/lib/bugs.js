'use strict';
/**
 * BUG_MODE (BUGS.md · DECISIONS §15–16)
 *
 *   BUG_MODE=B03,B07  → isBug('B03') === true, isBug('B07') === true
 *   ไม่ตั้ง/ว่าง       → isBug(...) === false เสมอ (เว็บถูกต้อง 100%)
 *
 * ใช้: const { isBug } = require('../lib/bugs');  if (isBug('B01')) { ...พฤติกรรมผิดเฉพาะจุด... }
 * อ่าน process.env ทุกครั้งที่เรียก (selftest เปลี่ยน process.env.BUG_MODE ระหว่างรันได้)
 * กติกา: บั๊กเปลี่ยนเฉพาะตรรกะฝั่งเซิร์ฟเวอร์จุดที่ระบุ ไม่เปลี่ยนข้อความ ไม่เปลี่ยน seed
 */

const { isTestMode } = require('./clock');

const KNOWN = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12'];

/** 'b3' / 'B3' / ' B03 ' → 'B03' */
function normalize(code) {
  const s = String(code || '').trim().toUpperCase();
  const m = /^B0*(\d+)$/.exec(s);
  if (!m) return s;
  return `B${m[1].padStart(2, '0')}`;
}

/** Set ของรหัสบั๊กที่เปิดอยู่ */
function activeBugs() {
  const raw = String(process.env.BUG_MODE || '');
  return new Set(
    raw
      .split(/[,\s;]+/)
      .map(normalize)
      .filter(Boolean)
  );
}

/** เปิดบั๊กรหัสนี้อยู่หรือไม่ */
function isBug(code) {
  return activeBugs().has(normalize(code));
}

module.exports = { isBug, activeBugs, normalize, isTestMode, KNOWN_BUGS: KNOWN };
