'use strict';
/**
 * B09 · Dashboard ผู้บริหาร + ส่งออก Excel/PDF
 * REQUIREMENTS FR-22 FR-23 BR-24 BR-25 BR-26 · CONTRACT §1 §2.9 §6.4 §6.8 §7 · TEST-DATA §7 · DECISIONS §12 §18
 *
 * หน้า:
 *   GET /dashboard?period=2026-11&service=ALL       (executive เท่านั้น · อื่น 403 forbidden-msg · ไม่ล็อกอิน → /login)
 *     period-select / service-select เปลี่ยนแล้วโหลดหน้าใหม่เอง (ฟอร์ม GET · ไม่มีปุ่ม "แสดงผล" ถ้ามี JavaScript)
 *
 * API:
 *   GET /api/dashboard?period=2026-11&service=ALL
 *     → 200 {"received","closed","onTime","ontimePct","backlog","overdue","workload":[{username,count}],"period","service"}
 *       (ontimePct = null เมื่อปิดงาน 0) · 400 BAD_REQUEST ถ้า period/service ผิดรูปแบบ · 401/403 ตาม rbac
 *   GET /api/dashboard/export?format=xlsx|pdf&period=…&service=…
 *     → ไฟล์ตาม CONTRACT §7 (ตัวเลขชุดเดียวกับจอ) + Audit EXPORT detail `<format> <period> <service>`
 *
 * นิยาม (BR-25 · DECISIONS §12 §18):
 *   period   = 'YYYY-MM' (เดือน) หรือ 'YYYY' (ทั้งปี ค.ศ. · 2026 = ปี 2569) · ไม่ระบุ = เดือนของนาฬิกา
 *              (รับปี พ.ศ. ได้ด้วย เช่น 2569-11 → 2026-11)
 *   รับเรื่อง = คำขอที่มีเลขคำขอ (ชำระสำเร็จ) และ paid_at อยู่ในช่วง (รวม CANCELLED ที่เคยชำระ)
 *   ปิดงาน   = COMPLETED + REJECTED ที่ closed_at อยู่ในช่วง (CANCELLED ไม่นับ)
 *   ทัน      = ปิดงานที่ closed_at ≤ due_at (rules.isOnTime · 16:30:00 ทัน · 16:30:01 ไม่ทัน)
 *   ทันกำหนด % = rules.onTimePct(ปิดงาน, ทัน) (ทศนิยม 1 ปัดครึ่งขึ้น · ปิดงาน 0 → null → '–')
 *   รายปี    = นับรวมทั้งปีแล้วคิด % จากยอดรวม (ไม่เฉลี่ย % รายเดือน · BR-26)
 *   งานคงค้าง = SUBMITTED+IN_REVIEW+NEED_FIX+PENDING_APPROVAL+APPROVED ณ ตอนนี้ (ไม่ขึ้นกับช่วง · ขึ้นกับบริการ · A-41)
 *   เกินกำหนดคงค้าง = คงค้างที่ไม่ใช่ NEED_FIX และนาฬิกาตอนนี้ > due_at
 *   งานในมือ  = IN_REVIEW ที่เจ้าหน้าที่แต่ละคนถือ (owner_id) ณ ตอนนี้ · แสดงเจ้าหน้าที่ (role officer) ทุกคนแม้ 0
 *              · กรองตามบริการที่เลือก (เหมือนงานคงค้าง) · ไม่ขึ้นกับช่วง
 *
 * ข้อมูลส่วนบุคคล (BR-24): หน้า/ไฟล์ส่งออกแสดงเฉพาะตัวเลขรวม + ชื่อบัญชีเจ้าหน้าที่ · ไม่ดึงชื่อ/เลขบัตร/เบอร์ของผู้ยื่นเลย
 *
 * BUG_MODE:
 *   B10  ทันกำหนด % หารด้วย "รับเรื่อง" แทน "ปิดงาน" (พ.ย. 6÷26 = 23.1% · ธ.ค. 0÷3 = 0.0% · ปี 7÷30 = 23.3%)
 *        กระทบจอ + API (ontimePct) + ไฟล์ส่งออก เพราะใช้ฟังก์ชันคำนวณเดียวกัน · ไม่เปลี่ยน onTime/closed
 */

