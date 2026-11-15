# INTEGRATION · บล็อก B14 รวมระบบ + Playwright เต็ม + BUG_MODE ทีละตัว

> ทำโดย B14 (yolo2) · 15 พ.ย. 2569 · ทำงานเฉพาะใน `app/` · อ้างอิง `BUGS.md` §2–§5, `TEST-PLAN.md`, `CONTRACT.md`, `DECISIONS.md` §18
> ผลดิบทุกรอบ: `test-results/matrix/` (รอบสุดท้าย) และ `test-results/matrix-r1/` (รอบแรกก่อนแก้ test) · ไฟล์ละโหมด `<โหมด>.log` `<โหมด>.json` `<โหมด>.serverlog`

## 0. สรุป

> เติมหลังจบ run (16 พ.ย. 2569) · B14 ชน timeout 3600 วิ หลังรันเมทริกซ์ครบแต่ก่อนเขียนส่วนสรุป · ตัวเลขทั้งหมดมาจาก `test-results/matrix/*.json` (`node scripts/summarize.cjs`)

- เว็บถูกต้อง (`TEST_MODE=1` ไม่มีบั๊ก): **51/51 ผ่าน** 3 รอบ (clean · clean-rerun ไม่ restart · clean-final หลังปิดบั๊ก)
- BUG_MODE B01–B12 ทีละตัว: **จับได้ 12/12** · TC ที่ BUGS.md §2 ระบุว่าต้องล้ม ล้มจริงทุกตัว · ไม่มี TC ที่ควรล้มแต่ผ่าน
- รวมบั๊ก `B03,B07` และ `B01,B05,B09`: ล้มเท่ากับ union ของแต่ละตัว ✅
- ล้มเกินที่คาด 1 จุด: B03 → TC-NOTI-02 (กลไกเดียวกับ TC-SLA-03 · Q-TA-1) แสดงเป็น ✅*
- ทุกข้อที่ล้มเป็น assert ค่าต่าง (Expected/Received) ไม่มี timeout หรือหา element ไม่เจอ (หลังแก้ T1)
- สิ่งที่แก้: เว็บ 2 (W1 W2) · test 2 (T1 T2) · โจทย์ 0 (คำถาม TA 3 ข้อ) · ไม่มีการแก้ผลที่คาดหวังให้ตรงหน้าจอ

## 1. วิธีรัน (คำสั่งเดียว)

```bash
# เว็บ: Docker Compose คำสั่งเดียว (พอร์ต 3000 · DB = ./data/egov.db ผ่าน bind mount)
TEST_MODE=1 docker compose up --build -d            # หรือ TEST_MODE=1 BUG_MODE=B03 docker compose up --build -d

# ชุดทดสอบ (devDependencies อยู่ใน package.json แล้ว)
npm ci
npx playwright install chromium                     # หรือ export PW_CHROMIUM_PATH=<chromium ที่มีในเครื่อง>
BASE_URL=http://localhost:3000 DB_PATH=$PWD/data/egov.db npx playwright test

# เมทริกซ์ BUG_MODE (restart เว็บด้วย docker compose ทีละโหมด แล้วสรุปเทียบ BUGS.md §2)
scripts/bug-matrix.sh                                 # clean B01 … B12 (13 รอบ)
NO_RESTART=1 scripts/bug-matrix.sh clean-rerun        # รันซ้ำทันทีโดยไม่ restart (BUGS.md §3 ขั้น 2)
scripts/bug-matrix.sh B03,B07 B01,B05,B09 clean-final # รวมบั๊ก (ขั้น 5) + ปิดบั๊กอีกครั้ง (ขั้น 6)
node scripts/summarize.cjs test-results/matrix/*.json # สรุปซ้ำจากไฟล์ JSON
```

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `BASE_URL` | ที่อยู่เว็บที่ test ยิง · ต้องตรง `BASE_URL` ของเว็บ (TC-DOC-01 ตรวจ `doc-qr` = `<BASE_URL>/verify/<code>`) · compose ตั้ง `http://localhost:3000` |
| `DB_PATH` | ไฟล์ DB ที่ฝั่ง test อ่านได้ (TC-NFR-04) = `./data/egov.db` บน host (ใน container = `/app/data/egov.db`) |
| `NO_TEST_MODE_BASE_URL` | อินสแตนซ์ที่ **ไม่** ตั้ง `TEST_MODE` สำหรับ TC-NFR-03 ส่วน "ปิด hook" · `bug-matrix.sh` เปิดคอนเทนเนอร์ `egov-notest` (image เดียวกัน พอร์ต 3001 DB แยกใน `/tmp` ของคอนเทนเนอร์) ให้เอง |
| `PW_CHROMIUM_PATH` | (ไม่บังคับ) ใช้ Chromium ที่มีในเครื่อง · เครื่องนี้มี `/ms-playwright/chromium_headless_shell-1252` แต่ `@playwright/test` 1.65.1 ต้องการ r1255 จึงชี้ executable ตรง |

