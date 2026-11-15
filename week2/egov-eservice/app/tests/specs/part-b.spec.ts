/**
 * Playwright ชุด B (B13): WORKFLOW · DOC · PDPA · DASH · AUDIT · RBAC · NFR — 29 TC ตาม TEST-PLAN.md หมวด 10–16
 *
 * แหล่งอ้างอิงเดียว: TEST-PLAN.md (หมวด 10+), CONTRACT.md, TEST-DATA.md และ tests/helpers.ts (B11)
 *
 * ข้อตกลงของไฟล์นี้
 * - ทุก TC เริ่มด้วย RESET (helpers.reset) และล็อกอินใหม่เสมอ (CONTRACT ข้อ 0.9)
 * - LOGIN_S / LOGIN_C = ล็อกอินผ่าน API ด้วย `context.request` ของ BrowserContext ใหม่ → cookie ใช้ร่วมกับ `page`
 *   ของ context เดียวกัน (ล็อกอินครั้งเดียวต่อบัญชี ⇒ จำนวนแถว STAFF_LOGIN ตรงกับแผน)
 * - การตรวจสิทธิ์ยิง API ตรง (ไม่เชื่อว่าปุ่มซ่อน = ปลอดภัย) เช่น TC-RBAC-02 ยิง POST /api/cases/…/approve
 * - ไฟล์ส่งออก/ดาวน์โหลดถูกดักด้วย page.route → route.fetch → route.fulfill (ได้ทั้ง header และเนื้อไฟล์
 *   โดยไม่ยิงซ้ำ ⇒ ไม่เกิดแถว Audit EXPORT เกิน)
 * - สถานะเซิร์ฟเวอร์เป็นของกลาง: ต้องรันแบบ workers = 1 (ห้ามรันขนานกับไฟล์ spec อื่น)
 * - TC-NFR-04 ต้องตั้ง env `DB_PATH` (path ไฟล์ฐานข้อมูลที่ผู้รัน test อ่านได้)
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, APIResponse, Browser, BrowserContext, Locator, Page } from '@playwright/test';
const REC = () => (process.env.PW_VIDEO ? { recordVideo: { dir: test.info().outputDir, size: { width: 1024, height: 640 } } } : {}); // LAB 4: บันทึกวิดีโอเมื่อ PW_VIDEO=1
import AxeBuilder from '@axe-core/playwright';
import { existsSync, readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';
import { DEFAULT_NOW, STAFF_PASSWORD, TEST_OTP, loginCitizen, pay, reset, setClock, tamper } from '../helpers';

/* ───────────────────────────── ค่าคงที่จาก TEST-DATA / CONTRACT ───────────────────────────── */

let BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');

const SOMCHAI = '1101700123456';
const SOMYING = '3100600987659';
const MANA = '5500400111221';
const PITI = '1909900555015';

const C = (n: number): string => `EG-2569-${String(n).padStart(6, '0')}`;
const REASON10 = 'xxxxxxxxxx';
const REASON9 = 'xxxxxxxxx';
const SPACES10 = '          ';
const MASK_RE = /^X-XXXX-XXXXX-\d{2}-\d$/;
const DASHED_ID_RE = /\d-\d{4}-\d{5}-\d{2}-\d/;
const PHONE_RE = /0\d{9}/;
const NAMES = ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ'];

const STATUS_TH: Record<string, string> = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};
const LEVEL_TH: Record<string, string> = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};
const MSG = {
  reasonShort: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  reasonRequired: 'กรุณากรอกเหตุผล',
  returnLimit: 'ตีกลับได้สูงสุด 2 ครั้ง',
  forbiddenPage: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  notFound: 'ไม่พบคำขอ',
  invalidFee: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  invalidSla: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  dupHoliday: 'มีวันหยุดนี้อยู่แล้ว',
  noRefund: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
};

test.describe.configure({ timeout: 240_000 });

/* ───────────────────────────── session / context ───────────────────────────── */

const openContexts: BrowserContext[] = [];
const openRequests: APIRequestContext[] = [];

test.beforeEach(async ({ baseURL }) => {
  if (baseURL) BASE_URL = baseURL.replace(/\/+$/, '');
});

test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map(c => c.close().catch(() => undefined)));
  await Promise.all(openRequests.splice(0).map(r => r.dispose().catch(() => undefined)));
});

interface Actor {
  name: string;
  context: BrowserContext;
  page: Page;
  /** ใช้ cookie ร่วมกับ page (BrowserContext.request) */
  api: APIRequestContext;
}

/** RESET ผ่าน helpers.reset แล้วคืน request context สำหรับ test hook (ไม่มี cookie ล็อกอิน) */
async function resetAll(browser: Browser): Promise<APIRequestContext> {
  const s = await reset(browser, BASE_URL);
  openContexts.push(s.context);
  openRequests.push(s.api);
  return s.api;
}

const dialogPages = new WeakSet<Page>();

/** กล่อง confirm()/alert() ให้ "ตกลง" เสมอ (ค่าเริ่มต้นของ Playwright คือ dismiss ซึ่งจะยกเลิกการกระทำ) */
function acceptDialogs(page: Page): void {
  if (dialogPages.has(page)) return;
  dialogPages.add(page);
  page.on('dialog', d => {
    d.accept().catch(() => undefined);
  });
}

async function newActor(browser: Browser, name = 'anon', viewport?: { width: number; height: number }): Promise<Actor> {
  const context = await browser.newContext({ baseURL: BASE_URL, ...(viewport ? { viewport } : {}), ...REC() });
  openContexts.push(context);
  context.on('page', acceptDialogs);
  const page = await context.newPage();
  acceptDialogs(page);
  return { name, context, page, api: context.request };
}

/** LOGIN_S: SSO จำลองผ่าน API (cookie ไปอยู่ใน BrowserContext) */
async function asStaff(browser: Browser, username: string, viewport?: { width: number; height: number }): Promise<Actor> {
  const a = await newActor(browser, username, viewport);
  const res = await a.api.post('/api/auth/staff/login', { data: { username, password: STAFF_PASSWORD } });
  expect(res.status(), `LOGIN_S ${username}: ${await res.text()}`).toBe(200);
  return a;
}

/** LOGIN_C: ThaiD จำลอง + OTP ผ่าน API */
async function asCitizen(browser: Browser, idNo: string, name = idNo, viewport?: { width: number; height: number }): Promise<Actor> {
  const a = await newActor(browser, name, viewport);
  const start = await a.api.post('/api/auth/thaid/start', { data: { idNo } });
  expect(start.status(), `thaid/start ${idNo}: ${await start.text()}`).toBe(200);
  const verify = await a.api.post('/api/auth/thaid/verify', { data: { idNo, otp: TEST_OTP } });
  expect(verify.status(), `thaid/verify ${idNo}: ${await verify.text()}`).toBe(200);
  return a;
}

/* ───────────────────────────── API helpers ───────────────────────────── */

async function bodyOf(res: APIResponse): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** ตรวจ HTTP status (+ `code` ถ้าระบุ) แล้วคืน JSON body */
async function expectApi(res: APIResponse, status: number, code?: string, label?: string): Promise<any> {
  const body = await bodyOf(res);
  const where = `${label ?? ''} ${res.url()} → ${res.status()} ${JSON.stringify(body)}`.trim();
  expect(res.status(), where).toBe(status);
  if (code !== undefined) expect(body?.code, where).toBe(code);
  return body;
}

const apiApprove = (a: Actor, caseNo: string) => a.api.post(`/api/cases/${caseNo}/approve`);
const apiReject = (a: Actor, caseNo: string, reason: string) => a.api.post(`/api/cases/${caseNo}/reject`, { data: { reason } });
const apiOfficer = (a: Actor, caseNo: string, action: 'claim' | 'return' | 'forward' | 'issue' | 'unmask', data?: Record<string, unknown>) =>
  a.api.post(`/api/officer/cases/${caseNo}/${action}`, data ? { data } : undefined);

async function getCase(a: Actor, caseNo: string): Promise<any> {
  return expectApi(await a.api.get(`/api/cases/${caseNo}`), 200, undefined, `GET case ${caseNo} as ${a.name}`);
}

async function dashApi(a: Actor, period: string, service = 'ALL'): Promise<any> {
  return expectApi(await a.api.get(`/api/dashboard?period=${period}&service=${service}`), 200, undefined, 'dashboard');
}

/** PDF จริงขนาด 1,024 ไบต์ (รูปแบบเดียวกับ TEST-DATA §11) */
function pdf1024(): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(1024 - head.length - tail.length, 0x20), tail]);
}

/** NEW_PAID: ร่าง → แนบเอกสารบังคับ → สร้าง QR → ชำระผ่าน hook · คืนข้อมูลชำระ ({caseNo, receiptNo, ...}) */
async function newPaid(citizen: Actor, hooks: APIRequestContext, draft: Record<string, unknown>, amount: number): Promise<any> {
  const d = await expectApi(await citizen.api.post('/api/drafts', { data: draft }), 201, undefined, 'NEW_PAID draft');
  expect(d.fee, 'ค่าธรรมเนียมของร่าง').toBe(amount);
  const docKeys: Record<string, string[]> = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };
  for (const docKey of docKeys[String(draft.serviceId)] ?? ['id-card']) {
    await expectApi(
      await citizen.api.post(`/api/drafts/${d.draftId}/files`, {
        multipart: { file: { name: `${docKey}.pdf`, mimeType: 'application/pdf', buffer: pdf1024() }, docKey },
      }),
      201, undefined, `NEW_PAID upload ${docKey}`,
    );
  }
  const p = await expectApi(await citizen.api.post(`/api/drafts/${d.draftId}/payment`), 201, undefined, 'NEW_PAID payment');
  expect(p.amount).toBe(amount);
  const paid = await pay(hooks, p.ref, amount);
  expect(paid.status).toBe('PAID');
  return paid;
}

/* ───────────────────────────── UI helpers ───────────────────────────── */

const tid = (scope: Page | Locator, id: string): Locator => scope.getByTestId(id);
const rowOf = (page: Page, testId: string, attr: string, value: string): Locator =>
  page.locator(`[data-testid="${testId}"][${attr}="${value}"]`);

async function textOf(loc: Locator): Promise<string> {
  return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

async function openCase(page: Page, kind: 'officer' | 'citizen', caseNo: string): Promise<void> {
  await page.goto(`/${kind}/cases/${caseNo}`);
  await expect(tid(page, 'case-no')).toHaveText(caseNo);
}

async function expectCaseStatus(page: Page, code: string): Promise<void> {
  const el = tid(page, 'case-status');
  await expect(el).toHaveText(STATUS_TH[code]);
  await expect(el).toHaveAttribute('data-status', code);
}

async function expectSlaLevel(page: Page, level: string): Promise<void> {
  const el = tid(page, 'sla-level');
  await expect(el).toHaveText(LEVEL_TH[level]);
  await expect(el).toHaveAttribute('data-level', level);
}

/** เปิดกล่องเหตุผล (ถ้ายังไม่เปิด) → กรอก → ยืนยัน */
async function submitReason(page: Page, openBtn: string, input: string, submit: string, reason: string): Promise<void> {
  const field = tid(page, input);
  if (!(await field.isVisible())) await tid(page, openBtn).click();
  await field.fill(reason);
  await tid(page, submit).click();
}

/** รอให้คำขอ GET/POST ที่ path ตรง pattern ตอบกลับ (ถ้ามี) แล้วรอหน้าโหลดเสร็จ */
async function actAndSettle(page: Page, pathRe: RegExp, act: () => Promise<void>): Promise<void> {
  const wait = page.waitForResponse(r => pathRe.test(new URL(r.url()).pathname), { timeout: 10_000 }).catch(() => null);
  await act();
  await wait;
  await page.waitForLoadState('load');
}

interface Captured { url: string; status: number; headers: Record<string, string>; body: Buffer }

/**
 * ดักคำขอดาวน์โหลด/ส่งออกที่เกิดจากการกด (ลิงก์, fetch+blob, form) แล้วคืน header + เนื้อไฟล์
 * ใช้ route.fetch → route.fulfill จึงยิงไปเซิร์ฟเวอร์ครั้งเดียว
 */
async function captureDownload(page: Page, urlRe: RegExp, act: () => Promise<void>): Promise<Captured> {
  const captured: Captured[] = [];
  const match = (url: URL): boolean => urlRe.test(url.pathname + url.search);
  const handler = async (route: any): Promise<void> => {
    try {
      const r = await route.fetch();
      captured.push({ url: route.request().url(), status: r.status(), headers: r.headers(), body: await r.body() });
      await route.fulfill({ response: r });
    } catch {
      await route.continue().catch(() => undefined);
    }
  };
  await page.route(match, handler);
  try {
    await act();
    await expect.poll(() => captured.length, { timeout: 20_000, message: `ไม่พบคำขอดาวน์โหลดที่ตรง ${urlRe}` }).toBeGreaterThan(0);
  } finally {
    await page.unroute(match, handler).catch(() => undefined);
  }
  return captured[0];
}

/* ───────────────────────────── Audit helpers ───────────────────────────── */

interface AuditFilter { actor?: string; event?: string; from?: string; to?: string }
interface AuditRow {
  id: string; event: string; actor: string; caseNo: string; time: string;
  actorText: string; role: string; eventText: string; caseText: string; transition: string; detail: string;
}

async function applyAudit(page: Page, f: AuditFilter = {}): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/audit')) await page.goto('/audit');
  await tid(page, 'audit-filter-actor').fill(f.actor ?? '');
  await tid(page, 'audit-filter-event').selectOption({ value: f.event ?? '' });
  await tid(page, 'audit-filter-from').fill(f.from ?? '');
  await tid(page, 'audit-filter-to').fill(f.to ?? '');
  await actAndSettle(page, /audit/, () => tid(page, 'audit-apply-btn').click());
}

async function auditRows(page: Page): Promise<AuditRow[]> {
  return tid(page, 'audit-row').evaluateAll((rows: any[]) =>
    rows.map((r: any) => {
      const cell = (id: string): any => r.querySelector(`[data-testid="${id}"]`);
      const txt = (id: string): string => String(cell(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: String(r.getAttribute('data-id') ?? ''),
        event: String(r.getAttribute('data-event') ?? ''),
        actor: String(r.getAttribute('data-actor') ?? ''),
        caseNo: String(r.getAttribute('data-case-no') ?? ''),
        time: String(cell('audit-time')?.getAttribute('data-iso') ?? ''),
        actorText: txt('audit-actor'),
        role: txt('audit-role'),
        eventText: txt('audit-event'),
        caseText: txt('audit-case-no'),
        transition: txt('audit-transition'),
        detail: txt('audit-detail'),
      };
    }),
  );
}

/* ───────────────────────────── Dashboard helpers ───────────────────────────── */

interface Kpi { received: string; closed: string; pct: string; backlog: string; overdue: string }

async function chooseDashboard(page: Page, period: string, service: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const p = tid(page, 'period-select');
      await expect(p).toBeVisible();
      if ((await p.inputValue()) !== period) await actAndSettle(page, /dashboard/, () => p.selectOption(period).then(() => undefined));
      const s = tid(page, 'service-select');
      if ((await s.inputValue()) !== service) await actAndSettle(page, /dashboard/, () => s.selectOption(service).then(() => undefined));
      if ((await tid(page, 'period-select').inputValue()) === period && (await tid(page, 'service-select').inputValue()) === service) return;
    } catch {
      await page.waitForLoadState('load');
    }
  }
  throw new Error(`ตัวกรอง Dashboard ไม่คงค่า ${period}/${service}`);
}

async function expectKpis(page: Page, k: Kpi, label: string): Promise<void> {
  await expect.soft(tid(page, 'kpi-received'), `${label} kpi-received`).toHaveText(k.received);
  await expect.soft(tid(page, 'kpi-closed'), `${label} kpi-closed`).toHaveText(k.closed);
  await expect.soft(tid(page, 'kpi-ontime-pct'), `${label} kpi-ontime-pct`).toHaveText(k.pct);
  await expect.soft(tid(page, 'kpi-backlog'), `${label} kpi-backlog`).toHaveText(k.backlog);
  await expect.soft(tid(page, 'kpi-overdue'), `${label} kpi-overdue`).toHaveText(k.overdue);
}

