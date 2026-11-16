/**
 * ถ่ายภาพหน้าจอทุกหน้าหลัก (desktop 1280 + mobile 375) เพื่อตรวจ UI ด้วยตา
 *   BASE_URL=http://localhost:3000 node scripts/ui-shots.cjs [โฟลเดอร์ผล]
 * ต้องเปิดเว็บด้วย TEST_MODE=1 (สคริปต์เรียก /api/test/reset ก่อนและหลัง)
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const B = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.resolve(process.argv[2] || 'test-results/ui-shots');
const PW = 'Test@1234';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  await fetch(`${B}/api/test/reset`, { method: 'POST' });
  const errors = [];

  const snap = async (page, name) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); // กัน header แบบ sticky ไปโผล่กลางภาพ fullPage
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  };
  const open = async (ctx, url, name, width = 1280) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console ${m.text()}`); });
    await page.setViewportSize({ width, height: width < 500 ? 740 : 860 });
    const res = await page.goto(B + url);
    await snap(page, name);
    return { page, status: res && res.status() };
  };
  const both = async (ctx, url, name) => {
    const d = await open(ctx, url, name); await d.page.close();
    const m = await open(ctx, url, `${name}.m`, 375); await m.page.close();
  };
  const staff = async (username) => {
    const ctx = await browser.newContext();
    const r = await ctx.request.post(`${B}/api/auth/staff/login`, { data: { username, password: PW } });
    if (!r.ok()) errors.push(`login ${username}: ${r.status()}`);
    return ctx;
  };
  const citizen = async (idNo) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${B}/login`);
    await page.getByTestId('login-tab-citizen').click();
    await page.getByTestId('thaid-id-input').fill(idNo);
    await page.getByTestId('thaid-submit').click();
    await page.getByTestId('otp-input').fill('123456');
    await page.getByTestId('otp-submit').click();
    await page.waitForURL(/\/citizen/);
    await page.close();
    return ctx;
  };

  // ── ไม่ล็อกอิน ──
  let ctx = await browser.newContext();
  await both(ctx, '/login', '01-login-citizen');
  for (const w of [1280, 375]) {
    const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: 860 });
    await p.goto(`${B}/login`); await p.getByTestId('login-tab-staff').click(); await snap(p, `02-login-staff${w < 500 ? '.m' : ''}`);
    await p.getByTestId('login-tab-citizen').click();
    await p.getByTestId('thaid-id-input').fill('1101700123456'); await p.getByTestId('thaid-submit').click();
    await p.getByTestId('otp-input').waitFor(); await snap(p, `03-login-otp${w < 500 ? '.m' : ''}`);
    await p.getByTestId('otp-input').fill('000000'); await p.getByTestId('otp-submit').click();
    await p.waitForTimeout(400); await snap(p, `04-login-otp-wrong${w < 500 ? '.m' : ''}`);
    await p.close();
  }
  await fetch(`${B}/api/test/reset`, { method: 'POST' });
  { // หน้าลงทะเบียนจริง: ล็อกอินด้วยเลขบัตรที่ยังไม่ลงทะเบียน (มานะ)
    const rc = await browser.newContext();
    await rc.request.post(`${B}/api/auth/thaid/start`, { data: { idNo: '5500400111221' } });
    await rc.request.post(`${B}/api/auth/thaid/verify`, { data: { idNo: '5500400111221', otp: '123456' } });
    await both(rc, '/register', '05-register');
    await rc.close();
  }
  await both(ctx, '/verify/K7M2Q9XA', '06-verify-ok');
  await both(ctx, '/verify/ZZZZZZZZ', '07-verify-notfound');
  await ctx.close();

  // ── ประชาชน ──
  ctx = await citizen('1101700123456');
  await both(ctx, '/citizen', '10-citizen-home');
  await both(ctx, '/citizen/new/SV-01', '11-wizard-sv01');
  await both(ctx, '/citizen/new/SV-03', '12-wizard-sv03');
  for (const [c, n] of [['EG-2569-000005', '13-case-completed'], ['EG-2569-000017', '14-case-needfix'], ['EG-2569-000020', '15-case-overdue'], ['EG-2569-000009', '16-case-cancelled'], ['EG-2569-000030', '17-case-submitted']]) await both(ctx, `/citizen/cases/${c}`, n);
  for (const w of [1280, 375]) { // กล่องยืนยันยกเลิกคำขอ
    const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: 860 });
    await p.goto(`${B}/citizen/cases/EG-2569-000030`);
    const b = p.getByTestId('cancel-case-btn'); if (await b.count()) { await b.click(); await p.waitForTimeout(300); }
    await p.screenshot({ path: path.join(OUT, `14b-case-cancel-dialog${w < 500 ? '.m' : ''}.png`) }); await p.close();
  }
  await both(ctx, '/citizen/cases/EG-2569-999999', '18-case-404');
  await both(ctx, '/officer/queue', '19-forbidden');
  // wizard: กรอก → ขั้น 2 → ขั้น 3 (ถ้าไปได้)
  for (const w of [1280, 375]) {
    const sfx = w < 500 ? '.m' : '';
    const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: 860 });
    try {
      await p.goto(`${B}/citizen/new/SV-01`);
      await p.getByTestId('qty-input').fill('2');
      await p.waitForTimeout(300); await snap(p, `20-wizard-step1-filled${sfx}`);
      await p.getByTestId('to-upload-btn').click(); await p.waitForTimeout(500); await snap(p, `21-wizard-step2${sfx}`);
    } catch (e) { errors.push(`wizard${sfx}: ${e.message.split('\n')[0]}`); await snap(p, `2x-wizard-error${sfx}`); }
    await p.close();
  }
  // เปิดร่างรอชำระ (DR-0002)
  for (const w of [1280, 375]) {
    const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: 860 });
    try { await p.goto(`${B}/citizen`); await p.getByText('เปิดร่าง DR-0002').click(); await p.waitForTimeout(600); await snap(p, `22-wizard-pay${w < 500 ? '.m' : ''}`); }
    catch (e) { errors.push(`pay: ${e.message.split('\n')[0]}`); }
    await p.close();
  }
  await ctx.close();

  // ── เจ้าหน้าที่ / หัวหน้า ──
  ctx = await staff('off.reg1');
  await both(ctx, '/officer/queue', '30-queue');
  await both(ctx, '/officer/cases/EG-2569-000020', '31-officer-case-mine');
  // หน้าคำขอ: เปิดฟอร์มแสดงเลขเต็ม/ไม่อนุมัติ/ตีกลับ แล้วกดยืนยันว่าง ๆ ให้เห็นข้อความผิดพลาด
  for (const w of [1280, 375]) {
    const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: 860 });
    await p.goto(`${B}/officer/cases/EG-2569-000020`);
    for (const t of ['show-full-id-btn', 'reject-btn', 'return-btn']) { const b = p.getByTestId(t); if (await b.count()) await b.click(); }
    for (const t of ['unmask-submit', 'return-submit']) { const b = p.getByTestId(t); if (await b.count()) await b.click(); }
    await p.waitForTimeout(400); await snap(p, `31b-officer-case-forms${w < 500 ? '.m' : ''}`); await p.close();
  }
  await both(ctx, '/officer/cases/EG-2569-000024', '32-officer-case-unclaimed');
  await both(ctx, '/notifications', '33-notifications');
  await ctx.close();
  ctx = await staff('off.works1'); await both(ctx, '/officer/queue', '34-queue-works'); await both(ctx, '/notifications', '35-notifications-empty'); await ctx.close();
  ctx = await staff('head1');
  await both(ctx, '/head/approvals', '40-approvals');
  await both(ctx, '/officer/queue', '41-head-queue');
  await both(ctx, '/officer/cases/EG-2569-000011', '42-head-case');
  await ctx.close();

  // ── ผู้บริหาร / ตรวจสอบ / ผู้ดูแล ──
  ctx = await staff('exec1');
  await both(ctx, '/dashboard', '50-dashboard');
  await both(ctx, '/dashboard?period=2026-11&service=ALL', '51-dashboard-nov');
  await ctx.close();
  ctx = await staff('audit1'); await both(ctx, '/audit', '60-audit'); await ctx.close();
  ctx = await staff('admin1');
  await both(ctx, '/admin/services', '70-admin-services');
  await both(ctx, '/admin/holidays', '71-admin-holidays');
  await both(ctx, '/admin/users', '72-admin-users');
  await ctx.close();

  await fetch(`${B}/api/test/reset`, { method: 'POST' });
  await browser.close();
  console.log(`saved ${fs.readdirSync(OUT).length} files → ${OUT}`);
  if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
})();