สภาพแวดล้อมที่ใช้รัน: Docker 29.9.3 · Compose v5.7.0 · Node ใน container v20.20.2 · `@playwright/test` 1.65.1 · Chromium 157.0.8103.15 (headless shell) · `@axe-core/playwright` 4.14.0 + `axe-core` 4.14.0 (ของจริง ไม่ใช่ stub) · `typescript` 7.0.2 (`npx tsc -p tsconfig.json` ผ่าน) · `workers: 1` (ทุก TC เรียก reset บนเซิร์ฟเวอร์ตัวเดียวกัน)

## 2. ผลรอบสุดท้าย (โค้ดสุดท้าย · ทุกโหมด restart เว็บด้วย `docker compose up --force-recreate`)

| โหมด | passed | failed | TC ที่ล้มจริง | ล้มเกินที่คาด | ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|---|
| B01,B05,B09 | 48 | 3 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | ✅ |
| B01 | 50 | 1 | TC-FEE-01 | – | – | ✅ |
| B02 | 50 | 1 | TC-UPLOAD-01 | – | – | ✅ |
| B03,B07 | 45 | 6 | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | TC-NOTI-02 (กลไกเดียวกัน · รอ TA) | – | ✅* |
| B03 | 46 | 5 | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-04 | TC-NOTI-02 (กลไกเดียวกัน · รอ TA) | – | ✅* |
| B04 | 50 | 1 | TC-SLA-02 | – | – | ✅ |
| B05 | 50 | 1 | TC-PAY-01 | – | – | ✅ |
| B06 | 50 | 1 | TC-RBAC-01 | – | – | ✅ |
| B07 | 50 | 1 | TC-RBAC-02 | – | – | ✅ |
| B08 | 50 | 1 | TC-QUEUE-02 | – | – | ✅ |
| B09 | 50 | 1 | TC-PDPA-02 | – | – | ✅ |
| B10 | 48 | 3 | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | ✅ |
| B11 | 49 | 2 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ |
| B12 | 50 | 1 | TC-WORKFLOW-04 | – | – | ✅ |
| clean-final | 51 | 0 | – | – | – | ✅ |
| clean-rerun | 51 | 0 | – | – | – | ✅ |
| clean | 51 | 0 | – | – | – | ✅ |

## 3. ตาราง triage ตาม BUGS.md §4 (รอบสุดท้าย)