const fs = require('fs');
const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const { isBug } = require('../lib/bugs');
const { sendError } = require('../lib/errors');
const { requireRole } = require('../lib/rbac');
const { BACKLOG_STATUSES, CLOSED_STATUSES, SERVICES, SERVICE_IDS, DEPT_LABELS } = require('../lib/constants');
const { esc, timeTag } = require('../lib/format');
const { sendPage } = require('../views/layout');

const router = express.Router();

// ---------------------------------------------------------------------------
// ค่าคงที่
// ---------------------------------------------------------------------------

/** ลำดับและป้ายตัวชี้วัด (ใช้ทั้งจอ · xlsx คอลัมน์ A · PDF) — CONTRACT §2.9 §7 */
const KPI_ROWS = [
  { key: 'received', testid: 'kpi-received', label: 'รับเรื่อง', ascii: 'received', hint: 'คำขอที่ชำระสำเร็จ (มีเลขคำขอ) ในช่วงที่เลือก' },
  { key: 'closed', testid: 'kpi-closed', label: 'ปิดงาน', ascii: 'closed', hint: 'เสร็จสิ้น + ไม่อนุมัติ ที่ปิดในช่วงที่เลือก' },
  { key: 'ontime', testid: 'kpi-ontime-pct', label: 'ทันกำหนด %', ascii: 'ontime', hint: 'ปิดงานที่ทันกำหนด ÷ ปิดงาน' },
  { key: 'backlog', testid: 'kpi-backlog', label: 'งานคงค้าง', ascii: 'backlog', hint: 'ค่า ณ ตอนนี้ (ไม่ขึ้นกับช่วงที่เลือก)' },
  { key: 'overdue', testid: 'kpi-overdue', label: 'เกินกำหนดคงค้าง', ascii: 'overdue', hint: 'งานคงค้างที่เลยกำหนดเสร็จ (ไม่นับรอแก้ไขเอกสาร)' },
];

const TH_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

const FORMATS = {
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
};

const BE_OFFSET = 543;
const PERIOD_MONTHS_BACK = 12; // ตัวเลือกเดือนใน period-select: เดือนปัจจุบันย้อนหลังรวม 12 เดือน

// ---------------------------------------------------------------------------
// ช่วงเวลา / บริการ
// ---------------------------------------------------------------------------

const p2 = (n) => String(n).padStart(2, '0');

/** ปี พ.ศ. ที่ส่งมา (≥ 2400) → ค.ศ. */
function toCe(year) {
  return year >= 2400 ? year - BE_OFFSET : year;
}

/** ช่วงเริ่มต้น = เดือนของนาฬิกา */
function defaultPeriod() {
  const n = clock.parts(clock.nowMs());
  return { kind: 'month', year: n.year, month: n.month, value: `${n.year}-${p2(n.month)}` };
}

/**
 * แปลงค่า period → { kind: 'month'|'year', year, month?, value } · ว่าง = เดือนของนาฬิกา · ผิดรูปแบบ = null
 */
function parsePeriod(raw) {
  if (raw === undefined || raw === null) return defaultPeriod();
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (s === '') return defaultPeriod();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) {
    const year = toCe(Number(m[1]));
    const month = Number(m[2]);
    if (month < 1 || month > 12 || year < 1900 || year > 2400) return null;
    return { kind: 'month', year, month, value: `${year}-${p2(month)}` };
  }
  m = /^(\d{4})$/.exec(s);
  if (m) {
    const year = toCe(Number(m[1]));
    if (year < 1900 || year > 2400) return null;
    return { kind: 'year', year, value: String(year) };
  }
  return null;
}

/** 'ALL' | 'SV-01' | 'SV-02' | 'SV-03' · ว่าง = ALL · ผิด = null */
function parseService(raw) {
  if (raw === undefined || raw === null) return 'ALL';
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim().toUpperCase();
  if (s === '' || s === 'ALL') return 'ALL';
  return SERVICE_IDS.includes(s) ? s : null;
}

/** ป้ายช่วงภาษาไทย: 'พฤศจิกายน 2569' · 'ทั้งปี 2569' */
function periodLabel(p) {
  if (p.kind === 'year') return `ทั้งปี ${p.year + BE_OFFSET}`;
  return `${TH_MONTHS[p.month - 1]} ${p.year + BE_OFFSET}`;
}

