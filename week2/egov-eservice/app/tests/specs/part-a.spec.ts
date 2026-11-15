/**
 * Playwright ชุด A (บล็อก B12): AUTH · FEE · SUBMIT · UPLOAD · PAY · QUEUE · SLA · NOTI = 22 TC
 * ที่มา: TEST-PLAN.md หมวด 0 (สูตร) และหมวด 2–9 · CONTRACT.md · TEST-DATA.md · helper จาก tests/helpers.ts (B11)
 *
 * - ทุก TC เริ่มด้วย RESET (`fresh()`) และหลัง RESET ทุกครั้งสร้าง context ใหม่และล็อกอินใหม่ (CONTRACT 0.9)
 * - ทุก TC รีเซ็ตสถานะของเซิร์ฟเวอร์ตัวเดียวกัน → ต้องรันด้วย workers = 1 (ไม่ขนาน)
 * - ข้อที่ใช้จับบั๊ก (FEE-01=B01 · UPLOAD-01=B02 · SLA-01=B03 · SLA-02=B04 · PAY-01=B05 · QUEUE-02=B08)
 *   ยิง API และตรวจค่าตรงตัวเสมอ ไม่ดูแค่ปุ่ม
 * - ค่าที่คาดหวังทั้งหมดคิดจากกฎ/การ์ด TC ไม่ได้อ่านจากหน้าจอ
 */
import { test, expect, request } from '@playwright/test';
import type { APIRequestContext, APIResponse, Browser, Locator, Page } from '@playwright/test';
const REC = () => (process.env.PW_VIDEO ? { recordVideo: { dir: test.info().outputDir, size: { width: 1024, height: 640 } } } : {}); // LAB 4: บันทึกวิดีโอเมื่อ PW_VIDEO=1
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_NOW,
  STAFF_PASSWORD,
  TEST_OTP,
  loginCitizen,
  loginStaff,
  make_testfiles,
  pay,
  reset,
  setClock,
  type FreshTestSession,
} from '../helpers';

// ───────────────────────────── ค่าคงที่ ─────────────────────────────

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

const SOMCHAI = '1101700123456'; // สมชาย ใจดี
const SOMYING = '3100600987659'; // สมหญิง รักไทย
const MANA = '5500400111221'; // มานะ ตั้งใจ (ยังไม่ลงทะเบียน)
const PITI = '1909900555015'; // ปิติ มีสุข

const EN_DASH = '–';

const MSG = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_QTY: `จำนวนฉบับต้อง 1${EN_DASH}5 ฉบับ`,
  INVALID_AREA: `กรุณาระบุพื้นที่ 1${EN_DASH}500 ตร.ม.`,
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  NO_REFUND: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
  NOTI_EMPTY: 'ไม่มีแจ้งเตือน',
} as const;

const STATUS_TH = {
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  APPROVED: 'อนุมัติ',
  CANCELLED: 'ยกเลิก',
} as const;

type Level = 'normal' | 'near' | 'overdue' | 'paused' | 'closed';
const LEVEL_TH: Record<Level, string> = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

const STAFF_NAME: Record<string, string> = {
  'off.reg1': 'เจ้าหน้าที่ทะเบียน 1',
  'off.reg2': 'เจ้าหน้าที่ทะเบียน 2',
  'off.works1': 'เจ้าหน้าที่โยธา 1',
  head1: 'หัวหน้าฝ่าย',
  exec1: 'ผู้บริหาร',
  audit1: 'ผู้ตรวจสอบภายใน',
  admin1: 'ผู้ดูแลระบบ',
};

/** `…000025` → `EG-2569-000025` */
const EG = (n: number, year = 2569): string => `EG-${year}-${String(n).padStart(6, '0')}`;
const RC = (n: number, year = 2569): string => `RC-${year}-${String(n).padStart(6, '0')}`;
/** `T('2026-12-01T09:00:00')` → `2026-12-01T09:00:00+07:00` */
const T = (local: string): string => `${local}+07:00`;
/** `฿1,010` */
const baht = (n: number): string => `฿${n.toLocaleString('en-US')}`;

type ServiceId = 'SV-01' | 'SV-02' | 'SV-03';

const REQUIRED_FILES: Record<ServiceId, Array<[docKey: string, fileName: string]>> = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [['id-card', 'id-card.pdf'], ['map', 'map.pdf']],
  'SV-03': [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']],
};

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain',
};

// ───────────────────────────── โครงต่อ test ─────────────────────────────

test.describe.configure({ timeout: 240_000 });

let FILES = new Map<string, string>();
test.beforeAll(async () => {
  // ทุกการ์ดคิดจากนาฬิกาตั้งต้น อ. 1 ธ.ค. 2569 09:00
  if (DEFAULT_NOW !== T('2026-12-01T09:00:00')) throw new Error(`DEFAULT_NOW เปลี่ยนเป็น ${DEFAULT_NOW}`);
  const list = await make_testfiles();
  FILES = new Map(list.map(p => [path.basename(p), p]));
});

/** ทรัพยากรที่เปิดใน test นี้ (context / request) ปิดทั้งหมดหลังจบ */
const cleanup: Array<() => Promise<unknown>> = [];
test.afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => undefined);
});

/** RESET (สูตร 0) + context ใหม่ · `api` ไม่มี cookie ใช้กับ /api/test/* */
async function fresh(browser: Browser): Promise<FreshTestSession> {
  const s = await reset(browser, BASE_URL);
  cleanup.push(() => s.api.dispose(), () => s.context.close());
  acceptDialogs(s.page);
  return s;
}

async function newApi(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE_URL });
  cleanup.push(() => api.dispose());
  return api;
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL, ...REC() });
  cleanup.push(() => context.close());
  const page = await context.newPage();
  acceptDialogs(page);
  return page;
}

/** กล่องยืนยันของ CONTRACT เป็น element ในหน้า · ถ้าเว็บใช้ dialog ของเบราว์เซอร์ ให้กดยืนยัน (ค่าตั้งต้นของ Playwright คือยกเลิก) */
function acceptDialogs(page: Page): void {
  page.on('dialog', d => void d.accept().catch(() => undefined));
}

/** รอให้คำขอ HTTP ที่เกิดจากการกดจบ (ไม่เกิน 10 วินาที เผื่อหน้ามีโพลล์) */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

function filePath(name: string): string {
  const p = FILES.get(name);
  if (!p) throw new Error(`ไม่พบไฟล์ทดสอบ ${name} (TEST-DATA ข้อ 11)`);
  return p;
}

async function bodyOf(res: APIResponse): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** ตรวจ HTTP status และ `code` (+ `message` ถ้าให้มา) ของ error ตาม CONTRACT 0.6 */
async function expectApiError(res: APIResponse, status: number, code: string, message?: string): Promise<any> {
  const body = await bodyOf(res);
  expect(res.status(), `${res.url()} → ${JSON.stringify(body)}`).toBe(status);
  expect(body.code, `${res.url()} → ${JSON.stringify(body)}`).toBe(code);
  if (message !== undefined) expect(body.message).toBe(message);
  return body;
}

async function expectStatus(res: APIResponse, status: number): Promise<any> {
  const body = await bodyOf(res);
  expect(res.status(), `${res.url()} → ${JSON.stringify(body)}`).toBe(status);
  return body;
}

// ───────────── LOGIN_C / LOGIN_S ผ่าน API (สูตร 0) ─────────────

async function apiLoginCitizen(api: APIRequestContext, idNo: string): Promise<any> {
  await expectStatus(await api.post('/api/auth/thaid/start', { data: { idNo } }), 200);
  return expectStatus(await api.post('/api/auth/thaid/verify', { data: { idNo, otp: TEST_OTP } }), 200);
}

async function apiLoginStaff(api: APIRequestContext, username: string): Promise<any> {
  return expectStatus(await api.post('/api/auth/staff/login', { data: { username, password: STAFF_PASSWORD } }), 200);
}

async function citizenApi(idNo = SOMCHAI): Promise<APIRequestContext> {
  const api = await newApi();
  await apiLoginCitizen(api, idNo);
  return api;
}

async function staffApi(username: string): Promise<APIRequestContext> {
  const api = await newApi();
  await apiLoginStaff(api, username);
  return api;
}

/** browser context ใหม่ ล็อกอินประชาชนด้วย API ของ context (cookie ใช้ร่วมกับหน้าเว็บ) */
async function asCitizen(browser: Browser, idNo = SOMCHAI): Promise<Page> {
  const page = await newPage(browser);
  await apiLoginCitizen(page.context().request, idNo);
  return page;
}

async function asStaff(browser: Browser, username: string): Promise<Page> {
  const page = await newPage(browser);
  await apiLoginStaff(page.context().request, username);
  return page;
}

// ───────────── ร่าง / ไฟล์ / ชำระ (สูตร NEW_PAID) ─────────────

interface DraftOpts {
  serviceId: ServiceId;
  qty?: number;
  areaSqm?: number;
}

function draftBody(o: DraftOpts): Record<string, unknown> {
  if (o.serviceId === 'SV-01') return { serviceId: 'SV-01', qty: o.qty ?? 1 };
  if (o.serviceId === 'SV-03') return { serviceId: 'SV-03', areaSqm: o.areaSqm ?? 100 };
  return { serviceId: 'SV-02' };
}

async function createDraft(api: APIRequestContext, o: DraftOpts): Promise<{ draftId: string; fee: number }> {
  return expectStatus(await api.post('/api/drafts', { data: draftBody(o) }), 201);
}

async function uploadFile(
  api: APIRequestContext,
  draftId: string,
  fileName: string,
  docKey: string,
  mimeType?: string,
): Promise<APIResponse> {
  const buffer = await readFile(filePath(fileName));
  return api.post(`/api/drafts/${draftId}/files`, {
    multipart: {
      file: { name: fileName, mimeType: mimeType ?? MIME[path.extname(fileName)] ?? 'application/octet-stream', buffer },
      docKey,
    },
  });
}

/** สร้างร่าง + แนบไฟล์บังคับ + สร้าง QR (ยังไม่ชำระ) */
async function draftWithQr(api: APIRequestContext, o: DraftOpts): Promise<{ draftId: string; fee: number; ref: string; amount: number }> {
  const { draftId, fee } = await createDraft(api, o);
  for (const [docKey, name] of REQUIRED_FILES[o.serviceId]) await expectStatus(await uploadFile(api, draftId, name, docKey), 201);
  const qr = await expectStatus(await api.post(`/api/drafts/${draftId}/payment`), 201);
  expect(qr.amount).toBe(fee);
  return { draftId, fee, ref: qr.ref, amount: qr.amount };
}

interface Paid {
  caseNo: string;
  receiptNo: string;
  ref: string;
  fee: number;
  draftId: string;
  citizen: APIRequestContext;
}

/** NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก): CLOCK → LOGIN_C → drafts → files → payment → pay → GET payment */
async function newPaid(hook: APIRequestContext, o: DraftOpts & { idNo?: string; at?: string }): Promise<Paid> {
  if (o.at) await setClock(hook, o.at);
  const citizen = await citizenApi(o.idNo ?? SOMCHAI);
  const q = await draftWithQr(citizen, o);
  const paid = await pay(hook, q.ref, q.fee);
  expect(paid.status).toBe('PAID');
  const payment = await expectStatus(await citizen.get(`/api/payments/${q.ref}`), 200);
  expect(payment.caseNo).toBe(paid.caseNo);
  return { caseNo: paid.caseNo, receiptNo: paid.receiptNo, ref: q.ref, fee: q.fee, draftId: q.draftId, citizen };
}

