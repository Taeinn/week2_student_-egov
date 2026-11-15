-- =====================================================================
-- e-Service กลาง เทศบาลนครตัวอย่าง · SQLite schema (better-sqlite3)
-- ครอบคลุม FR-01..FR-29 · ไฟล์นี้ถูก exec ใหม่ทั้งไฟล์ทุกครั้งที่ POST /api/test/reset
-- (ทุกตารางถูก DROP ก่อน แล้วจึงสร้างใหม่ + เรียก src/db/seed.js) → ห้ามมี BEGIN/COMMIT ในไฟล์นี้
--
-- ข้อตกลงร่วม:
--   * เวลาเก็บเป็น TEXT 'YYYY-MM-DDTHH:mm:ss+07:00' (clock.toIso) → เทียบด้วย < > ได้ตรงเพราะ offset เดียวกันและยาวเท่ากัน
--   * วันที่ล้วนเก็บ 'YYYY-MM-DD' (ค.ศ.)
--   * เงินเป็นจำนวนเต็มบาท (INTEGER)
--   * เลขบัตร/เบอร์โทร ห้ามเก็บตรง ๆ (NFR-04): เก็บ crypto.encrypt() ใน *_enc และ crypto.blindIndex() ใน id_no_hash
--     (รวมถึงห้ามใส่เลขบัตร/เบอร์ตรง ๆ ใน sessions.data, audit_log.detail, case_events, notifications)
--   * ห้ามเขียนเลขบัตร/เบอร์ตัวอย่างจริงในคอมเมนต์ภายใน CREATE TABLE: SQLite เก็บข้อความ CREATE (รวมคอมเมนต์)
--     ไว้ใน sqlite_master ในไฟล์ DB → TC-NFR-04 (grep ไฟล์ DB) จะเจอ
--   * ผู้ใช้อ้างอิงด้วย users.id (INTEGER)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ผู้ใช้ทุกบทบาท (FR-01 FR-02 FR-03 FR-27)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT UNIQUE,                 -- เจ้าหน้าที่: 'off.reg1' ฯลฯ · ประชาชน: NULL (ล็อกอินด้วยเลขบัตร)
  password_hash TEXT,                        -- เจ้าหน้าที่: crypto.hashPassword('Test@1234')
  name          TEXT NOT NULL,               -- ชื่อแสดง user-name / ชื่อ-สกุลจาก ThaiD จำลอง
  role          TEXT NOT NULL CHECK (role IN ('citizen','officer','head','executive','auditor','admin')),
  dept          TEXT CHECK (dept IS NULL OR dept IN ('registry','works')),  -- officer เท่านั้น
  id_no_enc     TEXT,                        -- ประชาชน: crypto.encrypt(<เลขบัตร 13 หลัก>)
  id_no_hash    TEXT UNIQUE,                 -- ประชาชน: crypto.blindIndex(<เลขบัตร>) ใช้ค้นตอนล็อกอิน
  id_masked     TEXT,                        -- ประชาชน: 'X-XXXX-XXXXX-45-6' (มีแค่ 3 หลักท้าย)
  mobile_enc    TEXT,                        -- crypto.encrypt(<เบอร์ 10 หลัก>)
  email         TEXT,
  registered    INTEGER NOT NULL DEFAULT 1,  -- ประชาชนที่ยังไม่ลงทะเบียน (มานะ) = 0
  consent_at    TEXT,                        -- เวลายินยอม PDPA
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX idx_users_role ON users(role, dept);

-- ตัวนับ OTP ผิด / การล็อกเลขบัตร (BR-02 · ล้างเมื่อ reset)
CREATE TABLE otp_attempts (
  id_no_hash    TEXT PRIMARY KEY,            -- crypto.blindIndex(idNo)
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_fail_at  TEXT,
  locked_until  TEXT                         -- เวลาครั้งที่ 3 + 15 นาที
);

-- session cookie 'sid' (src/lib/session.js) · reset ล้างทั้งตาราง = ทุกคนต้องล็อกอินใหม่
CREATE TABLE sessions (
  sid           TEXT PRIMARY KEY,
  data          TEXT NOT NULL DEFAULT '{}',  -- JSON: { user: {id, username, name, role, dept}, ... }
  created_at    TEXT,
  updated_at    TEXT
);