| บั๊ก | ผลรัน (assert แรกที่ล้ม) | สรุป |
|---|---|---|
| B01 | 50/1 · TC-FEE-01 `fee-total` พื้นที่ 101 expected `฿1,010` received `฿1,000` | ✅ ตรงจุด |
| B02 | 50/1 · TC-UPLOAD-01 `file-item` (5,242,880 ไบต์) expected 1 received 0 | ✅ ตรงจุด |
| B03 | 46/5 · TC-SLA-01 แถว c `dueAt` expected `2026-12-08T16:30` received `2026-12-07T16:30` · TC-SLA-02 · TC-SLA-03 `ใกล้ครบกำหนด`→`ปกติ` · TC-RBAC-04 · TC-NOTI-02 `noti-item` 10→9 | ✅* SLA-03 RBAC-04 อยู่ในรายการ "อาจล้มด้วย" · NOTI-02 กลไกเดียวกัน (Q-TA-1) |
| B04 | 50/1 · TC-SLA-02 `dueAt` expected `2026-12-08T16:30` received `2026-12-04T16:30` | ✅ ตรงจุด |
| B05 | 50/1 · TC-PAY-01 ชำระที่อายุ 15:00 expected 410 received 200 `PAID` | ✅ ตรงจุด |
| B06 | 50/1 · TC-RBAC-01 เปิดคำขอคนอื่น expected 404 received 200 | ✅ ตรงจุด |
| B07 | 50/1 · TC-RBAC-02 `off.reg2` approve `…000014` expected 403 received 200 | ✅ ยิง API ตรง (ไม่ผ่านหลอก) |
| B08 | 50/1 · TC-QUEUE-02 claim พร้อมกัน expected `[200, 409]` received `[200, 200]` | ✅ หลังแก้ T1 (รอบ 1 ล้มด้วยหา element ไม่เจอ ⚠️) |
| B09 | 50/1 · TC-PDPA-02 `/api/officer/queue` พบเลข 13 หลัก 19 ค่า expected `[]` | ✅ ตรงจุด |
| B10 | 48/3 · TC-DASH-02 พ.ย. expected `85.7%` received `23.1%` · TC-DASH-01 ธ.ค. `–`→`0.0%` · TC-DASH-03 | ✅ ล้มเกินอยู่ในรายการ "อาจล้มด้วย" |
| B11 | 49/2 · TC-PDPA-03 `audit-count` expected 1 received 0 · TC-AUDIT-01 16→15 | ✅ ตรงจุด |
| B12 | 50/1 · TC-WORKFLOW-04 `return-btn` expected 0 received 1 | ✅ ตรงจุด |

## 4. ประวัติการรันก่อนได้โค้ดสุดท้าย

| รอบ | โค้ด | ผล | สิ่งที่พบ → แก้ |
|---|---|---|---|
| รอบ 0 (`TEST_MODE=1` ไม่มีบั๊ก) | ตามที่บล็อก B01–B13 ส่งมา + config/devDeps ของ B14 | **50/51** · ล้ม TC-DASH-03 `ไม่พบคำขอดาวน์โหลดที่ตรง /export…/` (รอ 20 วิ) | ปุ่มส่งออกเป็น `<a download>` → แก้เว็บ (ข้อ W1) |
| matrix รอบ 1 · clean / clean-rerun | + W1 + W2 | **51/51 · 51/51** | – |
| matrix รอบ 1 · B01–B12 | เหมือนบรรทัดบน | 12/12 บั๊ก TC ที่ต้องล้ม ล้มจริง · ดู `test-results/matrix-r1/summary.txt` | B03 ล้มเกิน TC-NOTI-02 → ตรวจแล้วเป็นกลไกเดียวกับที่ BUGS/DECISIONS อธิบาย (คำถาม TA ข้อ 1 · ไม่แก้) · B08 ล้มด้วย `element(s) not found` ของ `action-error` แทนค่าต่าง → แก้ test (ข้อ T1) แล้วรันใหม่ทั้งเมทริกซ์ (ข้อ 2) |

ตาราง matrix รอบ 1 (ก่อนแก้ T1):

