/**
 * Playwright config กลางของโปรเจกต์ (บล็อก B14)
 *
 *   TEST_MODE=1 docker compose up --build -d           # เปิดเว็บ (พอร์ต 3000)
 *   BASE_URL=http://localhost:3000 DB_PATH=./data/egov.db npx playwright test
 *
 * - ทุก TC เรียก POST /api/test/reset กับเซิร์ฟเวอร์ตัวเดียวกัน → workers = 1 และห้าม fullyParallel
 * - BASE_URL ต้องตรงกับ BASE_URL ของเว็บ (TC-DOC-01 ตรวจ doc-qr = <BASE_URL>/verify/<code>)
 * - DB_PATH = ไฟล์ DB ที่ test มองเห็น (docker bind mount ./data → /app/data) ใช้ใน TC-NFR-04
 * - PW_CHROMIUM_PATH (ไม่บังคับ) = ใช้ Chromium ที่มีอยู่ในเครื่องแทนตัวที่ `npx playwright install` ติดตั้ง
 */
import { defineConfig } from '@playwright/test';

const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/specs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