async function rawPay(hook: APIRequestContext, ref: string, amount: number): Promise<APIResponse> {
  return hook.post(`/api/test/payments/${encodeURIComponent(ref)}/pay`, { data: { amount } });
}

async function getCase(api: APIRequestContext, caseNo: string): Promise<any> {
  return expectStatus(await api.get(`/api/cases/${caseNo}`), 200);
}

async function myCaseCount(api: APIRequestContext): Promise<number> {
  return (await expectStatus(await api.get('/api/cases'), 200)).items.length;
}

/** จำนวนไฟล์ใน GET /api/drafts/:id (CONTRACT ไม่กำหนดชื่อฟิลด์ → อ่าน `files` ถ้ามี) */
async function draftFileCount(api: APIRequestContext, draftId: string): Promise<number | undefined> {
  const body = await expectStatus(await api.get(`/api/drafts/${draftId}`), 200);
  const files = body.files ?? body.items?.[0]?.files ?? body.draft?.files;
  return Array.isArray(files) ? files.length : undefined;
}

// ───────────── ตัวช่วยหน้าจอ ─────────────

const byAttr = (page: Page, testId: string, attr: string, value: string): Locator =>
  page.locator(`[data-testid="${testId}"][${attr}="${value}"]`);
const queueRow = (page: Page, caseNo: string): Locator => byAttr(page, 'queue-row', 'data-case-no', caseNo);

async function attrList(rows: Locator, attr: string): Promise<string[]> {
  return rows.evaluateAll((els, a) => els.map(e => e.getAttribute(a) ?? ''), attr);
}

/** ใช้ใน expect.poll: ถ้าหน้ากำลังเปลี่ยน (เช่น select แล้ว submit) ให้คืน [] แล้ว poll ใหม่ */
async function attrListSafe(rows: Locator, attr: string): Promise<string[]> {
  return attrList(rows, attr).catch(() => []);
}

const pathname = (page: Page): string => new URL(page.url()).pathname;

/** ขั้นตอนยื่น SV-01 ถึงขั้นแนบเอกสาร */
async function wizardSv01ToUpload(page: Page, qty: number): Promise<void> {
  await page.goto('/citizen/new/SV-01');
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await page.getByTestId('qty-input').fill(String(qty));
  await page.getByTestId('qty-input').blur();
  await expect(page.getByTestId('fee-total')).toHaveText(baht(20 * qty));
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
}

async function attach(page: Page, inputTestId: string, ...names: string[]): Promise<void> {
  await page.getByTestId(inputTestId).setInputFiles(names.map(filePath));
}

async function removeFile(page: Page, fileName: string): Promise<void> {
  const items = page.getByTestId('file-item');
  const before = await items.count();
  await byAttr(page, 'file-item', 'data-name', fileName).getByTestId('file-remove-btn').click();
  await expect(items).toHaveCount(before - 1);
}

/** กรอกช่องค่าธรรมเนียมแล้วออกจากช่อง (ให้ทั้ง input และ change ทำงาน) */
async function fillFeeInput(page: Page, testId: 'qty-input' | 'area-input', value: number): Promise<void> {
  const input = page.getByTestId(testId);
  await input.fill(String(value));
  await input.blur();
}

/** เปิดคิว แล้วอ่าน workload-count */
async function workloadOf(page: Page): Promise<Locator> {
  await page.goto('/officer/queue');
  return page.getByTestId('workload-count');
}

/** กด claim-btn ของแถวในคิว แล้วรอให้คำขอ HTTP ของการกดจบ */
async function clickClaimInQueue(page: Page, caseNo: string): Promise<void> {
  await page.goto('/officer/queue');
  await queueRow(page, caseNo).getByTestId('claim-btn').click();
  await settle(page);
}

async function expectOwner(api: APIRequestContext, caseNo: string, owner: string | null, status?: string): Promise<void> {
  await expect
    .poll(async () => {
      const c = await getCase(api, caseNo);
      return { owner: c.owner || null, status: status === undefined ? undefined : c.status };
    })
    .toEqual({ owner, status });
}

/** ตีกลับผ่านหน้าเจ้าหน้าที่ (return-btn → return-reason → return-submit) */
async function uiReturn(page: Page, caseNo: string, reason: string): Promise<void> {
  await page.goto(`/officer/cases/${caseNo}`);
  await page.getByTestId('return-btn').click();
  await page.getByTestId('return-reason').fill(reason);
  await page.getByTestId('return-submit').click();
  await expect.poll(async () => (await getCase(page.request, caseNo)).status).toBe('NEED_FIX');
  await page.goto(`/officer/cases/${caseNo}`);
  await expect(page.getByTestId('case-status')).toHaveText(STATUS_TH.NEED_FIX);
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'NEED_FIX');
}

/** ประชาชนกด submit-fix-btn แล้วรอสถานะ IN_REVIEW (ไม่มี action-error) */
async function uiSubmitFix(page: Page, caseNo: string): Promise<void> {
  await page.goto(`/citizen/cases/${caseNo}`);
  await page.getByTestId('submit-fix-btn').click();
  await expect.poll(async () => (await getCase(page.request, caseNo)).status).toBe('IN_REVIEW');
  await expect(page.getByTestId('action-error')).toBeHidden();
  await page.goto(`/citizen/cases/${caseNo}`);
}

async function expectSlaLevel(scope: Page, level: Level, testId = 'sla-level', soft = false): Promise<void> {
  const e = soft ? expect.soft : expect;
  await e(scope.getByTestId(testId), `${testId} = ${level}`).toHaveText(LEVEL_TH[level]);
  await e(scope.getByTestId(testId), `${testId} data-level = ${level}`).toHaveAttribute('data-level', level);
}

/** CLAIM ใน Audit ของคำขอ (ตรวจผ่าน audit1) */
async function auditClaimCount(caseNo: string): Promise<number> {
  const auditor = await staffApi('audit1');
  const body = await expectStatus(await auditor.get('/api/audit?event=CLAIM'), 200);
  return body.items.filter((i: any) => i.event === 'CLAIM' && i.caseNo === caseNo).length;
}

// ───────────── แจ้งเตือน ─────────────

type Noti = `${string}:${'near' | 'overdue'}`;
const noti = (n: number, level: 'near' | 'overdue'): Noti => `${EG(n)}:${level}`;

async function apiNotis(api: APIRequestContext): Promise<string[]> {
  const body = await expectStatus(await api.get('/api/notifications'), 200);
  return body.items.map((i: any) => `${i.caseNo}:${i.level}`).sort();
}

/** ล็อกอิน (request = กระตุ้นการประเมิน) → เปิด /notifications → ตรวจรายการ ข้อความ bell-count และ API */
async function expectNotifications(browser: Browser, username: string, expected: Noti[]): Promise<Page> {
  const page = await asStaff(browser, username);
  await page.goto('/notifications');
  const items = page.getByTestId('noti-item');
  await expect(items, `${username} noti-item`).toHaveCount(expected.length);
  expect((await items.evaluateAll(els => els.map(e => `${e.getAttribute('data-case-no')}:${e.getAttribute('data-level')}`))).sort(), username).toEqual(
    [...expected].sort(),
  );
  for (const n of expected) {
    const [caseNo, level] = n.split(':') as [string, 'near' | 'overdue'];
    await expect(page.locator(`[data-testid="noti-item"][data-case-no="${caseNo}"][data-level="${level}"]`)).toContainText(
      `คำขอ ${caseNo} ${LEVEL_TH[level]}`,
    );
  }
  if (expected.length === 0) await expect(page.getByTestId('noti-empty')).toHaveText(MSG.NOTI_EMPTY);
  await expect(page.getByTestId('bell-count'), `${username} bell-count`).toHaveText(String(expected.length));
  expect(await apiNotis(page.request), `${username} GET /api/notifications`).toEqual([...expected].sort());
  return page;
}

/** TC-NOTI-01 ทั้งการ์ด (ใช้ซ้ำใน TC-NOTI-02 ส่วน A) */
async function noti01Flow(browser: Browser, hook: APIRequestContext): Promise<void> {
  // request แรกหลัง RESET = LOGIN_S off.reg1 ที่ 09:00
  await expectNotifications(browser, 'off.reg1', [noti(24, 'near'), noti(22, 'near'), noti(20, 'overdue')]);
  await expectNotifications(browser, 'off.reg2', [noti(24, 'near')]);
  await expectNotifications(browser, 'head1', [noti(20, 'overdue')]);
  await expectNotifications(browser, 'off.works1', []);

  await setClock(hook, T('2026-12-01T16:31:00'));
  await expectNotifications(browser, 'off.reg1', [noti(24, 'near'), noti(22, 'near'), noti(20, 'overdue'), noti(22, 'overdue')]);
  await expectNotifications(browser, 'head1', [noti(20, 'overdue'), noti(22, 'overdue')]);
  await expectNotifications(browser, 'off.reg2', [noti(24, 'near')]);
}

// ════════════════════════════ 2. AUTH ════════════════════════════

test('TC-AUTH-01 · เลขบัตร 13 หลัก + checksum', async ({ browser }) => {
  const { page, api } = await fresh(browser);

  const invalid = ['110170012345', '11017001234567', '1101700123457', '11017001234ab'];
  for (const idNo of invalid) {
    await test.step(`ปฏิเสธ ${idNo}`, async () => {
      await page.goto('/login');
      await page.getByTestId('login-tab-citizen').click();
      await page.getByTestId('thaid-id-input').fill(idNo);
      if (idNo.length === 14) await expect(page.getByTestId('thaid-id-input')).toHaveValue(idNo); // ไม่จำกัด maxlength (A-45)
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('thaid-error')).toHaveText(MSG.INVALID_ID);
      await expect(page.getByTestId('otp-step')).toBeHidden();
      await expectApiError(await api.post('/api/auth/thaid/start', { data: { idNo } }), 400, 'INVALID_ID');
    });
  }

  for (const idNo of [SOMCHAI, SOMYING, PITI, MANA]) {
    await test.step(`รับ ${idNo}`, async () => {
      await page.goto('/login');
      await page.getByTestId('login-tab-citizen').click();
      await expect(page.getByTestId('thaid-submit')).toHaveText('เข้าสู่ระบบด้วย ThaiD (จำลอง)');
      await page.getByTestId('thaid-id-input').fill(idNo);
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('otp-step')).toBeVisible();
      await expect(page.getByTestId('thaid-error')).toBeHidden();
      const ok = await expectStatus(await api.post('/api/auth/thaid/start', { data: { idNo } }), 200);
      expect(ok).toEqual({ status: 'OTP_SENT' });
    });
  }
});

