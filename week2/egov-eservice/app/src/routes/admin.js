'use strict';
/**
 * B10 · Audit Trail + ผู้ดูแลระบบ (บริการ วันหยุด ผู้ใช้)
 * REQUIREMENTS FR-24..27 · BR-11 BR-27 BR-28 · CONTRACT §1 §2.10 §2.11 §5 §6.4 (audit) §6.5 §6.8 §7 · DECISIONS §13
 *
 * หน้า:
 *   GET /audit                       auditor · กรอง actor/event/from/to (query GET) · ส่งออก CSV · ไม่มีปุ่มแก้/ลบ
 *   GET /admin                       admin → redirect /admin/services
 *   GET /admin/services              admin · แก้ค่าธรรมเนียม/SLA ต่อบริการ (fetch PUT)
 *   GET /admin/holidays              admin · เพิ่ม/ลบวันหยุด
 *   GET /admin/users                 admin · เปลี่ยนบทบาท/ฝ่ายของผู้ใช้เจ้าหน้าที่
 *
 * API:
 *   GET  /api/audit?actor=&event=&from=&to=   auditor → {count, items:[{id,time,username,role,event,caseNo,fromStatus,toStatus,detail}]}
 *   GET  /api/audit/export.csv?...            auditor → CSV (§7) + Audit EXPORT detail 'audit-csv'
 *   อื่น ๆ ทุก method (PUT/PATCH/DELETE/POST) ที่ /api/audit, /api/audit/:id → 405 METHOD_NOT_ALLOWED ทุกบทบาท (ก่อนตรวจสิทธิ์)
 *   GET  /api/admin/services                  → {items:[{id,name,fee,feeBase?,feePerSqm,sla}]}
 *   PUT  /api/admin/services/:id              {fee,sla} · SV-03 {feeBase|fee, feePerSqm, sla} → 200 item · 400 INVALID_FEE / INVALID_SLA
 *   GET  /api/admin/holidays                  → {items:[{date,name}]}
 *   POST /api/admin/holidays                  {date,name} → 201 · 409 DUPLICATE_HOLIDAY
 *   DELETE /api/admin/holidays/:date          → 200 · 404
 *   GET  /api/admin/users                     → {items:[{username,name,role,dept,active}]}
 *   PUT  /api/admin/users/:username           {role,dept} → 200 · 409 SELF_ROLE_CHANGE
 *
 * กฎ:
 *   - ช่วงวันที่ของ Audit เทียบด้วยวันที่ตามเวลาไทย (clock.dateStr) รวมวันเริ่มและวันจบ
 *   - เรียงใหม่ → เก่า (เวลาเท่ากันเรียง id มาก → น้อย) ทั้งจอ API และ CSV
 *   - ADMIN_CHANGE บันทึกเฉพาะคำขอที่ยอมรับและมีค่าที่เปลี่ยนจริง (1 แถวต่อคำขอ · หลายค่าคั่นด้วย '; ')
 *   - แก้ค่าธรรมเนียมแก้เฉพาะตาราง services · ยอดที่ล็อกใน cases.fee (PENDING_PAYMENT ขึ้นไป) ไม่ถูกแตะ (BR-11)
 *   - เพิ่ม/ลบวันหยุดไม่คำนวณ dueAt ของคำขอเดิมใหม่ (DECISIONS ⚠️A-42)
 */

const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const { sendError } = require('../lib/errors');
const { esc, timeTag, fmtMoney } = require('../lib/format');
const { sendPage } = require('../views/layout');
const rbac = require('../lib/rbac');
const { ROLES, ROLE_LABELS, DEPTS, DEPT_LABELS, AUDIT_EVENTS, SERVICES } = require('../lib/constants');

const router = express.Router();

const FEE_MIN = 0;
const FEE_MAX = 100000;
const SLA_MIN = 1;
const SLA_MAX = 60;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EN_DASH = '–';
const CSV_HEADER = ['time', 'username', 'role', 'event', 'caseNo', 'fromStatus', 'toStatus', 'detail'];

// ===========================================================================
// ตัวช่วย
// ===========================================================================