function expectKpiApi(d: any, k: Kpi, label: string): void {
  expect.soft(d.received, `${label} received`).toBe(Number(k.received));
  expect.soft(d.closed, `${label} closed`).toBe(Number(k.closed));
  if (k.pct === '–') expect.soft(d.ontimePct, `${label} ontimePct`).toBeNull();
  else expect.soft(Number(d.ontimePct), `${label} ontimePct`).toBeCloseTo(Number(k.pct.replace('%', '')), 1);
  expect.soft(d.backlog, `${label} backlog`).toBe(Number(k.backlog));
  expect.soft(d.overdue, `${label} overdue`).toBe(Number(k.overdue));
}

/* ───────────────────────────── PDPA helpers ───────────────────────────── */

function thaiIdChecksumOk(d: string): boolean {
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

/**
 * ตัวเลขยาว ≥ 13 หลักที่ถือว่าเป็นเลขบัตรรั่ว
 * ยกเว้นตามที่ TEST-PLAN TC-PDPA-02 ระบุ ("เลข 13 หลักอื่น เช่น epoch ms ไม่นับ"): ตัวเลข 13 หลักพอดีที่อยู่ในช่วง
 * epoch ms (ปี 2017–2039) และไม่ผ่าน checksum เลขบัตร — เลขบัตรจริงผ่าน checksum เสมอจึงยังถูกจับ
 */
function idLikeRuns(s: string): string[] {
  return (s.match(/\d{13,}/g) ?? []).filter(run => !(run.length === 13 && !thaiIdChecksumOk(run) && Number(run) >= 1.48e12 && Number(run) <= 2.2e12));
}

function piiProblems(text: string): string[] {
  const out: string[] = [];
  const runs = idLikeRuns(text);
  if (runs.length) out.push(`เลข 13 หลัก: ${runs.join(', ')}`);
  const phone = text.match(PHONE_RE);
  if (phone) out.push(`เบอร์โทร: ${phone[0]}`);
  for (const n of NAMES) if (text.includes(n)) out.push(`ชื่อ: ${n}`);
  return out;
}

function hasKeyDeep(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some(x => hasKeyDeep(x, key));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === key || hasKeyDeep(x, key));
  return false;
}

function collectKey(v: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) v.forEach(x => collectKey(x, key, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === key) out.push(x);
      collectKey(x, key, out);
    }
  }
  return out;
}

/* ───────────────────────────── ตัวอ่านไฟล์ (PDF / XLSX / CSV) ───────────────────────────── */

function inflateMaybe(data: Buffer): string | undefined {
  try {
    return zlib.inflateSync(data).toString('latin1');
  } catch {
    try {
      return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
    } catch {
      return undefined;
    }
  }
}

function parseCMap(s: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (h: string): string => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length === 2) out += String.fromCharCode(parseInt(h, 16));
    return out;
  };
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), utf16(p[2]));
  }
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (p[3].startsWith('[')) {
        const arr = [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => x[1]);
        for (let i = 0; i < arr.length && lo + i <= hi; i++) map.set(lo + i, utf16(arr[i]));
      } else {
        const base = p[3].slice(1, -1);
        const head = base.slice(0, -4);
        const last = parseInt(base.slice(-4), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, utf16(head + (last + c - lo).toString(16).padStart(4, '0')));
      }
    }
  }
  return map;
}

function unescapePdfLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, g: string) => {
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (g in map) return map[g];
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return '';
  });
}

type Seg = { bytes: string } | { kern: number };