test('TC-AUTH-02 · OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ browser }) => {
  const verify = (api: APIRequestContext, idNo: string, otp: string) => api.post('/api/auth/thaid/verify', { data: { idNo, otp } });

  await test.step('API: ขั้น 1–8 (รหัสตอบกลับ)', async () => {
    const { api: hook } = await fresh(browser);
    const piti = await newApi();
    await expectStatus(await piti.post('/api/auth/thaid/start', { data: { idNo: PITI } }), 200);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 423, 'LOCKED')).lockedUntil).toBe(T('2026-12-01T09:15:00'));
    await expectApiError(await verify(piti, PITI, TEST_OTP), 423, 'LOCKED'); // 4: ล็อกอยู่แม้ OTP ถูก
    await citizenApi(SOMCHAI); // 5: ล็อกเฉพาะเลขบัตรที่ผิด
    await setClock(hook, T('2026-12-01T09:14:59'));
    await expectApiError(await verify(piti, PITI, TEST_OTP), 423, 'LOCKED'); // 6
    await setClock(hook, T('2026-12-01T09:15:00'));
    await expectStatus(await piti.post('/api/auth/thaid/start', { data: { idNo: PITI } }), 200);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2); // 7 ตัวนับเริ่มใหม่
    await expectStatus(await verify(piti, PITI, TEST_OTP), 200); // 8
  });

  await test.step('หน้าจอ: ขั้น 1–8', async () => {
    const { page, api: hook } = await fresh(browser);
    const startLogin = async (idNo: string) => {
      await page.goto('/login');
      await page.getByTestId('login-tab-citizen').click();
      await page.getByTestId('thaid-id-input').fill(idNo);
      await page.getByTestId('thaid-submit').click();
    };
    const enterOtp = async (otp: string) => {
      await page.getByTestId('otp-input').fill(otp);
      await page.getByTestId('otp-submit').click();
    };
    /** ลองเข้าใหม่ด้วย OTP ถูกระหว่างล็อก → ต้องเห็น lock-message และไม่เข้าระบบ */
    const expectLockedOnScreen = async () => {
      await startLogin(PITI);
      const lock = page.getByTestId('lock-message');
      const otpStep = page.getByTestId('otp-step');
      await expect.poll(async () => (await lock.isVisible()) || (await otpStep.isVisible())).toBe(true);
      if (!(await lock.isVisible())) await enterOtp(TEST_OTP);
      await expect(lock).toHaveText(MSG.LOCKED);
      expect(pathname(page)).not.toMatch(/^\/(citizen|register)/);
    };

    await startLogin(PITI);
    await expect(page.getByTestId('otp-step')).toBeVisible();
    await enterOtp('000000');
    await expect(page.getByTestId('otp-error')).toHaveText(MSG.OTP_INVALID);
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await enterOtp('000000');
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await enterOtp('000000');
    await expect(page.getByTestId('lock-message')).toHaveText(MSG.LOCKED);
    await expect(page.getByTestId('lock-until')).toHaveAttribute('data-iso', T('2026-12-01T09:15:00'));

    await expectLockedOnScreen(); // 4

    const somchai = await newPage(browser); // 5
    await loginCitizen(somchai, SOMCHAI);
    expect(pathname(somchai)).toBe('/citizen');

    await setClock(hook, T('2026-12-01T09:14:59')); // 6
    await expectLockedOnScreen();

    await setClock(hook, T('2026-12-01T09:15:00')); // 7
    await startLogin(PITI);
    await expect(page.getByTestId('otp-step')).toBeVisible();
    await enterOtp('000000');
    await expect(page.getByTestId('otp-error')).toHaveText(MSG.OTP_INVALID);
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await enterOtp(TEST_OTP); // 8
    await page.waitForURL(/\/citizen(?:\/|\?|$)/);
  });

  await test.step('ขั้น 9 (หน้าจอ): OTP ถูกรีเซ็ตตัวนับ', async () => {
    const { page } = await fresh(browser);
    const round = async () => {
      await page.goto('/login');
      await page.getByTestId('login-tab-citizen').click();
      await page.getByTestId('thaid-id-input').fill(PITI);
      await page.getByTestId('thaid-submit').click();
      await page.getByTestId('otp-input').fill('000000');
      await page.getByTestId('otp-submit').click();
      await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
      await page.getByTestId('otp-input').fill('000000');
      await page.getByTestId('otp-submit').click();
      await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
      await expect(page.getByTestId('lock-message')).toBeHidden();
    };
    await round();
    await page.getByTestId('otp-input').fill(TEST_OTP);
    await page.getByTestId('otp-submit').click();
    await page.waitForURL(/\/citizen(?:\/|\?|$)/);
    await page.getByTestId('logout-btn').click();
    await page.waitForURL(/\/login(?:\?|$)/);
    await round();
  });

  await test.step('ขั้น 9 (API)', async () => {
    await fresh(browser);
    const piti = await newApi();
    await expectStatus(await piti.post('/api/auth/thaid/start', { data: { idNo: PITI } }), 200);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
    await expectStatus(await verify(piti, PITI, TEST_OTP), 200);
    await expectStatus(await piti.post('/api/auth/logout'), 204);
    await expectStatus(await piti.post('/api/auth/thaid/start', { data: { idNo: PITI } }), 200);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
    expect((await expectApiError(await verify(piti, PITI, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
  });
});

test('TC-AUTH-03 · ลงทะเบียนครั้งแรก', async ({ browser }) => {
  const { page } = await fresh(browser);

  // LOGIN_C มานะ ผ่านหน้า /login → /register
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(MANA);
  await page.getByTestId('thaid-submit').click();
  await page.getByTestId('otp-input').fill(TEST_OTP);
  await page.getByTestId('otp-submit').click();
  await page.waitForURL(/\/register(?:\?|$)/);

  // 1 reg-name อ่านอย่างเดียว
  const regName = page.getByTestId('reg-name');
  await expect(regName).toHaveValue('มานะ ตั้งใจ');
  expect(await regName.evaluate(el => (el as HTMLInputElement).readOnly)).toBe(true);
  await regName.focus();
  await page.keyboard.type('ทดสอบ');
  await expect(regName).toHaveValue('มานะ ตั้งใจ');

  // 2–4 เบอร์ผิด
  for (const mobile of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await test.step(`เบอร์ ${mobile}`, async () => {
      await page.getByTestId('reg-mobile').fill(mobile);
      await page.getByTestId('reg-consent').check();
      await page.getByTestId('reg-submit').click();
      await expect(page.getByTestId('reg-error-mobile')).toHaveText(MSG.INVALID_MOBILE);
      expect(pathname(page)).toBe('/register');
    });
  }

  // 5 ไม่ติ๊กยินยอม
  await page.getByTestId('reg-mobile').fill('0845678901');
  await page.getByTestId('reg-consent').uncheck();
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('reg-error-consent')).toHaveText(MSG.CONSENT_REQUIRED);
  expect(pathname(page)).toBe('/register');

  // 6 สำเร็จ (อีเมลว่าง)
  await page.getByTestId('reg-mobile').fill('0845678901');
  await page.getByTestId('reg-email').fill('');
  await page.getByTestId('reg-consent').check();
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/citizen(?:\?|$)/);
  await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');

  // 7 ออก → เข้าใหม่ ไป /citizen ตรง ๆ ไม่ผ่าน /register
  await page.getByTestId('logout-btn').click();
  await page.waitForURL(/\/login(?:\?|$)/);
  const visited: string[] = [];
  page.on('framenavigated', f => {
    if (f === page.mainFrame()) visited.push(new URL(f.url()).pathname);
  });
  await loginCitizen(page, MANA);
  expect(pathname(page)).toBe('/citizen');
  expect(visited).not.toContain('/register');

  // 8 RESET → API register
  await fresh(browser);
  const mana = await newApi();
  await expectStatus(await mana.post('/api/auth/thaid/start', { data: { idNo: MANA } }), 200);
  const v = await expectStatus(await mana.post('/api/auth/thaid/verify', { data: { idNo: MANA, otp: TEST_OTP } }), 200);
  expect(v.registered).toBe(false);
  await expectApiError(await mana.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }), 400, 'INVALID_MOBILE');
  await expectApiError(await mana.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }), 400, 'CONSENT_REQUIRED');
});

test('TC-AUTH-04 · เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้น', async ({ browser }) => {
  const { page, api } = await fresh(browser);

  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await expect(page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');

  const table: Array<{ username: string; landing: string; roleText: string; role: string; dept?: string }> = [
    { username: 'off.reg1', landing: '/officer/queue', roleText: 'เจ้าหน้าที่', role: 'officer', dept: 'registry' },
    { username: 'off.reg2', landing: '/officer/queue', roleText: 'เจ้าหน้าที่', role: 'officer', dept: 'registry' },
    { username: 'off.works1', landing: '/officer/queue', roleText: 'เจ้าหน้าที่', role: 'officer', dept: 'works' },
    { username: 'head1', landing: '/head/approvals', roleText: 'หัวหน้าฝ่าย', role: 'head' },
    { username: 'exec1', landing: '/dashboard', roleText: 'ผู้บริหาร', role: 'executive' },
    { username: 'audit1', landing: '/audit', roleText: 'ผู้ตรวจสอบภายใน', role: 'auditor' },
    { username: 'admin1', landing: '/admin/services', roleText: 'ผู้ดูแลระบบ', role: 'admin' },
  ];
  for (const row of table) {
    await test.step(row.username, async () => {
      await loginStaff(page, row.username);
      expect(pathname(page)).toBe(row.landing);
      await expect(page.getByTestId('user-name')).toHaveText(STAFF_NAME[row.username]);
      await expect(page.getByTestId('user-role')).toHaveText(row.roleText);
      await expect(page.getByTestId('user-role')).toHaveAttribute('data-role', row.role);
      if (row.dept) await expect(page.getByTestId('user-role')).toHaveAttribute('data-dept', row.dept);
      await page.getByTestId('logout-btn').click();
      await page.waitForURL(/\/login(?:\?|$)/);
      if (row.username === 'off.reg1') {
        await page.goto('/officer/queue');
        await page.waitForURL(/\/login(?:\?|$)/);
      }
    });
  }

  for (const [username, password] of [
    ['off.reg1', 'wrong'],
    ['nobody', STAFF_PASSWORD],
    [SOMCHAI, STAFF_PASSWORD],
  ]) {
    await test.step(`ปฏิเสธ ${username}/${password}`, async () => {
      await page.goto('/login');
      await page.getByTestId('login-tab-staff').click();
      await page.getByTestId('staff-username').fill(username);
      await page.getByTestId('staff-password').fill(password);
      await page.getByTestId('staff-submit').click();
      await expect(page.getByTestId('staff-error')).toHaveText(MSG.INVALID_CREDENTIALS);
      await expectApiError(await api.post('/api/auth/staff/login', { data: { username, password } }), 401, 'INVALID_CREDENTIALS');
    });
  }
});

// ════════════════════════════ 3. FEE ════════════════════════════

test('TC-FEE-01 · ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ browser }) => {
  const { page } = await fresh(browser);
  await loginCitizen(page, SOMCHAI);
  const citizen = page.request;

  // ผลคาดหวังจากสูตร (TEST-DATA ข้อ 2) ไม่ใช่จากหน้าจอ
  const feeSv03 = (area: number) => 1000 + 10 * Math.max(0, area - 100);
  const feeSv01 = (qty: number) => 20 * qty;

  await test.step('SV-03 area-input', async () => {
    await page.goto('/citizen/new/SV-03');
    for (const area of [0, -1, 1, 100, 101, 102, 250, 300, 499, 500, 501]) {
      await fillFeeInput(page, 'area-input', area);
      const res = await citizen.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: area } });
      if (area >= 1 && area <= 500) {
        await expect.soft(page.getByTestId('fee-total'), `area ${area}`).toHaveText(baht(feeSv03(area)));
        await expect.soft(page.getByTestId('fee-error'), `area ${area}`).toBeHidden();
        await expect.soft(page.getByTestId('to-upload-btn'), `area ${area}`).toBeEnabled();
        const body = await expectStatus(res, 201);
        expect.soft(body.fee, `API fee area ${area}`).toBe(feeSv03(area));
      } else {
        const [code, message] = area > 500 ? ['AREA_TOO_LARGE', MSG.AREA_TOO_LARGE] : ['INVALID_AREA', MSG.INVALID_AREA];
        await expect.soft(page.getByTestId('fee-total'), `area ${area}`).toHaveText(EN_DASH);
        await expect.soft(page.getByTestId('fee-error'), `area ${area}`).toHaveText(message);
        await expect.soft(page.getByTestId('to-upload-btn'), `area ${area}`).toBeDisabled();
        await expectApiError(res, 400, code);
      }
    }
    // ค่าขอบหลัก 101 → ฿1,010 (ตรวจแบบไม่ soft)
    await fillFeeInput(page, 'area-input', 101);
    await expect(page.getByTestId('fee-total')).toHaveText('฿1,010');
  });

  await test.step('SV-01 qty-input', async () => {
    await page.goto('/citizen/new/SV-01');
    for (const qty of [0, 1, 2, 3, 4, 5, 6]) {
      await fillFeeInput(page, 'qty-input', qty);
      const res = await citizen.post('/api/drafts', { data: { serviceId: 'SV-01', qty } });
      if (qty >= 1 && qty <= 5) {
        await expect.soft(page.getByTestId('fee-total'), `qty ${qty}`).toHaveText(baht(feeSv01(qty)));
        await expect.soft(page.getByTestId('fee-error'), `qty ${qty}`).toBeHidden();
        await expect.soft(page.getByTestId('to-upload-btn'), `qty ${qty}`).toBeEnabled();
        const body = await expectStatus(res, 201);
        expect.soft(body.fee, `API fee qty ${qty}`).toBe(feeSv01(qty));
      } else {
        await expect.soft(page.getByTestId('fee-error'), `qty ${qty}`).toHaveText(MSG.INVALID_QTY);
        await expect.soft(page.getByTestId('fee-total'), `qty ${qty}`).toHaveText(EN_DASH);
        await expect.soft(page.getByTestId('to-upload-btn'), `qty ${qty}`).toBeDisabled();
        await expectApiError(res, 400, 'INVALID_QTY');
      }
    }
  });

  await test.step('SV-02 ค่าคงที่', async () => {
    await page.goto('/citizen/new/SV-02');
    await expect(page.getByTestId('fee-total')).toHaveText('฿500');
    await expect(page.getByTestId('qty-input')).toHaveCount(0);
    await expect(page.getByTestId('area-input')).toHaveCount(0);
    const body = await expectStatus(await citizen.post('/api/drafts', { data: { serviceId: 'SV-02' } }), 201);
    expect(body.fee).toBe(500);
  });
});