function serviceLabel(service) {
  if (service === 'ALL') return 'ทุกบริการ';
  const svc = SERVICES[service];
  return svc ? `${service} ${svc.name}` : service;
}

/** เวลา (ISO/Date/ms) อยู่ในช่วงหรือไม่ (เทียบตามวันที่เวลาไทย) */
function inPeriod(at, p) {
  if (at == null || at === '') return false;
  const t = clock.parts(at);
  if (!t) return false;
  if (t.year !== p.year) return false;
  return p.kind === 'year' || t.month === p.month;
}

/** ตัวเลือกของ period-select: เดือนปัจจุบันย้อนหลัง 12 เดือน + ทั้งปี (ปีปัจจุบัน/ปีก่อน) · รวมค่าที่เลือกเสมอ */
function periodOptions(selected) {
  const n = clock.parts(clock.nowMs());
  const opts = [];
  let y = n.year;
  let mo = n.month;
  for (let i = 0; i < PERIOD_MONTHS_BACK; i++) {
    opts.push({ kind: 'month', year: y, month: mo, value: `${y}-${p2(mo)}` });
    mo -= 1;
    if (mo === 0) {
      mo = 12;
      y -= 1;
    }
  }
  for (const yy of [n.year, n.year - 1]) opts.push({ kind: 'year', year: yy, value: String(yy) });
  if (selected && !opts.some((o) => o.value === selected.value)) {
    const idx = selected.kind === 'month' ? opts.findIndex((o) => o.kind === 'year') : opts.length;
    opts.splice(idx < 0 ? opts.length : idx, 0, selected);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// คำนวณตัวชี้วัด
// ---------------------------------------------------------------------------

function safeMs(v) {
  const ms = clock.toMs(v);
  return Number.isFinite(ms) ? ms : NaN;
}

/** ทัน ⇔ closed_at ≤ due_at (ใช้กฎกลางของ B03) · ข้อมูลไม่ครบ = ไม่ทัน */
function onTimeSafe(closedAt, dueAt) {
  if (!Number.isFinite(safeMs(closedAt)) || !Number.isFinite(safeMs(dueAt))) return false;
  return rules.isOnTime(closedAt, dueAt);
}

/**
 * ตัวชี้วัด Dashboard
 * @param {{kind:string,year:number,month?:number,value:string}} period
 * @param {string} service  'ALL' | 'SV-0x'
 * @returns {{received:number, closed:number, onTime:number, ontimePct:number|null, backlog:number, overdue:number,
 *            workload:Array<{username:string,name:string,dept:string|null,count:number}>}}
 */
function computeDashboard(period, service) {
  const nowMs = clock.nowMs();
  const svcSql = service === 'ALL' ? '' : ' AND service_id = @service';
  const params = { service };

  // เฉพาะคอลัมน์ที่จำเป็น (ไม่มีข้อมูลผู้ยื่น)
  const rows = db
    .prepare(
      `SELECT status, service_id, paid_at, due_at, closed_at, owner_id
         FROM cases
        WHERE case_no IS NOT NULL${svcSql}`
    )
    .all(params);

  let received = 0;
  let closed = 0;
  let onTime = 0;
  let backlog = 0;
  let overdue = 0;
  const ownerCount = new Map();

  for (const r of rows) {
    if (r.paid_at && inPeriod(r.paid_at, period)) received += 1;

    if (CLOSED_STATUSES.includes(r.status) && inPeriod(r.closed_at, period)) {
      closed += 1;
      if (onTimeSafe(r.closed_at, r.due_at)) onTime += 1;
    }

    if (BACKLOG_STATUSES.includes(r.status)) {
      backlog += 1;
      const dueMs = safeMs(r.due_at);
      if (r.status !== 'NEED_FIX' && Number.isFinite(dueMs) && nowMs > dueMs) overdue += 1;
    }

    if (r.status === 'IN_REVIEW' && r.owner_id != null) {
      ownerCount.set(r.owner_id, (ownerCount.get(r.owner_id) || 0) + 1);
    }
  }

  // BR-25: ทัน ÷ ปิดงาน · B10: ÷ รับเรื่อง (ผิด)
  const ontimePct = isBug('B10') ? rules.onTimePct(received, onTime) : rules.onTimePct(closed, onTime);

  // งานในมือ: เจ้าหน้าที่ (officer) ที่ใช้งานอยู่ทุกคน + ผู้ถือเรื่องอื่น ๆ ที่ยังมีงาน (เช่นถูกเปลี่ยนบทบาท)
  const staff = db
    .prepare(`SELECT id, username, name, role, dept, active FROM users WHERE username IS NOT NULL AND role != 'citizen'`)
    .all();
  const workload = staff
    .filter((u) => (u.role === 'officer' && u.active) || ownerCount.has(u.id))
    .map((u) => ({ username: u.username, name: u.name, dept: u.dept || null, count: ownerCount.get(u.id) || 0 }))
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));

  return { received, closed, onTime, ontimePct, backlog, overdue, workload };
}