| โหมด | passed | failed | TC ที่ล้มจริง | ล้มเกินที่คาด | ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|---|
| clean | 51 | 0 | – | – | – | ✅ |
| clean-rerun | 51 | 0 | – | – | – | ✅ |
| B01 | 50 | 1 | TC-FEE-01 | – | – | ✅ |
| B02 | 50 | 1 | TC-UPLOAD-01 | – | – | ✅ |
| B03 | 46 | 5 | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-04 | TC-NOTI-02 (กลไกเดียวกัน · รอ TA) | – | ✅* |
| B04 | 50 | 1 | TC-SLA-02 | – | – | ✅ |
| B05 | 50 | 1 | TC-PAY-01 | – | – | ✅ |
| B06 | 50 | 1 | TC-RBAC-01 | – | – | ✅ |
| B07 | 50 | 1 | TC-RBAC-02 | – | – | ✅ |
| B08 | 50 | 1 | TC-QUEUE-02 | – | – | ⚠️ |
| B09 | 50 | 1 | TC-PDPA-02 | – | – | ✅ |
| B10 | 48 | 3 | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | ✅ |
| B11 | 49 | 2 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ |
| B12 | 50 | 1 | TC-WORKFLOW-04 | – | – | ✅ |
| clean | 51 / 0 | – | – | – | – | ✅ |
| clean-rerun | 51 / 0 | – | – | – | – | ✅ |
| B01 | 50 / 1 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ |
| B02 | 50 / 1 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ |
| B03 | 46 / 5 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-04 | TC-NOTI-02 (กลไกเดียวกัน · Q-TA-1) | – | ✅* |
| B04 | 50 / 1 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ |
| B05 | 50 / 1 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ |
| B06 | 50 / 1 | TC-RBAC-01 | TC-RBAC-01 | – | – | ✅ |
| B07 | 50 / 1 | TC-RBAC-02 (อาจล้มด้วย TC-WORKFLOW-01) | TC-RBAC-02 | – | – | ✅ |
| B08 | 50 / 1 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | ⚠️ |
| B09 | 50 / 1 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ |
| B10 | 48 / 3 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | ✅ |
| B11 | 49 / 2 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ |
| B12 | 50 / 1 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ |

(ข้อความ assert ของรอบนี้ทั้งหมด: `test-results/matrix-r1/summary.md` · รอบนี้ยังไม่ได้ตั้ง `NO_TEST_MODE_BASE_URL`)

## 5. สิ่งที่แก้ แยกตามประเภท

ไม่มีการแก้ "ผลที่คาดหวัง" ใน test ให้ตรงหน้าจอ · ไม่มีการแก้ seed หรือตัวเลขกฎ

### 5.1 เว็บ

| # | อาการ | สาเหตุ | แก้ | ไฟล์ |
|---|---|---|---|---|
| W1 | TC-DASH-03 ล้ม: test หา response ของไฟล์ส่งออกไม่เจอ จึงตรวจ `Content-Type: application/pdf` และเนื้อไฟล์ไม่ได้ | ปุ่ม `export-xlsx-btn`/`export-pdf-btn` เป็น `<a href download>` · ทดลองแล้ว (Chromium + Playwright 1.65.1) การคลิก `<a download>` เกิดแค่ event `download` **ไม่มี** `request`/`response`/`route` เลย จึงไม่มี header ให้ตรวจ ขณะที่ปุ่มดาวน์โหลดอีก 2 จุดในเว็บเดียวกัน (`audit-export-csv-btn` ของ B10 · `download-doc-btn` ของ B07) ใช้ fetch + blob อยู่แล้ว | ปุ่มส่งออก Dashboard ใช้ fetch + blob แบบเดียวกัน (ชื่อไฟล์จาก `Content-Disposition` · ผิดพลาด → `App.showError`) · `href` ยังอยู่เป็น fallback เมื่อไม่มี JS · ตัวเลข/ไฟล์/audit `EXPORT` ไม่เปลี่ยน | `src/routes/dashboard.js` (`PAGE_SCRIPT`) |
| W2 | ความเสี่ยงผลสุ่มใน TC-NOTI-01/02 (B08 แจ้งไว้บนกระดาน) | `HEALTHCHECK` ของ Docker ยิง `GET /api/health` ทุก 10 วิ และ CONTRACT §0.7 / A-30 ให้ทุก request ยกเว้น `/api/test/*` ประเมินแจ้งเตือน → ถ้า probe ตกช่วงระหว่าง `POST /api/test/reset` กับ `PUT /api/test/clock` จะสร้างแจ้งเตือนตามนาฬิกา 09:00 และ TC ที่ตรวจ "request แรกหลัง reset" ล้มแบบสุ่ม (ยังไม่เคยเห็นล้มจริง แต่รันเมทริกซ์ 17 รอบ × หลาย TC ต่อรอบ) | healthcheck เปลี่ยนเป็นเปิด TCP ไปที่พอร์ตเว็บเท่านั้น (ไม่ส่ง HTTP request จึงไม่กระทบสถานะ) + `--start-interval=1s` ให้ `docker compose up --wait` พร้อมใน ~2 วิ · `/api/health` ยังตอบ `{"status":"ok"}` ตาม CONTRACT §6.6 (TC-NFR-03 ผ่าน) | `Dockerfile` |

