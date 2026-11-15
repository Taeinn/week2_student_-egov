'use strict';
/**
 * Test hook (CONTRACT §8 · DECISIONS §15) — ใช้ได้เฉพาะ TEST_MODE=1 (ไม่ตั้ง → 404 ทุกเส้นใต้ /api/test)
 *
 *   POST /api/test/reset  → ล้างทุกตาราง (รวม session ทุกคน, ตัวนับ OTP, การล็อก, แจ้งเตือน, audit, ไฟล์อัปโหลด)
 *                           + seed ใหม่ (src/db/seed.js ถ้ามี) + นาฬิกา = 2026-12-01T09:00:00+07:00
 *                           → 200 {"ok":true,"now":"2026-12-01T09:00:00+07:00"}
 *   GET  /api/test/clock  → 200 {"now":"…"}
 *   PUT  /api/test/clock  {"now":"2026-12-01T16:30:00+07:00"} → 200 {"now":"…"} (แช่แข็ง) · ISO ไม่ถูก/ไม่มี offset → 400 INVALID_TIME
 *
 * (POST /api/test/payments/:ref/pay และ /api/test/documents/:docNo/tamper อยู่ในไฟล์ route ของบล็อกชำระเงิน/เอกสาร)
 */

const express = require('express');
const clock = require('../lib/clock');
const db = require('../db');
const session = require('../lib/session');
const { sendError } = require('../lib/errors');

const router = express.Router();

// กันซ้ำ (server.js ก็กันไว้แล้ว): ไม่ได้ตั้ง TEST_MODE → 404
router.use('/api/test', (req, res, next) => {
  if (!clock.isTestMode()) return sendError(res, 'NOT_FOUND');
  return next();
});

router.post('/api/test/reset', async (req, res, next) => {
  try {
    clock.resetClock();
    await db.resetDatabase(); // DROP ทุกตาราง (sessions ด้วย) → schema.sql → seed.js → reset hooks
    session.clearAll();
    session.logout(req, res); // ล้าง cookie ของผู้เรียกด้วย
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, now: clock.nowIso() });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/test/clock', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ now: clock.nowIso() });
});

router.put('/api/test/clock', (req, res) => {
  const value = req.body && typeof req.body === 'object' ? req.body.now : undefined;
  if (typeof value !== 'string' || !clock.isValidIsoWithOffset(value)) {
    return sendError(res, 'INVALID_TIME');
  }
  const now = clock.setNow(value);
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ now });
});

module.exports = router;