-- ---------------------------------------------------------------------
-- บริการ + วันหยุด (FR-04 FR-25 FR-26 · admin แก้ได้)
-- ---------------------------------------------------------------------
CREATE TABLE services (
  id            TEXT PRIMARY KEY,            -- 'SV-01' 'SV-02' 'SV-03'
  name          TEXT NOT NULL,               -- ตาม CONTRACT §4.3
  fee           INTEGER NOT NULL,            -- SV-01 ต่อฉบับ (20) · SV-02 คงที่ (500) · SV-03 ฐาน feeBase (1000)
  fee_per_sqm   INTEGER,                     -- SV-03 ต่อ ตร.ม. ส่วนเกิน 100 (10) · อื่น NULL
  sla_days      INTEGER NOT NULL,            -- 3 / 10 / 15 วันทำการ
  sort          INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);

CREATE TABLE holidays (
  date          TEXT PRIMARY KEY,            -- 'YYYY-MM-DD'
  name          TEXT NOT NULL,
  created_at    TEXT
);

-- ---------------------------------------------------------------------
-- คำขอ (ร่าง → รอชำระ → มีเลขคำขอ) (FR-04..FR-16 FR-19)
-- แถวเดียวตลอดอายุ: ร่างมี draft_id ไม่มี case_no · ชำระสำเร็จแล้วได้ case_no
-- ---------------------------------------------------------------------
CREATE TABLE cases (
  id             INTEGER PRIMARY KEY,
  case_no        TEXT UNIQUE,                -- 'EG-2569-000001' · NULL ขณะ DRAFT/PENDING_PAYMENT
  draft_id       TEXT UNIQUE,                -- 'DR-0001' · seed ประวัติไม่มีร่าง = NULL
  service_id     TEXT NOT NULL REFERENCES services(id),
  applicant_id   INTEGER NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_PAYMENT','SUBMITTED','IN_REVIEW','NEED_FIX',
                                                 'PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','CANCELLED')),
  qty            INTEGER,                    -- SV-01 จำนวนฉบับ
  area_sqm       INTEGER,                    -- SV-03 พื้นที่ ตร.ม.
  fee            INTEGER,                    -- ยอดค่าธรรมเนียม · ล็อกเมื่อเข้า PENDING_PAYMENT (A-42) · ร่าง = ยอดคำนวณล่าสุด
  fee_locked_at  TEXT,
  -- ขั้นตอน/ผู้รับผิดชอบปัจจุบัน
  step           INTEGER CHECK (step IS NULL OR step BETWEEN 1 AND 3),  -- SV-03 เท่านั้น (1 ทะเบียน · 2 โยธา · 3 หัวหน้า) อื่น NULL
  dept           TEXT CHECK (dept IS NULL OR dept IN ('registry','works')),
                                             -- แผนกของขั้นปัจจุบัน (คิว): SUBMITTED/IN_REVIEW/NEED_FIX/APPROVED = 'registry'
                                             -- ยกเว้น SV-03 step 2 = 'works' · PENDING_APPROVAL/ร่าง/ปิดแล้ว = NULL
  owner_id       INTEGER REFERENCES users(id),  -- ผู้ถือเรื่องขั้นปัจจุบัน (IN_REVIEW/NEED_FIX) · ไม่มีผู้รับ/รออนุมัติ/APPROVED = NULL
  issuer_id      INTEGER REFERENCES users(id),  -- เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก = ผู้ออกเอกสาร (A-27)
  approver_id    INTEGER REFERENCES users(id),  -- ผู้อนุมัติ = ผู้ลงนาม
  approved_at    TEXT,
  -- เวลา/SLA
  paid_at        TEXT,                       -- เวลาชำระสำเร็จ (เริ่มนับ SLA · Dashboard "รับเรื่อง")
  due_at         TEXT,                       -- กำหนดเสร็จที่เก็บ (seed เป็นค่าตายตัวตาม TEST-DATA · A-35)
  return_count   INTEGER NOT NULL DEFAULT 0, -- จำนวนครั้งที่ตีกลับ (return-count)
  returned_at    TEXT,                       -- เวลาตีกลับครั้งล่าสุด
  fix_deadline   TEXT,                       -- returned_at + 168 ชม. (มีค่าเมื่อ NEED_FIX)
  closed_at      TEXT,                       -- COMPLETED/REJECTED (ทันกำหนด ⇔ closed_at ≤ due_at)
  cancelled_at   TEXT,                       -- CANCELLED
  cancel_reason  TEXT CHECK (cancel_reason IS NULL OR cancel_reason IN ('CITIZEN','FIX_EXPIRED')),
  reject_reason  TEXT,
  created_at     TEXT,
  updated_at     TEXT
);
CREATE INDEX idx_cases_status    ON cases(status, dept);
CREATE INDEX idx_cases_applicant ON cases(applicant_id);
CREATE INDEX idx_cases_owner     ON cases(owner_id, status);
CREATE INDEX idx_cases_due       ON cases(due_at, case_no);