/** จำนวนเต็มแบบเข้มงวด: number ที่เป็นจำนวนเต็ม หรือสตริงตัวเลขล้วน (มีเครื่องหมายลบได้) · อื่น ๆ → null */
function strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^-?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function has(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 'YYYY-MM-DD' ที่เป็นวันจริง */
function isValidDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

function auditUser(req) {
  return req.user;
}

function adminChange(req, detail) {
  db.appendAudit({ user: auditUser(req), event: 'ADMIN_CHANGE', detail });
}

/** ตอบ 405 ทุกบทบาท (ไม่ตรวจสิทธิ์ ไม่ตรวจว่ามี id จริง) */
function methodNotAllowed(req, res) {
  res.set('Allow', 'GET');
  return sendError(res, 'METHOD_NOT_ALLOWED');
}

// ===========================================================================
// Audit Trail (FR-24 · BR-27)
// ===========================================================================

/** อ่านตัวกรองจาก query (ค่าไม่ถูกต้องถือว่าไม่กรอง ยกเว้น event ที่ไม่รู้จัก → ไม่มีผล) */
function readAuditFilter(q) {
  const str = (v) => (Array.isArray(v) ? String(v[0] || '') : v == null ? '' : String(v)).trim();
  const actor = str(q.actor);
  const event = str(q.event);
  const fromRaw = str(q.from);
  const toRaw = str(q.to);
  return {
    actor,
    event,
    from: isValidDate(fromRaw) ? fromRaw : '',
    to: isValidDate(toRaw) ? toRaw : '',
  };
}

function auditItem(row) {
  return {
    id: row.id,
    time: clock.toIso(row.at) || row.at,
    username: row.username,
    role: row.role,
    event: row.event,
    caseNo: row.case_no || null,
    fromStatus: row.from_status || null,
    toStatus: row.to_status || null,
    detail: row.detail || '',
  };
}

/** แถว Audit ตามตัวกรอง เรียงใหม่ → เก่า */
function queryAudit(f) {
  const where = [];
  const params = {};
  if (f.actor) {
    where.push('username = @actor COLLATE NOCASE');
    params.actor = f.actor;
  }
  if (f.event) {
    where.push('event = @event');
    params.event = f.event;
  }
  const sql = `SELECT id, at, username, role, event, case_no, from_status, to_status, detail
               FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const rows = db.prepare(sql).all(params);
  const out = [];
  for (const r of rows) {
    const ms = clock.toMs(r.at);
    const day = ms == null || Number.isNaN(ms) ? String(r.at || '').slice(0, 10) : clock.dateStr(ms);
    if (f.from && day < f.from) continue;
    if (f.to && day > f.to) continue;
    out.push({ ...r, _ms: ms == null || Number.isNaN(ms) ? 0 : ms });
  }
  out.sort((a, b) => b._ms - a._ms || b.id - a.id);
  return out.map(auditItem);
}

function filterQueryString(f) {
  const p = new URLSearchParams();
  p.set('actor', f.actor);
  p.set('event', f.event);
  p.set('from', f.from);
  p.set('to', f.to);
  return p.toString();
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // กัน CSV/formula injection เมื่อเปิดใน Excel
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(items) {
  const lines = [CSV_HEADER.join(',')];
  for (const it of items) {
    lines.push(
      [it.time, it.username, it.role, it.event, it.caseNo || '', it.fromStatus || '', it.toStatus || '', it.detail]
        .map(csvCell)
        .join(',')
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// --- 405: ต้องอยู่ก่อนตรวจสิทธิ์ทุกเส้น (รวม admin และผู้ไม่ล็อกอิน) ---
function only(methods) {
  return (req, res, next) => (methods.includes(req.method) ? next() : methodNotAllowed(req, res));
}
router.all('/api/audit', only(['GET', 'HEAD']));
router.all('/api/audit/export.csv', only(['GET', 'HEAD']));
router.all('/api/audit/:id', only(['GET', 'HEAD']));

router.get('/api/audit', rbac.requireRole('auditor'), (req, res) => {
  const items = queryAudit(readAuditFilter(req.query));
  res.set('Cache-Control', 'no-store');
  return res.json({ count: items.length, items });
});

router.get('/api/audit/export.csv', rbac.requireRole('auditor'), (req, res) => {
  const f = readAuditFilter(req.query);
  const items = queryAudit(f);
  const csv = buildCsv(items);
  const parts = ['audit-csv'];
  if (f.actor) parts.push(`actor=${f.actor}`);
  if (f.event) parts.push(`event=${f.event}`);
  if (f.from) parts.push(`from=${f.from}`);
  if (f.to) parts.push(`to=${f.to}`);
  db.appendAudit({ user: auditUser(req), event: 'EXPORT', detail: parts.join(' ') });
  const stamp = clock.toIso(clock.now()).slice(0, 10).replace(/-/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`);
  res.set('Cache-Control', 'no-store');
  return res.send(csv);
});