function textSegments(content: string): Seg[][] {
  const runs: Seg[][] = [];
  const strRe = /<([0-9a-fA-F\s]*)>|\(((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*)\)|(-?\d+(?:\.\d+)?)/g;
  const parseArr = (inner: string): Seg[] => {
    const segs: Seg[] = [];
    for (const m of inner.matchAll(strRe)) {
      if (m[1] !== undefined) {
        const hex = m[1].replace(/\s+/g, '');
        segs.push({ bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1') });
      } else if (m[2] !== undefined) segs.push({ bytes: unescapePdfLiteral(m[2]) });
      else if (m[3] !== undefined) segs.push({ kern: Number(m[3]) });
    }
    return segs;
  };
  for (const m of content.matchAll(/\[((?:[^\]\\]|\\[\s\S])*)\]\s*TJ/g)) runs.push(parseArr(m[1]));
  for (const m of content.matchAll(/(<[0-9a-fA-F\s]*>|\((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*\))\s*(?:Tj|'|")/g)) runs.push(parseArr(m[1]));
  return runs;
}

/**
 * ดึงข้อความที่แสดงใน PDF (text operators · รองรับ FlateDecode และ ToUnicode CMap ของฟอนต์ฝัง)
 * `text` = แต่ละ text run ขึ้นบรรทัดใหม่ · `flat` = run ต่อกันด้วยช่องว่าง (รองรับบรรทัดที่ถูกตัดขึ้นบรรทัด)
 */
function pdfText(buf: Buffer): { text: string; flat: string; raw: string } {
  const raw = buf.toString('latin1');
  const streams: string[] = [];
  const re = /(?<!end)stream(?:\r\n|\n|\r)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const data = buf.subarray(start, end);
    streams.push(inflateMaybe(data) ?? data.toString('latin1'));
    re.lastIndex = end + 'endstream'.length;
  }
  const cmaps = streams.filter(s => s.includes('begincmap')).map(parseCMap).filter(mp => mp.size > 0);
  // variants[0] = ถอดแบบ 1 ไบต์ (ฟอนต์มาตรฐาน) · variants[i+1] = ถอดด้วย CMap ที่ i
  const variants: string[][] = [[], ...cmaps.map(() => [] as string[])];
  for (const content of [raw, ...streams]) {
    for (const run of textSegments(content)) {
      let latin = '';
      const viaCmap = cmaps.map(() => '');
      for (const seg of run) {
        if ('kern' in seg) {
          if (seg.kern < -200) latin += ' ';
          continue;
        }
        latin += seg.bytes;
        cmaps.forEach((mp, i) => {
          if (seg.bytes.length % 2 === 0) {
            for (let j = 0; j < seg.bytes.length; j += 2) viaCmap[i] += mp.get(seg.bytes.charCodeAt(j) * 256 + seg.bytes.charCodeAt(j + 1)) ?? '';
          }
          for (let j = 0; j < seg.bytes.length; j++) {
            const one = mp.get(seg.bytes.charCodeAt(j));
            if (seg.bytes.length % 2 === 1 && one) viaCmap[i] += one;
          }
        });
      }
      variants[0].push(latin);
      viaCmap.forEach((t, i) => {
        if (t) variants[i + 1].push(t);
      });
    }
  }
  const norm = (s: string): string => s.replace(/[ \t ]+/g, ' ').trim();
  return {
    text: variants.map(v => v.map(norm).join('\n')).join('\n'),
    flat: variants.map(v => norm(v.join(' '))).join('\n'),
    raw: norm([raw, ...streams].join('\n')),
  };
}

function pdfHasLine(buf: Buffer, line: string): boolean {
  const { text, flat, raw } = pdfText(buf);
  return text.includes(line) || flat.includes(line) || raw.includes(line);
}

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ไม่ใช่ไฟล์ zip/xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** อ่าน xlsx: `first` = เซลล์ชีตแรก ('A1' → ข้อความ) · `all` = ข้อความทุกเซลล์ทุกชีต (ใช้ exceljs ถ้ามี ไม่มีก็อ่าน XML เอง) */
async function readXlsx(buf: Buffer): Promise<{ first: Map<string, string>; all: string[] }> {
  const first = new Map<string, string>();
  const all: string[] = [];
  try {
    const spec = 'exceljs';
    const mod: any = await import(spec);
    const Excel = mod.default ?? mod;
    const wb = new Excel.Workbook();
    await wb.xlsx.load(buf);
    wb.worksheets.forEach((ws: any, i: number) => {
      ws.eachRow({ includeEmpty: false }, (row: any) => {
        row.eachCell({ includeEmpty: false }, (cell: any) => {
          const t = String(cell.text ?? cell.value ?? '').trim();
          all.push(t);
          if (i === 0) first.set(String(cell.address), t);
        });
      });
    });
    return { first, all };
  } catch {
    /* fallback ด้านล่าง */
  }
  const files = unzip(buf);
  const xml = (name: string): string => files.get(name)?.toString('utf8') ?? '';
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlUnescape(t[1])).join(''),
  );
  const rid = xml('xl/workbook.xml').match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = rid ? xml('xl/_rels/workbook.xml.rels').match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1]
    ?? xml('xl/_rels/workbook.xml.rels').match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1] : undefined;
  const firstName = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml';
  for (const name of [...files.keys()].filter(n => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
    for (const c of xml(name).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1] ?? '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let t = '';
      if (type === 's' && v !== undefined) t = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') t = xmlUnescape(inner);
      else if (v !== undefined) t = xmlUnescape(v);
      t = t.trim();
      all.push(t);
      if (name === firstName) first.set(ref, t);
    }
  }
  return { first, all };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

/* ═════════════════════════════ 10. WORKFLOW ═════════════════════════════ */

test.describe('หมวด WORKFLOW', () => {
  test('TC-WORKFLOW-01 · SV-01 อนุมัติ + ออกเอกสาร', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;
    await openCase(p, 'officer', C(25));

    // 1 ตรวจปุ่ม
    await expectCaseStatus(p, 'IN_REVIEW');
    await expect(tid(p, 'approve-btn')).toHaveCount(1);
    await expect(tid(p, 'return-btn')).toHaveCount(1);
    await expect(tid(p, 'reject-btn')).toHaveCount(1);
    await expect(tid(p, 'forward-btn')).toHaveCount(0);
    await expect(tid(p, 'issue-btn')).toHaveCount(0);
    await expect(tid(p, 'case-fee')).toHaveText('฿60');

    // 2 off.reg1 ไม่ใช่ผู้ถือ …000026 → 403
    const reg1 = await asStaff(browser, 'off.reg1');
    await expectApi(await apiApprove(reg1, C(26)), 403, 'FORBIDDEN', 'off.reg1 approve 000026');

    // 3 อนุมัติ
    await tid(p, 'approve-btn').click();
    await expectCaseStatus(p, 'APPROVED');
    await expect(tid(p, 'issue-btn')).toHaveCount(1);
    await expect(tid(p, 'approve-btn')).toHaveCount(0);

    // 4 ออกเอกสาร
    await tid(p, 'issue-btn').click();
    await expectCaseStatus(p, 'COMPLETED');
    await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
    expect(await textOf(tid(p, 'verify-code'))).toMatch(/^[A-Z0-9]{8}$/);
    await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', DEFAULT_NOW);
    await expectSlaLevel(p, 'closed');

    // 5 สมหญิงดาวน์โหลดเอกสาร
    const somying = await asCitizen(browser, SOMYING, 'สมหญิง');
    await openCase(somying.page, 'citizen', C(25));
    await expectCaseStatus(somying.page, 'COMPLETED');
    await expect(tid(somying.page, 'download-doc-btn')).toHaveCount(1);
    const dl = await captureDownload(somying.page, /documents?|download|\.pdf/i, () => tid(somying.page, 'download-doc-btn').click());
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type'] ?? '').toContain('application/pdf');
    expect(dl.headers['content-disposition'] ?? '').toContain('DOC-2569-000002.pdf');
    expect(pdfHasLine(dl.body, 'docNo=DOC-2569-000002 caseNo=EG-2569-000025'), 'บรรทัด ASCII ในเนื้อ PDF').toBe(true);

    // 6 Dashboard
    const exec = await asStaff(browser, 'exec1');
    const d = await dashApi(exec, '2026-12');
    expect(d.closed).toBe(1);
    expect(d.onTime).toBe(1);
    expect(d.received).toBe(3);
    expect(d.backlog).toBe(20);
  });

  test('TC-WORKFLOW-02 · SV-02 ผ่านหัวหน้า', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    await openCase(reg2.page, 'officer', C(13));

    // 1
    await expect(tid(reg2.page, 'approve-btn')).toHaveCount(0);
    await expect(tid(reg2.page, 'forward-btn')).toHaveCount(1);
    await expect(tid(reg2.page, 'forward-target')).toHaveCount(0);

    // 2 ส่งต่อ
    await tid(reg2.page, 'forward-btn').click();
    await expectCaseStatus(reg2.page, 'PENDING_APPROVAL');
    await reg2.page.goto('/officer/queue');
    await expect(tid(reg2.page, 'workload-count')).toHaveText('8');
    await expect(tid(reg2.page, 'queue-row').first()).toBeVisible();
    await expect(rowOf(reg2.page, 'queue-row', 'data-case-no', C(13))).toHaveCount(0);

    // 3 head1 รายการรออนุมัติ
    const head = await asStaff(browser, 'head1');
    await head.page.goto('/head/approvals');
    await expect(tid(head.page, 'approval-row')).toHaveCount(3);
    expect(await tid(head.page, 'approval-row').evaluateAll((rs: any[]) => rs.map(r => r.getAttribute('data-case-no')))).toEqual([C(13), C(14), C(11)]);

    // 4 เปิดคำขอ
    await tid(rowOf(head.page, 'approval-row', 'data-case-no', C(13)), 'approval-open').click();
    await head.page.waitForURL(new RegExp(`/officer/cases/${C(13)}`));
    await expect(tid(head.page, 'case-no')).toHaveText(C(13));
    await expect(tid(head.page, 'approve-btn')).toHaveCount(1);
    await expect(tid(head.page, 'reject-btn')).toHaveCount(1);
    await expect(tid(head.page, 'issue-btn')).toHaveCount(0);

    // 5 อนุมัติ · หัวหน้าไม่มีปุ่มออกเอกสาร
    await tid(head.page, 'approve-btn').click();
    await expectCaseStatus(head.page, 'APPROVED');
    await expect(tid(head.page, 'issue-btn')).toHaveCount(0);

    // 6 off.reg1 (ไม่ใช่ผู้รับเรื่อง)
    const reg1 = await asStaff(browser, 'off.reg1');
    await openCase(reg1.page, 'officer', C(13));
    await expect(tid(reg1.page, 'issue-btn')).toHaveCount(0);
    await expectApi(await apiOfficer(reg1, C(13), 'issue'), 403, 'FORBIDDEN', 'off.reg1 issue 000013');

    // 7 off.reg2 ออกเอกสาร → ผู้ลงนาม = หัวหน้าฝ่าย
    await openCase(reg2.page, 'officer', C(13));
    await tid(reg2.page, 'issue-btn').click();
    await expectCaseStatus(reg2.page, 'COMPLETED');
    await expect(tid(reg2.page, 'doc-no')).toHaveText('DOC-2569-000002');
    const code = await textOf(tid(reg2.page, 'verify-code'));
    const anon = await newActor(browser);
    await anon.page.goto(`/verify/${code}`);
    await expect(tid(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');

    // 8 RESET · seed …000019 (APPROVED โดย head1) → off.reg1 ออกเอกสาร
    await resetAll(browser);
    const reg1b = await asStaff(browser, 'off.reg1');
    await openCase(reg1b.page, 'officer', C(19));
    await tid(reg1b.page, 'issue-btn').click();
    await expectCaseStatus(reg1b.page, 'COMPLETED');
    await expect(tid(reg1b.page, 'doc-no')).toHaveText('DOC-2569-000002');
    const code2 = await textOf(tid(reg1b.page, 'verify-code'));
    const anon2 = await newActor(browser);
    await anon2.page.goto(`/verify/${code2}`);
    await expect(tid(anon2.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
  });

  test('TC-WORKFLOW-03 · SV-03 สามขั้นตอน', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    await openCase(reg2.page, 'officer', C(12));

    // 1
    await expect(tid(reg2.page, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
    await expect(tid(reg2.page, 'case-fee')).toHaveText('฿1,010');
    await expect(tid(reg2.page, 'forward-btn')).toHaveCount(1);

    // 2 ส่งต่อไปโยธา
    await tid(reg2.page, 'forward-btn').click();
    await expect(tid(reg2.page, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
    await expectCaseStatus(reg2.page, 'IN_REVIEW');
    await expect(tid(reg2.page, 'case-owner')).toHaveText('ยังไม่มีผู้รับ');

    // 3 คิวทะเบียน
    await reg2.page.goto('/officer/queue');
    await expect(tid(reg2.page, 'workload-count')).toHaveText('8');
    await expect(tid(reg2.page, 'queue-row')).toHaveCount(16);
    await expect(rowOf(reg2.page, 'queue-row', 'data-case-no', C(12))).toHaveCount(0);

    // 4 คิวโยธา
    const works = await asStaff(browser, 'off.works1');
    await works.page.goto('/officer/queue');
    await expect(tid(works.page, 'queue-row')).toHaveCount(2);
    expect(await tid(works.page, 'queue-row').evaluateAll((rs: any[]) => rs.map(r => r.getAttribute('data-case-no')))).toEqual([C(10), C(12)]);
    await expect(tid(works.page, 'claim-btn')).toHaveCount(2);

    // 5 off.reg1 ข้ามแผนก
    const reg1 = await asStaff(browser, 'off.reg1');
    await expectApi(await apiOfficer(reg1, C(12), 'claim'), 403, 'FORBIDDEN', 'off.reg1 claim 000012');

    // 6 off.works1 รับเรื่องแล้วส่งต่อ
    await openCase(works.page, 'officer', C(12));
    await tid(works.page, 'claim-btn').click();
    await expect(tid(works.page, 'case-owner')).toHaveText('off.works1');
    await tid(works.page, 'forward-btn').click();
    await expectCaseStatus(works.page, 'PENDING_APPROVAL');
    await expect(tid(works.page, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');

    // 7 หัวหน้าอนุมัติ
    const head = await asStaff(browser, 'head1');
    await head.page.goto('/head/approvals');
    await expect(tid(head.page, 'approval-row')).toHaveCount(3);
    await expect(rowOf(head.page, 'approval-row', 'data-case-no', C(12))).toHaveCount(1);
    await tid(rowOf(head.page, 'approval-row', 'data-case-no', C(12)), 'approval-open').click();
    await head.page.waitForURL(new RegExp(`/officer/cases/${C(12)}`));
    await tid(head.page, 'approve-btn').click();
    await expectCaseStatus(head.page, 'APPROVED');

    // 8 ผู้ออกเอกสาร = ทะเบียนขั้นแรก (off.reg2)
    await openCase(works.page, 'officer', C(12));
    await expect(tid(works.page, 'issue-btn')).toHaveCount(0);
    await openCase(reg2.page, 'officer', C(12));
    await expect(tid(reg2.page, 'issue-btn')).toHaveCount(1);
    await tid(reg2.page, 'issue-btn').click();
    await expectCaseStatus(reg2.page, 'COMPLETED');
    const code = await textOf(tid(reg2.page, 'verify-code'));
    const anon = await newActor(browser);
    await anon.page.goto(`/verify/${code}`);
    await expect(tid(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
  });

  test('TC-WORKFLOW-04 · ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ browser }) => {
    // ── ส่วน A: SV-01 …000020 ครั้งที่ 1, 2 ✓ · ครั้งที่ 3 ✗
    await resetAll(browser);
    const reg1 = await asStaff(browser, 'off.reg1');
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    for (const round of [1, 2]) {
      await openCase(reg1.page, 'officer', C(20));
      await submitReason(reg1.page, 'return-btn', 'return-reason', 'return-submit', REASON10);
      await expectCaseStatus(reg1.page, 'NEED_FIX');
      await expect(tid(reg1.page, 'return-count')).toHaveText(String(round));

      await openCase(somchai.page, 'citizen', C(20));
      await tid(somchai.page, 'submit-fix-btn').click();
      await expectCaseStatus(somchai.page, 'IN_REVIEW');
      expect((await getCase(reg1, C(20))).owner, 'ผู้ถือเรื่องเดิมหลังส่งแก้').toBe('off.reg1');
    }
    await openCase(reg1.page, 'officer', C(20));
    await expect(tid(reg1.page, 'return-btn')).toHaveCount(0);
    const limitA = await expectApi(await apiOfficer(reg1, C(20), 'return', { reason: REASON10 }), 409, 'RETURN_LIMIT', 'return ครั้งที่ 3');
    expect(limitA.message).toBe(MSG.returnLimit);
    await reg1.page.reload();
    await expectCaseStatus(reg1.page, 'IN_REVIEW');
    await expect(tid(reg1.page, 'return-count')).toHaveText('2');
    await expect(tid(reg1.page, 'approve-btn')).toHaveCount(1);
    await expect(tid(reg1.page, 'reject-btn')).toHaveCount(1);

    // ── ส่วน B: seed …000023 ตีกลับแล้ว 2 ครั้ง
    await resetAll(browser);
    const reg1b = await asStaff(browser, 'off.reg1');
    await openCase(reg1b.page, 'officer', C(23));
    await expect(tid(reg1b.page, 'return-count')).toHaveText('2');
    await expect(tid(reg1b.page, 'return-btn')).toHaveCount(0);
    await expectApi(await apiOfficer(reg1b, C(23), 'return', { reason: REASON10 }), 409, 'RETURN_LIMIT', 'return 000023');
    expect((await getCase(reg1b, C(23))).status).toBe('IN_REVIEW');
    await reg1b.page.reload();
    await expectCaseStatus(reg1b.page, 'IN_REVIEW');
    await expect(tid(reg1b.page, 'approve-btn')).toHaveCount(1);
    await expect(tid(reg1b.page, 'reject-btn')).toHaveCount(1);

    // ── ส่วน C: SV-02 …000013 หลังตีกลับครบ 2 ครั้ง
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    const somchaiC = await asCitizen(browser, SOMCHAI, 'สมชาย');
    for (const round of [1, 2]) {
      const r = await expectApi(await apiOfficer(reg2, C(13), 'return', { reason: REASON10 }), 200, undefined, `return #${round}`);
      expect(r.status).toBe('NEED_FIX');
      expect(r.returnCount).toBe(round);
      const fix = await expectApi(await somchaiC.api.post(`/api/cases/${C(13)}/resubmit`), 200, undefined, `resubmit #${round}`);
      expect(fix.status).toBe('IN_REVIEW');
    }
    await openCase(reg2.page, 'officer', C(13));
    await expectCaseStatus(reg2.page, 'IN_REVIEW');
    await expect(tid(reg2.page, 'return-btn')).toHaveCount(0);
    await expect(tid(reg2.page, 'approve-btn')).toHaveCount(0);
    await expect(tid(reg2.page, 'reject-btn')).toHaveCount(0);
    await expect(tid(reg2.page, 'forward-btn')).toHaveCount(1);
    await expectApi(await apiReject(reg2, C(13), REASON10), 403, undefined, 'off.reg2 reject SV-02');
    await tid(reg2.page, 'forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา');
    await tid(reg2.page, 'forward-btn').click();
    await expectCaseStatus(reg2.page, 'PENDING_APPROVAL');

    const audit = await asStaff(browser, 'audit1');
    await audit.page.goto('/audit');
    await applyAudit(audit.page, { event: 'FORWARD' });
    const fwd = rowOf(audit.page, 'audit-row', 'data-case-no', C(13));
    await expect(fwd).toHaveCount(1);
    await expect(tid(fwd, 'audit-detail')).toContainText('ส่งต่อให้หัวหน้าพิจารณา');

    const head = await asStaff(browser, 'head1');
    await openCase(head.page, 'officer', C(13));
    await expect(tid(head.page, 'reject-btn')).toHaveCount(1);
    await expect(tid(head.page, 'approve-btn')).toHaveCount(1);
  });

  test('TC-WORKFLOW-05 · เหตุผล ≥ 10 ตัวอักษร (ตีกลับ / ไม่อนุมัติ)', async ({ browser }) => {
    // ── ส่วน A ตีกลับ …000020 (off.reg1)
    await resetAll(browser);
    const reg1 = await asStaff(browser, 'off.reg1');
    for (const bad of [REASON9, SPACES10]) {
      await openCase(reg1.page, 'officer', C(20));
      await submitReason(reg1.page, 'return-btn', 'return-reason', 'return-submit', bad);
      await expect(tid(reg1.page, 'return-reason-error')).toHaveText(MSG.reasonShort);
      await expectApi(await apiOfficer(reg1, C(20), 'return', { reason: bad }), 400, 'REASON_TOO_SHORT', `return "${bad}"`);
      await reg1.page.reload();
      await expectCaseStatus(reg1.page, 'IN_REVIEW');
    }
    await openCase(reg1.page, 'officer', C(20));
    await submitReason(reg1.page, 'return-btn', 'return-reason', 'return-submit', REASON10);
    await expectCaseStatus(reg1.page, 'NEED_FIX');
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await openCase(somchai.page, 'citizen', C(20));
    await expect(tid(somchai.page, 'return-reason-display')).toHaveText(REASON10);

    // ── ส่วน B ไม่อนุมัติ SV-01 …000026 (off.reg2)
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    await openCase(reg2.page, 'officer', C(26));
    await submitReason(reg2.page, 'reject-btn', 'reject-reason', 'reject-submit', REASON9);
    await expect(tid(reg2.page, 'reject-reason-error')).toHaveText(MSG.reasonShort);
    await expectApi(await apiReject(reg2, C(26), REASON9), 400, 'REASON_TOO_SHORT', 'reject 9 ตัว');
    await openCase(reg2.page, 'officer', C(26));
    await expectCaseStatus(reg2.page, 'IN_REVIEW');
    await submitReason(reg2.page, 'reject-btn', 'reject-reason', 'reject-submit', REASON10);
    await expectCaseStatus(reg2.page, 'REJECTED');
    await expect(tid(reg2.page, 'closed-at')).toHaveAttribute('data-iso', DEFAULT_NOW);
    await expectSlaLevel(reg2.page, 'closed');
    const somchaiB = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await openCase(somchaiB.page, 'citizen', C(26));
    await expect(tid(somchaiB.page, 'no-refund-note')).toHaveText(MSG.noRefund);
    const exec = await asStaff(browser, 'exec1');
    const d = await dashApi(exec, '2026-12');
    expect(d.closed).toBe(1);
    expect(d.onTime).toBe(1);

    // ── ส่วน C หัวหน้าไม่อนุมัติ …000011
    await resetAll(browser);
    const head = await asStaff(browser, 'head1');
    await openCase(head.page, 'officer', C(11));
    await submitReason(head.page, 'reject-btn', 'reject-reason', 'reject-submit', REASON9);
    await expect(tid(head.page, 'reject-reason-error')).toHaveText(MSG.reasonShort);
    await expectApi(await apiReject(head, C(11), REASON9), 400, 'REASON_TOO_SHORT', 'head reject 9 ตัว');
    const ok = await expectApi(await apiReject(head, C(11), REASON10), 200, undefined, 'head reject 10 ตัว');
    expect(ok.status).toBe('REJECTED');
    await openCase(head.page, 'officer', C(11));
    await expectCaseStatus(head.page, 'REJECTED');
  });

  test('TC-WORKFLOW-06 · เวลาแก้ไข 168 ชั่วโมง', async ({ browser }) => {
    // หน้าตั้งต้น
    await resetAll(browser);
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    const p = somchai.page;
    await openCase(p, 'citizen', C(17));
    await expectCaseStatus(p, 'NEED_FIX');
    await expect(tid(p, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
    await expect(tid(p, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
    await expect(tid(p, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00');
    await expect(tid(p, 'submit-fix-btn')).toHaveCount(1);

    // รอบ A: 167:59 → ส่งแก้ได้
    const hooksA = await resetAll(browser);
    await setClock(hooksA, '2026-12-04T13:59:00+07:00');
    const a = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await openCase(a.page, 'citizen', C(17));
    await expect(tid(a.page, 'submit-fix-btn')).toBeEnabled();
    await tid(a.page, 'submit-fix-btn').click();
    await expectCaseStatus(a.page, 'IN_REVIEW');

    // รอบ B: 168:00 → ยกเลิกอัตโนมัติ
    const hooksB = await resetAll(browser);
    await setClock(hooksB, '2026-12-04T14:00:00+07:00');
    const b = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await openCase(b.page, 'citizen', C(17));
    await expectCaseStatus(b.page, 'CANCELLED');
    await expect(tid(b.page, 'submit-fix-btn')).toHaveCount(0);
    await expect(tid(b.page, 'no-refund-note')).toHaveText(MSG.noRefund);
    const r = await b.api.post(`/api/cases/${C(17)}/resubmit`);
    expect(r.status(), await r.text()).toBe(409);
    await expect(tid(b.page, 'case-timeline')).toBeVisible();
    await expect(b.page.locator('[data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]').first()).toBeAttached();
    const exec = await asStaff(browser, 'exec1');
    expect((await dashApi(exec, '2026-12')).backlog).toBe(20);
  });
});

/* ═════════════════════════════ 11. DOC ═════════════════════════════ */

test.describe('หมวด DOC', () => {
  async function approveAndIssue(a: Actor, caseNo: string, approveFirst = true): Promise<any> {
    if (approveFirst) {
      const ap = await expectApi(await apiApprove(a, caseNo), 200, undefined, `approve ${caseNo}`);
      expect(ap.status).toBe('APPROVED');
    }
    return expectApi(await apiOfficer(a, caseNo, 'issue'), 200, undefined, `issue ${caseNo}`);
  }

  async function verifyAt(hooks: APIRequestContext, anon: Actor, code: string, now: string, result: string, expires?: string): Promise<void> {
    await setClock(hooks, now);
    const res = await anon.page.goto(`/verify/${code}`);
    expect(res?.status(), `/verify/${code} @ ${now}`).toBe(200);
    const thai: Record<string, string> = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง' };
    await expect(tid(anon.page, 'verify-result'), `@ ${now}`).toHaveText(thai[result]);
    await expect(tid(anon.page, 'verify-result')).toHaveAttribute('data-result', result);
    if (expires) await expect(tid(anon.page, 'verify-expires')).toHaveAttribute('data-iso', expires);
  }

  test('TC-DOC-01 · ออกเอกสารและข้อมูลในเอกสาร', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    const issued = await approveAndIssue(reg2, C(25));
    expect(issued.docNo).toBe('DOC-2569-000002');
    expect(issued.status).toBe('COMPLETED');
    expect(String(issued.verifyCode)).toMatch(/^[A-Z0-9]{8}$/);
    const code: string = issued.verifyCode;

    // PDF ของผู้ยื่น
    const somying = await asCitizen(browser, SOMYING, 'สมหญิง');
    const pdfRes = await somying.api.get('/api/documents/DOC-2569-000002/pdf');
    expect(pdfRes.status()).toBe(200);
    expect(pdfRes.headers()['content-type'] ?? '').toContain('application/pdf');
    expect(pdfRes.headers()['content-disposition'] ?? '').toContain('DOC-2569-000002.pdf');
    const line = `docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${code} validUntil=2027-02-28`;
    expect(pdfHasLine(await pdfRes.body(), line), `PDF ต้องมีบรรทัด: ${line}`).toBe(true);

    // หน้า /verify (ไม่ล็อกอิน)
    const anon = await newActor(browser);
    await anon.page.goto(`/verify/${code}`);
    await expect(tid(anon.page, 'verify-result')).toHaveText('เอกสารถูกต้อง');
    await expect(tid(anon.page, 'verify-result')).toHaveAttribute('data-result', 'VALID');
    await expect(tid(anon.page, 'verify-doc-no')).toHaveText('DOC-2569-000002');
    await expect(tid(anon.page, 'verify-applicant')).toHaveText('สมหญิง ร***');
    await expect(tid(anon.page, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await expect(tid(anon.page, 'verify-issued')).toHaveAttribute('data-iso', DEFAULT_NOW);
    await expect(tid(anon.page, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-28');
    await expect(tid(anon.page, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 2');

    // QR บนหน้าเคส
    await openCase(reg2.page, 'officer', C(25));
    const sameHost = (u: string): string => u.replace('://localhost', '://127.0.0.1');
    const qrUrl = (await tid(reg2.page, 'doc-qr').getAttribute('data-url')) ?? '';
    expect(sameHost(qrUrl), 'doc-qr data-url = <BASE_URL>/verify/<code>').toBe(sameHost(`${BASE_URL}/verify/${code}`));

    // API verify
    const v = await expectApi(await anon.api.get(`/api/verify/${code}`), 200, undefined, 'api verify');
    expect(v.result).toBe('VALID');
    expect(v.validUntil).toBe('2027-02-28');
    expect(v.issuedAt).toBe(DEFAULT_NOW);

    // สมชาย (ไม่ใช่ผู้ยื่น) → 404
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    expect((await somchai.api.get('/api/documents/DOC-2569-000002/pdf')).status()).toBe(404);

    // ออกซ้ำ → 409 และไม่กินเลขเอกสาร (เอกสารถัดไปยังเป็น DOC-2569-000003)
    await expectApi(await apiOfficer(reg2, C(25), 'issue'), 409, 'INVALID_STATE', 'issue ซ้ำ');
    const reg1 = await asStaff(browser, 'off.reg1');
    const next = await approveAndIssue(reg1, C(19), false);
    expect(next.docNo, 'เลขเอกสารถัดไปหลังออกซ้ำไม่สำเร็จ').toBe('DOC-2569-000003');
  });

  test('TC-DOC-02 · ตรวจเอกสาร /verify', async ({ browser }) => {
    await resetAll(browser);
    const anon = await newActor(browser);
    const res = await anon.page.goto('/verify/K7M2Q9XA');
    expect(res?.status()).toBe(200);
    expect(new URL(anon.page.url()).pathname).toBe('/verify/K7M2Q9XA');
    await expect(tid(anon.page, 'verify-result')).toHaveText('เอกสารถูกต้อง');
    await expect(tid(anon.page, 'verify-result')).toHaveAttribute('data-result', 'VALID');
    await expect(tid(anon.page, 'verify-doc-no')).toHaveText('DOC-2569-000001');
    await expect(tid(anon.page, 'verify-applicant')).toHaveText('สมชาย ใ***');
    await expect(tid(anon.page, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await expect(tid(anon.page, 'verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
    await expect(tid(anon.page, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-02');
    await expect(tid(anon.page, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 1');
    // PDPA
    const html = await anon.page.content();
    expect(html).not.toContain('ใจดี');
    expect(html).not.toContain(SOMCHAI);

    const nf = await anon.page.goto('/verify/ZZZZZZZZ');
    expect(nf?.status()).toBe(404);
    await expect(tid(anon.page, 'verify-result')).toHaveText('ไม่พบเอกสาร');
    await expect(tid(anon.page, 'verify-result')).toHaveAttribute('data-result', 'NOT_FOUND');
    await expect(tid(anon.page, 'verify-applicant')).toHaveCount(0);
    await expect(tid(anon.page, 'verify-doc-no')).toHaveCount(0);

    const ok = await expectApi(await anon.api.get('/api/verify/K7M2Q9XA'), 200);
    expect(ok.result).toBe('VALID');
    expect(ok.applicantMasked).toBe('สมชาย ใ***');
    expect(JSON.stringify(ok)).not.toContain('ใจดี');
    const missing = await expectApi(await anon.api.get('/api/verify/ZZZZZZZZ'), 404);
    expect(missing.result).toBe('NOT_FOUND');
  });

  test('TC-DOC-03 · เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser }) => {
    test.setTimeout(360_000);

    // ส่วน A: SV-01 ออก 1 ธ.ค. 69 → ใช้ได้ถึง 28 ก.พ. 70
    let hooks = await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    const c1: string = (await approveAndIssue(reg2, C(25))).verifyCode;
    const anonA = await newActor(browser);
    await verifyAt(hooks, anonA, c1, '2027-02-28T23:59:00+07:00', 'VALID', '2027-02-28');
    await verifyAt(hooks, anonA, c1, '2027-03-01T00:00:00+07:00', 'EXPIRED', '2027-02-28');

    // ส่วน B: SV-02 ออก 1 ธ.ค. 69 → 1 ปี
    hooks = await resetAll(browser);
    const reg1 = await asStaff(browser, 'off.reg1');
    const c2: string = (await approveAndIssue(reg1, C(19), false)).verifyCode;
    const anonB = await newActor(browser);
    await verifyAt(hooks, anonB, c2, '2027-11-30T23:59:00+07:00', 'VALID', '2027-11-30');
    await verifyAt(hooks, anonB, c2, '2027-12-01T00:00:00+07:00', 'EXPIRED');

    // ส่วน C: seed K7M2Q9XA ใช้ได้ถึง 2 ก.พ. 70
    hooks = await resetAll(browser);
    const anonC = await newActor(browser);
    await verifyAt(hooks, anonC, 'K7M2Q9XA', '2027-02-02T23:59:00+07:00', 'VALID', '2027-02-02');
    await verifyAt(hooks, anonC, 'K7M2Q9XA', '2027-02-03T00:00:00+07:00', 'EXPIRED');

    // ส่วน E: ออกวันที่ 29 ก.พ. 2571 (ค.ศ. 2028)
    hooks = await resetAll(browser);
    await setClock(hooks, '2028-02-29T10:00:00+07:00');
    const reg2e = await asStaff(browser, 'off.reg2');
    const reg1e = await asStaff(browser, 'off.reg1');
    const e1 = await approveAndIssue(reg2e, C(25));
    expect(e1.docNo).toBe('DOC-2571-000001');
    const e2 = await approveAndIssue(reg1e, C(19), false);
    expect(e2.docNo).toBe('DOC-2571-000002');
    const anonE = await newActor(browser);
    await verifyAt(hooks, anonE, e1.verifyCode, '2028-05-28T23:59:00+07:00', 'VALID', '2028-05-28');
    await verifyAt(hooks, anonE, e1.verifyCode, '2028-05-29T00:00:00+07:00', 'EXPIRED', '2028-05-28');
    await verifyAt(hooks, anonE, e2.verifyCode, '2029-02-27T23:59:00+07:00', 'VALID', '2029-02-27');
    await verifyAt(hooks, anonE, e2.verifyCode, '2029-02-28T00:00:00+07:00', 'EXPIRED', '2029-02-27');

    // ส่วน D: ลายเซ็นไม่ตรง (ตรวจก่อนวันหมดอายุ)
    hooks = await resetAll(browser);
    await tamper(hooks, 'DOC-2569-000001');
    const anonD = await newActor(browser);
    const res = await anonD.page.goto('/verify/K7M2Q9XA');
    expect(res?.status()).toBe(200);
    await expect(tid(anonD.page, 'verify-result')).toHaveText('ลายเซ็นไม่ถูกต้อง');
    await expect(tid(anonD.page, 'verify-result')).toHaveAttribute('data-result', 'TAMPERED');
    await expect(tid(anonD.page, 'verify-doc-no')).toHaveCount(0);
    await expect(tid(anonD.page, 'verify-applicant')).toHaveCount(0);
    await verifyAt(hooks, anonD, 'K7M2Q9XA', '2027-03-01T00:00:00+07:00', 'TAMPERED');
    await expect(tid(anonD.page, 'verify-doc-no')).toHaveCount(0);
    await expect(tid(anonD.page, 'verify-applicant')).toHaveCount(0);
  });
});

/* ═════════════════════════════ 12. PDPA ═════════════════════════════ */

test.describe('หมวด PDPA', () => {
  test('TC-PDPA-01 · ปิดบังเลขบัตรบนจอ', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    await reg2.page.goto('/officer/queue');
    await expect(tid(reg2.page, 'queue-row').first()).toBeVisible();
    const masks = await tid(reg2.page, 'row-id-masked').allTextContents();
    expect(masks.length).toBeGreaterThan(0);
    for (const m of masks) expect(m.trim()).toMatch(MASK_RE);
    await expect(tid(rowOf(reg2.page, 'queue-row', 'data-case-no', C(25)), 'row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(tid(rowOf(reg2.page, 'queue-row', 'data-case-no', C(26)), 'row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');

    await openCase(reg2.page, 'officer', C(25));
    await expect(tid(reg2.page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    const html = await reg2.page.content();
    expect(html).not.toContain(SOMYING);
    expect(html).not.toContain('3-1006-00987-65-9');

    const head = await asStaff(browser, 'head1');
    await openCase(head.page, 'officer', C(25));
    await expect(tid(head.page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');

    const somying = await asCitizen(browser, SOMYING, 'สมหญิง');
    await openCase(somying.page, 'citizen', C(25));
    await expect(tid(somying.page, 'case-id-full')).toHaveText('3-1006-00987-65-9');

    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await openCase(somchai.page, 'citizen', C(20));
    await expect(tid(somchai.page, 'case-id-full')).toHaveText('1-1017-00123-45-6');
  });

  test('TC-PDPA-02 · API (JSON) ไม่ส่งเลขบัตรเต็ม', async ({ browser }) => {
    await resetAll(browser);
    const endpoints = [
      '/api/officer/queue?filter=all',
      `/api/cases/${C(25)}`,
      `/api/cases/${C(26)}`,
      `/api/cases/${C(20)}`,
      '/api/notifications',
      `/api/cases/${C(25)}/files`,
    ];
    for (const username of ['off.reg1', 'head1']) {
      const staff = await asStaff(browser, username);
      for (const path of endpoints) {
        const label = `${username} GET ${path}`;
        const res = await staff.api.get(path);
        expect(res.status(), label).toBe(200);
        expect(res.headers()['content-type'] ?? '', label).toContain('application/json');
        const body = await res.json();
        const s = JSON.stringify(body);
        expect.soft(idLikeRuns(s), `${label}: ตัวเลข 13 หลัก`).toEqual([]);
        expect.soft(s, label).not.toMatch(DASHED_ID_RE);
        expect.soft(hasKeyDeep(body, 'idNo'), `${label}: มี key idNo`).toBe(false);
        for (const id of [SOMYING, SOMCHAI, PITI]) expect.soft(s, label).not.toContain(id);
        for (const m of collectKey(body, 'idMasked')) expect.soft(String(m), `${label}: idMasked`).toMatch(MASK_RE);
        if (path.startsWith('/api/officer/queue')) {
          expect.soft(body.items.length, label).toBeGreaterThan(0);
          for (const it of body.items) expect.soft(String(it.idMasked), `${label}: items[].idMasked ${it.caseNo}`).toMatch(MASK_RE);
        }
        if (/^\/api\/cases\/[^/]+$/.test(path)) expect.soft(String(body.idMasked), `${label}: idMasked`).toMatch(MASK_RE);
      }
    }
  });

  test('TC-PDPA-03 · แสดงเลขเต็มต้องมีเหตุผลและบันทึก Audit', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;

    // 1 เหตุผลว่าง · 2 เว้นวรรคล้วน
    for (const bad of ['', '     ']) {
      await openCase(p, 'officer', C(25));
      await submitReason(p, 'show-full-id-btn', 'unmask-reason', 'unmask-submit', bad);
      await expect(tid(p, 'unmask-error')).toHaveText(MSG.reasonRequired);
      await expect(tid(p, 'full-id')).toHaveCount(0);
      await expectApi(await apiOfficer(reg2, C(25), 'unmask', { reason: bad }), 400, 'REASON_REQUIRED', `unmask "${bad}"`);
    }

    // 3 เหตุผลถูกต้อง
    await openCase(p, 'officer', C(25));
    await submitReason(p, 'show-full-id-btn', 'unmask-reason', 'unmask-submit', 'ตรวจสอบตัวตนซ้ำ');
    await expect(tid(p, 'full-id')).toHaveText('3-1006-00987-65-9');

    // 4 โหลดซ้ำ → ปิดบังเหมือนเดิม
    await p.reload();
    await expect(tid(p, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(tid(p, 'full-id')).toHaveCount(0);

    // 5 Audit
    const audit = await asStaff(browser, 'audit1');
    await audit.page.goto('/audit');
    await applyAudit(audit.page, { event: 'UNMASK' });
    await expect(tid(audit.page, 'audit-count')).toHaveText('1');
    const row = tid(audit.page, 'audit-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-actor', 'off.reg2');
    await expect(row).toHaveAttribute('data-event', 'UNMASK');
    await expect(tid(row, 'audit-role')).toHaveText('officer');
    await expect(tid(row, 'audit-case-no')).toHaveText(C(25));
    await expect(tid(row, 'audit-event')).toContainText('UNMASK');
    await expect(tid(row, 'audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ');
    await expect(tid(row, 'audit-time')).toHaveAttribute('data-iso', DEFAULT_NOW);

    // 6 บทบาทอื่น → 403
    const exec = await asStaff(browser, 'exec1');
    const somying = await asCitizen(browser, SOMYING, 'สมหญิง');
    for (const who of [exec, audit, somying]) {
      const r = await apiOfficer(who, C(25), 'unmask', { reason: 'x' });
      expect(r.status(), `${who.name} unmask`).toBe(403);
    }
  });
});

/* ═════════════════════════════ 13. DASH ═════════════════════════════ */

test.describe('หมวด DASH', () => {
  test('TC-DASH-01 · Dashboard ตัวเลขเริ่มต้น', async ({ browser }) => {
    await resetAll(browser);
    const exec = await asStaff(browser, 'exec1');
    const p = exec.page;
    await p.goto('/dashboard');
    await expect(tid(p, 'period-select')).toHaveValue('2026-12');
    await expect(tid(p, 'service-select')).toHaveValue('ALL');
    const all: Kpi = { received: '3', closed: '0', pct: '–', backlog: '21', overdue: '1' };
    await expectKpis(p, all, '2026-12/ALL');
    for (const pct of ['NaN', '0%', '0.0%']) await expect(tid(p, 'kpi-ontime-pct')).not.toHaveText(pct);
    await expect(tid(p, 'workload-row')).toHaveCount(3);
    for (const [u, n] of [['off.reg1', '3'], ['off.reg2', '9'], ['off.works1', '0']] as const) {
      await expect(tid(rowOf(p, 'workload-row', 'data-username', u), 'workload-value')).toHaveText(n);
    }
    const d = await dashApi(exec, '2026-12');
    expectKpiApi(d, all, 'API 2026-12/ALL');
    const wl = Object.fromEntries((d.workload as any[]).map(w => [w.username, w.count]));
    expect(wl).toEqual({ 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 });

    // ไม่มีข้อมูลส่วนบุคคล
    const text = await p.locator('body').innerText();
    expect(piiProblems(text)).toEqual([]);

    // ตัวกรองบริการ
    const bySvc: Record<string, Kpi> = {
      'SV-01': { received: '3', closed: '0', pct: '–', backlog: '11', overdue: '1' },
      'SV-02': { received: '0', closed: '0', pct: '–', backlog: '7', overdue: '0' },
      'SV-03': { received: '0', closed: '0', pct: '–', backlog: '3', overdue: '0' },
    };
    for (const [svc, k] of Object.entries(bySvc)) {
      await chooseDashboard(p, '2026-12', svc);
      await expectKpis(p, k, `2026-12/${svc}`);
      expectKpiApi(await dashApi(exec, '2026-12', svc), k, `API 2026-12/${svc}`);
    }
  });

  test('TC-DASH-02 · Dashboard ย้อนหลัง', async ({ browser }) => {
    await resetAll(browser);
    const exec = await asStaff(browser, 'exec1');
    await exec.page.goto('/dashboard');
    const now: Record<string, { backlog: string; overdue: string }> = {
      ALL: { backlog: '21', overdue: '1' },
      'SV-01': { backlog: '11', overdue: '1' },
      'SV-02': { backlog: '7', overdue: '0' },
      'SV-03': { backlog: '3', overdue: '0' },
    };
    const rows: Array<[string, string, string, string, string]> = [
      ['2026-10', 'ALL', '1', '1', '100.0%'],
      ['2026-11', 'ALL', '26', '7', '85.7%'],
      ['2026-11', 'SV-01', '12', '3', '100.0%'],
      ['2026-11', 'SV-02', '10', '3', '66.7%'],
      ['2026-11', 'SV-03', '4', '1', '100.0%'],
      ['2026', 'ALL', '30', '8', '87.5%'],
      ['2026', 'SV-01', '16', '4', '100.0%'],
      ['2026', 'SV-02', '10', '3', '66.7%'],
      ['2026', 'SV-03', '4', '1', '100.0%'],
    ];
    for (const [period, svc, received, closed, pct] of rows) {
      const k: Kpi = { received, closed, pct, ...now[svc] };
      await chooseDashboard(exec.page, period, svc);
      await expectKpis(exec.page, k, `${period}/${svc}`);
      expectKpiApi(await dashApi(exec, period, svc), k, `API ${period}/${svc}`);
    }
  });

  test('TC-DASH-03 · ส่งออก Excel/PDF เท่าหน้าจอ', async ({ browser }) => {
    await resetAll(browser);
    const exec = await asStaff(browser, 'exec1');
    const p = exec.page;
    await p.goto('/dashboard');
    const exportRe = /export|\.xlsx|\.pdf|format=/i;
    const labels = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
    const screenKpis = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const id of ['kpi-received', 'kpi-closed', 'kpi-ontime-pct', 'kpi-backlog', 'kpi-overdue']) out.push(await textOf(tid(p, id)));
      return out;
    };
    const checkXlsx = async (buf: Buffer, expected: string[], label: string): Promise<void> => {
      const { first, all } = await readXlsx(buf);
      expect(first.get('A1'), `${label} A1`).toBe('ตัวชี้วัด');
      expect(first.get('B1'), `${label} B1`).toBe('ค่า');
      labels.forEach((l, i) => {
        expect(first.get(`A${i + 2}`), `${label} A${i + 2}`).toBe(l);
        expect(first.get(`B${i + 2}`), `${label} B${i + 2} (${l})`).toBe(expected[i]);
      });
      expect(piiProblems(all.join('\n')), `${label} PII`).toEqual([]);
    };

    // พ.ย. / ALL
    await chooseDashboard(p, '2026-11', 'ALL');
    const nov = ['26', '7', '85.7%', '21', '1'];
    await expectKpis(p, { received: '26', closed: '7', pct: '85.7%', backlog: '21', overdue: '1' }, '2026-11/ALL');
    const novScreen = await screenKpis();
    const x1 = await captureDownload(p, exportRe, () => tid(p, 'export-xlsx-btn').click());
    expect(x1.status).toBe(200);
    await checkXlsx(x1.body, nov, 'xlsx พ.ย.');
    await checkXlsx(x1.body, novScreen, 'xlsx พ.ย. = หน้าจอ');

    const pdf = await captureDownload(p, exportRe, () => tid(p, 'export-pdf-btn').click());
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type'] ?? '').toContain('application/pdf');
    expect(pdfHasLine(pdf.body, 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1'), 'บรรทัด kpi ใน PDF').toBe(true);
    expect(piiProblems(pdfText(pdf.body).text), 'PDF PII').toEqual([]);

    // ธ.ค. / ALL
    if (!new URL(p.url()).pathname.startsWith('/dashboard')) await p.goto('/dashboard');
    await chooseDashboard(p, '2026-12', 'ALL');
    await expectKpis(p, { received: '3', closed: '0', pct: '–', backlog: '21', overdue: '1' }, '2026-12/ALL');
    const x2 = await captureDownload(p, exportRe, () => tid(p, 'export-xlsx-btn').click());
    await checkXlsx(x2.body, ['3', '0', '–', '21', '1'], 'xlsx ธ.ค.');

    // Audit EXPORT = 3
    const audit = await asStaff(browser, 'audit1');
    await audit.page.goto('/audit');
    await applyAudit(audit.page, { event: 'EXPORT' });
    await expect(tid(audit.page, 'audit-count')).toHaveText('3');
    const rows = await auditRows(audit.page);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.actor).toBe('exec1');
      expect(r.role).toBe('executive');
    }
    const details = rows.map(r => r.detail);
    for (const [fmt, period] of [['xlsx', '2026-11'], ['pdf', '2026-11'], ['xlsx', '2026-12']]) {
      expect(details.some(d => d.includes(fmt) && d.includes(period)), `EXPORT detail ${fmt} ${period} in ${JSON.stringify(details)}`).toBe(true);
    }
  });

  test('TC-DASH-04 · ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser }) => {
    const hooks = await resetAll(browser);
    await setClock(hooks, '2026-12-03T16:00:00+07:00');
    const reg1 = await asStaff(browser, 'off.reg1');
    const reg2 = await asStaff(browser, 'off.reg2');
    const exec = await asStaff(browser, 'exec1');

    // 1 ที่ 16:00:00 อนุมัติ …000025 และ …000023
    expect((await expectApi(await apiApprove(reg2, C(25)), 200, undefined, 'approve 000025')).status).toBe('APPROVED');
    expect((await expectApi(await apiApprove(reg1, C(23)), 200, undefined, 'approve 000023')).status).toBe('APPROVED');

    const checkDash = async (closed: number, onTime: number, label: string): Promise<void> => {
      const d = await dashApi(exec, '2026-12');
      expect(d.closed, `${label} closed`).toBe(closed);
      expect(d.onTime, `${label} onTime`).toBe(onTime);
      await exec.page.goto('/dashboard');
      await expect(tid(exec.page, 'kpi-closed'), `${label} kpi-closed`).toHaveText(String(closed));
    };

    // 2 16:29:59 issue …000025
    await setClock(hooks, '2026-12-03T16:29:59+07:00');
    expect((await expectApi(await apiOfficer(reg2, C(25), 'issue'), 200, undefined, 'issue 000025')).status).toBe('COMPLETED');
    await openCase(reg2.page, 'officer', C(25));
    await expect(tid(reg2.page, 'closed-at')).toHaveAttribute('data-iso', '2026-12-03T16:29:59+07:00');
    await checkDash(1, 1, 'หลังขั้น 2');

    // 3 16:30:00 reject …000026
    await setClock(hooks, '2026-12-03T16:30:00+07:00');
    const rj = await expectApi(await apiReject(reg2, C(26), REASON10), 200, undefined, 'reject 000026');
    expect(rj.status).toBe('REJECTED');
    expect(rj.closedAt).toBe('2026-12-03T16:30:00+07:00');
    await openCase(reg2.page, 'officer', C(26));
    await expect(tid(reg2.page, 'closed-at')).toHaveAttribute('data-iso', '2026-12-03T16:30:00+07:00');
    await checkDash(2, 2, 'หลังขั้น 3');

    // 4 16:30:01 issue …000023
    await setClock(hooks, '2026-12-03T16:30:01+07:00');
    expect((await expectApi(await apiOfficer(reg1, C(23), 'issue'), 200, undefined, 'issue 000023')).status).toBe('COMPLETED');
    await openCase(reg1.page, 'officer', C(23));
    await expect(tid(reg1.page, 'closed-at')).toHaveAttribute('data-iso', '2026-12-03T16:30:01+07:00');
    await checkDash(3, 2, 'หลังขั้น 4');
    await expect(tid(exec.page, 'kpi-backlog')).toHaveText('18');
    expect((await dashApi(exec, '2026-12')).backlog).toBe(18);
  });
});

/* ═════════════════════════════ 14. AUDIT ═════════════════════════════ */

test.describe('หมวด AUDIT', () => {
  test('TC-AUDIT-01 · เหตุการณ์และฟิลด์ใน Audit', async ({ browser }) => {
    await resetAll(browser);
    // ทำรายการผ่าน API · ล็อกอินครั้งเดียวต่อบัญชี
    const reg2 = await asStaff(browser, 'off.reg2');
    await expectApi(await apiOfficer(reg2, C(28), 'claim'), 200, undefined, '1 claim 000028');
    const reg1 = await asStaff(browser, 'off.reg1');
    await expectApi(await apiOfficer(reg1, C(20), 'return', { reason: REASON10 }), 200, undefined, '2 return 000020');
    await expectApi(await apiOfficer(reg2, C(13), 'forward', {}), 200, undefined, '3 forward 000013');
    const head = await asStaff(browser, 'head1');
    await expectApi(await apiApprove(head, C(13)), 200, undefined, '4 approve 000013');
    await expectApi(await apiApprove(reg2, C(25)), 200, undefined, '5 approve 000025');
    await expectApi(await apiOfficer(reg2, C(25), 'issue'), 200, undefined, '5 issue 000025');
    await expectApi(await apiReject(reg2, C(26), REASON10), 200, undefined, '5 reject 000026');
    await expectApi(await apiOfficer(reg2, C(25), 'unmask', { reason: 'ตรวจสอบตัวตนซ้ำ' }), 200, undefined, '5 unmask 000025');
    const exec = await asStaff(browser, 'exec1');
    const ex = await exec.api.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL');
    expect(ex.status(), '6 export').toBe(200);
    const admin = await asStaff(browser, 'admin1');
    await expectApi(await admin.api.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }), 200, undefined, '7 admin change');
    const audit = await asStaff(browser, 'audit1');
    const p = audit.page;
    await p.goto('/audit');

    type Exp = { event: string; actor: string; role: string; caseNo?: string; transition?: string; detail?: string[] };
    const chrono: Exp[] = [
      { event: 'STAFF_LOGIN', actor: 'off.reg2', role: 'officer' },
      { event: 'CLAIM', actor: 'off.reg2', role: 'officer', caseNo: C(28), transition: 'SUBMITTED → IN_REVIEW' },
      { event: 'STAFF_LOGIN', actor: 'off.reg1', role: 'officer' },
      { event: 'RETURN', actor: 'off.reg1', role: 'officer', caseNo: C(20), transition: 'IN_REVIEW → NEED_FIX', detail: [REASON10] },
      { event: 'FORWARD', actor: 'off.reg2', role: 'officer', caseNo: C(13), transition: 'IN_REVIEW → PENDING_APPROVAL' },
      { event: 'STAFF_LOGIN', actor: 'head1', role: 'head' },
      { event: 'APPROVE', actor: 'head1', role: 'head', caseNo: C(13), transition: 'PENDING_APPROVAL → APPROVED' },
      { event: 'APPROVE', actor: 'off.reg2', role: 'officer', caseNo: C(25), transition: 'IN_REVIEW → APPROVED' },
      { event: 'ISSUE', actor: 'off.reg2', role: 'officer', caseNo: C(25), transition: 'APPROVED → COMPLETED', detail: ['DOC-2569-000002'] },
      { event: 'REJECT', actor: 'off.reg2', role: 'officer', caseNo: C(26), transition: 'IN_REVIEW → REJECTED', detail: [REASON10] },
      { event: 'UNMASK', actor: 'off.reg2', role: 'officer', caseNo: C(25), transition: '–', detail: ['ตรวจสอบตัวตนซ้ำ'] },
      { event: 'STAFF_LOGIN', actor: 'exec1', role: 'executive' },
      { event: 'EXPORT', actor: 'exec1', role: 'executive', transition: '–', detail: ['xlsx', '2026-12'] },
      { event: 'STAFF_LOGIN', actor: 'admin1', role: 'admin' },
      { event: 'ADMIN_CHANGE', actor: 'admin1', role: 'admin', transition: '–', detail: ['SV-01 fee 20 → 25'] },
      { event: 'STAFF_LOGIN', actor: 'audit1', role: 'auditor' },
    ];
    const expected = [...chrono].reverse();

    await expect(tid(p, 'audit-count')).toHaveText('16');
    const rows = await auditRows(p);
    expect(rows).toHaveLength(16);
    expect(rows.map(r => `${r.event}/${r.actor}`), 'ลำดับใหม่ → เก่า').toEqual(expected.map(e => `${e.event}/${e.actor}`));
    const ids = rows.map(r => Number(r.id));
    if (ids.every(n => Number.isFinite(n))) {
      for (let i = 1; i < ids.length; i++) expect(ids[i - 1], 'เวลาเท่ากันเรียง data-id มาก → น้อย').toBeGreaterThan(ids[i]);
    }
    rows.forEach((r, i) => {
      const e = expected[i];
      const label = `แถว ${i + 1} ${e.event}/${e.actor}`;
      expect.soft(r.time, `${label} audit-time`).toBe(DEFAULT_NOW);
      expect.soft(r.actorText, `${label} audit-actor`).toBe(e.actor);
      expect.soft(r.role, `${label} audit-role`).toBe(e.role);
      expect.soft(r.eventText, `${label} audit-event`).toContain(e.event);
      if (e.caseNo) {
        expect.soft(r.caseNo, `${label} data-case-no`).toBe(e.caseNo);
        expect.soft(r.caseText, `${label} audit-case-no`).toBe(e.caseNo);
      } else {
        expect.soft(r.caseText, `${label} audit-case-no (ไม่มี)`).toMatch(/^(–|-)?$/);
      }
      expect.soft(r.transition, `${label} audit-transition`).toBe(e.transition ?? '–');
      for (const d of e.detail ?? []) expect.soft(r.detail, `${label} audit-detail`).toContain(d);
    });

    // กรอง
    await applyAudit(p, { actor: 'off.reg2' });
    await expect(tid(p, 'audit-count')).toHaveText('7');
    expect((await auditRows(p)).map(r => r.event).sort()).toEqual(['APPROVE', 'CLAIM', 'FORWARD', 'ISSUE', 'REJECT', 'STAFF_LOGIN', 'UNMASK']);
    await applyAudit(p, { event: 'APPROVE' });
    await expect(tid(p, 'audit-count')).toHaveText('2');
    expect((await auditRows(p)).map(r => r.actor).sort()).toEqual(['head1', 'off.reg2']);
    await applyAudit(p, { actor: 'off.reg2', event: 'APPROVE' });
    await expect(tid(p, 'audit-count')).toHaveText('1');
    expect((await auditRows(p)).map(r => r.actor)).toEqual(['off.reg2']);
    const apiCount = await expectApi(await audit.api.get('/api/audit?actor=off.reg2&event=&from=&to='), 200);
    expect(apiCount.count).toBe(7);

    // CSV (ไม่กรอง)
    await applyAudit(p, {});
    await expect(tid(p, 'audit-count')).toHaveText('16');
    const csv = await captureDownload(p, /export|\.csv/i, () => tid(p, 'audit-export-csv-btn').click());
    expect(csv.status).toBe(200);
    const csvRows = parseCsv(csv.body.toString('utf8').replace(/^﻿/, ''));
    expect(csvRows[0].join(',')).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
    expect(csvRows.length - 1, 'จำนวนแถวข้อมูล CSV').toBe(16);
    expect(csvRows.slice(1).map(r => `${r[3]}/${r[1]}`), 'ลำดับใน CSV เท่าหน้าจอ').toEqual(expected.map(e => `${e.event}/${e.actor}`));

    await p.goto('/audit');
    await applyAudit(p, {});
    await expect(tid(p, 'audit-count')).toHaveText('17');
    const top = (await auditRows(p))[0];
    expect(top.event).toBe('EXPORT');
    expect(top.actor).toBe('audit1');
    expect(top.detail).toContain('audit-csv');
  });

  test('TC-AUDIT-02 · Audit แก้/ลบไม่ได้ (405)', async ({ browser }) => {
    await resetAll(browser);
    const audit = await asStaff(browser, 'audit1');
    const before = await expectApi(await audit.api.get('/api/audit'), 200, undefined, 'GET audit (before)');
    expect(before.items.length).toBeGreaterThanOrEqual(1);
    const id = before.items[0].id;
    const admin = await asStaff(browser, 'admin1');

    for (const who of [admin, audit]) {
      const calls: Array<[string, string, Record<string, unknown> | undefined]> = [
        ['PUT', `/api/audit/${id}`, { detail: 'x' }],
        ['PATCH', `/api/audit/${id}`, { detail: 'x' }],
        ['DELETE', `/api/audit/${id}`, undefined],
        ['PUT', '/api/audit', { detail: 'x' }],
        ['DELETE', '/api/audit', undefined],
        ['DELETE', '/api/audit/999999', undefined],
      ];
      for (const [method, path, data] of calls) {
        const res = await who.api.fetch(path, { method, ...(data ? { data } : {}) });
        await expectApi(res, 405, 'METHOD_NOT_ALLOWED', `${who.name} ${method} ${path}`);
      }
    }

    const after = await expectApi(await audit.api.get('/api/audit'), 200, undefined, 'GET audit (after)');
    for (const old of before.items) {
      const same = after.items.find((x: any) => x.id === old.id);
      expect(same, `แถว ${old.id} ต้องยังอยู่`).toBeDefined();
      expect(same, `แถว ${old.id} ต้องไม่ถูกแก้`).toEqual(old);
    }
    const added = after.items.filter((x: any) => !before.items.some((o: any) => o.id === x.id));
    expect(added).toHaveLength(1);
    expect(added[0].event).toBe('STAFF_LOGIN');
    expect(added[0].username).toBe('admin1');

    await audit.page.goto('/audit');
    await expect(tid(audit.page, 'audit-row').first()).toBeVisible();
    await expect(tid(audit.page, 'audit-edit-btn')).toHaveCount(0);
    await expect(tid(audit.page, 'audit-delete-btn')).toHaveCount(0);
    expect((await admin.api.get('/api/audit')).status()).toBe(403);
  });

  test('TC-AUDIT-03 · กรองช่วงวันที่ตามเวลาไทย', async ({ browser }) => {
    const hooks = await resetAll(browser);
    const L = {
      L1: { now: '2026-11-30T23:59:59+07:00', user: 'off.reg1' },
      L2: { now: '2026-12-01T00:00:00+07:00', user: 'off.reg2' },
      L3: { now: '2026-12-01T23:59:59+07:00', user: 'off.works1' },
      L4: { now: '2026-12-02T00:00:00+07:00', user: 'off.reg1' },
      L5: { now: '2026-12-02T09:00:00+07:00', user: 'audit1' },
    };
    let audit: Actor | undefined;
    for (const { now, user } of Object.values(L)) {
      await setClock(hooks, now);
      const a = await asStaff(browser, user);
      if (user === 'audit1') audit = a;
    }
    const p = audit!.page;
    await p.goto('/audit');

    type Key = keyof typeof L;
    const cases: Array<{ from: string; to: string; actor?: string; rows: Key[] }> = [
      { from: '2026-12-01', to: '2026-12-01', rows: ['L2', 'L3'] },
      { from: '2026-11-30', to: '2026-11-30', rows: ['L1'] },
      { from: '2026-11-30', to: '2026-12-01', rows: ['L1', 'L2', 'L3'] },
      { from: '2026-12-02', to: '', rows: ['L4', 'L5'] },
      { from: '', to: '2026-11-30', rows: ['L1'] },
      { from: '2026-12-01', to: '2026-12-02', rows: ['L2', 'L3', 'L4', 'L5'] },
      { from: '2026-12-01', to: '2026-12-01', actor: 'off.reg2', rows: ['L2'] },
    ];
    for (const c of cases) {
      const label = `from=${c.from || '∅'} to=${c.to || '∅'}${c.actor ? ` actor=${c.actor}` : ''}`;
      const expectedRows = [...c.rows].reverse().map(k => `${L[k].now}|${L[k].user}`);
      await applyAudit(p, { from: c.from, to: c.to, actor: c.actor });
      await expect.soft(tid(p, 'audit-count'), label).toHaveText(String(c.rows.length));
      const rows = await auditRows(p);
      expect.soft(rows.map(r => `${r.time}|${r.actor}`), label).toEqual(expectedRows);
      const api = await expectApi(await audit!.api.get(`/api/audit?actor=${c.actor ?? ''}&event=&from=${c.from}&to=${c.to}`), 200, undefined, label);
      expect.soft(api.count, `API ${label}`).toBe(c.rows.length);
      expect.soft((api.items as any[]).map(it => `${it.time}|${it.username}`), `API ${label}`).toEqual(expectedRows);
    }
  });
});

/* ═════════════════════════════ 15. RBAC ═════════════════════════════ */

test.describe('หมวด RBAC', () => {
  test('TC-RBAC-01 · ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser }) => {
    await resetAll(browser);
    const somying = await asCitizen(browser, SOMYING, 'สมหญิง');
    const p = somying.page;

    const ui = await p.goto(`/citizen/cases/${C(5)}`);
    expect(ui?.status()).toBe(404);
    await expect(tid(p, 'not-found-msg')).toHaveText(MSG.notFound);
    await expect(tid(p, 'case-no')).toHaveCount(0);
    await expect(tid(p, 'case-status')).toHaveCount(0);
    expect(await p.content()).not.toContain('สมชาย');

    const other = await somying.api.get(`/api/cases/${C(5)}`);
    expect(other.status()).toBe(404);
    const otherText = await other.text();
    expect(JSON.parse(otherText)).toEqual({ code: 'NOT_FOUND', message: MSG.notFound });
    const none = await somying.api.get('/api/cases/EG-2569-999999');
    expect(none.status()).toBe(404);
    expect(await none.text(), 'เนื้อหา 404 ต้องเหมือนกันทุกตัวอักษร').toBe(otherText);

    expect((await somying.api.get('/api/documents/DOC-2569-000001/pdf')).status()).toBe(404);
    expect((await somying.api.get('/api/drafts/DR-0001')).status()).toBe(404);
    expect((await somying.api.post(`/api/cases/${C(30)}/cancel`)).status()).toBe(404);

    const own = await p.goto(`/citizen/cases/${C(7)}`);
    expect(own?.status()).toBe(200);
    await expect(tid(p, 'case-no')).toHaveText(C(7));

    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await expectApi(await somchai.api.get(`/api/cases/${C(5)}`), 200, undefined, 'สมชายเปิดของตัวเอง');
    expect((await getCase(somchai, C(30))).status, 'ยกเลิกโดยคนอื่นต้องไม่มีผล').toBe('SUBMITTED');
  });

  test('TC-RBAC-02 · เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (ตรวจที่ API)', async ({ browser }) => {
    await resetAll(browser);
    const reg2 = await asStaff(browser, 'off.reg2');
    const me = await expectApi(await reg2.api.get('/api/me'), 200, undefined, 'session off.reg2');
    expect(me.role).toBe('officer');

    // 1 ยิง approve ตรงที่ SV-02 PENDING_APPROVAL
    await expectApi(await apiApprove(reg2, C(14)), 403, 'FORBIDDEN', 'off.reg2 approve 000014');
    expect((await getCase(reg2, C(14))).status).toBe('PENDING_APPROVAL');
    // 2 SV-02 ที่ตัวเองถือ IN_REVIEW
    await expectApi(await apiApprove(reg2, C(13)), 403, 'FORBIDDEN', 'off.reg2 approve 000013');
    expect((await getCase(reg2, C(13))).status).toBe('IN_REVIEW');
    // 3 reject
    await expectApi(await apiReject(reg2, C(14), REASON10), 403, 'FORBIDDEN', 'off.reg2 reject 000014');
    expect((await getCase(reg2, C(14))).status).toBe('PENDING_APPROVAL');
    // 4 UI ไม่มีปุ่ม
    for (const n of [13, 14]) {
      await openCase(reg2.page, 'officer', C(n));
      await expect(tid(reg2.page, 'approve-btn')).toHaveCount(0);
    }
    // 5 หัวหน้าอนุมัติแทน SV-01 ไม่ได้
    const head = await asStaff(browser, 'head1');
    await expectApi(await apiApprove(head, C(25)), 403, 'FORBIDDEN', 'head1 approve 000025');
    expect((await getCase(head, C(25))).status).toBe('IN_REVIEW');
    // 6 ตัวควบคุมบวก
    const ok = await expectApi(await apiApprove(head, C(14)), 200, undefined, 'head1 approve 000014');
    expect(ok.status).toBe('APPROVED');
    // 7 Audit APPROVE มีแถวเดียว (head1)
    const audit = await asStaff(browser, 'audit1');
    await audit.page.goto('/audit');
    await applyAudit(audit.page, { event: 'APPROVE' });
    await expect(tid(audit.page, 'audit-count')).toHaveText('1');
    const rows = await auditRows(audit.page);
    expect(rows.map(r => `${r.actor}|${r.caseNo}`)).toEqual([`head1|${C(14)}`]);
    const api = await expectApi(await audit.api.get('/api/audit?event=APPROVE'), 200);
    expect(api.count).toBe(1);
    expect((api.items as any[]).some(it => it.username === 'off.reg2')).toBe(false);
  });

  test('TC-RBAC-03 · ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
    test.setTimeout(480_000);
    type Role = 'anon' | 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
    const roles: Role[] = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
    const staffUser: Partial<Record<Role, string>> = { officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1' };
    type PageExp = 'ok' | '403' | 'login';
    const only = (ok: Role[]): Record<Role, PageExp> =>
      Object.fromEntries(roles.map(r => [r, r === 'anon' ? 'login' : ok.includes(r) ? 'ok' : '403'])) as Record<Role, PageExp>;
    const pages: Array<[string, Record<Role, PageExp>]> = [
      ['/citizen', only(['citizen'])],
      ['/officer/queue', only(['officer', 'head'])],
      ['/head/approvals', only(['head'])],
      ['/dashboard', only(['executive'])],
      ['/audit', only(['auditor'])],
      ['/admin/services', only(['admin'])],
      ['/admin/holidays', only(['admin'])],
      ['/admin/users', only(['admin'])],
      ['/notifications', only(['officer', 'head'])],
      ['/verify/K7M2Q9XA', Object.fromEntries(roles.map(r => [r, 'ok'])) as Record<Role, PageExp>],
    ];
    const api = (ok: Partial<Record<Role, number>>): Record<Role, number> =>
      Object.fromEntries(roles.map(r => [r, r === 'anon' ? 401 : ok[r] ?? 403])) as Record<Role, number>;
    const apis: Array<{ method: 'GET' | 'POST'; path: string; data?: Record<string, unknown>; exp: Record<Role, number>; asSomying?: boolean }> = [
      { method: 'GET', path: '/api/officer/queue', exp: api({ officer: 200, head: 200 }) },
      { method: 'GET', path: '/api/notifications', exp: api({ officer: 200, head: 200 }) },
      { method: 'GET', path: '/api/dashboard?period=2026-12&service=ALL', exp: api({ executive: 200 }) },
      { method: 'GET', path: '/api/audit', exp: api({ auditor: 200 }) },
      { method: 'GET', path: '/api/admin/services', exp: api({ admin: 200 }) },
      { method: 'POST', path: '/api/drafts', data: { serviceId: 'SV-01', qty: 1 }, exp: api({ citizen: 201 }) },
      { method: 'GET', path: `/api/cases/${C(25)}`, exp: api({ citizen: 200, officer: 200, head: 200 }), asSomying: true },
      // claim ต้องเป็นลำดับสุดท้ายหลัง RESET
      { method: 'POST', path: `/api/officer/cases/${C(28)}/claim`, exp: api({ officer: 200 }) },
    ];
    const navAll = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users', 'nav-bell'];
    const navOf: Partial<Record<Role, string[]>> = {
      citizen: ['nav-my-cases'],
      officer: ['nav-queue', 'nav-bell'],
      head: ['nav-queue', 'nav-approvals', 'nav-bell'],
      executive: ['nav-dashboard'],
      auditor: ['nav-audit'],
      admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
    };

    for (const role of roles) {
      await resetAll(browser);
      const actor = role === 'anon' ? await newActor(browser) : role === 'citizen' ? await asCitizen(browser, SOMCHAI, 'สมชาย') : await asStaff(browser, staffUser[role]!);
      const p = actor.page;

      // ส่วน A หน้า
      for (const [path, exp] of pages) {
        const label = `[${role}] ${path}`;
        const res = await p.goto(path);
        const status = res?.status() ?? 0;
        const pathname = new URL(p.url()).pathname;
        if (exp[role] === 'login') {
          expect.soft(pathname, `${label} → redirect /login`).toBe('/login');
        } else if (exp[role] === '403') {
          expect.soft(status, `${label} HTTP`).toBe(403);
          await expect.soft(tid(p, 'forbidden-msg'), label).toHaveText(MSG.forbiddenPage);
        } else {
          expect.soft(status, `${label} HTTP`).toBe(200);
          expect.soft(pathname, `${label} ไม่ redirect`).toBe(path);
          await expect.soft(tid(p, 'forbidden-msg'), label).toHaveCount(0);
        }
      }

      // ส่วน D เมนู
      if (role !== 'anon') {
        await p.goto('/');
        await expect(tid(p, 'app-header')).toBeVisible();
        for (const nav of navAll) {
          const want = navOf[role]!.includes(nav);
          if (want) await expect.soft(tid(p, nav).first(), `[${role}] ${nav} ต้องมี`).toBeVisible();
          else await expect.soft(tid(p, nav), `[${role}] ${nav} ต้องไม่มี`).toHaveCount(0);
        }
      }

      // ส่วน B API
      const somying = role === 'citizen' ? await asCitizen(browser, SOMYING, 'สมหญิง') : undefined;
      for (const a of apis) {
        const caller = a.asSomying && somying ? somying : actor;
        const res = a.method === 'GET' ? await caller.api.get(a.path) : await caller.api.post(a.path, a.data ? { data: a.data } : undefined);
        expect.soft(res.status(), `[${role}] ${a.method} ${a.path}: ${(await res.text()).slice(0, 200)}`).toBe(a.exp[role]);
        if (role === 'officer' && a.path.endsWith('/claim')) expect.soft((await bodyOf(res))?.owner).toBe('off.reg1');
      }
    }

    // ส่วน C ขอบเขตแผนก
    await resetAll(browser);
    const works = await asStaff(browser, 'off.works1');
    const reg1 = await asStaff(browser, 'off.reg1');
    await expectApi(await apiOfficer(works, C(28), 'claim'), 403, undefined, 'off.works1 claim งานทะเบียน');
    await expectApi(await apiOfficer(reg1, C(10), 'claim'), 403, undefined, 'off.reg1 claim งานโยธา');
    const q = await expectApi(await works.api.get('/api/officer/queue?filter=all'), 200);
    expect((q.items as any[]).map(i => i.caseNo)).toEqual([C(10)]);
    await works.page.goto('/officer/queue');
    await expect(tid(works.page, 'queue-row')).toHaveCount(1);
    await expect(tid(works.page, 'queue-row')).toHaveAttribute('data-case-no', C(10));
  });

  test('TC-RBAC-04 · ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser }) => {
    test.setTimeout(360_000);
    const hooks = await resetAll(browser);
    const admin = await asStaff(browser, 'admin1');
    const ap = admin.page;

    // 1 วันหยุดตั้งต้น
    await ap.goto('/admin/holidays');
    await expect(tid(ap, 'holiday-row')).toHaveCount(4);
    expect((await tid(ap, 'holiday-row').evaluateAll((rs: any[]) => rs.map(r => r.getAttribute('data-date')))).sort())
      .toEqual(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);

    // 2 NEW_PAID ก่อนแก้ใด ๆ
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    const paid31 = await newPaid(somchai, hooks, { serviceId: 'SV-01', qty: 1 }, 20);
    expect(paid31.caseNo).toBe('EG-2569-000031');
    expect((await getCase(somchai, paid31.caseNo)).dueAt).toBe('2026-12-04T16:30:00+07:00');

    // 3 แก้ค่าธรรมเนียม SV-01 = 25 · SV-02 = 600
    await ap.goto('/admin/services');
    await tid(ap, 'svc-fee-SV-01').fill('25');
    await tid(ap, 'svc-save-SV-01').click();
    await expect(tid(ap, 'action-success')).toBeVisible();
    await ap.goto('/admin/services');
    await tid(ap, 'svc-fee-SV-02').fill('600');
    await tid(ap, 'svc-save-SV-02').click();
    await expect(tid(ap, 'action-success')).toBeVisible();
    const svcs = await expectApi(await admin.api.get('/api/admin/services'), 200);
    const fee = (id: string): number => (svcs.items as any[]).find(s => s.id === id)?.fee;
    expect(fee('SV-01')).toBe(25);
    expect(fee('SV-02')).toBe(600);

    // 4 ร่างใหม่ใช้ค่าใหม่ · คำขอเดิมไม่เปลี่ยน
    const sp = somchai.page;
    await sp.goto('/citizen/new/SV-01');
    await tid(sp, 'qty-input').fill('5');
    await expect(tid(sp, 'fee-total')).toHaveText('฿125');
    await tid(sp, 'qty-input').fill('1');
    await expect(tid(sp, 'fee-total')).toHaveText('฿25');
    await sp.goto('/citizen/new/SV-02');
    await expect(tid(sp, 'fee-total')).toHaveText('฿600');
    await openCase(sp, 'citizen', C(30));
    await expect(tid(sp, 'case-fee')).toHaveText('฿20');

    // 5 ยอดที่ล็อกของ PP-0001 (฿500)
    await sp.goto('/citizen/new/SV-02?draft=DR-0002');
    await expect(tid(sp, 'payment-amount')).toHaveText('฿500');
    await expectApi(await hooks.post('/api/test/payments/PP-0001/pay', { data: { amount: 600 } }), 422, 'AMOUNT_MISMATCH', 'pay 600');
    const pp1 = await expectApi(await hooks.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } }), 200, undefined, 'pay 500');
    expect(pp1.status).toBe('PAID');
    expect(pp1.caseNo).toBe('EG-2569-000032');

    // 6 เพิ่มวันหยุด 2 ธ.ค. → คำขอเดิมไม่คำนวณใหม่
    await ap.goto('/admin/holidays');
    await tid(ap, 'holiday-date-input').fill('2026-12-02');
    await tid(ap, 'holiday-name-input').fill('วันหยุดทดสอบ');
    await tid(ap, 'holiday-add-btn').click();
    await expect(tid(ap, 'holiday-row')).toHaveCount(5);
    expect((await getCase(somchai, 'EG-2569-000031')).dueAt).toBe('2026-12-04T16:30:00+07:00');

    // 7 NEW_PAID หลังเพิ่มวันหยุด
    const paid33 = await newPaid(somchai, hooks, { serviceId: 'SV-01', qty: 1 }, 25);
    expect(paid33.caseNo).toBe('EG-2569-000033');
    expect((await getCase(somchai, paid33.caseNo)).dueAt).toBe('2026-12-08T16:30:00+07:00');

    // 8 เปลี่ยนบทบาท exec1 → auditor แล้วล็อกอินใหม่ (ผ่านหน้าจอ)
    await expectApi(await admin.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } }), 200, undefined, 'PUT users/exec1');
    const ex = await newActor(browser, 'exec1→auditor');
    await ex.page.goto('/login');
    await tid(ex.page, 'login-tab-staff').click();
    await tid(ex.page, 'staff-username').fill('exec1');
    await tid(ex.page, 'staff-password').fill(STAFF_PASSWORD);
    await tid(ex.page, 'staff-submit').click();
    await ex.page.waitForURL(/\/audit(?:\?|$)/);
    const dash = await ex.page.goto('/dashboard');
    expect(dash?.status()).toBe(403);
    await expect(tid(ex.page, 'forbidden-msg')).toHaveText(MSG.forbiddenPage);

    // 9 Audit ADMIN_CHANGE = 4
    const changes = ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'];
    await ex.page.goto('/audit');
    await applyAudit(ex.page, { event: 'ADMIN_CHANGE' });
    await expect(tid(ex.page, 'audit-count')).toHaveText('4');
    let rows = await auditRows(ex.page);
    for (const r of rows) {
      expect(r.actor).toBe('admin1');
      expect(r.role).toBe('admin');
    }
    for (const c of changes) expect(rows.some(r => r.detail.includes(c)), `ADMIN_CHANGE "${c}" in ${JSON.stringify(rows.map(r => r.detail))}`).toBe(true);

    // 10 ผู้ดูแลทำรายการคำขอไม่ได้
    expect((await admin.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).status()).toBe(403);

    // 11 ลบวันหยุด 2 ธ.ค.
    await ap.goto('/admin/holidays');
    await tid(rowOf(ap, 'holiday-row', 'data-date', '2026-12-02'), 'holiday-delete-btn').click();
    await expect(tid(ap, 'holiday-row')).toHaveCount(4);
    await applyAudit(ex.page, { event: 'ADMIN_CHANGE' });
    await expect(tid(ex.page, 'audit-count')).toHaveText('5');
    rows = await auditRows(ex.page);
    expect(rows.some(r => r.detail.includes('holiday delete 2026-12-02'))).toBe(true);
  });

  test('TC-RBAC-05 · สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser }) => {
    await resetAll(browser);
    const [reg1, reg2, works, head, exec, audit, admin] = await Promise.all(
      ['off.reg1', 'off.reg2', 'off.works1', 'head1', 'exec1', 'audit1', 'admin1'].map(u => asStaff(browser, u)),
    );
    const somying = await asCitizen(browser, SOMYING, 'สมหญิง');
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    const anon = await newActor(browser);

    const names3 = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];
    const expectedNames: Record<string, string[]> = { [C(25)]: ['id-card.pdf'], [C(12)]: names3, [C(10)]: names3, [C(11)]: names3 };

    // fileId อ้างอิง (head เห็นทุกแผนก)
    const refIds: Record<string, string[]> = {};
    for (const c of Object.keys(expectedNames)) {
      const list = await expectApi(await head.api.get(`/api/cases/${c}/files`), 200, undefined, `head1 files ${c}`);
      refIds[c] = (list.items as any[]).map(f => String(f.fileId));
    }

    const check = async (who: Actor, caseNo: string, listStatus: number, fileStatus: number): Promise<void> => {
      const label = `${who.name} ${caseNo}`;
      const res = await who.api.get(`/api/cases/${caseNo}/files`);
      expect.soft(res.status(), `${label} /files`).toBe(listStatus);
      let ids = refIds[caseNo];
      if (listStatus === 200 && res.status() === 200) {
        const items = (await res.json()).items as any[];
        expect.soft(items.map(f => String(f.name)).sort(), `${label} รายชื่อไฟล์`).toEqual(expectedNames[caseNo]);
        ids = items.map(f => String(f.fileId));
      }
      for (const id of ids) {
        const f = await who.api.get(`/api/files/${encodeURIComponent(id)}`);
        expect.soft(f.status(), `${label} /api/files/${id}`).toBe(fileStatus);
        if (fileStatus === 200 && f.status() === 200) {
          expect.soft(f.headers()['content-type'] ?? '', `${label} content-type`).toContain('application/pdf');
          expect.soft((await f.body()).subarray(0, 4).toString('latin1'), `${label} เนื้อไฟล์`).toBe('%PDF');
        }
      }
    };

    await check(reg1, C(25), 200, 200);
    await check(works, C(25), 403, 403);
    await check(reg2, C(12), 200, 200);
    await check(works, C(12), 403, 403);
    await check(works, C(10), 200, 200);
    await check(reg1, C(10), 200, 200);
    await check(works, C(11), 200, 200);
    for (const c of [C(25), C(10), C(12)]) await check(head, c, 200, 200);
    await check(somying, C(25), 200, 200);
    await check(somchai, C(25), 404, 404);
    for (const who of [exec, audit, admin]) await check(who, C(25), 403, 403);
    await check(anon, C(25), 401, 401);

    // fileId ที่ไม่มี
    expect((await reg1.api.get('/api/files/no-such-file-999999')).status()).toBe(404);

    // UI
    await openCase(reg1.page, 'officer', C(25));
    await expect(tid(reg1.page, 'doc-item')).toHaveCount(1);
    await expect(tid(reg1.page, 'doc-item')).toHaveAttribute('data-name', 'id-card.pdf');
    const link = tid(tid(reg1.page, 'doc-item'), 'doc-download-link');
    await expect(link).toHaveCount(1);
    const got = await captureDownload(reg1.page, /\/api\/files\//, () => link.click());
    expect(got.status).toBe(200);
    expect(got.body.length).toBeGreaterThan(0);
    await openCase(reg2.page, 'officer', C(12));
    await expect(tid(reg2.page, 'doc-item')).toHaveCount(3);
    await openCase(somying.page, 'citizen', C(25));
    await expect(tid(somying.page, 'doc-item')).toHaveCount(1);
  });

  test('TC-RBAC-06 · ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser }) => {
    await resetAll(browser);
    const admin = await asStaff(browser, 'admin1');
    const p = admin.page;
    const sv01 = async (): Promise<{ fee: number; sla: number }> => {
      const s = await expectApi(await admin.api.get('/api/admin/services'), 200);
      const it = (s.items as any[]).find(x => x.id === 'SV-01');
      return { fee: it.fee, sla: it.sla };
    };
    const putSv01 = (fee: number, sla: number) => admin.api.put('/api/admin/services/SV-01', { data: { fee, sla } });
    const uiSave = async (field: 'fee' | 'sla', value: string): Promise<void> => {
      await p.goto('/admin/services');
      await tid(p, field === 'fee' ? 'svc-fee-SV-01' : 'svc-sla-SV-01').fill(value);
      await tid(p, 'svc-save-SV-01').click();
    };
    const uiReject = async (field: 'fee' | 'sla', value: string, msg: string): Promise<void> => {
      await uiSave(field, value);
      await expect(tid(p, 'action-error'), `UI ${field}=${value}`).toHaveText(msg);
    };
    const uiAccept = async (field: 'fee' | 'sla', value: string): Promise<void> => {
      await uiSave(field, value);
      await expect(tid(p, 'action-success'), `UI ${field}=${value}`).toBeVisible();
    };

    expect(await sv01()).toEqual({ fee: 20, sla: 3 });
    // fee −1 ✗
    await uiReject('fee', '-1', MSG.invalidFee);
    await expectApi(await putSv01(-1, 3), 400, 'INVALID_FEE', 'fee -1');
    expect(await sv01()).toEqual({ fee: 20, sla: 3 });
    // fee 0 ✓ (หน้าจอ)
    await uiAccept('fee', '0');
    expect(await sv01()).toEqual({ fee: 0, sla: 3 });
    // fee 100000 ✓ (API)
    await expectApi(await putSv01(100000, 3), 200, undefined, 'fee 100000');
    expect(await sv01()).toEqual({ fee: 100000, sla: 3 });
    // fee 100001 ✗
    await uiReject('fee', '100001', MSG.invalidFee);
    await expectApi(await putSv01(100001, 3), 400, 'INVALID_FEE', 'fee 100001');
    expect(await sv01()).toEqual({ fee: 100000, sla: 3 });
    // sla 0 ✗
    await uiReject('sla', '0', MSG.invalidSla);
    await expectApi(await putSv01(100000, 0), 400, 'INVALID_SLA', 'sla 0');
    expect(await sv01()).toEqual({ fee: 100000, sla: 3 });
    // sla 1 ✓ (หน้าจอ)
    await uiAccept('sla', '1');
    expect(await sv01()).toEqual({ fee: 100000, sla: 1 });
    // sla 60 ✓ (API)
    await expectApi(await putSv01(100000, 60), 200, undefined, 'sla 60');
    expect(await sv01()).toEqual({ fee: 100000, sla: 60 });
    // sla 61 ✗
    await uiReject('sla', '61', MSG.invalidSla);
    await expectApi(await putSv01(100000, 61), 400, 'INVALID_SLA', 'sla 61');
    expect(await sv01()).toEqual({ fee: 100000, sla: 60 });

    // วันหยุดซ้ำ ✗ (หน้าจอ + API) · วันเสาร์ ✓
    await p.goto('/admin/holidays');
    await tid(p, 'holiday-date-input').fill('2026-12-07');
    await tid(p, 'holiday-name-input').fill('ซ้ำ');
    await tid(p, 'holiday-add-btn').click();
    await expect(tid(p, 'action-error')).toHaveText(MSG.dupHoliday);
    const dup = await expectApi(await admin.api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }), 409, 'DUPLICATE_HOLIDAY', 'holiday ซ้ำ');
    expect(dup.message).toBe(MSG.dupHoliday);
    await p.goto('/admin/holidays');
    await expect(tid(p, 'holiday-row')).toHaveCount(4);
    await expectApi(await admin.api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } }), 201, undefined, 'holiday วันเสาร์');

    // เปลี่ยนบทบาทตัวเอง ✗
    await expectApi(await admin.api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }), 409, 'SELF_ROLE_CHANGE', 'self role');
    expect((await expectApi(await admin.api.get('/api/me'), 200)).role).toBe('admin');

    // Audit ADMIN_CHANGE = 5 (เฉพาะที่ยอมรับ)
    const audit = await asStaff(browser, 'audit1');
    await audit.page.goto('/audit');
    await applyAudit(audit.page, { event: 'ADMIN_CHANGE' });
    await expect(tid(audit.page, 'audit-count')).toHaveText('5');
    const details = (await auditRows(audit.page)).map(r => r.detail);
    expect(details.filter(d => d.includes('SV-01 fee')), JSON.stringify(details)).toHaveLength(2);
    expect(details.filter(d => d.includes('SV-01 sla')), JSON.stringify(details)).toHaveLength(2);
    expect(details.some(d => d.includes('holiday add 2026-12-05')), JSON.stringify(details)).toBe(true);
  });
});

/* ═════════════════════════════ 16. NFR ═════════════════════════════ */

test.describe('หมวด NFR', () => {
  const noHScroll = async (page: Page): Promise<{ sw: number; iw: number }> =>
    page.evaluate(() => {
      const g = globalThis as any;
      return { sw: Number(g.document.documentElement.scrollWidth), iw: Number(g.innerWidth) };
    });

  test('TC-NFR-01 · Responsive 375 / 768 / 1280', async ({ browser }) => {
    test.setTimeout(360_000);
    await resetAll(browser);
    const anon = await newActor(browser);
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    const reg1 = await asStaff(browser, 'off.reg1');
    const head = await asStaff(browser, 'head1');
    const exec = await asStaff(browser, 'exec1');
    const audit = await asStaff(browser, 'audit1');
    const admin = await asStaff(browser, 'admin1');
    const targets: Array<[Actor, string]> = [
      [anon, '/login'],
      [somchai, '/citizen'],
      [somchai, '/citizen/new/SV-03'],
      [somchai, `/citizen/cases/${C(13)}`],
      [reg1, '/officer/queue'],
      [reg1, `/officer/cases/${C(20)}`],
      [head, '/head/approvals'],
      [exec, '/dashboard'],
      [audit, '/audit'],
      [admin, '/admin/services'],
      [anon, '/verify/K7M2Q9XA'],
    ];
    const viewports = [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];
    let checks = 0;
    for (const vp of viewports) {
      for (const [who, path] of targets) {
        await who.page.setViewportSize(vp);
        const res = await who.page.goto(path, { waitUntil: 'load' });
        expect.soft(res?.status(), `${vp.width}px ${path} HTTP`).toBeLessThan(400);
        const { sw, iw } = await noHScroll(who.page);
        expect.soft(sw, `${vp.width}px ${path}: scrollWidth ${sw} > innerWidth ${iw}`).toBeLessThanOrEqual(iw);
        checks++;
      }
    }
    expect(checks).toBe(33);

    // งานหลักที่ 375 px (ผ่านหน้าจอทั้งหมด)
    const mobile = await newActor(browser, 'สมชาย@375', { width: 375, height: 812 });
    const m = mobile.page;
    await loginCitizen(m, SOMCHAI);
    await tid(m, 'start-service-SV-01').click();
    await m.waitForURL(/\/citizen\/new\/SV-01/);
    await tid(m, 'qty-input').fill('1');
    await expect(tid(m, 'fee-total')).toHaveText('฿20');
    await tid(m, 'to-upload-btn').click();
    await tid(m, 'upload-input-id-card').setInputFiles({ name: 'id-card.pdf', mimeType: 'application/pdf', buffer: pdf1024() });
    await expect(m.locator('[data-testid="file-item"][data-doc-key="id-card"]')).toHaveCount(1);
    await expect(tid(m, 'to-payment-btn')).toBeEnabled();
    await tid(m, 'to-payment-btn').click();
    const qr = tid(m, 'create-qr-btn');
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box, 'create-qr-btn ต้องมีกรอบ').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    const { sw, iw } = await noHScroll(m);
    expect(sw).toBeLessThanOrEqual(iw);
  });

  test('TC-NFR-02 · WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser }) => {
    test.setTimeout(420_000);
    await resetAll(browser);
    const anon = await newActor(browser);
    const mana = await asCitizen(browser, MANA, 'มานะ');
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    const reg1 = await asStaff(browser, 'off.reg1');
    const head = await asStaff(browser, 'head1');
    const exec = await asStaff(browser, 'exec1');
    const audit = await asStaff(browser, 'audit1');
    const admin = await asStaff(browser, 'admin1');
    const targets: Array<[Actor, string]> = [
      [anon, '/login'],
      [mana, '/register'],
      [somchai, '/citizen'],
      [somchai, '/citizen/new/SV-01'],
      [somchai, `/citizen/cases/${C(17)}`],
      [reg1, '/officer/queue'],
      [reg1, `/officer/cases/${C(20)}`],
      [head, '/head/approvals'],
      [exec, '/dashboard'],
      [audit, '/audit'],
      [admin, '/admin/services'],
      [reg1, '/notifications'],
      [anon, '/verify/K7M2Q9XA'],
    ];

    // ── ส่วน A axe + ส่วน C label
    const axeProblems: string[] = [];
    const unlabeled: string[] = [];
    for (const [who, path] of targets) {
      await who.page.goto(path, { waitUntil: 'load' });
      expect.soft(new URL(who.page.url()).pathname, `${who.name} เปิด ${path}`).toBe(path.split('?')[0]);
      const result = await new AxeBuilder({ page: who.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of result.violations) {
        if (v.impact === 'serious' || v.impact === 'critical') {
          axeProblems.push(`${path}: ${v.id} (${v.impact}) × ${v.nodes.length} → ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
        }
      }
      const missing = await who.page.evaluate(() => {
        const g = globalThis as any;
        const doc = g.document;
        const out: string[] = [];
        for (const el of Array.from(doc.querySelectorAll('input, select, textarea')) as any[]) {
          const type = String(el.getAttribute('type') ?? '').toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
          const style = g.getComputedStyle(el);
          const visible = el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          if (!visible) continue;
          const aria = String(el.getAttribute('aria-label') ?? '').trim();
          const by = String(el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
            .some((id: string) => String(doc.getElementById(id)?.textContent ?? '').trim() !== '');
          const lab = Array.from(el.labels ?? []).some((l: any) => String(l.textContent ?? '').trim() !== '');
          if (!aria && !by && !lab) out.push(`${el.tagName.toLowerCase()}[data-testid=${el.getAttribute('data-testid') ?? '?'}][name=${el.getAttribute('name') ?? '?'}]`);
        }
        return out;
      });
      for (const m of missing) unlabeled.push(`${path}: ${m}`);
    }
    expect.soft(axeProblems, 'axe serious/critical').toEqual([]);
    expect.soft(unlabeled, 'ช่องกรอกที่ไม่มีชื่อที่เข้าถึงได้').toEqual([]);

    // ── ส่วน D สถานะไม่ใช้สีอย่างเดียว (ปกติ และ forced-colors)
    const statusPages: Array<[Actor, string]> = [
      [reg1, '/officer/queue'],
      [reg1, `/officer/cases/${C(20)}`],
      [somchai, '/citizen'],
      [somchai, `/citizen/cases/${C(17)}`],
    ];
    const readStatuses = (page: Page) =>
      page.evaluate(([statusTh, levelTh]) => {
        const g = globalThis as any;
        const out: Array<{ id: string; code: string; text: string; expected: string }> = [];
        for (const id of ['case-status', 'row-status', 'sla-level', 'row-sla-level']) {
          for (const el of Array.from(g.document.querySelectorAll(`[data-testid="${id}"]`)) as any[]) {
            const isLevel = id.includes('level');
            let code = String(el.getAttribute(isLevel ? 'data-level' : 'data-status') ?? '');
            if (!code) {
              const row = el.closest(isLevel ? '[data-sla-level],[data-level]' : '[data-status]');
              code = String(row?.getAttribute(isLevel ? 'data-sla-level' : 'data-status') ?? row?.getAttribute('data-level') ?? '');
            }
            const text = String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
            out.push({ id, code, text, expected: (isLevel ? levelTh : statusTh)[code] ?? `?${code}` });
          }
        }
        return out;
      }, [STATUS_TH, LEVEL_TH] as const);
    for (const forced of [false, true]) {
      for (const [who, path] of statusPages) {
        await who.page.emulateMedia({ forcedColors: forced ? 'active' : 'none' });
        await who.page.goto(path, { waitUntil: 'load' });
        const items = await readStatuses(who.page);
        expect.soft(items.length, `${path} ต้องมีป้ายสถานะ`).toBeGreaterThan(0);
        for (const it of items) {
          const label = `${forced ? '[forced-colors] ' : ''}${path} ${it.id}(${it.code})`;
          expect.soft(it.text, `${label} ข้อความว่าง`).not.toBe('');
          expect.soft(it.text, label).toBe(it.expected);
        }
      }
    }
    for (const [who] of statusPages) await who.page.emulateMedia({ forcedColors: 'none' });

    // ── ส่วน B คีย์บอร์ดอย่างเดียว
    const kb = await newActor(browser, 'keyboard');
    const k = kb.page;
    const focusIssues: string[] = [];
    const focused = () =>
      k.evaluate(() => {
        const g = globalThis as any;
        const el = g.document.activeElement;
        if (!el || el === g.document.body) return null;
        const cs = g.getComputedStyle(el);
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const shadow = cs.boxShadow && cs.boxShadow !== 'none';
        return { testid: String(el.getAttribute('data-testid') ?? ''), tag: String(el.tagName).toLowerCase(), ring: Boolean(outline || shadow) };
      });
    const tabTo = async (testId: string, max = 60): Promise<boolean> => {
      for (let i = 0; i <= max; i++) {
        const f = await focused();
        if (f?.testid === testId) return true;
        if (i === max) break;
        await k.keyboard.press('Tab');
        const now = await focused();
        if (now && !now.ring) focusIssues.push(`${new URL(k.url()).pathname}: ${now.tag}[data-testid=${now.testid}] ไม่มี focus ring`);
      }
      return false;
    };
    await k.goto('/login');
    if (!(await tid(k, 'thaid-id-input').isVisible())) {
      expect(await tabTo('login-tab-citizen'), 'Tab ถึง login-tab-citizen').toBe(true);
      await k.keyboard.press('Enter');
    }
    expect(await tabTo('thaid-id-input'), 'Tab ถึง thaid-id-input').toBe(true);
    await k.keyboard.type(SOMCHAI);
    await k.keyboard.press('Enter');
    await expect(tid(k, 'otp-input')).toBeVisible();
    expect(await tabTo('otp-input'), 'Tab ถึง otp-input').toBe(true);
    await k.keyboard.type(TEST_OTP);
    await k.keyboard.press('Enter');
    await k.waitForURL(/\/citizen(?:\/|\?|$)/);
    expect(await tabTo('start-service-SV-01'), 'Tab ถึง start-service-SV-01').toBe(true);
    await k.keyboard.press('Enter');
    await k.waitForURL(/\/citizen\/new\/SV-01/);
    expect(await tabTo('qty-input'), 'Tab ถึง qty-input').toBe(true);
    await k.keyboard.press('ControlOrMeta+A');
    await k.keyboard.type('1');
    await expect(tid(k, 'fee-total')).toHaveText('฿20');
    await expect(tid(k, 'to-upload-btn')).toBeEnabled();
    expect(await tabTo('to-upload-btn'), 'Tab ถึง to-upload-btn').toBe(true);
    await k.keyboard.press('Enter');
    const upload = tid(k, 'upload-input-id-card');
    await expect(upload).toBeAttached();
    const file = { name: 'id-card.pdf', mimeType: 'application/pdf', buffer: pdf1024() };
    if (await tabTo('upload-input-id-card', 40)) {
      const chooser = await Promise.all([k.waitForEvent('filechooser', { timeout: 5_000 }), k.keyboard.press('Space')]).then(([c]) => c).catch(() => null);
      if (chooser) await chooser.setFiles(file);
      else await upload.setInputFiles(file);
    } else {
      focusIssues.push('upload-input-id-card: ไปถึงด้วย Tab ไม่ได้');
      await upload.setInputFiles(file);
    }
    await expect(k.locator('[data-testid="file-item"][data-doc-key="id-card"]')).toHaveCount(1);
    await expect(tid(k, 'to-payment-btn')).toBeEnabled();
    expect(await tabTo('to-payment-btn'), 'Tab ถึง to-payment-btn').toBe(true);
    await k.keyboard.press('Enter');
    await expect(tid(k, 'create-qr-btn')).toBeVisible();
    expect(focusIssues, 'โฟกัสด้วยคีย์บอร์ดต้องมองเห็น').toEqual([]);
  });

  test('TC-NFR-03 · Health เวลาโหลด และผลซ้ำได้', async ({ browser, playwright }) => {
    test.setTimeout(300_000);
    // health (ไม่มี cookie)
    const bare = await playwright.request.newContext({ baseURL: BASE_URL });
    openRequests.push(bare);
    const h = await bare.get('/api/health');
    expect(h.status()).toBe(200);
    expect(await h.json()).toEqual({ status: 'ok' });

    // เวลาโหลด ≤ 3,000 ms (วัดรอบที่ 2)
    let hooks = await resetAll(browser);
    const anon = await newActor(browser);
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    const reg1 = await asStaff(browser, 'off.reg1');
    const exec = await asStaff(browser, 'exec1');
    const audit = await asStaff(browser, 'audit1');
    for (const [who, path] of [[anon, '/login'], [somchai, '/citizen'], [reg1, '/officer/queue'], [exec, '/dashboard'], [audit, '/audit']] as Array<[Actor, string]>) {
      await who.page.goto(path, { waitUntil: 'load' });
      const t0 = Date.now();
      const res = await who.page.goto(path, { waitUntil: 'load' });
      const ms = Date.now() - t0;
      expect.soft(res?.status(), `${path} HTTP`).toBe(200);
      expect.soft(ms, `${path} โหลด ${ms} ms`).toBeLessThanOrEqual(3_000);
    }

    // ผลซ้ำได้
    const snapshot = async (h2: APIRequestContext): Promise<unknown> => {
      const clock = await expectApi(await h2.get('/api/test/clock'), 200);
      const r1 = await asStaff(browser, 'off.reg1');
      const q = await expectApi(await r1.api.get('/api/officer/queue?filter=all'), 200);
      const ex = await asStaff(browser, 'exec1');
      const d = await dashApi(ex, '2026-12');
      return {
        clock: clock.now,
        queue: (q.items as any[]).map(i => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner })),
        dashboard: d,
      };
    };
    hooks = await resetAll(browser);
    const s1 = await snapshot(hooks);
    await setClock(hooks, '2026-12-10T12:00:00+07:00');
    const reg1b = await asStaff(browser, 'off.reg1');
    await expectApi(await apiOfficer(reg1b, C(28), 'claim'), 200, undefined, 'claim 000028');
    const somchaiB = await asCitizen(browser, SOMCHAI, 'สมชาย');
    await newPaid(somchaiB, hooks, { serviceId: 'SV-01', qty: 1 }, 20);
    hooks = await resetAll(browser);
    const s2 = await snapshot(hooks);
    expect(s2).toEqual(s1);
    expect((s1 as any).clock).toBe(DEFAULT_NOW);

    // นาฬิกาไม่มี offset → 400
    await expectApi(await hooks.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME', 'clock ไม่มี offset');

    // ปิด hook: ตรวจได้เมื่อมีอินสแตนซ์ที่ไม่ตั้ง TEST_MODE (env NO_TEST_MODE_BASE_URL)
    const offUrl = process.env.NO_TEST_MODE_BASE_URL;
    if (offUrl) {
      const off = await playwright.request.newContext({ baseURL: offUrl });
      openRequests.push(off);
      expect((await off.post('/api/test/reset')).status()).toBe(404);
    } else {
      test.info().annotations.push({ type: 'skip-part', description: 'ไม่ได้ตั้ง NO_TEST_MODE_BASE_URL — ข้ามการตรวจ /api/test/* = 404 เมื่อปิด TEST_MODE' });
    }
  });

  test('TC-NFR-04 · เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async ({ browser }) => {
    const dbPath = process.env.DB_PATH;
    expect(dbPath, 'ต้องตั้ง env DB_PATH ให้ชี้ไฟล์ฐานข้อมูลของเว็บ').toBeTruthy();
    expect(existsSync(dbPath!), `ไม่พบไฟล์ DB_PATH=${dbPath}`).toBe(true);

    await resetAll(browser);
    // มานะลงทะเบียน (ตาม TC-AUTH-03) ผ่านหน้าจอ
    const mana = await newActor(browser, 'มานะ');
    const m = mana.page;
    await m.goto('/login');
    await tid(m, 'login-tab-citizen').click();
    await tid(m, 'thaid-id-input').fill(MANA);
    await tid(m, 'thaid-submit').click();
    await tid(m, 'otp-input').fill(TEST_OTP);
    await tid(m, 'otp-submit').click();
    await m.waitForURL(/\/register(?:\?|$)/);
    await tid(m, 'reg-mobile').fill('0845678901');
    await tid(m, 'reg-consent').check();
    await tid(m, 'reg-submit').click();
    await m.waitForURL(/\/citizen(?:\/|\?|$)/);
    expect((await expectApi(await mana.api.get('/api/me'), 200)).name).toBe('มานะ ตั้งใจ');

    // inspection ไฟล์ฐานข้อมูล (+ WAL/journal) และไฟล์เพิ่มเติมที่ระบุใน PII_SCAN_PATHS (คั่น ,) / LOG_PATH
    const files = [dbPath!, `${dbPath}-wal`, `${dbPath}-journal`, ...(process.env.PII_SCAN_PATHS ?? '').split(','), process.env.LOG_PATH ?? '']
      .map(f => f.trim()).filter(f => f && existsSync(f));
    const needles = [
      '1101700123456', '3100600987659', '1909900555015', '5500400111221',
      '0812345678', '0823456789', '0834567890', '0845678901',
      '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1',
    ];
    const count = (hay: Buffer, needle: Buffer): number => {
      let n = 0;
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
      return n;
    };
    const found: string[] = [];
    for (const f of files) {
      const buf = readFileSync(f);
      for (const v of needles) {
        const n = count(buf, Buffer.from(v, 'utf8')) + count(buf, Buffer.from(v, 'utf16le'));
        if (n > 0) found.push(`${f}: "${v}" × ${n}`);
      }
    }
    test.info().annotations.push({ type: 'inspected-files', description: files.join(', ') });
    test.info().annotations.push({ type: 'encryption', description: process.env.PII_ENCRYPTION ?? '(ตั้ง env PII_ENCRYPTION เพื่อบันทึกวิธีเข้ารหัส เช่น AES-256-GCM)' });
    expect(found, 'พบข้อมูลส่วนบุคคลแบบไม่เข้ารหัสในที่เก็บ').toEqual([]);

    // ตัวควบคุมบวก: ถอดรหัสได้ถูกต้อง
    const somchai = await asCitizen(browser, SOMCHAI, 'สมชาย');
    expect((await getCase(somchai, C(5))).idNo).toBe(SOMCHAI);
  });
});