/** ค่าที่แสดงบนจอ (ข้อความ) — ใช้ชุดเดียวกันทั้งจอ xlsx และ PDF */
function displayValues(d) {
  return {
    received: String(d.received),
    closed: String(d.closed),
    ontime: rules.fmtPct(d.ontimePct), // '85.7%' · null → '–'
    backlog: String(d.backlog),
    overdue: String(d.overdue),
  };
}

/** อ่าน period/service จาก query · ผิดรูปแบบ → { error } */
function readFilters(query) {
  const period = parsePeriod(query.period);
  const service = parseService(query.service);
  return { period, service, error: !period || !service };
}

// ---------------------------------------------------------------------------
// หน้า /dashboard
// ---------------------------------------------------------------------------

function renderDashboard(period, service, d) {
  const v = displayValues(d);
  const periodOpts = periodOptions(period)
    .map((o) => `<option value="${esc(o.value)}"${o.value === period.value ? ' selected' : ''}>${esc(periodLabel(o))}</option>`)
    .join('');
  const serviceOpts = ['ALL', ...SERVICE_IDS]
    .map((s) => `<option value="${esc(s)}"${s === service ? ' selected' : ''}>${esc(serviceLabel(s))}</option>`)
    .join('');

  const kpiCards = KPI_ROWS.map(
    (k) => `<article class="card kpi" aria-labelledby="kpi-label-${k.key}">
<h3 class="kpi-label" id="kpi-label-${k.key}">${esc(k.label)}</h3>
<p class="kpi-value" data-testid="${k.testid}">${esc(v[k.key])}</p>
<p class="muted kpi-hint">${esc(k.hint)}</p>
</article>`
  ).join('\n');

  const wlRows = d.workload.length
    ? d.workload
        .map(
          (w) => `<tr data-testid="workload-row" data-username="${esc(w.username)}">
<th scope="row">${esc(w.name)}</th><td>${esc(w.username)}</td><td>${esc(DEPT_LABELS[w.dept] || '–')}</td>
<td class="num" data-testid="workload-value">${esc(w.count)}</td></tr>`
        )
        .join('\n')
    : '<tr><td colspan="4" class="muted">ไม่มีเจ้าหน้าที่</td></tr>';

  const q = `period=${encodeURIComponent(period.value)}&service=${encodeURIComponent(service)}`;

  return `
<style>
.kpi-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr))}
.kpi{margin:0;display:flex;flex-direction:column;gap:2px}
.kpi-label{font-size:1rem;margin:0;color:#162a4c}
.kpi-value{font-size:2rem;font-weight:700;margin:0;line-height:1.2;color:#1a1a1a}
.kpi-hint{font-size:.85rem;margin:0}
.dash-filter{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end}
.dash-filter .form-row{margin:0;min-width:min(100%,220px)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
</style>
<h1>Dashboard ผู้บริหาร</h1>
<form class="card dash-filter" id="dash-filter" method="get" action="/dashboard" aria-label="ตัวกรอง Dashboard">
<div class="form-row"><label for="period-select">ช่วงเวลา</label>
<select id="period-select" name="period" data-testid="period-select">${periodOpts}</select></div>
<div class="form-row"><label for="service-select">บริการ</label>
<select id="service-select" name="service" data-testid="service-select">${serviceOpts}</select></div>
<noscript><button type="submit" class="btn btn-primary">แสดงผล</button></noscript>
</form>
<p class="muted">ช่วง: <strong>${esc(periodLabel(period))}</strong> · บริการ: <strong>${esc(serviceLabel(service))}</strong>
· งานคงค้าง เกินกำหนดคงค้าง และงานในมือ เป็นค่า ณ ${timeTag(clock.nowIso(), 'dashboard-as-of')}${
    period.kind === 'year' ? ' · รายปีคิดร้อยละจากยอดรวมทั้งปี (ไม่เฉลี่ยร้อยละรายเดือน)' : ''
  }</p>
<section aria-labelledby="kpi-heading">
<h2 id="kpi-heading">ตัวชี้วัด</h2>
<div class="grid kpi-grid">
${kpiCards}
</div>
</section>
<section aria-labelledby="workload-heading">
<h2 id="workload-heading">งานในมือรายเจ้าหน้าที่</h2>
<p class="muted">จำนวนคำขอสถานะ "กำลังตรวจสอบ" ที่เจ้าหน้าที่แต่ละคนรับไว้</p>
<div class="table-wrap"><table data-testid="workload-table">
<caption class="visually-hidden">งานในมือรายเจ้าหน้าที่ (${esc(serviceLabel(service))})</caption>
<thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">ชื่อผู้ใช้</th><th scope="col">แผนก</th><th scope="col">งานในมือ</th></tr></thead>
<tbody>
${wlRows}
</tbody></table></div>
</section>
<section aria-labelledby="export-heading">
<h2 id="export-heading">ส่งออกรายงาน</h2>
<p class="muted">ไฟล์มีตัวเลขชุดเดียวกับหน้าจอ (${esc(periodLabel(period))} · ${esc(serviceLabel(service))}) และไม่มีข้อมูลส่วนบุคคล</p>
<div class="row">
<a class="btn btn-primary" data-testid="export-xlsx-btn" href="/api/dashboard/export?format=xlsx&amp;${esc(q)}" download>ส่งออก Excel</a>
<a class="btn btn-primary" data-testid="export-pdf-btn" href="/api/dashboard/export?format=pdf&amp;${esc(q)}" download>ส่งออก PDF</a>
</div>
</section>`;
}