// ════════════════════════════ 4. SUBMIT ════════════════════════════

test('TC-SUBMIT-01 · ยื่นคำขอ SV-01 ครบวงจร', async ({ browser }) => {
  const { page, api: hook } = await fresh(browser);
  await loginCitizen(page, SOMCHAI);

  // 1
  await page.goto('/citizen');
  await page.getByTestId('start-service-SV-01').click();
  await page.waitForURL(/\/citizen\/new\/SV-01/);
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await fillFeeInput(page, 'qty-input', 2);
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');
  await page.getByTestId('to-upload-btn').click();

  // 2
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('file-item')).toHaveAttribute('data-doc-key', 'id-card');
  await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
  await page.getByTestId('to-payment-btn').click();

  // 3
  await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(page.getByTestId('payment-amount')).toHaveText('฿40');
  await page.getByTestId('create-qr-btn').click();
  await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', T('2026-12-01T09:15:00'));
  await expect(page.getByTestId('payment-status')).toHaveText('รอชำระ');

  // 4
  const paid = await pay(hook, 'PP-0002', 40);
  expect(paid).toMatchObject({ status: 'PAID', caseNo: EG(31), receiptNo: RC(31), duplicate: false });
  await page.getByTestId('refresh-payment-btn').click();
  await expect(page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
  await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'PAID');
  await expect(page.getByTestId('submitted-case-no')).toHaveText(EG(31));
  await expect(page.getByTestId('receipt-no')).toHaveText(RC(31));
  await expect(page.getByTestId('receipt-amount')).toHaveText('฿40');
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', T('2026-12-01T09:00:00'));

  // 5
  await page.getByTestId('go-case-btn').click();
  await page.waitForURL(new RegExp(`/citizen/cases/${EG(31)}`));
  await expect(page.getByTestId('case-status')).toHaveText(STATUS_TH.SUBMITTED);
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(page.getByTestId('case-fee')).toHaveText('฿40');
  await expect(page.getByTestId('sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', T('2026-12-04T16:30:00'));
  await expectSlaLevel(page, 'normal');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await expect(page.getByTestId('case-step')).toHaveCount(0);

  // คิวของ off.reg1
  const officer = await newPage(browser);
  await loginStaff(officer, 'off.reg1');
  const row = queueRow(officer, EG(31));
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('row-owner')).toHaveText('');
  await expect(row.getByTestId('claim-btn')).toHaveCount(1);
  const order = await attrList(officer.getByTestId('queue-row'), 'data-case-no');
  expect(order.indexOf(EG(31)), 'ท้ายกลุ่มกำหนด 4 ธ.ค. หลัง …000030').toBe(order.indexOf(EG(30)) + 1);
});

test('TC-SUBMIT-02 · เอกสารบังคับครบก่อนชำระ', async ({ browser }) => {
  const { page } = await fresh(browser);
  await loginCitizen(page, SOMCHAI);
  const items = page.getByTestId('file-item');
  const toPay = page.getByTestId('to-payment-btn');
  const missing = page.getByTestId('missing-docs');

  await test.step('SV-02', async () => {
    await page.goto('/citizen/new/SV-02');
    await page.getByTestId('to-upload-btn').click();
    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');

    await attach(page, 'upload-input-id-card', 'id-card.pdf');
    await expect(items).toHaveCount(1);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

    await attach(page, 'upload-input-map', 'map.pdf');
    await expect(items).toHaveCount(2);
    await expect(toPay).toBeEnabled();
    await expect(missing).toHaveCount(0);

    await byAttr(page, 'file-item', 'data-doc-key', 'map').getByTestId('file-remove-btn').click();
    await expect(items).toHaveCount(1);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  });

  await test.step('SV-03 พื้นที่ 100', async () => {
    await page.goto('/citizen/new/SV-03');
    await fillFeeInput(page, 'area-input', 100);
    await page.getByTestId('to-upload-btn').click();
    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');

    await attach(page, 'upload-input-id-card', 'id-card.pdf');
    await expect(items).toHaveCount(1);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');

    await attach(page, 'upload-input-deed', 'deed.pdf');
    await expect(items).toHaveCount(2);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');

    await attach(page, 'upload-input-plan', 'plan-as-jpg.jpg');
    await expect(page.getByTestId('upload-error')).toHaveText(MSG.PLAN_NOT_PDF);
    await expect(items).toHaveCount(2);
    await expect(byAttr(page, 'file-item', 'data-doc-key', 'plan')).toHaveCount(0);
    await expect(toPay).toBeDisabled();
    await expect(missing).toHaveText('ยังขาดเอกสาร: แบบแปลน');

    await attach(page, 'upload-input-plan', 'plan.pdf');
    await expect(items).toHaveCount(3);
    await expect(toPay).toBeEnabled();
    await expect(missing).toHaveCount(0);
  });

  await test.step('API: SV-03 ขาดแบบแปลน → 409 MISSING_DOCS · ครบ → 201', async () => {
    const api = page.request;
    const { draftId } = await createDraft(api, { serviceId: 'SV-03', areaSqm: 100 });
    await expectStatus(await uploadFile(api, draftId, 'id-card.pdf', 'id-card'), 201);
    await expectStatus(await uploadFile(api, draftId, 'deed.pdf', 'deed'), 201);
    await expectApiError(await uploadFile(api, draftId, 'plan-as-jpg.jpg', 'plan'), 400, 'PLAN_NOT_PDF');
    const err = await expectApiError(await api.post(`/api/drafts/${draftId}/payment`), 409, 'MISSING_DOCS');
    expect(err.missing).toEqual(['แบบแปลน']);
    await expectStatus(await uploadFile(api, draftId, 'plan.pdf', 'plan'), 201);
    await expectStatus(await api.post(`/api/drafts/${draftId}/payment`), 201);
  });
});