### 5.2 test

| # | อาการ | สาเหตุ (เทียบการ์ด) | แก้ | ไฟล์ |
|---|---|---|---|---|
| T1 | เปิด `BUG_MODE=B08` แล้ว TC-QUEUE-02 ล้มด้วย `expect(getByTestId('action-error')).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว')` → `element(s) not found` (BUGS.md §5: ล้มเพราะหา element ไม่เจอ = test เปราะ) | การ์ด TC-QUEUE-02 ส่วน 1 กำหนดว่าคนที่แพ้ได้ **HTTP 409 `ALREADY_CLAIMED`** แต่ test ตรวจแค่ข้อความบนจอ | ส่วน 1 รอ response ของ `POST /api/officer/cases/EG-2569-000028/claim` จากทั้งสอง context แล้ว assert สถานะ = `[200, 409]` และ `code` = `ALREADY_CLAIMED` ก่อนตรวจ `action-error` (ค่าคาดหวังมาจากการ์ด ไม่ได้มาจากจอ) · ตรวจแล้ว: เว็บถูก 3/3 ผ่าน · `B08` 3/3 ล้มด้วย `claim พร้อมกัน 2 context: HTTP status` expected `[200, 409]` received `[200, 200]` | `tests/specs/part-a.spec.ts` |
| T2 | ชุด Playwright รันจาก `app/` ไม่ได้: ไม่มี `playwright.config.ts`, `tsconfig.json`, devDependencies (บล็อกก่อนหน้ารันผ่าน shim ใน `/tmp`/`data/` และ axe เป็นตัวปลอม) | โครงสร้างชุดทดสอบยังไม่ครบ (ไม่ใช่ assert ผิด) | เพิ่ม devDeps `@playwright/test` 1.65.1 · `@axe-core/playwright` 4.14.0 · `typescript` · `@types/node` (+ lock) · `playwright.config.ts` (`workers: 1`, `fullyParallel: false`, reporter list + json, `PW_CHROMIUM_PATH`) · `tsconfig.json` · TC-NFR-02 จึงรัน axe จริงเป็นครั้งแรก: 13 หน้า serious/critical = 0 ผ่าน | `package.json` `package-lock.json` `playwright.config.ts` `tsconfig.json` `.gitignore` |

### 5.3 สคริปต์รวมระบบ (ใหม่)

- `scripts/bug-matrix.sh` · restart เว็บด้วย `TEST_MODE=1 BUG_MODE=<โหมด> docker compose up -d --force-recreate --wait` แล้วรันชุดเต็ม เก็บ log/json/บรรทัดแรกของ log เว็บ (ยืนยันว่า BUG_MODE ถูกอ่านจริง) และเปิด `egov-notest` ให้ TC-NFR-03
- `scripts/summarize.cjs` · เทียบผลกับ BUGS.md §2 (ต้องล้ม/อาจล้มด้วย · รวมบั๊กเป็น union) · แยก "ล้มเกินที่คาด" "ควรล้มแต่ผ่าน" และ "ล้มด้วย timeout/หา element ไม่เจอ" (⚠️) · ดึง Expected/Received ของ assert แรกที่ล้ม · TC-NOTI-02 ภายใต้ B03 ถูกรายงานแยกเป็น "กลไกเดียวกัน · รอ TA" (✅*) ไม่ถูกซ่อน

### 5.4 โจทย์ (ไม่แก้เอง → คำถามถึง TA ข้อ 6)

ไม่พบข้อที่โจทย์ขัดกันจนทำให้ TC ผ่านไม่ได้ · พบ 3 จุดที่โจทย์ไม่ครบ/กำกวม จดเป็นคำถามด้านล่าง