const PAGE_SCRIPT = `<script>
(function(){
  var f = document.getElementById('dash-filter');
  if (!f) return;
  ['period-select','service-select'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function(){ f.submit(); });
  });
})();
// ส่งออก: ดาวน์โหลดด้วย fetch + blob (แบบเดียวกับปุ่มส่งออก CSV ของ Audit และปุ่มดาวน์โหลดเอกสาร)
// <a download> ล้วน ๆ ทำให้ชุดทดสอบเห็นแค่ event download ไม่เห็น response/Content-Type (B14)
// href ยังอยู่ → ถ้าไม่มี fetch/Blob URL ลิงก์ดาวน์โหลดแบบเดิมยังทำงาน
(function(){
  var links = document.querySelectorAll('[data-testid="export-xlsx-btn"],[data-testid="export-pdf-btn"]');
  Array.prototype.forEach.call(links, function(a){
    a.addEventListener('click', function(e){
      if (!window.fetch || !window.URL || !URL.createObjectURL) return;
      e.preventDefault();
      if (a.getAttribute('aria-busy') === 'true') return;
      a.setAttribute('aria-busy', 'true');
      fetch(a.getAttribute('href'), { credentials: 'same-origin' }).then(function(r){
        if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error((d && d.message) || 'ส่งออกไม่สำเร็จ'); });
        var cd = r.headers.get('Content-Disposition') || '';
        var m = /filename="?([^";]+)"?/.exec(cd);
        return r.blob().then(function(b){
          var u = URL.createObjectURL(b);
          var t = document.createElement('a');
          t.href = u; t.download = m ? m[1] : 'dashboard';
          document.body.appendChild(t); t.click(); t.remove();
          setTimeout(function(){ URL.revokeObjectURL(u); }, 10000);
        });
      }).catch(function(err){
        if (window.App && App.showError) App.showError(err && err.message ? err.message : 'ส่งออกไม่สำเร็จ');
      }).then(function(){ a.removeAttribute('aria-busy'); });
    });
  });
})();
</script>`;