// GET /api/audit/:id (อ่านอย่างเดียว · ให้ path นี้ตอบได้ไม่ใช่ 404 ของระบบ)
router.get('/api/audit/:id', rbac.requireRole('auditor'), (req, res) => {
  const id = strictInt(req.params.id);
  const row = id == null
    ? null
    : db.prepare('SELECT id, at, username, role, event, case_no, from_status, to_status, detail FROM audit_log WHERE id = ?').get(id);
  if (!row) return sendError(res, 'NOT_FOUND', undefined, 'ไม่พบรายการ');
  return res.json(auditItem(row));
});

function renderAuditPage(req, f, items) {
  const qs = filterQueryString(f);
  const eventOptions = ['<option value="">ทั้งหมด</option>']
    .concat(AUDIT_EVENTS.map((e) => `<option value="${esc(e)}"${f.event === e ? ' selected' : ''}>${esc(e)}</option>`))
    .join('');
  const rows = items
    .map((it) => {
      const transition = it.fromStatus || it.toStatus ? `${it.fromStatus || EN_DASH} → ${it.toStatus || EN_DASH}` : EN_DASH;
      return `<tr data-testid="audit-row" data-id="${esc(it.id)}" data-event="${esc(it.event)}" data-actor="${esc(it.username)}" data-case-no="${esc(it.caseNo || '')}">
<td>${timeTag(it.time, 'audit-time')}</td>
<td data-testid="audit-actor">${esc(it.username)}</td>
<td data-testid="audit-role">${esc(it.role)}</td>
<td data-testid="audit-event">${esc(it.event)}</td>
<td data-testid="audit-case-no">${esc(it.caseNo || EN_DASH)}</td>
<td data-testid="audit-transition">${esc(transition)}</td>
<td data-testid="audit-detail">${esc(it.detail)}</td>
</tr>`;
    })
    .join('\n');
  const body = `
<h1>Audit Trail</h1>
<p class="muted">บันทึกการทำรายการของเจ้าหน้าที่ (อ่านอย่างเดียว · ไม่สามารถแก้ไขหรือลบได้) · ช่วงวันที่ตามเวลาไทย รวมวันเริ่มและวันสิ้นสุด</p>
<form class="card" method="get" action="/audit" id="audit-filter" aria-label="ตัวกรอง Audit Trail">
<div class="grid">
<div class="form-row"><label for="f-actor">ผู้ทำ (username)</label><input id="f-actor" name="actor" type="text" autocomplete="off" data-testid="audit-filter-actor" value="${esc(f.actor)}"></div>
<div class="form-row"><label for="f-event">เหตุการณ์</label><select id="f-event" name="event" data-testid="audit-filter-event">${eventOptions}</select></div>
<div class="form-row"><label for="f-from">ตั้งแต่วันที่</label><input id="f-from" name="from" type="date" data-testid="audit-filter-from" value="${esc(f.from)}"></div>
<div class="form-row"><label for="f-to">ถึงวันที่</label><input id="f-to" name="to" type="date" data-testid="audit-filter-to" value="${esc(f.to)}"></div>
</div>
<div class="row">
<button type="submit" class="btn btn-primary" data-testid="audit-apply-btn">ค้นหา</button>
<button type="button" class="btn" data-testid="audit-export-csv-btn" id="audit-export" data-href="/api/audit/export.csv?${esc(qs)}">ส่งออก CSV</button>
</div>
</form>
<p>จำนวนรายการ: <strong data-testid="audit-count">${items.length}</strong></p>
<div class="table-wrap">
<table>
<caption class="visually-hidden">รายการ Audit Trail เรียงจากใหม่ไปเก่า</caption>
<thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">เลขคำขอ</th><th scope="col">สถานะก่อน → หลัง</th><th scope="col">รายละเอียด</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7" class="muted">ไม่พบรายการ</td></tr>'}
</tbody>
</table>
</div>`;
  const scripts = `<script>
(function(){
  var btn = document.getElementById('audit-export');
  if (!btn) return;
  btn.addEventListener('click', function(){
    var url = btn.getAttribute('data-href');
    btn.disabled = true;
    fetch(url, { credentials: 'same-origin' }).then(function(r){
      if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error((d && d.message) || 'ส่งออกไม่สำเร็จ'); });
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="?([^";]+)"?/.exec(cd);
      return r.blob().then(function(b){
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = m ? m[1] : 'audit.csv';
        document.body.appendChild(a); a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        App.showSuccess('ส่งออก CSV แล้ว');
      });
    }).catch(function(e){ App.showError(e.message); }).then(function(){ btn.disabled = false; });
  });
})();
</script>`;
  return { title: 'Audit Trail', body, scripts };
}

