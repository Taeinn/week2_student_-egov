'use strict';
/**
 * e-Service กลาง เทศบาลนครตัวอย่าง · จุดเริ่มเซิร์ฟเวอร์ (Express 4)
 *
 * ลำดับ middleware:
 *   1. GET /api/health → 200 {"status":"ok"} (ไม่ขึ้นกับ TEST_MODE · ไม่ต้องล็อกอิน)
 *   2. /api/test/* → 404 ถ้าไม่ได้ตั้ง TEST_MODE=1
 *   3. static: public/ ที่ '/' (ไม่มี /img/logo.png → ส่งตราสำรอง SVG แทน ไม่ทำให้หน้าพัง)
 *   4. body parser JSON/urlencoded (limit 10 MB · multipart ให้ route จัดการเอง เช่น multer)
 *   5. session (req.session / req.user)
 *   6. แจ้งเตือน SLA + ยกเลิกอัตโนมัติ: src/lib/notify.js (ถ้ามี) ทุก request ยกเว้น /api/test/*
 *   7. router ทุกไฟล์ใน src/routes/*.js (test.js ก่อน แล้วเรียงตามชื่อไฟล์ · ไฟล์ที่ยังไม่มีก็ข้าม)
 *   8. '/' → redirect /login หรือหน้าตั้งต้นของบทบาท (ถ้าไม่มี route ไหนจัดการก่อน)
 *   9. 404 · 10. error handler (HttpError → JSON ตาม CONTRACT §5 หรือหน้า HTML)
 *
 * รูปแบบไฟล์ route ที่รองรับ (mount ที่ '/' · path ใน router เขียนเต็ม เช่น '/api/cases/:caseNo'):
 *   module.exports = router                         (express.Router())
 *   module.exports = { router, basePath? }          (basePath = prefix ที่จะ mount)
 *   module.exports = function register(app, ctx) {} (ฟังก์ชันรับ app · arity ≤ 2)
 * router แต่ละไฟล์ถูก "แยกขอบเขต": middleware ระดับ root ของ router (router.use(fn) ไม่มี path)
 * จะทำงานเฉพาะ request ที่ router นั้นมี route/prefix ตรง — ไม่ไปกั้น route ของไฟล์อื่น
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const clock = require('./lib/clock');
const { activeBugs } = require('./lib/bugs');
const db = require('./db');
const session = require('./lib/session');
const { HttpError, ERRORS, sendError, errorBody } = require('./lib/errors');
const { LANDING } = require('./lib/constants');
const layout = require('./views/layout');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ROUTES_DIR = path.join(__dirname, 'routes');
const NOTIFY_PATH = path.join(__dirname, 'lib', 'notify.js');

const isApi = (req) => req.path === '/api' || req.path.startsWith('/api/');
const isTestPath = (req) => req.path === '/api/test' || req.path.startsWith('/api/test/');

// ตราสำรอง (ใช้เมื่อยังไม่มี public/img/logo.png)
const FALLBACK_LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="ตราเทศบาลนครตัวอย่าง">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b4fe0"/><stop offset="1" stop-color="#918df6"/></linearGradient></defs>
<circle cx="48" cy="48" r="46" fill="url(#g)"/>
<path d="M48 22 L66 40 H58 V66 H38 V40 H30 Z" fill="#fff"/>
<rect x="44" y="50" width="8" height="16" fill="#5b4fe0"/>
</svg>`;

// ---------------------------------------------------------------------------
// โหลด router แบบ optional
// ---------------------------------------------------------------------------
function isRouter(x) {
  return typeof x === 'function' && Array.isArray(x.stack) && typeof x.handle === 'function';
}

function safeMatch(layer, p) {
  try {
    return layer.match(p);
  } catch (_) {
    return true; // path ผิดรูปแบบ (เช่น %) → ให้ router จัดการเอง
  }
}

/** router นี้มี route หรือ middleware ที่มี path ตรงกับ request หรือไม่ (ไม่นับ middleware ระดับ root) */
function routerWants(router, req, depth = 0) {
  if (depth > 5) return true;
  const p = req.path;
  for (const layer of router.stack || []) {
    if (layer.route) {
      if (safeMatch(layer, p) && layer.route._handles_method(req.method)) return true;
      continue;
    }
    const isRoot = layer.regexp && layer.regexp.fast_slash;
    if (isRoot) {
      if (isRouter(layer.handle) && routerWants(layer.handle, req, depth + 1)) return true;
      continue;
    }
    if (safeMatch(layer, p)) return true;
  }
  return false;
}