-- ไทม์ไลน์ของคำขอ (case-timeline · FR-09) — แยกจาก audit_log (audit ว่างหลัง reset แต่ไทม์ไลน์ seed มีได้)
CREATE TABLE case_events (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  at            TEXT NOT NULL,
  type          TEXT NOT NULL,               -- CREATED PAID CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL ...
  actor_id      INTEGER REFERENCES users(id),
  from_status   TEXT,
  to_status     TEXT,
  step          INTEGER,
  text          TEXT,                        -- ข้อความไทยที่แสดงใน timeline-item
  detail        TEXT
);
CREATE INDEX idx_case_events_case ON case_events(case_id, at);

-- ประวัติตีกลับ/ส่งแก้ (FR-11 FR-14 · BR-13 หยุดนับ · TEST-DATA §4.4)
CREATE TABLE case_returns (
  id             INTEGER PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,           -- ครั้งที่ 1, 2 (B12 เปิดแล้วมี 3 ได้)
  returned_at    TEXT NOT NULL,
  returned_by    INTEGER REFERENCES users(id),
  reason         TEXT NOT NULL,
  fix_deadline   TEXT NOT NULL,              -- returned_at + 168 ชม.
  resubmitted_at TEXT,                       -- NULL = ยังไม่ส่งแก้
  paused_days    INTEGER,                    -- วันทำการใน (ตีกลับ, ส่งแก้] ที่บวกเพิ่มให้ due_at
  UNIQUE (case_id, seq)
);

-- ไฟล์แนบ (FR-05 FR-06 FR-29) · เก็บเนื้อไฟล์ใน BLOB → reset ล้างไฟล์อัปโหลดใหม่อัตโนมัติ
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  file_id       TEXT NOT NULL UNIQUE,        -- ใช้ใน /api/files/:fileId (รูปแบบใดก็ได้ เช่น 'F-000001')
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  doc_key       TEXT NOT NULL CHECK (doc_key IN ('id-card','map','site-photo','plan','deed','extra')),
  name          TEXT NOT NULL,               -- ชื่อไฟล์ที่อัปโหลด (data-name)
  mime          TEXT NOT NULL,               -- จาก magic bytes: application/pdf · image/jpeg · image/png
  size          INTEGER NOT NULL,            -- ไบต์
  data          BLOB NOT NULL,
  round         INTEGER NOT NULL DEFAULT 0,  -- 0 = ตอนยื่น · n = แนบตอนส่งแก้ครั้งที่ n
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT
);
CREATE INDEX idx_attachments_case ON attachments(case_id);

-- ชำระเงิน QR จำลอง + ใบเสร็จ (FR-08 · BR-09 BR-10)
-- สถานะ "EXPIRED" ไม่เก็บ: คำนวณจาก (นาฬิกา − qr_created_at) ≥ 15:00 ขณะ status = 'PENDING'
CREATE TABLE payments (
  id            INTEGER PRIMARY KEY,
  ref           TEXT UNIQUE,                 -- 'PP-0001' · seed ประวัติ 30 ใบไม่มี ref (NULL)
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,            -- ยอดที่ต้องชำระ (= cases.fee ที่ล็อก)
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','VOID')),
  qr_created_at TEXT,
  qr_expires_at TEXT,                        -- qr_created_at + 15 นาที
  paid_at       TEXT,
  paid_amount   INTEGER,
  receipt_no    TEXT UNIQUE,                 -- 'RC-2569-000031' (ลำดับตรงกับเลขคำขอ)
  created_at    TEXT
);
CREATE INDEX idx_payments_case ON payments(case_id);