router.get('/audit', rbac.requireRole('auditor'), (req, res) => {
  const f = readAuditFilter(req.query);
  const items = queryAudit(f);
  return sendPage(req, res, renderAuditPage(req, f, items));
});

// ===========================================================================
// ผู้ดูแลระบบ: บริการ (FR-25 · BR-28 · BR-11)
// ===========================================================================

function serviceRows() {
  return db.prepare('SELECT id, name, fee, fee_per_sqm, sla_days FROM services ORDER BY sort, id').all();
}

function serviceItem(r) {
  const it = { id: r.id, name: r.name, fee: r.fee, feePerSqm: r.fee_per_sqm == null ? null : r.fee_per_sqm, sla: r.sla_days };
  if (r.fee_per_sqm != null) it.feeBase = r.fee;
  return it;
}

router.get('/api/admin/services', rbac.requireRole('admin'), (req, res) => {
  res.json({ items: serviceRows().map(serviceItem) });
});

router.put('/api/admin/services/:id', rbac.requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id, name, fee, fee_per_sqm, sla_days FROM services WHERE id = ?').get(req.params.id);
  if (!row) return sendError(res, 'NOT_FOUND', undefined, 'ไม่พบบริการ');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const perSqmService = row.fee_per_sqm != null;

  // ค่าธรรมเนียม (SV-03 ใช้ feeBase · รับ fee แทนได้)
  const feeKey = perSqmService && has(b, 'feeBase') ? 'feeBase' : has(b, 'fee') ? 'fee' : null;
  let fee = row.fee;
  if (feeKey) {
    fee = strictInt(b[feeKey]);
    if (fee == null || fee < FEE_MIN || fee > FEE_MAX) return sendError(res, 'INVALID_FEE');
  }
  let perSqm = row.fee_per_sqm;
  if (perSqmService && has(b, 'feePerSqm')) {
    perSqm = strictInt(b.feePerSqm);
    if (perSqm == null || perSqm < FEE_MIN || perSqm > FEE_MAX) return sendError(res, 'INVALID_FEE');
  }
  let sla = row.sla_days;
  if (has(b, 'sla')) {
    sla = strictInt(b.sla);
    if (sla == null || sla < SLA_MIN || sla > SLA_MAX) return sendError(res, 'INVALID_SLA');
  }

  const changes = [];
  if (fee !== row.fee) changes.push(`${row.id} fee ${row.fee} → ${fee}`);
  if (perSqmService && perSqm !== row.fee_per_sqm) changes.push(`${row.id} feePerSqm ${row.fee_per_sqm} → ${perSqm}`);
  if (sla !== row.sla_days) changes.push(`${row.id} sla ${row.sla_days} → ${sla}`);

  if (changes.length) {
    db.tx(() => {
      db.prepare('UPDATE services SET fee = ?, fee_per_sqm = ?, sla_days = ?, updated_at = ? WHERE id = ?').run(
        fee,
        perSqmService ? perSqm : null,
        sla,
        clock.nowIso(),
        row.id
      );
      adminChange(req, changes.join('; '));
    });
  }
  const fresh = db.prepare('SELECT id, name, fee, fee_per_sqm, sla_days FROM services WHERE id = ?').get(row.id);
  return res.json({ ...serviceItem(fresh), changed: changes });
});