function isolate(router) {
  return function isolatedRouter(req, res, next) {
    if (!routerWants(router, req)) return next();
    return router(req, res, next);
  };
}

function routeFiles() {
  if (!fs.existsSync(ROUTES_DIR)) return [];
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('.') && !/\.(self)?test\.js$/.test(f))
    .sort((a, b) => {
      if (a === 'test.js') return -1;
      if (b === 'test.js') return 1;
      return a.localeCompare(b);
    });
}

function mountModule(app, mod, name, ctx) {
  if (mod && mod.__esModule && mod.default) mod = mod.default;
  const base = (mod && (mod.basePath || mod.mountPath || mod.prefix)) || '/';
  if (isRouter(mod)) {
    app.use(base, isolate(mod));
    return 'router';
  }
  if (mod && isRouter(mod.router)) {
    app.use(base, isolate(mod.router));
    return 'router';
  }
  if (mod && typeof mod.register === 'function') {
    mod.register(app, ctx);
    return 'register';
  }
  if (typeof mod === 'function') {
    if (mod.length >= 3) {
      app.use(base, mod);
      return 'middleware';
    }
    mod(app, ctx);
    return 'register';
  }
  if (mod && typeof mod.default === 'function') return mountModule(app, mod.default, name, ctx);
  throw new Error('ไม่ได้ export express.Router() หรือฟังก์ชัน register(app)');
}

function loadRoutes(app, ctx) {
  const loaded = [];
  for (const file of routeFiles()) {
    const full = path.join(ROUTES_DIR, file);
    try {
      const kind = mountModule(app, require(full), file, ctx);
      loaded.push(`${file}(${kind})`);
    } catch (err) {
      console.error(`[routes] ข้าม ${file}: ${err && err.stack ? err.stack : err}`);
    }
  }
  return loaded;
}

/** middleware แจ้งเตือน SLA จาก src/lib/notify.js (ถ้ามี) */
function loadNotifyMiddleware() {
  if (!fs.existsSync(NOTIFY_PATH)) return null;
  let mod;
  try {
    mod = require(NOTIFY_PATH);
  } catch (err) {
    console.error(`[notify] โหลด src/lib/notify.js ไม่ได้: ${err && err.stack ? err.stack : err}`);
    return null;
  }
  if (mod && typeof mod.middleware === 'function') return mod.middleware;
  if (mod && typeof mod.notifyMiddleware === 'function') return mod.notifyMiddleware;
  if (typeof mod === 'function' && mod.length >= 3) return mod;
  const fn = mod && (mod.evaluate || mod.evaluateAll || mod.run);
  if (typeof fn === 'function') {
    return (req, res, next) => {
      fn();
      next();
    };
  }
  console.warn('[notify] src/lib/notify.js ไม่ได้ export middleware(req,res,next) — ข้าม');
  return null;
}