router.get('/dashboard', requireRole('executive'), (req, res) => {
  const f = readFilters(req.query);
  const period = f.period || defaultPeriod();
  const service = f.service || 'ALL';
  const d = computeDashboard(period, service);
  return sendPage(req, res, {
    title: 'Dashboard ผู้บริหาร',
    body: renderDashboard(period, service, d),
    error: f.error ? 'ตัวกรองไม่ถูกต้อง แสดงค่าเริ่มต้นแทน' : undefined,
    scripts: PAGE_SCRIPT,
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

router.get('/api/dashboard', requireRole('executive'), (req, res) => {
  const f = readFilters(req.query);
  if (f.error) return sendError(res, 'BAD_REQUEST', { field: !f.period ? 'period' : 'service' });
  const d = computeDashboard(f.period, f.service);
  res.set('Cache-Control', 'no-store');
  return res.json({
    received: d.received,
    closed: d.closed,
    onTime: d.onTime,
    ontimePct: d.ontimePct,
    backlog: d.backlog,
    overdue: d.overdue,
    workload: d.workload.map((w) => ({ username: w.username, count: w.count })),
    period: f.period.value,
    service: f.service,
  });
});

// ---------------------------------------------------------------------------
// ส่งออก (CONTRACT §7)
// ---------------------------------------------------------------------------

/** ข้อความ ASCII บรรทัดเดียวใน PDF: 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1' (ปิดงาน 0 → ontime=-) */
function kpiAsciiLine(v) {
  const ontime = v.ontime === '–' ? '-' : v.ontime;
  return `kpi received=${v.received} closed=${v.closed} ontime=${ontime} backlog=${v.backlog} overdue=${v.overdue}`;
}

async function buildXlsx(period, service, d) {
  const ExcelJS = require('exceljs');
  const v = displayValues(d);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Service กลาง';
  wb.created = clock.now();
  wb.modified = clock.now();

  // ชีตแรก: แถว 1 หัวตาราง · แถว 2–6 ตัวชี้วัด (ค่าเป็นข้อความตามจอ)
  const ws = wb.addWorksheet('Dashboard');
  ws.columns = [
    { key: 'a', width: 22 },
    { key: 'b', width: 14 },
  ];
  ws.addRow(['ตัวชี้วัด', 'ค่า']).font = { bold: true };
  for (const k of KPI_ROWS) {
    const row = ws.addRow([k.label, v[k.key]]);
    row.getCell(2).numFmt = '@';
    row.getCell(2).alignment = { horizontal: 'right' };
  }

  // ชีตที่ 2: ช่วง/บริการ + งานในมือ (ข้อมูลเดียวกับจอ · ไม่มีข้อมูลส่วนบุคคล)
  const ws2 = wb.addWorksheet('รายละเอียด');
  ws2.columns = [
    { key: 'a', width: 24 },
    { key: 'b', width: 30 },
    { key: 'c', width: 14 },
    { key: 'd', width: 12 },
  ];
  ws2.addRow(['ช่วง', periodLabel(period), period.value]);
  ws2.addRow(['บริการ', serviceLabel(service), service]);
  ws2.addRow(['ข้อมูล ณ', clock.nowIso()]);
  ws2.addRow([]);
  ws2.addRow(['งานในมือรายเจ้าหน้าที่', 'ชื่อผู้ใช้', 'แผนก', 'งานในมือ']).font = { bold: true };
  for (const w of d.workload) ws2.addRow([w.name, w.username, DEPT_LABELS[w.dept] || '–', String(w.count)]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** ฟอนต์ไทยสำหรับป้ายใน PDF (ถ้าไม่มีไฟล์ฟอนต์ ใช้ป้ายภาษาอังกฤษแทน) */
function thaiFontPath() {
  const candidates = [process.env.THAI_FONT_PATH, '/usr/share/fonts/truetype/tlwg/Garuda.ttf'];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      /* ข้าม */
    }
  }
  return null;
}

const KPI_EN = {
  received: 'Received',
  closed: 'Closed',
  ontime: 'On-time %',
  backlog: 'Backlog (now)',
  overdue: 'Overdue backlog (now)',
};

function buildPdf(period, service, d) {
  const PDFDocument = require('pdfkit');
  const v = displayValues(d);
  const now = clock.now();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Dashboard ${period.value} ${service}`,
        Author: 'e-Service',
        Producer: 'e-Service',
        Creator: 'e-Service',
        CreationDate: now,
        ModDate: now,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const thai = thaiFontPath();
    const TH = thai ? 'thai' : 'Helvetica';
    if (thai) doc.registerFont('thai', thai);
    const left = doc.page.margins.left;

    // หัวรายงาน
    doc.font(TH).fontSize(16);
    doc.text(thai ? 'รายงาน Dashboard ผู้บริหาร · เทศบาลนครตัวอย่าง' : 'Executive Dashboard Report', left, 50);
    doc.fontSize(11);
    doc.text(thai ? `ช่วง: ${periodLabel(period)} · บริการ: ${serviceLabel(service)}` : `Service: ${service}`);
    doc.moveDown(0.5);

    // บรรทัด ASCII ที่เครื่องอ่านได้ (CONTRACT §7) · ห้ามตัดบรรทัด
    doc.font('Helvetica').fontSize(11);
    doc.text(`period=${period.value} service=${service}`, { lineBreak: false });
    doc.moveDown(1);
    doc.text(kpiAsciiLine(v), left, doc.y, { lineBreak: false });
    doc.moveDown(1.5);

    // ตารางตัวชี้วัด (ป้ายตามจอ)
    const colB = left + 260;
    doc.font(TH).fontSize(12);
    let y = doc.y;
    doc.text(thai ? 'ตัวชี้วัด' : 'Indicator', left, y, { lineBreak: false });
    doc.text(thai ? 'ค่า' : 'Value', colB, y, { lineBreak: false });
    y += 22;
    doc.moveTo(left, y - 4).lineTo(colB + 120, y - 4).stroke();
    for (const k of KPI_ROWS) {
      doc.font(TH).text(thai ? k.label : KPI_EN[k.key], left, y, { lineBreak: false });
      doc.font(v[k.key] === '–' && !thai ? 'Helvetica' : TH).text(thai ? v[k.key] : v[k.key].replace('–', '-'), colB, y, {
        lineBreak: false,
      });
      y += 20;
    }

    // งานในมือ
    y += 16;
    doc.font(TH).fontSize(12).text(thai ? 'งานในมือรายเจ้าหน้าที่ (กำลังตรวจสอบ)' : 'Workload (in review)', left, y, {
      lineBreak: false,
    });
    y += 22;
    for (const w of d.workload) {
      doc.font('Helvetica').fontSize(11).text(w.username, left, y, { lineBreak: false });
      doc.text(String(w.count), colB, y, { lineBreak: false });
      y += 18;
    }
    y += 10;
    doc
      .font('Helvetica')
      .fontSize(11)
      .text(`workload ${d.workload.map((w) => `${w.username}=${w.count}`).join(' ')}`, left, y, { lineBreak: false });

    // หมายเหตุ
    y += 30;
    doc
      .font(TH)
      .fontSize(9)
      .text(
        thai
          ? `ข้อมูล ณ ${clock.nowIso()} · งานคงค้าง/เกินกำหนดคงค้างเป็นค่า ณ เวลาส่งออก · รายงานนี้ไม่มีข้อมูลส่วนบุคคล`
          : `As of ${clock.nowIso()} · no personal data`,
        left,
        y,
        { width: doc.page.width - left - doc.page.margins.right }
      );

    doc.end();
  });
}

router.get('/api/dashboard/export', requireRole('executive'), async (req, res, next) => {
  try {
    const format = String(req.query.format || '').trim().toLowerCase();
    if (!FORMATS[format]) return sendError(res, 'BAD_REQUEST', { field: 'format' });
    const f = readFilters(req.query);
    if (f.error) return sendError(res, 'BAD_REQUEST', { field: !f.period ? 'period' : 'service' });

    const d = computeDashboard(f.period, f.service);
    const buf = format === 'xlsx' ? await buildXlsx(f.period, f.service, d) : await buildPdf(f.period, f.service, d);

    // Audit EXPORT 1 แถวต่อการส่งออก 1 ครั้ง (หลังสร้างไฟล์สำเร็จ)
    db.appendAudit({ user: req.user, event: 'EXPORT', detail: `${format} ${f.period.value} ${f.service}` });

    const filename = `dashboard-${f.period.value}-${f.service}.${FORMATS[format].ext}`;
    res.status(200);
    res.set('Content-Type', FORMATS[format].mime);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Length', String(buf.length));
    res.set('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// ตัวช่วยสำหรับทดสอบภายใน (ไม่กระทบ server.js ที่ใช้ตัว router)
module.exports.computeDashboard = computeDashboard;
module.exports.parsePeriod = parsePeriod;
module.exports.kpiAsciiLine = kpiAsciiLine;