router.get('/admin', rbac.requireRole('admin'), (req, res) => res.redirect(302, '/admin/services'));

router.get('/admin/services', rbac.requireRole('admin'), (req, res) => {
  const rows = serviceRows()
    .map((r) => {
      const id = esc(r.id);
      const perSqm = r.fee_per_sqm != null;
      const feeLabel = perSqm
        ? 'ค่าธรรมเนียมฐาน (พื้นที่ 1–100 ตร.ม.) บาท'
        : r.id === 'SV-01'
          ? 'ค่าธรรมเนียมต่อฉบับ (บาท)'
          : 'ค่าธรรมเนียมคงที่ (บาท)';
      const feeCell = `<div class="form-row"><label for="fee-${id}">${esc(feeLabel)}</label>
<input id="fee-${id}" type="number" inputmode="numeric" step="1" data-testid="svc-fee-${id}" value="${esc(r.fee)}"></div>${
        perSqm
          ? `<div class="form-row"><label for="per-${id}">ต่อ ตร.ม. ส่วนเกิน 100 (บาท)</label>
<input id="per-${id}" type="number" inputmode="numeric" step="1" data-testid="svc-fee-per-sqm-${id}" value="${esc(r.fee_per_sqm)}"></div>`
          : ''
      }`;
      return `<tr data-testid="service-row" data-service-id="${id}">
<th scope="row">${id}<br><span class="muted">${esc(r.name || (SERVICES[r.id] || {}).name || '')}</span></th>
<td>${feeCell}<p class="muted" style="margin:0">ปัจจุบัน ${esc(fmtMoney(r.fee))}${perSqm ? ` · ${esc(fmtMoney(r.fee_per_sqm))}/ตร.ม.` : ''}</p></td>
<td><div class="form-row"><label for="sla-${id}">SLA (วันทำการ)</label>
<input id="sla-${id}" type="number" inputmode="numeric" step="1" data-testid="svc-sla-${id}" value="${esc(r.sla_days)}"></div></td>
<td><button type="button" class="btn btn-primary" data-testid="svc-save-${id}" data-svc="${id}" data-per-sqm="${perSqm ? '1' : ''}">บันทึก</button></td>
</tr>`;
    })
    .join('\n');
  const body = `
<h1>จัดการบริการ</h1>
<p class="muted">ค่าธรรมเนียมเป็นจำนวนเต็ม 0–100,000 บาท · SLA เป็นจำนวนเต็ม 1–60 วันทำการ · ค่าใหม่มีผลกับคำขอที่เข้าสถานะรอชำระหลังบันทึกเท่านั้น (ยอดของคำขอเดิมถูกล็อกไว้)</p>
<div class="table-wrap">
<table>
<caption class="visually-hidden">ค่าธรรมเนียมและ SLA ของแต่ละบริการ</caption>
<thead><tr><th scope="col">บริการ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">SLA</th><th scope="col">บันทึก</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
  const scripts = `<script>
(function(){
  function val(id){ var el = document.querySelector('[data-testid="' + id + '"]'); return el ? el.value.trim() : undefined; }
  document.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-svc]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-svc');
    var body = { sla: val('svc-sla-' + id) };
    if (btn.getAttribute('data-per-sqm')) { body.feeBase = val('svc-fee-' + id); body.feePerSqm = val('svc-fee-per-sqm-' + id); }
    else { body.fee = val('svc-fee-' + id); }
    App.clearFlash();
    btn.disabled = true;
    App.api('PUT', '/api/admin/services/' + encodeURIComponent(id), body).then(function(r){
      if (!r.ok) { App.showError((r.data && r.data.message) || 'บันทึกไม่สำเร็จ'); return; }
      var d = r.data || {};
      var f = document.querySelector('[data-testid="svc-fee-' + id + '"]'); if (f) f.value = d.fee;
      var s = document.querySelector('[data-testid="svc-sla-' + id + '"]'); if (s) s.value = d.sla;
      var p = document.querySelector('[data-testid="svc-fee-per-sqm-' + id + '"]'); if (p && d.feePerSqm != null) p.value = d.feePerSqm;
      App.showSuccess('บันทึก ' + id + ' แล้ว');
    }).catch(function(){ App.showError('บันทึกไม่สำเร็จ'); }).then(function(){ btn.disabled = false; });
  });
})();
</script>`;
  return sendPage(req, res, { title: 'จัดการบริการ', body, scripts });
});

// ===========================================================================
// ผู้ดูแลระบบ: วันหยุด (FR-26 · BR-28)
// ===========================================================================

function holidayRows() {
  return db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
}

router.get('/api/admin/holidays', rbac.requireRole('admin'), (req, res) => {
  res.json({ items: holidayRows() });
});

router.post('/api/admin/holidays', rbac.requireRole('admin'), (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const date = String(b.date == null ? '' : b.date).trim();
  if (!isValidDate(date)) return sendError(res, 'BAD_REQUEST', undefined, 'วันที่ไม่ถูกต้อง (YYYY-MM-DD)');
  const name = String(b.name == null ? '' : b.name).trim().slice(0, 200) || 'วันหยุด';
  if (db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) return sendError(res, 'DUPLICATE_HOLIDAY');
  try {
    db.tx(() => {
      db.prepare('INSERT INTO holidays (date, name, created_at) VALUES (?, ?, ?)').run(date, name, clock.nowIso());
      adminChange(req, `holiday add ${date}`);
    });
  } catch (err) {
    if (err && /UNIQUE|PRIMARY KEY/i.test(String(err.message))) return sendError(res, 'DUPLICATE_HOLIDAY');
    throw err;
  }
  return res.status(201).json({ date, name });
});

router.delete('/api/admin/holidays/:date', rbac.requireRole('admin'), (req, res) => {
  const date = String(req.params.date || '').trim();
  const row = db.prepare('SELECT date, name FROM holidays WHERE date = ?').get(date);
  if (!row) return sendError(res, 'NOT_FOUND', undefined, 'ไม่พบวันหยุด');
  db.tx(() => {
    db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
    adminChange(req, `holiday delete ${date}`);
  });
  return res.json({ ok: true, date });
});

router.get('/admin/holidays', rbac.requireRole('admin'), (req, res) => {
  const added = isValidDate(req.query.added) ? req.query.added : '';
  const deleted = isValidDate(req.query.deleted) ? req.query.deleted : '';
  const success = added ? `เพิ่มวันหยุด ${added} แล้ว` : deleted ? `ลบวันหยุด ${deleted} แล้ว` : '';
  const rows = holidayRows()
    .map(
      (h) => `<tr data-testid="holiday-row" data-date="${esc(h.date)}">