// ---------------------------------------------------------------------------
// สร้างแอป
// ---------------------------------------------------------------------------
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 0. security headers (ทุก response) · หน้าเว็บใช้ <style>/<script> ฝังในหน้า จึงต้องมี 'unsafe-inline'
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });

  // 1. health
  app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok' });
  });

  // 2. test hook เปิดเฉพาะ TEST_MODE=1
  app.use('/api/test', (req, res, next) => {
    if (!clock.isTestMode()) return sendError(res, 'NOT_FOUND');
    return next();
  });

  // 3. static
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  app.get('/img/logo.png', (req, res) => {
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(FALLBACK_LOGO_SVG);
  });
  app.get('/favicon.ico', (req, res) => res.redirect(302, '/img/logo.png'));

  // 4. body parser (≥ 6 MB · CONTRACT §0 ข้อ 10)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // หน้า/API แบบไดนามิกไม่ให้ cache
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // 5. session
  app.use(session.middleware);

  // 6. แจ้งเตือน SLA + ยกเลิกอัตโนมัติ (CONTRACT §0 ข้อ 7)
  const notify = loadNotifyMiddleware();
  if (notify) {
    app.use((req, res, next) => {
      if (isTestPath(req)) return next();
      try {
        return notify(req, res, next);
      } catch (err) {
        console.error('[notify] error:', err && err.stack ? err.stack : err);
        return next();
      }
    });
  }

  // 7. routes
  const ctx = { db, clock, layout };
  const loaded = loadRoutes(app, ctx);
  app.locals.loadedRoutes = loaded;
  app.locals.notifyLoaded = !!notify;

  // 8. '/' (สำรอง ถ้าไม่มีไฟล์ route ไหนจัดการ)
  app.get('/', (req, res) => {
    if (!req.user) return res.redirect(302, '/login');
    if (req.user.role === 'citizen' && req.user.registered === false) return res.redirect(302, '/register');
    return res.redirect(302, LANDING[req.user.role] || '/login');
  });

  // 9. 404
  app.use((req, res) => {
    if (isApi(req)) return sendError(res, 'NOT_FOUND');
    return layout.sendPage(req, res, {
      status: 404,
      title: 'ไม่พบหน้า',
      body: '<h1>ไม่พบหน้าที่ต้องการ</h1><p><a href="/">กลับหน้าหลัก</a></p>',
    });
  });

  // 10. error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let code = 'INTERNAL';
    let extra;
    let message;
    if (err instanceof HttpError || (err && err.name === 'HttpError')) {
      code = err.code;
      extra = err.extra;
      message = err.message;
    } else if (err && (err.type === 'entity.parse.failed' || (err instanceof URIError && err.status === 400))) {
      // JSON ผิดรูปแบบ · URL มี %-encoding เสีย (express: "Failed to decode param") → 400 ไม่ใช่ 500 (A-38)
      code = 'BAD_REQUEST';
    } else if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      code = 'PAYLOAD_TOO_LARGE';
    } else if (err && err.code && err.code === 'INVALID_TIME') {
      code = 'INVALID_TIME';
    } else {
      console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
    }
    if (res.headersSent) return res.end();
    const body = errorBody(code, extra, message);
    const status = (err && err.name === 'HttpError' && err.status) || (ERRORS[code] || {}).status || 500;
    if (isApi(req) || (req.headers.accept || '').includes('application/json')) {
      return res.status(status).json(body);
    }
    if (status === 403) return layout.sendForbidden(req, res);
    if (status === 404) return layout.sendNotFound(req, res);
    return layout.sendPage(req, res, {
      status,
      title: 'เกิดข้อผิดพลาด',
      error: body.message,
      body: '<h1>เกิดข้อผิดพลาด</h1><p><a href="/">กลับหน้าหลัก</a></p>',
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// เริ่มเซิร์ฟเวอร์
// ---------------------------------------------------------------------------
async function start() {
  await db.initDatabase();
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    const bugs = [...activeBugs()];
    console.log(
      `[egov] http://${host}:${port} · TEST_MODE=${clock.isTestMode() ? '1' : 'off'} · BUG_MODE=${bugs.length ? bugs.join(',') : '-'}`
        + ` · DB_PATH=${db.DB_PATH} · now=${clock.nowIso()}`
    );
    console.log(`[egov] routes: ${app.locals.loadedRoutes.join(' ') || '-'} · notify: ${app.locals.notifyLoaded ? 'on' : 'none'}`);
  });
  server.requestTimeout = 120000;
  const shutdown = (sig) => {
    console.log(`[egov] ${sig} → ปิดเซิร์ฟเวอร์`);
    server.close(() => {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[egov] เริ่มเซิร์ฟเวอร์ไม่สำเร็จ:', err);
    process.exit(1);
  });
}

module.exports = { createApp, start };
