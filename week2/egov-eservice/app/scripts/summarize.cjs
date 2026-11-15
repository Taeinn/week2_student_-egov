#!/usr/bin/env node
'use strict';
/**
 * สรุปผล Playwright JSON (ไฟล์จาก scripts/bug-matrix.sh) เทียบกับตาราง BUGS.md §2
 * ใช้: node scripts/summarize.cjs test-results/matrix/clean.json test-results/matrix/B01.json ...
 * ชื่อไฟล์ = โหมด (clean · B01 · B03,B07 · ...) · ไฟล์ <โหมด>.serverlog = บรรทัดแรกของ log เว็บ (ยืนยัน BUG_MODE)
 */
const fs = require('fs');
const path = require('path');

// BUGS.md §2: TC ที่ต้องล้ม / TC ที่อาจล้มด้วย
const EXPECT = {
  B01: { must: ['TC-FEE-01'], may: [] },
  B02: { must: ['TC-UPLOAD-01'], may: [] },
  B03: { must: ['TC-SLA-01', 'TC-SLA-02'], may: ['TC-SLA-03', 'TC-RBAC-04'] },
  B04: { must: ['TC-SLA-02'], may: [] },
  B05: { must: ['TC-PAY-01'], may: [] },
  B06: { must: ['TC-RBAC-01'], may: [] },
  B07: { must: ['TC-RBAC-02'], may: ['TC-WORKFLOW-01'] },
  B08: { must: ['TC-QUEUE-02'], may: [] },
  B09: { must: ['TC-PDPA-02'], may: [] },
  B10: { must: ['TC-DASH-02'], may: ['TC-DASH-01', 'TC-DASH-03'] },
  B11: { must: ['TC-PDPA-03', 'TC-AUDIT-01'], may: [] },
  B12: { must: ['TC-WORKFLOW-04'], may: [] },
};

// TC ที่ล้มเกินตาราง BUGS.md §2 แต่ตรวจแล้วว่าเป็นกลไกเดียวกับที่ BUGS/DECISIONS อธิบาย → แยกรายงาน รอ TA ยืนยัน
// B03: ฟังก์ชันวันทำการตัวเดียวใช้นับ "วันคงเหลือ" (DECISIONS §18) → …000016/…000011 ที่ ส.5 ธ.ค. 10:00 เป็น ปกติ แทน ใกล้ครบกำหนด
//      → ไม่เกิดแจ้งเตือน near ใน TC-NOTI-02 ส่วน B (ดู INTEGRATION.md คำถามถึง TA ข้อ 1)
const KNOWN_EXTRA = { B03: ['TC-NOTI-02'] };

function knownExtraFor(mode) {
  const out = new Set();
  for (const b of String(mode).split(',').map(s => s.trim())) (KNOWN_EXTRA[b] || []).forEach(t => out.add(t));
  return out;
}

function expectedFor(mode) {
  if (mode === '' || mode.startsWith('clean')) return { must: [], may: [] };
  const must = new Set(); const may = new Set();
  for (const b of mode.split(',').map(s => s.trim()).filter(Boolean)) {
    const e = EXPECT[b];
    if (!e) throw new Error(`ไม่รู้จักบั๊ก ${b}`);
    e.must.forEach(t => must.add(t)); e.may.forEach(t => may.add(t));
  }
  for (const t of must) may.delete(t);
  return { must: [...must], may: [...may] };
}

const strip = s => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

function collect(suite, out) {
  for (const s of suite.suites || []) collect(s, out);
  for (const spec of suite.specs || []) {
    const id = (/^(TC-[A-Z]+-\d+)/.exec(spec.title) || [])[1] || spec.title;
    for (const t of spec.tests || []) {
      const results = t.results || [];
      const last = results[results.length - 1] || {};
      const err = (last.errors && last.errors[0]) || last.error || {};
      const msg = strip(err.message || '').split('\n').map(l => l.trim()).filter(Boolean);
      out.push({ id, title: spec.title, status: last.status || t.status, ms: last.duration || 0, msg });
    }
  }
}

const args = process.argv.slice(2);
const MD = args.includes('--md'); // พิมพ์เฉพาะตาราง markdown (ผลรวม + triage ตาม BUGS.md §4) สำหรับ INTEGRATION.md
const rows = [];
for (const file of args.filter(a => a !== '--md')) {
  const mode = path.basename(file).replace(/\.json$/, '');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tests = [];
  for (const s of j.suites || []) collect(s, tests);
  const failed = tests.filter(t => t.status !== 'passed' && t.status !== 'skipped');
  const skipped = tests.filter(t => t.status === 'skipped');
  const passed = tests.filter(t => t.status === 'passed');
  const exp = expectedFor(mode);
  const failedIds = failed.map(t => t.id);
  const missing = exp.must.filter(t => !failedIds.includes(t));
  const known = knownExtraFor(mode);
  const extraAll = failedIds.filter(t => !exp.must.includes(t) && !exp.may.includes(t));
  const knownExtra = extraAll.filter(t => known.has(t));
  const extra = extraAll.filter(t => !known.has(t));
  const sideEffects = failedIds.filter(t => exp.may.includes(t));
  // ล้มเพราะ timeout / หา element ไม่เจอ (BUGS.md §5) ≠ ค่าไม่ตรง · "Timeout: 5000ms" ของ toHaveText ที่มี Received ไม่นับ
  const timeouts = failed.filter(t => {
    const m = t.msg.join(' ');
    return t.status === 'timedOut' || /Test timeout of|element\(s\) not found|Target (page|closed)|net::ERR/i.test(m);
  });
  let serverLine = '';
  const sl = file.replace(/\.json$/, '.serverlog');
  if (fs.existsSync(sl)) serverLine = fs.readFileSync(sl, 'utf8').split('\n').find(l => l.includes('BUG_MODE')) || '';
  const ok = tests.length === 51 && missing.length === 0 && extra.length === 0 && skipped.length === 0;
  rows.push({ mode, total: tests.length, passed: passed.length, failed, skipped: skipped.length, exp, missing, extra, knownExtra, sideEffects, timeouts, ok, serverLine });
}