<td>${timeTag(h.date, null, { dateOnly: true })} <span class="muted">(${esc(h.date)})</span></td>
<td>${esc(h.name)}</td>
<td><button type="button" class="btn btn-danger" data-testid="holiday-delete-btn" data-date="${esc(h.date)}" aria-label="ลบวันหยุด ${esc(h.date)}">ลบ</button></td>
</tr>`
    )
    .join('\n');
  const body = `
<h1>จัดการวันหยุด</h1>
<p class="muted">วันทำการ = จันทร์–ศุกร์ที่ไม่อยู่ในตารางนี้ · การเพิ่ม/ลบวันหยุดไม่คำนวณกำหนดเสร็จของคำขอที่ชำระแล้วใหม่</p>
<form class="card" id="holiday-form" novalidate aria-label="เพิ่มวันหยุด">
<div class="grid">
<div class="form-row"><label for="h-date">วันที่ (ค.ศ.)</label><input id="h-date" type="date" required data-testid="holiday-date-input"></div>
<div class="form-row"><label for="h-name">ชื่อวันหยุด</label><input id="h-name" type="text" maxlength="200" data-testid="holiday-name-input"></div>
</div>
<button type="submit" class="btn btn-primary" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
</form>
<div class="table-wrap">
<table>
<caption class="visually-hidden">ตารางวันหยุด</caption>
<thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อ</th><th scope="col">ลบ</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="3" class="muted">ไม่มีวันหยุด</td></tr>'}
</tbody>
</table>
</div>`;
  const scripts = `<script>
