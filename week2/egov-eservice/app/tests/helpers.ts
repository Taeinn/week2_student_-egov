import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from "@playwright/test"; // LAB 4: ใช้ test.info() บันทึกวิดีโอ
import type { Browser, BrowserContext, Page, APIRequestContext } from '@playwright/test';

export const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';
export const TEST_OTP = '123456';
export const STAFF_PASSWORD = 'Test@1234';

export interface FreshTestSession {
  context: BrowserContext;
  page: Page;
  /** Keep this context for test-hook calls; it carries no application login cookie. */
  api: APIRequestContext;
}

/** Reset server state, discard the old browser context, and return a clean session. */
export async function reset(browser: Browser, baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:3000'): Promise<FreshTestSession> {
  const { request } = await import('@playwright/test');
  const api = await request.newContext({ baseURL });
  const response = await api.post('/api/test/reset');
  if (!response.ok()) throw new Error(`POST /api/test/reset failed: ${response.status()} ${await response.text()}`);
  const body = await response.json();
  if (body.now !== DEFAULT_NOW) throw new Error(`Unexpected reset clock: ${body.now}`);

  const context = await browser.newContext({ baseURL, ...(process.env.PW_VIDEO ? { recordVideo: { dir: test.info().outputDir, size: { width: 1024, height: 640 } } } : {}) });
  return { context, page: await context.newPage(), api };
}

export async function setClock(api: APIRequestContext, now: string): Promise<void> {
  const response = await api.put('/api/test/clock', { data: { now } });
  if (!response.ok()) throw new Error(`PUT /api/test/clock failed: ${response.status()} ${await response.text()}`);
  const body = await response.json();
  if (body.now !== now) throw new Error(`Clock mismatch: expected ${now}, received ${body.now}`);
}

export async function loginCitizen(page: Page, idNo = '1101700123456'): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
  await page.getByTestId('otp-input').fill(TEST_OTP);
  await page.getByTestId('otp-submit').click();
  await page.waitForURL(/\/citizen(?:\/|$)/);
}

export async function loginStaff(page: Page, username: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await page.getByTestId('staff-username').fill(username);
  await page.getByTestId('staff-password').fill(STAFF_PASSWORD);
  await page.getByTestId('staff-submit').click();
  const destinations: Record<string, RegExp> = {
    head1: /\/head\/approvals(?:\?|$)/,
    exec1: /\/dashboard(?:\?|$)/,
    audit1: /\/audit(?:\?|$)/,
    admin1: /\/admin\/services(?:\?|$)/,
  };
  await page.waitForURL(destinations[username] ?? /\/officer\/queue(?:\?|$)/);
}

export async function pay(api: APIRequestContext, ref: string, amount: number): Promise<any> {
  const response = await api.post(`/api/test/payments/${encodeURIComponent(ref)}/pay`, { data: { amount } });
  if (!response.ok()) throw new Error(`Test payment failed: ${response.status()} ${await response.text()}`);
  return response.json();
}

export async function tamper(api: APIRequestContext, docNo: string): Promise<void> {
  const response = await api.post(`/api/test/documents/${encodeURIComponent(docNo)}/tamper`);
  if (!response.ok()) throw new Error(`Document tamper failed: ${response.status()} ${await response.text()}`);
}

/** Generate the exact upload fixtures described in TEST-DATA.md §11. */
export async function make_testfiles(directory = path.resolve(process.cwd(), 'tests/testfiles')): Promise<string[]> {
  await mkdir(directory, { recursive: true });

  const pdf = (size: number): Buffer => {
    const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
    const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const pad = size - head.length - tail.length;
    if (pad < 0) throw new Error(`PDF fixture size too small: ${size}`);
    return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
  };
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const png = (size: number): Buffer => {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrData = Buffer.alloc(13); ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8; ihdrData[9] = 2;
    const ihdr = pngChunk('IHDR', ihdrData);
    const idat = pngChunk('IDAT', Buffer.from([120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0]));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    const base = Buffer.concat([signature, ihdr, idat, iend]);
    const payloadSize = size - base.length - 12;
    if (payloadSize < 2) throw new Error(`PNG fixture size too small: ${size}`);
    return Buffer.concat([signature, ihdr, idat, pngChunk('tEXt', Buffer.concat([Buffer.from([0x6b, 0]), Buffer.alloc(payloadSize - 2, 0x78)])), iend]);
  };
  const jpg = (size: number): Buffer => {
    const soi = Buffer.from([0xff, 0xd8]);
    const app0 = Buffer.from([0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const padding = size - soi.length - app0.length - 6;
    if (padding < 0 || padding + 4 > 0xffff) throw new Error(`JPEG fixture size unsupported: ${size}`);
    const commentLength = Buffer.alloc(2); commentLength.writeUInt16BE(padding + 2);
    return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), commentLength, Buffer.alloc(padding, 0x78), Buffer.from([0xff, 0xd9])]);
  };
  const files = new Map<string, Buffer>();
  for (const name of ['ok-id.pdf', 'id-card.pdf', 'map.pdf', 'plan.pdf', 'deed.pdf', ...Array.from({ length: 6 }, (_, i) => `multi-${i + 1}.pdf`)]) files.set(name, pdf(1024));
  files.set('real.jpg', jpg(1024)); files.set('real.png', png(1024)); files.set('plan-as-jpg.jpg', jpg(1024));
  for (const size of [5242879, 5242880, 5242881]) files.set(`size-${size}.pdf`, pdf(size));
  files.set('fake-text.pdf', Buffer.from('hello')); files.set('fake-text.jpg', Buffer.from('hello'));
  files.set('notes.txt', Buffer.from('hello')); files.set('exe-as.png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]));

  await Promise.all([...files].map(([name, data]) => writeFile(path.join(directory, name), data)));
  for (const [name, expected] of files) {
    const actual = (await stat(path.join(directory, name))).size;
    if (actual !== expected.length) throw new Error(`${name}: expected ${expected.length} bytes, got ${actual}`);
  }
  return (await readdir(directory)).sort().map(name => path.join(directory, name));
}