function keyMsg(t) {
  // บรรทัดแรก (ข้อความ assert) + Expected/Received ตัวแรก = "ค่าจริงต่างจากค่าที่คาดตรงไหน" (BUGS.md §3 ขั้น 4)
  const key = t.msg.filter((l, i) => i === 0 || /^(Expected|Received|Error:)/.test(l)).slice(0, 5);
  const diff = t.msg.filter(l => /^[-+]\s+(Array|Object|["\d\[\{])/.test(l)).slice(0, 4); // บรรทัด diff ของ toEqual (array/object)
  if (diff.length) key.push(`diff: ${diff.join(' ')}`);
  return key.join(' | ').replace(/\s+/g, ' ').slice(0, 500);
}

function verdictOf(r) {
  // ⚠️ = จับได้ แต่ล้มด้วย timeout/หา element ไม่เจอ แทนค่าต่าง (BUGS.md §3 ขั้น 4 · §5 = test เปราะ)
  return !r.ok ? '❌' : r.timeouts.length ? '⚠️' : r.knownExtra.length ? '✅*' : '✅';
}

if (MD) {
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/`/g, "'");
  console.log('| โหมด (BUG_MODE) | passed / failed | TC ที่คาดว่าล้ม (BUGS.md §2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const expCell = (r.exp.must.join(' · ') || '–') + (r.exp.may.length ? ` (อาจล้มด้วย ${r.exp.may.join(' · ')})` : '');
    const extraCell = [...r.extra, ...r.knownExtra.map(t => `${t} (กลไกเดียวกัน · Q-TA-1)`)].join(' · ') || '–';
    console.log(`| ${r.mode} | ${r.passed} / ${r.failed.length} | ${expCell} | ${r.failed.map(t => t.id).join(' · ') || '–'} | ${extraCell} | ${r.missing.join(' · ') || '–'} | ${verdictOf(r)} |`);
  }
  const withFail = rows.filter(r => r.failed.length);
  if (withFail.length) {
    console.log('\nข้อความ assert แรกที่ล้ม (ค่าที่คาด → ค่าจริง):\n');
    console.log('| โหมด | TC | ข้อความ |');
    console.log('|---|---|---|');
    for (const r of withFail) for (const t of r.failed) console.log(`| ${r.mode} | ${t.id} | ${esc(keyMsg(t))} |`);
  }
  process.exit(rows.every(r => r.ok) ? 0 : 1);
}

for (const r of rows) {
  console.log(`\n=== ${r.mode} · ${r.passed} passed · ${r.failed.length} failed · ${r.skipped} skipped · total ${r.total} → ${r.ok ? (r.knownExtra.length ? 'OK* (มี TC ล้มเกินตาราง · รอ TA)' : 'OK') : 'NOT OK'}`);
  if (r.serverLine) console.log(`    server: ${r.serverLine.trim()}`);
  console.log(`    คาดว่าล้ม: ${r.exp.must.join(' · ') || '–'}${r.exp.may.length ? ` (อาจล้มด้วย ${r.exp.may.join(' · ')})` : ''}`);
  console.log(`    ล้มจริง:   ${r.failed.map(t => t.id).join(' · ') || '–'}`);
  if (r.extra.length) console.log(`    ล้มเกินที่คาด: ${r.extra.join(' · ')}`);
  if (r.knownExtra.length) console.log(`    ล้มเกินตาราง แต่เป็นกลไกเดียวกัน (รอ TA ยืนยัน): ${r.knownExtra.join(' · ')}`);
  if (r.missing.length) console.log(`    ควรล้มแต่ผ่าน: ${r.missing.join(' · ')}`);
  if (r.timeouts.length) console.log(`    ล้มด้วย timeout/หา element ไม่เจอ: ${r.timeouts.map(t => t.id).join(' · ')}`);
  for (const t of r.failed) console.log(`    - ${t.id}: ${keyMsg(t)}`);
}
console.log('\n| โหมด | passed | failed | TC ที่ล้มจริง | ล้มเกินที่คาด | ควรล้มแต่ผ่าน | ผล |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  const extraCell = [...r.extra, ...r.knownExtra.map(t => `${t} (กลไกเดียวกัน · รอ TA)`)].join(' · ') || '–';
  const verdict = verdictOf(r);
  console.log(`| ${r.mode} | ${r.passed} | ${r.failed.length} | ${r.failed.map(t => t.id).join(' · ') || '–'} | ${extraCell} | ${r.missing.join(' · ') || '–'} | ${verdict} |`);
}
process.exitCode = rows.every(r => r.ok) ? 0 : 1;