-- เอกสารดิจิทัล (FR-17 FR-18 · BR-23) · 1 คำขอ 1 เอกสาร
-- signature = HMAC-SHA256('docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer') (crypto.signFields)
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY,
  doc_no        TEXT NOT NULL UNIQUE,        -- 'DOC-2569-000001'
  case_id       INTEGER NOT NULL UNIQUE REFERENCES cases(id),
  case_no       TEXT NOT NULL,
  verify_code   TEXT NOT NULL UNIQUE,        -- [A-Z0-9]{8} เช่น 'K7M2Q9XA'
  applicant     TEXT NOT NULL,               -- ชื่อผู้ยื่นเต็ม (ฟิลด์ที่ลงนาม · หน้า verify แสดงแบบปิดบัง)
  service_id    TEXT NOT NULL,
  issued_at     TEXT NOT NULL,               -- ISO +07:00
  valid_until   TEXT NOT NULL,               -- 'YYYY-MM-DD' วันสุดท้ายที่ใช้ได้ (A-43)
  signer        TEXT NOT NULL,               -- ชื่อผู้ลงนาม (= ผู้อนุมัติ)
  signer_id     INTEGER REFERENCES users(id),
  issued_by     INTEGER REFERENCES users(id),
  signature     TEXT NOT NULL
);

-- แจ้งเตือนกระดิ่ง (FR-20 · BR-15) · 1 ครั้งต่อระดับต่อคำขอต่อคน (UNIQUE) → ใช้ INSERT OR IGNORE
CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_no       TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text          TEXT NOT NULL,               -- 'คำขอ EG-2569-000024 ใกล้ครบกำหนด' / 'คำขอ EG-2569-000020 เกินกำหนด'
  created_at    TEXT NOT NULL,
  read_at       TEXT,
  UNIQUE (user_id, case_id, level)
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);

-- ---------------------------------------------------------------------
-- Audit Trail (FR-24 · DECISIONS §13) · เพิ่มได้อย่างเดียว (append-only)
-- UPDATE/DELETE ถูกปฏิเสธด้วย trigger (reset ใช้ DROP TABLE ทั้งตาราง)
-- เขียนผ่าน db.appendAudit(...) ใน src/db/index.js
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,               -- ISO +07:00 จากนาฬิกาทดสอบ
  user_id       INTEGER,
  username      TEXT NOT NULL,
  role          TEXT NOT NULL,               -- รหัสบทบาท ณ เวลาที่ทำ
  event         TEXT NOT NULL CHECK (event IN ('STAFF_LOGIN','CLAIM','RETURN','FORWARD','APPROVE','REJECT',
                                               'ISSUE','UNMASK','EXPORT','ADMIN_CHANGE')),
  case_no       TEXT,
  from_status   TEXT,
  to_status     TEXT,
  detail        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at    ON audit_log(at);
CREATE INDEX idx_audit_event ON audit_log(event);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- ---------------------------------------------------------------------
-- ตัวนับเลขรัน (db.nextSeq(name) → ค่าถัดไปแบบ atomic)
--   'case:2569'    เลขคำขอ EG-2569-xxxxxx   (seed ตั้ง 30 → ถัดไป 000031 · ปี 2570 ยังไม่มีแถว → 000001)
--   'receipt:2569' เลขใบเสร็จ RC-2569-xxxxxx (seed ตั้ง 30)
--   'doc:2569'     เลขเอกสาร DOC-2569-xxxxxx (seed ตั้ง 1 → ถัดไป 000002)
--   'draft'        DR-xxxx                  (seed ตั้ง 2 → ถัดไป DR-0003)
--   'payref'       PP-xxxx                  (seed ตั้ง 1 → ถัดไป PP-0002)
--   'file'         ลำดับ fileId (ไม่บังคับ)
-- ---------------------------------------------------------------------
CREATE TABLE counters (
  name          TEXT PRIMARY KEY,
  value         INTEGER NOT NULL
);

CREATE TABLE app_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT
);
