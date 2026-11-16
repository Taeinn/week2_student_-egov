/**
 * Playwright config ของชุดทดสอบเพิ่มเติม (regression ของบั๊กที่แก้นอกชุด TC กลาง 51 ข้อ)
 *
 *   BASE_URL=http://localhost:3000 DB_PATH=./data/egov.db npx playwright test -c playwright.extra.config.ts
 *
 * ค่าอื่นเหมือน playwright.config.ts (ทุก test เรียก /api/test/reset กับเซิร์ฟเวอร์ตัวเดียวกัน → workers = 1)
 */
import { defineConfig } from '@playwright/test';

const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/extra',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/results-extra.json' }]],
  outputDir: 'test-results/artifacts-extra',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