## 6. คำถามถึง TA

| # | เรื่อง | สิ่งที่พบ (หลักฐาน) | ที่ทีมทำไปก่อน | ขอให้ตัดสิน |
|---|---|---|---|---|
| Q-TA-1 | BUGS.md §2 แถว B03 คอลัมน์ "TC ที่อาจล้มด้วย" ขาด **TC-NOTI-02** | เปิด B03 แล้ว TC-NOTI-02 ส่วน B (request แรก ส. 5 ธ.ค. 10:00) ล้ม `off.reg2 noti-item` expected `10` received `9` · ยิง API ตรวจแล้ว: `…000016` ยังมี `dueAt` = `2026-12-08T16:30:00+07:00` ตาม seed (A-35) แต่ `slaLevel` = `normal` แทน `near` เพราะฟังก์ชันวันทำการตัวเดียวนับ จ.7 ธ.ค. (วันหยุด) เป็นวันทำการ → วันคงเหลือ 2 วัน → ไม่เกิดแจ้งเตือน `near` (เช่นเดียวกับ `…000011` ของ head1) · เป็นกลไกเดียวกับที่ BUGS.md เขียนไว้ให้ TC-SLA-03 ส่วน B และ DECISIONS §18 "B03 กระทบอะไร: TC ที่ใช้วันคงเหลือข้ามวันหยุดล้มด้วยได้" | ไม่แก้เว็บ (ถ้าแยกฟังก์ชันวันทำการของแจ้งเตือนจะขัด DECISIONS §18 "ฟังก์ชันวันทำการตัวเดียว") · ไม่แก้ test · รายงานเป็น ✅* | ยืนยันให้เพิ่ม TC-NOTI-02 ในคอลัมน์ "อาจล้มด้วย" ของ B03 (และตาราง §4 ของ BUGS.md) |
| Q-TA-2 | CONTRACT §0.7 / A-30 ให้ **ทุก** HTTP request ยกเว้น `/api/test/*` ประเมินแจ้งเตือน รวม `GET /api/health` | health probe ของ Docker/load balancer/monitoring ที่ยิง `/api/health` เป็นระยะจะสร้างแจ้งเตือนตามนาฬิกาปัจจุบัน ถ้าตกช่วงระหว่าง reset กับตั้งนาฬิกา TC-NOTI-01/02 (ซึ่งพึ่ง "request แรกหลัง reset" A-30) ล้มแบบสุ่ม | ใช้ TCP probe แทน (W2) จึงไม่ต้องยกเว้น `/api/health` และยังทำตาม §0.7 ครบ | ควรยกเว้น `/api/health` จากการประเมิน (เหมือน `/api/test/*`) หรือระบุใน CONTRACT ว่า healthcheck ต้องไม่ส่ง HTTP request ในโหมดทดสอบ |
| Q-TA-3 | TC-DASH-03 ตรวจ `Content-Type: application/pdf` ของไฟล์ส่งออก แต่ CONTRACT §2.9 ไม่ได้กำหนดว่าปุ่ม `export-*-btn` ดาวน์โหลดแบบไหน | ถ้าเว็บใช้ `<a download>` (ถูกต้องตาม HTML) Playwright เห็นแค่ event `download` ไม่มี header → ตรวจ Content-Type ไม่ได้ · ถ้าให้ test ยิง `GET /api/dashboard/export` ซ้ำเพื่อดู header จะเกิด audit `EXPORT` เพิ่ม ทำให้ `audit-count` ≠ 3 ตามการ์ด | ปรับเว็บเป็น fetch + blob (W1) ให้สอดคล้องกับปุ่มดาวน์โหลดอื่นในเว็บ | ระบุใน CONTRACT ว่าปุ่มส่งออก/ดาวน์โหลดต้อง "สังเกต response ได้" (fetch) หรืออนุญาตให้ TC ตรวจ header ผ่านคำขอที่ไม่ถูกนับเป็น `EXPORT` |

## 7. ข้อสังเกต / ความเสี่ยงที่เหลือ