test('TC-SUBMIT-03 · ร่าง และการยกเลิก', async ({ browser }) => {
  await test.step('ส่วน A ร่าง', async () => {
    const { page } = await fresh(browser);
    await loginCitizen(page, SOMCHAI);
    await page.goto('/citizen');
    await expect(page.getByTestId('my-case-row')).toHaveCount(10);
    const drafts = page.getByTestId('my-draft-row');
    await expect(drafts).toHaveCount(2);
    await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0001')).toHaveAttribute('data-status', 'DRAFT');
    await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0002')).toHaveAttribute('data-status', 'PENDING_PAYMENT');
    for (const text of await drafts.allTextContents()) expect(text).not.toContain('EG-');

    await byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0001').getByTestId('open-draft-btn').click();
    await page.waitForURL(/\/citizen\/new\/SV-01\?draft=DR-0001/);
    await expect(page.getByTestId('qty-input')).toHaveValue('2');
    await expect(page.getByTestId('fee-total')).toHaveText('฿40');

    await page.goto('/citizen/new/SV-01');
    await fillFeeInput(page, 'qty-input', 3);
    await page.getByTestId('save-draft-btn').click();
    await expect(page.getByTestId('draft-id')).toHaveText('DR-0003');

    await page.goto('/citizen');
    await expect(page.getByTestId('my-case-row')).toHaveCount(10);
    expect(await myCaseCount(page.request)).toBe(10);
    expect((await expectStatus(await page.request.get('/api/drafts'), 200)).items).toHaveLength(3);
  });

  await test.step('ส่วน B ยกเลิก', async () => {
    const { page } = await fresh(browser);
    await loginCitizen(page, SOMCHAI);
    await page.goto(`/citizen/cases/${EG(30)}`);
    await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
    await page.getByTestId('cancel-case-btn').click();
    await expect(page.getByTestId('cancel-confirm-text')).toHaveText(MSG.NO_REFUND);
    await page.getByTestId('confirm-cancel-btn').click();
    await expect(page.getByTestId('case-status')).toHaveText(STATUS_TH.CANCELLED);
    await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
    await expect(page.getByTestId('no-refund-note')).toHaveText(MSG.NO_REFUND);
    await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);

    const officer = await asStaff(browser, 'off.reg1');
    await officer.goto('/officer/queue');
    await expect(officer.getByTestId('queue-row')).toHaveCount(16);
    await expect(queueRow(officer, EG(30))).toHaveCount(0);

    const exec = await asStaff(browser, 'exec1');
    await exec.goto('/dashboard');
    await expect(exec.getByTestId('kpi-backlog')).toHaveText('20');
    await expect(exec.getByTestId('kpi-received')).toHaveText('3');
  });

  await test.step('ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ', async () => {
    await fresh(browser);
    const reg1 = await staffApi('off.reg1');
    await expectStatus(await reg1.post(`/api/officer/cases/${EG(30)}/claim`), 200);
    const page = await asCitizen(browser, SOMCHAI);
    await page.goto(`/citizen/cases/${EG(30)}`);
    await expect(page.getByTestId('case-status')).toHaveText(STATUS_TH.IN_REVIEW);
    await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);
    await expectApiError(await page.request.post(`/api/cases/${EG(30)}/cancel`), 409, 'CANNOT_CANCEL', MSG.CANNOT_CANCEL);
    await expectApiError(await page.request.post(`/api/cases/${EG(13)}/cancel`), 409, 'CANNOT_CANCEL');
  });

  await test.step('ส่วน E ลบร่าง', async () => {
    const { page, api: hook } = await fresh(browser);
    await loginCitizen(page, SOMCHAI);
    const api = page.request;
    await expectStatus(await api.delete('/api/drafts/DR-0001'), 204);
    await expectApiError(await api.get('/api/drafts/DR-0001'), 404, 'NOT_FOUND');
    await page.goto('/citizen');
    await expect(page.getByTestId('my-draft-row')).toHaveCount(1);
    await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0002')).toHaveCount(1);
    await expectStatus(await api.delete('/api/drafts/DR-0002'), 204);
    await expectStatus(await api.get('/api/payments/PP-0001'), 404);
    await expectStatus(await rawPay(hook, 'PP-0001', 500), 404);
    expect(await myCaseCount(api)).toBe(10);
  });

  await test.step('ส่วน F ยกเลิกชนกับรับเรื่อง', async () => {
    await fresh(browser);
    const somchai = await citizenApi(SOMCHAI);
    const reg1 = await staffApi('off.reg1');
    const [cancel, claim] = await Promise.all([
      somchai.post(`/api/cases/${EG(30)}/cancel`),
      reg1.post(`/api/officer/cases/${EG(30)}/claim`),
    ]);
    expect([cancel.status(), claim.status()].filter(s => s === 200), 'สำเร็จฝั่งเดียว').toHaveLength(1);
    const state = await getCase(reg1, EG(30));
    const mine = (await expectStatus(await reg1.get('/api/officer/queue?filter=mine'), 200)).items.length;
    if (cancel.status() === 200) {
      await expectApiError(claim, 409, 'INVALID_STATE');
      expect(state.status).toBe('CANCELLED');
      expect(state.owner || null).toBeNull();
      expect(mine).toBe(3);
    } else {
      await expectStatus(claim, 200);
      await expectApiError(cancel, 409, 'CANNOT_CANCEL');
      expect(state.status).toBe('IN_REVIEW');
      expect(state.owner).toBe('off.reg1');
      expect(mine).toBe(4);
    }
  });
});

// ════════════════════════════ 5. UPLOAD ════════════════════════════

test('TC-UPLOAD-01 · ขนาดและจำนวนไฟล์', async ({ browser }) => {
  const { page } = await fresh(browser);
  await loginCitizen(page, SOMCHAI);
  const api = page.request;
  const items = page.getByTestId('file-item');
  const uploadError = page.getByTestId('upload-error');

  await test.step('ขนาด (หน้าจอ)', async () => {
    await wizardSv01ToUpload(page, 1);
    await attach(page, 'upload-input-id-card', 'size-5242879.pdf');
    await expect(items).toHaveCount(1);
    await expect(uploadError).toBeHidden();
    await removeFile(page, 'size-5242879.pdf');

    await attach(page, 'upload-input-id-card', 'size-5242880.pdf');
    await expect(items).toHaveCount(1);
    await expect(uploadError).toBeHidden();
    await removeFile(page, 'size-5242880.pdf');

    await attach(page, 'upload-input-id-card', 'size-5242881.pdf');
    await expect(uploadError).toHaveText(MSG.FILE_TOO_LARGE);
    await expect(items).toHaveCount(0);
  });

  await test.step('ขนาด (API)', async () => {
    for (const [name, accepted] of [
      ['size-5242879.pdf', true],
      ['size-5242880.pdf', true],
      ['size-5242881.pdf', false],
    ] as const) {
      const { draftId } = await createDraft(api, { serviceId: 'SV-01', qty: 1 });
      const res = await uploadFile(api, draftId, name, 'id-card');
      if (accepted) {
        const body = await expectStatus(res, 201);
        expect(body.size).toBe(Number(name.match(/\d+/)![0]));
      } else {
        await expectApiError(res, 400, 'FILE_TOO_LARGE', MSG.FILE_TOO_LARGE); // ไม่ใช่ 413
      }
    }
  });

  await test.step('จำนวน (หน้าจอ)', async () => {
    await attach(page, 'upload-input-id-card', 'id-card.pdf');
    await expect(items).toHaveCount(1);
    await attach(page, 'upload-input-extra', 'multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf', 'multi-4.pdf');
    await expect(items).toHaveCount(5);

    await attach(page, 'upload-input-extra', 'multi-5.pdf');
    await expect(uploadError).toHaveText(MSG.FILE_COUNT);
    await expect(items).toHaveCount(5);

    await removeFile(page, 'multi-1.pdf');
    await attach(page, 'upload-input-extra', 'multi-5.pdf');
    await expect(items).toHaveCount(5);
    await expect(byAttr(page, 'file-item', 'data-name', 'multi-5.pdf')).toHaveCount(1);
  });

  await test.step('จำนวน (API)', async () => {
    const { draftId } = await createDraft(api, { serviceId: 'SV-01', qty: 1 });
    await expectStatus(await uploadFile(api, draftId, 'id-card.pdf', 'id-card'), 201);
    for (const n of [1, 2, 3, 4]) await expectStatus(await uploadFile(api, draftId, `multi-${n}.pdf`, 'extra'), 201);
    await expectApiError(await uploadFile(api, draftId, 'multi-5.pdf', 'extra'), 400, 'FILE_COUNT', MSG.FILE_COUNT);
  });
});

test('TC-UPLOAD-02 · ชนิดไฟล์จากเนื้อไฟล์', async ({ browser }) => {
  const { page } = await fresh(browser);
  await loginCitizen(page, SOMCHAI);
  const api = page.request;
  const items = page.getByTestId('file-item');
  const uploadError = page.getByTestId('upload-error');

  await test.step('หน้าจอ', async () => {
    await wizardSv01ToUpload(page, 1);
    for (const name of ['ok-id.pdf', 'real.jpg', 'real.png']) {
      await attach(page, 'upload-input-id-card', name);
      await expect(items, name).toHaveCount(1);
      await removeFile(page, name);
    }
    for (const name of ['fake-text.pdf', 'fake-text.jpg', 'exe-as.png', 'notes.txt']) {
      await attach(page, 'upload-input-id-card', name);
      await expect(uploadError, name).toHaveText(MSG.FILE_TYPE);
      await expect(items, name).toHaveCount(0);
    }
    // ไม่เชื่อ Content-Type
    await page.getByTestId('upload-input-id-card').setInputFiles({
      name: 'fake-text.pdf',
      mimeType: 'application/pdf',
      buffer: await readFile(filePath('fake-text.pdf')),
    });
    await expect(uploadError).toHaveText(MSG.FILE_TYPE);
    await expect(items).toHaveCount(0);
  });

  await test.step('API', async () => {
    for (const name of ['ok-id.pdf', 'real.jpg', 'real.png']) {
      const { draftId } = await createDraft(api, { serviceId: 'SV-01', qty: 1 });
      await expectStatus(await uploadFile(api, draftId, name, 'id-card'), 201);
    }

    const { draftId } = await createDraft(api, { serviceId: 'SV-01', qty: 1 });
    const before = await draftFileCount(api, draftId);
    for (const [name, mime] of [
      ['fake-text.pdf', 'application/pdf'],
      ['fake-text.jpg', 'image/jpeg'],
      ['exe-as.png', 'image/png'],
      ['notes.txt', 'text/plain'],
    ] as const) {
      await expectApiError(await uploadFile(api, draftId, name, 'id-card', mime), 400, 'FILE_TYPE', MSG.FILE_TYPE);
    }
    const after = await draftFileCount(api, draftId);
    if (before !== undefined) expect(after, 'GET /api/drafts/:id จำนวนไฟล์ไม่เพิ่ม').toBe(before);
    // พิสูจน์ว่าไฟล์ที่ถูกปฏิเสธไม่ถูกเก็บ: ยังแนบไฟล์ถูกได้ครบ 5 และไฟล์ที่ 6 ถูกปฏิเสธ
    await expectStatus(await uploadFile(api, draftId, 'ok-id.pdf', 'id-card'), 201);
    for (const n of [1, 2, 3, 4]) await expectStatus(await uploadFile(api, draftId, `multi-${n}.pdf`, 'extra'), 201);
    await expectApiError(await uploadFile(api, draftId, 'multi-5.pdf', 'extra'), 400, 'FILE_COUNT');
  });
});

// ════════════════════════════ 6. PAY ════════════════════════════