(function(){
  var form = document.getElementById('holiday-form');
  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var date = document.getElementById('h-date').value.trim();
    var name = document.getElementById('h-name').value.trim();
    App.clearFlash();
    App.api('POST', '/api/admin/holidays', { date: date, name: name }).then(function(r){
      if (!r.ok) { App.showError((r.data && r.data.message) || 'เพิ่มวันหยุดไม่สำเร็จ'); return; }
      window.location.href = '/admin/holidays?added=' + encodeURIComponent(date);
    }).catch(function(){ App.showError('เพิ่มวันหยุดไม่สำเร็จ'); });
  });
  document.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-testid="holiday-delete-btn"]') : null;
    if (!btn) return;
    var date = btn.getAttribute('data-date');
    App.clearFlash();
    btn.disabled = true;
    App.api('DELETE', '/api/admin/holidays/' + encodeURIComponent(date)).then(function(r){
      if (!r.ok) { App.showError((r.data && r.data.message) || 'ลบวันหยุดไม่สำเร็จ'); btn.disabled = false; return; }
      window.location.href = '/admin/holidays?deleted=' + encodeURIComponent(date);
    }).catch(function(){ App.showError('ลบวันหยุดไม่สำเร็จ'); btn.disabled = false; });
  });
})();
</script>`;
  return sendPage(req, res, { title: 'จัดการวันหยุด', body, scripts, success });
});

// ===========================================================================
// ผู้ดูแลระบบ: ผู้ใช้/บทบาท (FR-27 · BR-28)
// ===========================================================================

function userRows() {
  // เฉพาะบัญชีเจ้าหน้าที่ (มี username) · ไม่ดึงข้อมูลส่วนบุคคลของประชาชน (NFR-04)
  return db
    .prepare('SELECT id, username, name, role, dept, active FROM users WHERE username IS NOT NULL ORDER BY id')
    .all();
}

function userItem(u) {
  return { username: u.username, name: u.name, role: u.role, dept: u.dept || '', active: !!u.active };
}

router.get('/api/admin/users', rbac.requireRole('admin'), (req, res) => {
  res.json({ items: userRows().map(userItem) });
});

router.put('/api/admin/users/:username', rbac.requireRole('admin'), (req, res) => {
  const target = db
    .prepare('SELECT id, username, name, role, dept, active FROM users WHERE username = ?')
    .get(String(req.params.username || ''));
  if (!target) return sendError(res, 'NOT_FOUND', undefined, 'ไม่พบผู้ใช้');
  if (target.id === req.user.id || target.username === req.user.username) return sendError(res, 'SELF_ROLE_CHANGE');

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const role = has(b, 'role') ? String(b.role || '').trim() : target.role;
  if (!ROLES.includes(role) || role === 'citizen') {
    return sendError(res, 'BAD_REQUEST', undefined, 'บทบาทไม่ถูกต้อง');
  }
  let dept = has(b, 'dept') ? String(b.dept == null ? '' : b.dept).trim() : target.dept || '';
  if (dept && !DEPTS.includes(dept)) return sendError(res, 'BAD_REQUEST', undefined, 'ฝ่ายไม่ถูกต้อง');
  if (role === 'officer' && !dept) return sendError(res, 'BAD_REQUEST', undefined, 'เจ้าหน้าที่ต้องระบุฝ่าย');
  if (role !== 'officer') dept = ''; // dept ใช้กับ officer เท่านั้น
  let active = !!target.active;
  if (has(b, 'active')) active = b.active === true || b.active === 1 || b.active === '1' || b.active === 'true';

  const changes = [];
  if (role !== target.role) changes.push(`${target.username} role ${target.role} → ${role}`);
  if ((dept || '') !== (target.dept || '')) changes.push(`${target.username} dept ${target.dept || EN_DASH} → ${dept || EN_DASH}`);
  if (active !== !!target.active) changes.push(`${target.username} active ${target.active ? 1 : 0} → ${active ? 1 : 0}`);

  if (changes.length) {
    db.tx(() => {
      db.prepare('UPDATE users SET role = ?, dept = ?, active = ?, updated_at = ? WHERE id = ?').run(
        role,
        dept || null,
        active ? 1 : 0,
        clock.nowIso(),
        target.id
      );
      adminChange(req, changes.join('; '));
    });
  }
  const fresh = db.prepare('SELECT id, username, name, role, dept, active FROM users WHERE id = ?').get(target.id);
  return res.json({ ...userItem(fresh), changed: changes });
});

router.get('/admin/users', rbac.requireRole('admin'), (req, res) => {
  const me = req.user;
  const rows = userRows()
    .map((u) => {
      const un = esc(u.username);
      const roleOpts = ROLES.map(
        (r) => `<option value="${esc(r)}"${u.role === r ? ' selected' : ''}>${esc(r)} · ${esc(ROLE_LABELS[r] || r)}</option>`
      ).join('');
      const deptOpts = ['<option value="">(ไม่มี)</option>']
        .concat(DEPTS.map((d) => `<option value="${esc(d)}"${u.dept === d ? ' selected' : ''}>${esc(d)} · ${esc(DEPT_LABELS[d] || d)}</option>`))
        .join('');
      const self = me && (me.id === u.id || me.username === u.username);
      return `<tr data-testid="user-row" data-username="${un}">
