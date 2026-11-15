/** config สำหรับ LAB 4: ผลชุดเต็ม + รายงาน HTML + วิดีโอทุก TC (แปลงเป็น GIF เฉพาะ P1) */
import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base,
  reporter: [['list'], ['json', { outputFile: 'test-report/results.json' }], ['html', { outputFolder: 'test-report/html', open: 'never' }]],
  outputDir: 'test-report/artifacts',
  use: { ...base.use, video: { mode: 'on', size: { width: 1024, height: 640 } } },
});