test('TC-PAY-01 · อายุ QR 15:00', async ({ browser }) => {
  await test.step('รอบ 1 · 09:00:00 (อายุ 5:00)', async () => {
    const { api: hook } = await fresh(browser);
    await citizenApi(SOMCHAI);
    const r = await expectStatus(await rawPay(hook, 'PP-0001', 500), 200);
    expect(r.status).toBe('PAID');
    expect(r.caseNo).toBe(EG(31));
  });

  await test.step('รอบ 2 · 09:09:59 (อายุ 14:59)', async () => {
    const { api: hook } = await fresh(browser);
    await setClock(hook, T('2026-12-01T09:09:59'));
    await citizenApi(SOMCHAI);
    const r = await expectStatus(await rawPay(hook, 'PP-0001', 500), 200);
    expect(r.status).toBe('PAID');
    expect(r.caseNo).toBe(EG(31));
  });

  await test.step('รอบ 3 · 09:10:00 (อายุ 15:00 พอดี) → 410', async () => {
    const { page, api: hook } = await fresh(browser);
    await setClock(hook, T('2026-12-01T09:10:00'));
    await loginCitizen(page, SOMCHAI);
    await expectApiError(await rawPay(hook, 'PP-0001', 500), 410, 'QR_EXPIRED');
    expect((await expectStatus(await page.request.get('/api/payments/PP-0001'), 200)).status).toBe('EXPIRED');
    expect(await myCaseCount(page.request)).toBe(10);

    await page.goto('/citizen/new/SV-02?draft=DR-0002');
    await expect(page.getByTestId('qr-expired-msg')).toHaveText(MSG.QR_EXPIRED);
    await expect(page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
    await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
    await expect(page.getByTestId('regenerate-qr-btn')).toHaveCount(1);
    await page.getByTestId('regenerate-qr-btn').click();
    await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
    await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', T('2026-12-01T09:25:00'));
    const r = await expectStatus(await rawPay(hook, 'PP-0002', 500), 200);
    expect(r.caseNo).toBe(EG(31));
  });

  await test.step('รอบ 4 · 09:10:01 (อายุ 15:01) → 410', async () => {
    const { api: hook } = await fresh(browser);
    await setClock(hook, T('2026-12-01T09:10:01'));
    await citizenApi(SOMCHAI);
    await expectApiError(await rawPay(hook, 'PP-0001', 500), 410, 'QR_EXPIRED');
  });
});

test('TC-PAY-02 · ยอดเงินและ callback ซ้ำ', async ({ browser }) => {
  const { api: hook } = await fresh(browser);
  const somchai = await citizenApi(SOMCHAI);
  const q = await draftWithQr(somchai, { serviceId: 'SV-01', qty: 1 });
  expect(q.ref).toBe('PP-0002');
  expect(q.fee).toBe(20);
  const paymentStatus = async () => (await expectStatus(await somchai.get('/api/payments/PP-0002'), 200)).status;

  await expectApiError(await rawPay(hook, 'PP-0002', 19), 422, 'AMOUNT_MISMATCH'); // 1
  expect(await paymentStatus()).toBe('PENDING');
  expect(await myCaseCount(somchai)).toBe(10);

  await expectApiError(await rawPay(hook, 'PP-0002', 21), 422, 'AMOUNT_MISMATCH'); // 2
  expect(await paymentStatus()).toBe('PENDING');

  const first = await expectStatus(await rawPay(hook, 'PP-0002', 20), 200); // 3
  expect(first).toMatchObject({ status: 'PAID', caseNo: EG(31), receiptNo: RC(31) });
  expect(await myCaseCount(somchai)).toBe(11);

  const dup = await expectStatus(await rawPay(hook, 'PP-0002', 20), 200); // 4
  expect(dup).toMatchObject({ duplicate: true, caseNo: EG(31), receiptNo: RC(31) });
  expect(await myCaseCount(somchai)).toBe(11);

  const q2 = await draftWithQr(somchai, { serviceId: 'SV-01', qty: 1 }); // 5
  const next = await expectStatus(await rawPay(hook, q2.ref, 20), 200);
  expect(next).toMatchObject({ caseNo: EG(32), receiptNo: RC(32) });
});

test('TC-PAY-03 · ชำระพร้อมกัน เลขไม่ซ้ำ', async ({ browser }) => {
  const { api: hook } = await fresh(browser);
  const somchai = await citizenApi(SOMCHAI);
  const somying = await citizenApi(SOMYING);
  const refsOf = new Map<string, APIRequestContext>();
  for (const who of [somchai, somchai, somchai, somying, somying, somying]) {
    const q = await draftWithQr(who, { serviceId: 'SV-01', qty: 1 });
    refsOf.set(q.ref, who);
  }
  const refs = [...refsOf.keys()];
  expect([...refs].sort()).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);

  const responses = await Promise.all(refs.map(ref => rawPay(hook, ref, 20)));
  const bodies = await Promise.all(responses.map(r => expectStatus(r, 200)));
  const caseNos = bodies.map(b => b.caseNo);
  const receiptNos = bodies.map(b => b.receiptNo);
  expect(new Set(caseNos).size).toBe(6);
  expect([...caseNos].sort()).toEqual([31, 32, 33, 34, 35, 36].map(n => EG(n)));
  expect([...receiptNos].sort()).toEqual([31, 32, 33, 34, 35, 36].map(n => RC(n)));

  for (const who of [somchai, somying]) {
    const mine = refs.map((ref, i) => [ref, caseNos[i]] as const).filter(([ref]) => refsOf.get(ref) === who).map(([, c]) => c);
    expect(mine).toHaveLength(3);
    const listed = (await expectStatus(await who.get('/api/cases'), 200)).items.map((i: any) => i.caseNo);
    for (const c of mine) expect(listed).toContain(c);
  }

  const q = await draftWithQr(somchai, { serviceId: 'SV-01', qty: 1 });
  expect((await expectStatus(await rawPay(hook, q.ref, 20), 200)).caseNo).toBe(EG(37));
});

test('TC-PAY-04 · เลขคำขอข้ามปี', async ({ browser }) => {
  const { page, api: hook } = await fresh(browser);

  // 1 · 23:58 สร้างร่าง + QR (ผ่านหน้าจอ)
  await setClock(hook, T('2026-12-31T23:58:00'));
  await loginCitizen(page, SOMCHAI);
  await wizardSv01ToUpload(page, 1);
  await attach(page, 'upload-input-id-card', 'id-card.pdf');
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await page.getByTestId('to-payment-btn').click();
  await page.getByTestId('create-qr-btn').click();
  await expect(page.getByTestId('qr-ref')).toHaveText(/^PP-\d{4}$/);
  const ref = (await page.getByTestId('qr-ref').textContent())!.trim();
  const pending = await expectStatus(await page.request.get(`/api/payments/${ref}`), 200);
  expect(pending.caseNo || null).toBeNull();
  expect(await myCaseCount(page.request)).toBe(10);

  // 2 · 23:59 ชำระ
  await setClock(hook, T('2026-12-31T23:59:00'));
  expect(await pay(hook, ref, 20)).toMatchObject({ caseNo: EG(31), receiptNo: RC(31) });
  await page.getByTestId('refresh-payment-btn').click();
  await expect(page.getByTestId('submitted-case-no')).toHaveText(EG(31));
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', T('2026-12-31T23:59:00'));

  // 3 · 2027-01-01 00:00 → ปี 2570 เริ่ม 000001
  const y1 = await newPaid(hook, { serviceId: 'SV-01', qty: 1, at: T('2027-01-01T00:00:00') });
  expect(y1.caseNo).toBe(EG(1, 2570));
  expect(y1.receiptNo).toBe(RC(1, 2570));

  // 4
  const y2 = await newPaid(hook, { serviceId: 'SV-01', qty: 1 });
  expect(y2.caseNo).toBe(EG(2, 2570));

  // 5 เลขเดิมไม่ถูกแก้
  const old = await getCase(y2.citizen, EG(31));
  expect(old.caseNo).toBe(EG(31));
});

// ════════════════════════════ 7. QUEUE ════════════════════════════

test('TC-QUEUE-01 · ลำดับคิวและขอบเขตแผนก', async ({ browser }) => {
  const { page } = await fresh(browser);
  await loginStaff(page, 'off.reg1');
  await page.goto('/officer/queue');
  await expect(page.getByTestId('queue-filter')).toHaveValue('all');

  const rows = page.getByTestId('queue-row');
  const registryOrder = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map(n => EG(n));
  await expect(rows).toHaveCount(17);
  expect(await attrList(rows, 'data-case-no')).toEqual(registryOrder);
  const apiQueue: string[] = (await expectStatus(await page.request.get('/api/officer/queue?filter=all'), 200)).items.map((i: any) => i.caseNo);
  expect([...apiQueue].sort()).toEqual([...registryOrder].sort());

  await expect(rows.nth(0).getByTestId('row-sla-level')).toHaveText(LEVEL_TH.overdue);
  await expect(rows.nth(1).getByTestId('row-sla-level')).toHaveText(LEVEL_TH.near);
  await expect(rows.nth(2).getByTestId('row-sla-level')).toHaveText(LEVEL_TH.near);
  const masked = await page.getByTestId('row-id-masked').allTextContents();
  expect(masked).toHaveLength(17);
  for (const m of masked) expect(m.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);

  const claimable = [24, 28, 29, 30].map(n => EG(n));
  await expect(page.getByTestId('claim-btn')).toHaveCount(4);
  for (const c of claimable) await expect(queueRow(page, c).getByTestId('claim-btn')).toHaveCount(1);
  await expect(queueRow(page, EG(19)).getByTestId('claim-btn')).toHaveCount(0);

  await page.getByTestId('queue-filter').selectOption('unclaimed');
  await expect.poll(() => attrListSafe(page.getByTestId('queue-row'), 'data-case-no')).toEqual(claimable);
  await page.getByTestId('queue-filter').selectOption('mine');
  await expect.poll(() => attrListSafe(page.getByTestId('queue-row'), 'data-case-no')).toEqual([20, 22, 23].map(n => EG(n)));
  await expect(page.getByTestId('workload-count')).toHaveText('3');

  const reg2 = await asStaff(browser, 'off.reg2');
  await reg2.goto('/officer/queue');
  await reg2.getByTestId('queue-filter').selectOption('mine');
  await expect
    .poll(() => attrListSafe(reg2.getByTestId('queue-row'), 'data-case-no'))
    .toEqual([25, 26, 13, 15, 27, 16, 18, 12, 21].map(n => EG(n)));
  await expect(reg2.getByTestId('workload-count')).toHaveText('9');

  const works = await asStaff(browser, 'off.works1');
  await works.goto('/officer/queue');
  await expect(works.getByTestId('queue-row')).toHaveCount(1);
  expect(await attrList(works.getByTestId('queue-row'), 'data-case-no')).toEqual([EG(10)]);

  const head = await newPage(browser);
  await loginStaff(head, 'head1');
  await head.goto('/officer/queue');
  await expect(head.getByTestId('queue-row')).toHaveCount(18);
  const headOrder = await attrList(head.getByTestId('queue-row'), 'data-case-no');
  expect(headOrder).toEqual([20, 22, 24, 10, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map(n => EG(n)));
  const i10 = headOrder.indexOf(EG(10));
  expect(headOrder.slice(i10, i10 + 4)).toEqual([10, 23, 25, 26].map(n => EG(n)));
  await expect(head.getByTestId('claim-btn')).toHaveCount(0);

  for (const n of [17, 11, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    expect(registryOrder).not.toContain(EG(n));
    expect(headOrder).not.toContain(EG(n));
  }
});

test('TC-QUEUE-02 · รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ browser }) => {
  await test.step('ส่วน 1 พร้อมกัน (UI · 2 context)', async () => {
    await fresh(browser);
    const a = await newPage(browser);
    const b = await newPage(browser);
    await loginStaff(a, 'off.reg1');
    await loginStaff(b, 'off.reg2');
    for (const p of [a, b]) {
      await p.goto('/officer/queue');
      await expect(queueRow(p, EG(28)).getByTestId('claim-btn')).toBeVisible();
    }
    // ผล HTTP ของการกดพร้อมกัน (การ์ด ส่วน 1: ผู้แพ้ได้ HTTP 409 ALREADY_CLAIMED) · ตรวจก่อน action-error
    // เพื่อให้ตอนเปิด B08 ล้มด้วย "ค่าต่าง" (200,200 แทน 200,409) ไม่ใช่ "หา element ไม่เจอ" (BUGS.md §3 ขั้น 4 · B14)
    const claimPath = `/api/officer/cases/${EG(28)}/claim`;
    const claimWaits = [a, b].map(p =>
      p.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === claimPath, { timeout: 15_000 }),
    );
    await Promise.all([a, b].map(p => queueRow(p, EG(28)).getByTestId('claim-btn').click()));
    const claimRes = await Promise.all(claimWaits);
    await Promise.all([a, b].map(settle));
    expect(claimRes.map(r => r.status()).sort(), 'claim พร้อมกัน 2 context: HTTP status').toEqual([200, 409]);
    expect((await claimRes.find(r => r.status() === 409)!.json()).code, 'ผู้แพ้ได้ code').toBe('ALREADY_CLAIMED');

    await expect.poll(async () => (await getCase(a.request, EG(28))).status).toBe('IN_REVIEW');
    const c = await getCase(a.request, EG(28));
    expect(c.status).toBe('IN_REVIEW');
    expect(['off.reg1', 'off.reg2']).toContain(c.owner);
    const [winner, loser] = c.owner === 'off.reg1' ? [a, b] : [b, a];
    await expect(loser.getByTestId('action-error')).toHaveText(MSG.ALREADY_CLAIMED);
    await winner.goto('/officer/queue');
    await expect(queueRow(winner, EG(28))).toHaveAttribute('data-owner', c.owner);
    await expect(queueRow(winner, EG(28)).getByTestId('row-owner')).toHaveText(
      new RegExp(`^\\s*(${c.owner.replace('.', '\\.')}|${STAFF_NAME[c.owner]})\\s*$`),
    );
    expect(await auditClaimCount(EG(28))).toBe(1);
  });

  await test.step('ส่วน 2 พร้อมกัน (API 10 ครั้ง)', async () => {
    await fresh(browser);
    const reg1 = await staffApi('off.reg1');
    const reg2 = await staffApi('off.reg2');
    const callers = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? (['off.reg1', reg1] as const) : (['off.reg2', reg2] as const)));
    const results = await Promise.all(callers.map(async ([user, api]) => ({ user, res: await api.post(`/api/officer/cases/${EG(29)}/claim`) })));
    const ok = results.filter(r => r.res.status() === 200);
    expect(ok, 'ตอบ 200 ครั้งเดียว').toHaveLength(1);
    for (const r of results.filter(r => r.res.status() !== 200)) await expectApiError(r.res, 409, 'ALREADY_CLAIMED');
    const winner = ok[0].user;
    expect((await ok[0].res.json()).owner).toBe(winner);
    expect((await getCase(reg1, EG(29))).owner).toBe(winner);
    expect(await auditClaimCount(EG(29))).toBe(1);
  });

  await test.step('ส่วน 3 ต่อกัน (กำหนดได้)', async () => {
    await fresh(browser);
    const reg1 = await staffApi('off.reg1');
    const reg2 = await staffApi('off.reg2');
    const first = await expectStatus(await reg1.post(`/api/officer/cases/${EG(29)}/claim`), 200);
    expect(first.owner).toBe('off.reg1');
    await expectApiError(await reg2.post(`/api/officer/cases/${EG(29)}/claim`), 409, 'ALREADY_CLAIMED', MSG.ALREADY_CLAIMED);
    expect((await getCase(reg2, EG(29))).owner).toBe('off.reg1');
    const reg2Page = await asStaff(browser, 'off.reg2');
    await expect(await workloadOf(reg2Page)).toHaveText('9');
    await expectStatus(await reg1.post(`/api/officer/cases/${EG(29)}/claim`), 409);
    expect(await auditClaimCount(EG(29))).toBe(1);
  });
});