<th scope="row">${un}${self ? ' <span class="muted">(ตัวคุณ)</span>' : ''}</th>
<td>${esc(u.name)}${u.active ? '' : ' <span class="muted">(ปิดใช้งาน)</span>'}</td>
<td><label class="visually-hidden" for="role-${un}">บทบาทของ ${un}</label><select id="role-${un}" data-testid="user-role-select">${roleOpts}</select></td>
<td><label class="visually-hidden" for="dept-${un}">ฝ่ายของ ${un}</label><select id="dept-${un}" data-testid="user-dept-select">${deptOpts}</select></td>
<td><button type="button" class="btn btn-primary" data-testid="user-save-btn" data-username="${un}">บันทึก</button></td>
</tr>`;
    })
    .join('\n');
  const body = `
<h1>จัดการผู้ใช้และบทบาท</h1>
<p class="muted">ฝ่ายใช้กับบทบาทเจ้าหน้าที่ (officer) เท่านั้น · ผู้ดูแลระบบเปลี่ยนบทบาทของตัวเองไม่ได้</p>
<div class="table-wrap">
<table>
<caption class="visually-hidden">ผู้ใช้เจ้าหน้าที่</caption>
<thead><tr><th scope="col">ชื่อผู้ใช้</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">ฝ่าย</th><th scope="col">บันทึก</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
  const scripts = `<script>
(function(){
  document.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-testid="user-save-btn"]') : null;
    if (!btn) return;
    var row = btn.closest('[data-testid="user-row"]');
    var username = btn.getAttribute('data-username');
    var role = row.querySelector('[data-testid="user-role-select"]').value;
    var dept = row.querySelector('[data-testid="user-dept-select"]').value;
    App.clearFlash();
    btn.disabled = true;
    App.api('PUT', '/api/admin/users/' + encodeURIComponent(username), { role: role, dept: dept }).then(function(r){
      if (!r.ok) { App.showError((r.data && r.data.message) || 'บันทึกไม่สำเร็จ'); return; }
      var d = r.data || {};
      row.querySelector('[data-testid="user-role-select"]').value = d.role;
      row.querySelector('[data-testid="user-dept-select"]').value = d.dept || '';
      App.showSuccess('บันทึก ' + username + ' แล้ว');
    }).catch(function(){ App.showError('บันทึกไม่สำเร็จ'); }).then(function(){ btn.disabled = false; });
  });
})();
</script>`;
  return sendPage(req, res, { title: 'จัดการผู้ใช้', body, scripts });
});

module.exports = router;