- **TC-NFR-04 วิธีเข้ารหัสที่ใช้:** เลขบัตรและเบอร์เก็บเป็น AES-256-GCM (`*_enc` รูปแบบ `gcm1:<base64url>` · iv สุ่ม 12 ไบต์ + tag 16) · ค้นหาด้วย blind index HMAC-SHA256 (`users.id_no_hash`) · รหัสผ่าน scrypt · ลายเซ็นเอกสาร HMAC-SHA256 (`src/lib/crypto.js`) · ถ้าไม่ตั้ง env `DATA_KEY` `INDEX_KEY` `SIGNING_KEY` จะใช้คีย์ทดสอบตายตัว → ตอน deploy จริงต้องตั้ง (HTTPS = Q-08 ไม่ทดสอบที่นี่)
- **TC-NFR-02:** ก่อนหน้านี้บล็อกอื่นรันด้วย axe ตัวปลอม · รอบนี้ใช้ `@axe-core/playwright` จริง (tags `wcag2a` `wcag2aa` `wcag21a` `wcag21aa`) ผ่านทุกรอบ
- **TC-NFR-03 ส่วน "ปิด hook":** ตรวจจริงในรอบสุดท้ายด้วย `egov-notest` (ไม่ตั้ง `TEST_MODE`) → `POST /api/test/reset` = 404 · ในเมทริกซ์รอบ 1 ยังไม่ได้ตั้ง (test บันทึก annotation `skip-part` แล้วผ่าน)
- **Chromium:** `@playwright/test` 1.65.1 ต้องการ Chromium r1255 · ไม่ได้ดาวน์โหลด browser เพิ่มเพราะ `npx playwright install` เขียนลง `~/.cache/ms-playwright` (นอก `app/`) จึงใช้ r1252 ที่มีอยู่ใน `/ms-playwright` ผ่าน `PW_CHROMIUM_PATH` (เครื่องใหม่ใช้ `npx playwright install chromium` ได้เลย)
- **(เติมภายหลัง)** `test-report/` และ `BUG-HUNT.md` ทำแล้วใน LAB 4–5 ที่ `week2/egov-eservice/` · **เดิม นอกขอบเขต B14:** PROMPTS ขั้น 4–5 ให้เก็บ `test-report/` (results.json · index.html · GIF) และ `BUG-HUNT.md` ไว้ที่ระดับ `week2/egov-eservice/` ซึ่งอยู่นอก `app/` → B14 ไม่ได้สร้าง (ผลดิบ JSON/log อยู่ใน `app/test-results/matrix*/` นำไปใช้ต่อได้ · ตาราง triage อยู่ในข้อ 3)
- **ไฟล์ค้างของบล็อกอื่นใน `data/`:** `data/b06-*` (runner/DB ทดสอบของ B06) ไม่ได้ลบ (อยู่ใน `.gitignore`/`.dockerignore` ไม่กระทบ image)

## 8. ไฟล์ที่ B14 เพิ่ม/แก้

| ไฟล์ | เพิ่ม/แก้ | ข้อ |
|---|---|---|
| `src/routes/dashboard.js` | แก้ (`PAGE_SCRIPT` ปุ่มส่งออก fetch + blob) | W1 |
| `Dockerfile` | แก้ (`HEALTHCHECK` TCP probe + `--start-interval`) | W2 |
| `tests/specs/part-a.spec.ts` | แก้ (TC-QUEUE-02 ส่วน 1 ตรวจ HTTP `[200, 409]` + `ALREADY_CLAIMED`) | T1 |
| `package.json` · `package-lock.json` | แก้ (devDependencies เท่านั้น · dependencies เดิม · `npm ci --omit=dev` ใน image ผ่าน) | T2 |
| `playwright.config.ts` · `tsconfig.json` | เพิ่ม | T2 |
| `.gitignore` | แก้ (+ `tests/testfiles/`) | T2 |
| `scripts/bug-matrix.sh` · `scripts/summarize.cjs` | เพิ่ม | 5.3 |
| `INTEGRATION.md` | เพิ่ม (ไฟล์นี้) | – |