test('TC-QUEUE-03 · งานในมือสูงสุด 10', async ({ browser }) => {
  const { page } = await fresh(browser);
  await loginStaff(page, 'off.reg2');
  const api = page.request;

  await expect(await workloadOf(page)).toHaveText('9'); // 1

  await clickClaimInQueue(page, EG(28)); // 2
  await expectOwner(api, EG(28), 'off.reg2', 'IN_REVIEW');
  await expect(await workloadOf(page)).toHaveText('10');

  await clickClaimInQueue(page, EG(29)); // 3
  await expect(page.getByTestId('action-error')).toHaveText(MSG.WORKLOAD_LIMIT);
  await expectApiError(await api.post(`/api/officer/cases/${EG(29)}/claim`), 409, 'WORKLOAD_LIMIT', MSG.WORKLOAD_LIMIT);
  const c29 = await getCase(api, EG(29));
  expect(c29.status).toBe('SUBMITTED');
  expect(c29.owner || null).toBeNull();
  await expect(await workloadOf(page)).toHaveText('10');

  await page.goto(`/officer/cases/${EG(25)}`); // 4
  await page.getByTestId('approve-btn').click();
  await expect.poll(async () => (await getCase(api, EG(25))).status).toBe('APPROVED');
  await expect(await workloadOf(page)).toHaveText('9');

  await clickClaimInQueue(page, EG(29)); // 5
  await expectOwner(api, EG(29), 'off.reg2', 'IN_REVIEW');
  await expect(await workloadOf(page)).toHaveText('10');

  const reg1 = await staffApi('off.reg1'); // 6
  expect((await expectStatus(await reg1.post(`/api/officer/cases/${EG(30)}/claim`), 200)).owner).toBe('off.reg1');

  // 7 RESET
  const s2 = await fresh(browser);
  const p2 = s2.page;
  await loginStaff(p2, 'off.reg2');
  const api2 = p2.request;
  await uiReturn(p2, EG(25), 'xxxxxxxxxx');
  await expect(await workloadOf(p2)).toHaveText('8');

  await clickClaimInQueue(p2, EG(28)); // 8
  await expectOwner(api2, EG(28), 'off.reg2', 'IN_REVIEW');
  await clickClaimInQueue(p2, EG(29));
  await expectOwner(api2, EG(29), 'off.reg2', 'IN_REVIEW');
  await expect(await workloadOf(p2)).toHaveText('10');

  const somying = await newPage(browser); // 9
  await loginCitizen(somying, SOMYING);
  await uiSubmitFix(somying, EG(25));
  await expect(somying.getByTestId('case-status')).toHaveText(STATUS_TH.IN_REVIEW);
  expect((await getCase(api2, EG(25))).owner).toBe('off.reg2');
  await expect(await workloadOf(p2)).toHaveText('11');

  await clickClaimInQueue(p2, EG(30)); // 10
  await expect(p2.getByTestId('action-error')).toHaveText(MSG.WORKLOAD_LIMIT);
  await expectApiError(await api2.post(`/api/officer/cases/${EG(30)}/claim`), 409, 'WORKLOAD_LIMIT', MSG.WORKLOAD_LIMIT);
  await expect(await workloadOf(p2)).toHaveText('11');
});

// ════════════════════════════ 8. SLA ════════════════════════════

test('TC-SLA-01 · กำหนดเสร็จตามตารางวันที่', async ({ browser }) => {
  test.setTimeout(360_000);
  const rows: Array<{ row: string; o: DraftOpts; at: string; due: string; text: string }> = [
    { row: 'a', o: { serviceId: 'SV-01' }, at: T('2026-12-01T09:00:00'), due: T('2026-12-04T16:30:00'), text: '4 ธ.ค. 2569 16:30' },
    { row: 'b', o: { serviceId: 'SV-01' }, at: T('2026-12-01T16:29:00'), due: T('2026-12-04T16:30:00'), text: '4 ธ.ค. 2569 16:30' },
    { row: 'c', o: { serviceId: 'SV-01' }, at: T('2026-12-01T16:30:00'), due: T('2026-12-08T16:30:00'), text: '8 ธ.ค. 2569 16:30' },
    { row: 'd', o: { serviceId: 'SV-01' }, at: T('2026-12-04T10:00:00'), due: T('2026-12-11T16:30:00'), text: '11 ธ.ค. 2569 16:30' },
    { row: 'e', o: { serviceId: 'SV-01' }, at: T('2026-12-05T10:00:00'), due: T('2026-12-14T16:30:00'), text: '14 ธ.ค. 2569 16:30' },
    { row: 'f', o: { serviceId: 'SV-02' }, at: T('2026-12-01T09:00:00'), due: T('2026-12-17T16:30:00'), text: '17 ธ.ค. 2569 16:30' },
    { row: 'g', o: { serviceId: 'SV-03', areaSqm: 100 }, at: T('2026-12-01T09:00:00'), due: T('2026-12-24T16:30:00'), text: '24 ธ.ค. 2569 16:30' },
    { row: 'h', o: { serviceId: 'SV-01' }, at: T('2026-12-29T10:00:00'), due: T('2027-01-05T16:30:00'), text: '5 ม.ค. 2570 16:30' },
    { row: 'i', o: { serviceId: 'SV-01' }, at: T('2026-12-31T23:59:00'), due: T('2027-01-07T16:30:00'), text: '7 ม.ค. 2570 16:30' },
  ];
  for (const r of rows) {
    await test.step(`แถว ${r.row}: ${r.o.serviceId} ชำระ ${r.at} → ${r.due}`, async () => {
      const { api: hook } = await fresh(browser);
      const paid = await newPaid(hook, { ...r.o, at: r.at });
      expect(paid.caseNo).toBe(EG(31));
      expect.soft((await getCase(paid.citizen, EG(31))).dueAt, `แถว ${r.row} dueAt`).toBe(r.due);
      const page = await asCitizen(browser, SOMCHAI);
      await page.goto(`/citizen/cases/${EG(31)}`);
      await expect.soft(page.getByTestId('sla-due'), `แถว ${r.row} data-iso`).toHaveAttribute('data-iso', r.due);
      await expect.soft(page.getByTestId('sla-due'), `แถว ${r.row} ข้อความ`).toHaveText(r.text);
    });
  }
});

