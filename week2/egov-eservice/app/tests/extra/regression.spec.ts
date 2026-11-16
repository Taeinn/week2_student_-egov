/**
 * Regression ของบั๊กที่พบนอกชุด TC กลาง (tests/specs) · รันด้วย playwright.extra.config.ts
 * แต่ละข้อล้มก่อนแก้ และผ่านหลังแก้
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import { reset, loginStaff, loginCitizen, STAFF_PASSWORD } from '../helpers';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

async function staffApi(username: string) {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const r = await api.post('/api/auth/staff/login', { data: { username, password: STAFF_PASSWORD } });
  expect(r.ok()).toBeTruthy();
  return api;
}

test.describe('extra', () => {
  test('EX-01 · ออกเอกสารแล้วหน้าคำขอยังมีลิงก์ PDF และไทม์ไลน์ (ส่วนเอกสารไม่ปิด </div> เกิน)', async ({ browser }) => {
    // FR-17 · CONTRACT §2.6: หลังออกเอกสาร หน้าเจ้าหน้าที่รีเฟรชในที่ (#officer-view) ต้องยังมีลิงก์ PDF และไทม์ไลน์
    const { context, page } = await reset(browser);
    await loginStaff(page, 'off.reg1');
    await page.goto('/officer/cases/EG-2569-000019'); // A01 · APPROVED · ผู้ออกเอกสาร off.reg1
    await page.getByTestId('issue-btn').click();
    await expect(page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
    const view = page.locator('#officer-view');
    await expect(view.locator('a[href="/api/documents/DOC-2569-000002/pdf"]')).toHaveCount(1);
    await expect(view.getByTestId('case-timeline')).toHaveCount(1);
    await expect(view.getByTestId('timeline-item').last()).toContainText('ออกเอกสาร DOC-2569-000002');
    await context.close();

    // ฝั่งประชาชน: ปุ่มดาวน์โหลดอยู่ในส่วนเอกสาร และไทม์ไลน์อยู่ใน <main> (ไม่หลุดออกนอกโครงหน้า)
    const c = await browser.newContext({ baseURL: BASE });
    const cp = await c.newPage();
    await loginCitizen(cp, '3100600987659'); // สมหญิง = ผู้ยื่น …000019
    await cp.goto('/citizen/cases/EG-2569-000019');
    await expect(cp.locator('section[aria-labelledby="doc-heading"] [data-testid="download-doc-btn"]')).toHaveCount(1);
    await expect(cp.locator('main [data-testid="case-timeline"]')).toHaveCount(1);
    await c.close();
  });

  test('EX-02 · Dashboard งานในมือรายเจ้าหน้าที่ไม่ขึ้นกับตัวกรองบริการ (A-41)', async ({ browser }) => {
    const { context, page } = await reset(browser);
    const exec = await staffApi('exec1');
    const expected = { 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 }; // TEST-DATA §7.1
    for (const service of ['ALL', 'SV-01', 'SV-02', 'SV-03']) {
      const r = await exec.get(`/api/dashboard?period=2026-12&service=${service}`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      const workload = Object.fromEntries(body.workload.map((w: { username: string; count: number }) => [w.username, w.count]));
      expect(workload, `service=${service}`).toEqual(expected);
    }
    // จอ: เปลี่ยน service-select แล้วตัวเลขงานในมือเท่าเดิม
    await loginStaff(page, 'exec1');
    await page.goto('/dashboard?period=2026-12&service=SV-03');
    await expect(page.locator('[data-testid="workload-row"][data-username="off.reg2"] [data-testid="workload-value"]')).toHaveText('9');
    await expect(page.locator('[data-testid="workload-row"][data-username="off.reg1"] [data-testid="workload-value"]')).toHaveText('3');
    await exec.dispose();
    await context.close();
  });

  test('EX-03 · URL ที่ %-encoding เสียตอบ 400 ไม่ใช่ 500 (A-38)', async ({ browser }) => {
    const { context, page, api } = await reset(browser);
    const anon = await pwRequest.newContext({ baseURL: BASE });
    for (const p of ['/verify/%', '/verify/%E0', '/api/verify/%E0%A4%A']) {
      const r = await anon.get(p);
      expect(r.status(), p).toBe(400);
    }
    const admin = await staffApi('admin1');
    const del = await admin.delete('/api/admin/holidays/%');
    expect(del.status()).toBe(400);
    expect((await del.json()).code).toBe('BAD_REQUEST');
    // หน้า HTML: ไม่ใช่หน้า 500
    const resp = await page.goto('/verify/%E0');
    expect(resp?.status()).toBe(400);
    await Promise.all([anon.dispose(), admin.dispose(), api.dispose()]);
    await context.close();
  });

  test('EX-04 · เหตุผลตีกลับ/ไม่อนุมัติ/แสดงเลขเต็มที่ไม่ใช่ข้อความถูกปฏิเสธ (BR-19 · A-32)', async ({ browser }) => {
    const { context } = await reset(browser);
    const reg1 = await staffApi('off.reg1');
    // …000020 IN_REVIEW ผู้ถือ off.reg1 (SV-01)
    const ret = await reg1.post('/api/officer/cases/EG-2569-000020/return', { data: { reason: { text: 'xxxxxxxxxxxx' } } });
    expect(ret.status()).toBe(400);
    expect((await ret.json()).code).toBe('REASON_TOO_SHORT');
    const rej = await reg1.post('/api/cases/EG-2569-000020/reject', { data: { reason: ['ไม่ผ่านเกณฑ์', 'xxxxxxxx'] } });
    expect(rej.status()).toBe(400);
    expect((await rej.json()).code).toBe('REASON_TOO_SHORT');
    const un = await reg1.post('/api/officer/cases/EG-2569-000020/unmask', { data: { reason: { a: 1 } } });
    expect(un.status()).toBe(400);
    expect((await un.json()).code).toBe('REASON_REQUIRED');
    const fwd = await reg1.post('/api/officer/cases/EG-2569-000013/forward', { data: { note: { a: 1 } } }); // off.reg2 ถือ → 403 ก็พอ
    expect(fwd.status()).toBe(403);
    // ยังเป็น IN_REVIEW และไม่มี "[object Object]" ใน Audit
    const c = await reg1.get('/api/cases/EG-2569-000020');
    expect((await c.json()).status).toBe('IN_REVIEW');
    const aud = await staffApi('audit1');
    const items = (await (await aud.get('/api/audit')).json()).items as Array<{ detail: string }>;
    expect(items.some((i) => i.detail.includes('[object Object]'))).toBe(false);
    // ข้อความปกติยังใช้ได้
    const ok = await reg1.post('/api/officer/cases/EG-2569-000020/return', { data: { reason: 'xxxxxxxxxx' } });
    expect(ok.status()).toBe(200);
    await Promise.all([reg1.dispose(), aud.dispose()]);
    await context.close();
  });
});