test('TC-SLA-02 · หยุดนับ SLA ระหว่างรอแก้ไข', async ({ browser }) => {
  test.setTimeout(300_000);

  await test.step('ส่วน 1: ตีกลับ 2 ธ.ค. 11:00 ส่งแก้ 3 ธ.ค. 10:00 → 8 ธ.ค.', async () => {
    const { api: hook } = await fresh(browser);
    const paid = await newPaid(hook, { serviceId: 'SV-01', at: T('2026-12-01T09:00:00') });
    expect(paid.caseNo).toBe(EG(31));
    expect((await getCase(paid.citizen, EG(31))).dueAt).toBe(T('2026-12-04T16:30:00'));

    await setClock(hook, T('2026-12-02T11:00:00'));
    const officer = await asStaff(browser, 'off.reg1');
    await officer.goto(`/officer/cases/${EG(31)}`);
    await officer.getByTestId('claim-btn').click();
    await expectOwner(officer.request, EG(31), 'off.reg1', 'IN_REVIEW');
    await uiReturn(officer, EG(31), 'xxxxxxxxxx');

    const citizen = await asCitizen(browser, SOMCHAI);
    await citizen.goto(`/citizen/cases/${EG(31)}`);
    await expectSlaLevel(citizen, 'paused');
    await expect(citizen.getByTestId('fix-deadline')).toHaveAttribute('data-iso', T('2026-12-09T11:00:00'));

    await setClock(hook, T('2026-12-03T10:00:00'));
    const citizen2 = await asCitizen(browser, SOMCHAI);
    await uiSubmitFix(citizen2, EG(31));
    await expect(citizen2.getByTestId('case-status')).toHaveText(STATUS_TH.IN_REVIEW);
    const c = await getCase(citizen2.request, EG(31));
    expect(c.dueAt).toBe(T('2026-12-08T16:30:00'));
    await expect(citizen2.getByTestId('sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
    await expect(citizen2.getByTestId('sla-due')).toHaveAttribute('data-iso', T('2026-12-08T16:30:00'));
    await expectSlaLevel(citizen2, 'normal');

    const officer2 = await asStaff(browser, 'off.reg1');
    await officer2.goto(`/officer/cases/${EG(31)}`);
    await expect(officer2.getByTestId('case-owner')).toHaveText('off.reg1');
  });

  await test.step('ส่วน 2: seed …000017 ส่งแก้ 1 ธ.ค. 09:00 → 1 ธ.ค. 16:30', async () => {
    const { page } = await fresh(browser);
    await loginCitizen(page, SOMCHAI);
    await page.goto(`/citizen/cases/${EG(17)}`);
    await expectSlaLevel(page, 'paused');
    await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', T('2026-11-27T16:30:00'));
    await uiSubmitFix(page, EG(17));
    await expect(page.getByTestId('case-status')).toHaveText(STATUS_TH.IN_REVIEW);
    expect((await getCase(page.request, EG(17))).dueAt).toBe(T('2026-12-01T16:30:00'));
    await expectSlaLevel(page, 'near');
    expect((await getCase(await staffApi('off.reg1'), EG(17))).owner).toBe('off.reg1');
  });

  await test.step('ส่วน 3: ส่งแก้ …000017 เมื่อ 4 ธ.ค. 10:00 → 4 ธ.ค. 16:30', async () => {
    const { api: hook } = await fresh(browser);
    await setClock(hook, T('2026-12-04T10:00:00'));
    const page = await asCitizen(browser, SOMCHAI);
    const res = await expectStatus(await page.request.post(`/api/cases/${EG(17)}/resubmit`), 200);
    expect(res.status).toBe('IN_REVIEW');
    expect(res.dueAt).toBe(T('2026-12-04T16:30:00'));
    expect((await getCase(page.request, EG(17))).dueAt).toBe(T('2026-12-04T16:30:00'));
    await page.goto(`/citizen/cases/${EG(17)}`);
    await expectSlaLevel(page, 'near');
  });

  await test.step('ส่วน 4: ตีกลับและส่งแก้วันเดียวกัน → dueAt ไม่เลื่อน', async () => {
    const { api: hook } = await fresh(browser);
    await newPaid(hook, { serviceId: 'SV-01', at: T('2026-12-01T09:00:00') });
    await setClock(hook, T('2026-12-02T09:00:00'));
    const reg1 = await staffApi('off.reg1');
    await expectStatus(await reg1.post(`/api/officer/cases/${EG(31)}/claim`), 200);
    expect((await expectStatus(await reg1.post(`/api/officer/cases/${EG(31)}/return`, { data: { reason: 'xxxxxxxxxx' } }), 200)).status).toBe(
      'NEED_FIX',
    );
    await setClock(hook, T('2026-12-02T15:00:00'));
    const somchai = await citizenApi(SOMCHAI);
    const res = await expectStatus(await somchai.post(`/api/cases/${EG(31)}/resubmit`), 200);
    expect(res.dueAt).toBe(T('2026-12-04T16:30:00'));
    expect((await getCase(somchai, EG(31))).dueAt).toBe(T('2026-12-04T16:30:00'));
  });

  await test.step('ส่วน 5: คร่อมสุดสัปดาห์/วันหยุด ส่งแก้หลัง 16:30 → 8 ธ.ค. เกินกำหนด', async () => {
    const { api: hook } = await fresh(browser);
    await newPaid(hook, { serviceId: 'SV-01', at: T('2026-12-01T09:00:00') });
    await setClock(hook, T('2026-12-04T10:00:00'));
    const reg1 = await staffApi('off.reg1');
    await expectStatus(await reg1.post(`/api/officer/cases/${EG(31)}/claim`), 200);
    await expectStatus(await reg1.post(`/api/officer/cases/${EG(31)}/return`, { data: { reason: 'xxxxxxxxxx' } }), 200);
    await setClock(hook, T('2026-12-08T17:00:00'));
    const page = await asCitizen(browser, SOMCHAI);
    const res = await expectStatus(await page.request.post(`/api/cases/${EG(31)}/resubmit`), 200);
    expect(res.dueAt).toBe(T('2026-12-08T16:30:00'));
    const c = await getCase(page.request, EG(31));
    expect(c.dueAt).toBe(T('2026-12-08T16:30:00'));
    expect(c.slaLevel).toBe('overdue');
    await page.goto(`/citizen/cases/${EG(31)}`);
    await expectSlaLevel(page, 'overdue');
  });
});

test('TC-SLA-03 · ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ browser }) => {
  test.setTimeout(300_000);

  const checkAt = async (hook: APIRequestContext, idNo: string, caseNo: string, at: string, level: Level) => {
    await setClock(hook, at);
    const page = await asCitizen(browser, idNo);
    await page.goto(`/citizen/cases/${caseNo}`);
    await expectSlaLevel(page, level, 'sla-level', true);
    expect.soft((await getCase(page.request, caseNo)).slaLevel, `${caseNo} @ ${at}`).toBe(level);
  };

  await test.step('ส่วน A คำขอใหม่ …000031 กำหนด 4 ธ.ค. 16:30', async () => {
    const { api: hook } = await fresh(browser);
    const paid = await newPaid(hook, { serviceId: 'SV-01', at: T('2026-12-01T09:00:00') });
    expect(paid.caseNo).toBe(EG(31));
    for (const [at, level] of [
      [T('2026-12-01T09:00:00'), 'normal'],
      [T('2026-12-02T09:00:00'), 'normal'],
      [T('2026-12-03T09:00:00'), 'near'],
      [T('2026-12-04T16:30:00'), 'near'],
      [T('2026-12-04T16:30:01'), 'overdue'],
      [T('2026-12-04T16:31:00'), 'overdue'],
      [T('2026-12-05T10:00:00'), 'overdue'],
    ] as const) {
      await checkAt(hook, SOMCHAI, EG(31), at, level);
    }
  });

  await test.step('ส่วน B seed …000016 กำหนด 8 ธ.ค. 16:30', async () => {
    const { api: hook } = await fresh(browser);
    for (const [at, level] of [
      [T('2026-12-03T09:00:00'), 'normal'],
      [T('2026-12-04T09:00:00'), 'near'],
      [T('2026-12-08T16:30:00'), 'near'],
      [T('2026-12-08T16:31:00'), 'overdue'],
    ] as const) {
      await checkAt(hook, PITI, EG(16), at, level);
    }
  });

  await test.step('ส่วน C seed ที่ 09:00 (คิว + หน้าเคส)', async () => {
    const { api: hook } = await fresh(browser);
    const reg1 = await asStaff(browser, 'off.reg1');
    const reg2 = await asStaff(browser, 'off.reg2');
    await reg1.goto('/officer/queue');
    const expected: Array<[number, Level, Page]> = [
      [20, 'overdue', reg1],
      [22, 'near', reg1],
      [24, 'near', reg1],
      [25, 'normal', reg2],
    ];
    for (const [n, level] of expected) {
      const row = queueRow(reg1, EG(n));
      await expect.soft(row.getByTestId('row-sla-level'), `queue ${EG(n)}`).toHaveText(LEVEL_TH[level]);
      await expect.soft(row, `queue ${EG(n)}`).toHaveAttribute('data-sla-level', level);
    }
    for (const [n, level, viewer] of expected) {
      await viewer.goto(`/officer/cases/${EG(n)}`);
      await expectSlaLevel(viewer, level, 'sla-level', true);
    }
    await reg1.goto(`/officer/cases/${EG(17)}`);
    await expectSlaLevel(reg1, 'paused', 'sla-level', true);

    const somying = await asCitizen(browser, SOMYING);
    await somying.goto(`/citizen/cases/${EG(1)}`);
    await expectSlaLevel(somying, 'closed', 'sla-level', true);

    for (const [at, level] of [
      [T('2026-12-01T16:30:00'), 'near'],
      [T('2026-12-01T16:31:00'), 'overdue'],
    ] as const) {
      await setClock(hook, at);
      const viewer = await asStaff(browser, 'off.reg1');
      await viewer.goto(`/officer/cases/${EG(22)}`);
      await expectSlaLevel(viewer, level, 'sla-level', true);
    }
  });
});

// ════════════════════════════ 9. NOTI ════════════════════════════

test('TC-NOTI-01 · ผู้รับแจ้งเตือนตามระดับ', async ({ browser }) => {
  const { api: hook } = await fresh(browser); // ยังไม่มี request ใดหลัง reset (/api/test/* ไม่นับ)
  await noti01Flow(browser, hook);
});

test('TC-NOTI-02 · ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ browser }) => {
  test.setTimeout(300_000);

  await test.step('ส่วน A ไม่แจ้งซ้ำ', async () => {
    const { api: hook } = await fresh(browser);
    await noti01Flow(browser, hook);
    for (const [username, count] of [
      ['off.reg1', 4],
      ['head1', 2],
    ] as const) {
      const page = await asStaff(browser, username);
      for (let i = 0; i < 3; i++) await page.goto('/notifications');
      for (let i = 0; i < 3; i++) await expectStatus(await page.request.get('/api/notifications'), 200);
      for (let i = 0; i < 2; i++) await page.goto('/officer/queue');
      await page.goto('/notifications');
      await expect(page.getByTestId('noti-item'), username).toHaveCount(count);
      await expect(page.getByTestId('bell-count'), username).toHaveText(String(count));
      const pairs = await apiNotis(page.request);
      expect(pairs, username).toHaveLength(count);
      expect(new Set(pairs).size, `${username} (คำขอ, ระดับ) ไม่ซ้ำ`).toBe(count);
    }
  });

  await test.step('ส่วน B ข้ามระดับ (request แรก ส. 5 ธ.ค. 10:00)', async () => {
    const { api: hook } = await fresh(browser);
    await setClock(hook, T('2026-12-05T10:00:00'));
    const overdue = (...ns: number[]) => ns.map(n => noti(n, 'overdue'));
    await expectNotifications(browser, 'off.reg1', overdue(20, 22, 23, 24, 28, 29, 30));
    await expectNotifications(browser, 'off.reg2', [...overdue(13, 15, 24, 25, 26, 27, 28, 29, 30), noti(16, 'near')]);
    await expectNotifications(browser, 'off.works1', overdue(10));
    await expectNotifications(browser, 'head1', [...overdue(10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30), noti(11, 'near')]);
  });

  await test.step('ส่วน C ขั้นรออนุมัติและรอออกเอกสาร', async () => {
    const { api: hook } = await fresh(browser);
    const of = async (username: string, n: number) => {
      const api = await staffApi(username); // ล็อกอิน = request ที่กระตุ้นการประเมิน
      return (await apiNotis(api)).filter(p => p.startsWith(`${EG(n)}:`));
    };

    await setClock(hook, T('2026-12-04T09:00:00'));
    expect(await of('head1', 14)).toEqual([noti(14, 'near')]);
    expect(await of('off.reg1', 14)).toEqual([]);
    expect(await of('off.reg2', 14)).toEqual([]);

    await setClock(hook, T('2026-12-04T16:31:00')); // 1
    expect(await of('head1', 14)).toEqual([noti(14, 'near'), noti(14, 'overdue')]);
    expect(await of('off.reg1', 14)).toEqual([]);
    expect(await of('off.reg2', 14)).toEqual([]);

    await setClock(hook, T('2026-12-08T09:00:00')); // 2
    expect(await of('off.reg1', 19)).toEqual([noti(19, 'near')]);
    expect(await of('off.reg2', 19)).toEqual([]);
    expect(await of('head1', 19)).toEqual([]);

    await setClock(hook, T('2026-12-09T16:31:00')); // 3
    expect(await of('off.reg1', 19)).toEqual([noti(19, 'near'), noti(19, 'overdue')]);
    expect(await of('head1', 19)).toEqual([noti(19, 'overdue')]);
  });
});
