'use strict';
/**
 * การเข้ารหัสข้อมูลส่วนบุคคล (NFR-04 · DECISIONS §11) และลายเซ็นจำลอง (CONTRACT §3 · A-22)
 *
 *   encrypt('1101700123456') → 'gcm1:<base64url>'   AES-256-GCM (iv 12 ไบต์สุ่ม + tag 16) — เก็บใน *_enc
 *   decrypt(token)           → '1101700123456' | null
 *   blindIndex('1101700123456') → hex HMAC-SHA256 (คีย์แยก) — เก็บใน id_no_hash เพื่อค้นหา/unique โดยไม่เก็บเลขตรง ๆ
 *   hmacSha256(message)      → hex ด้วยคีย์ลงนามทดสอบ (เอกสาร: docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer)
 *   hashPassword / verifyPassword  → scrypt (รหัสผ่านเจ้าหน้าที่)
 *
 * คีย์: env DATA_KEY / INDEX_KEY / SIGNING_KEY (สตริงใดก็ได้ → SHA-256 เป็น 32 ไบต์) · ไม่ตั้ง = คีย์ทดสอบตายตัว
 * (คีย์ตายตัวทำให้ DB เดิมยังถอดรหัสได้หลัง restart · ระบบจริงต้องเก็บคีย์ใน KMS → คำถาม Q-08)
 */

const nodeCrypto = require('crypto');

const deriveKey = (s) => nodeCrypto.createHash('sha256').update(String(s), 'utf8').digest();

const DATA_KEY = deriveKey(process.env.DATA_KEY || 'egov-eservice-demo-data-key-v1');
const INDEX_KEY = deriveKey(process.env.INDEX_KEY || 'egov-eservice-demo-index-key-v1');
const SIGNING_KEY = process.env.SIGNING_KEY || 'egov-eservice-test-signing-key';

const PREFIX = 'gcm1:';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** เข้ารหัส AES-256-GCM · null/undefined/'' → null */
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + b64url(Buffer.concat([iv, tag, ct]));
}

/** ถอดรหัส · ผิดรูปแบบ/ถูกแก้ → null */
function decrypt(token) {
  if (token == null || token === '') return null;
  const s = String(token);
  if (!s.startsWith(PREFIX)) return null;
  try {
    const raw = fromB64url(s.slice(PREFIX.length));
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', DATA_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/** blind index สำหรับค้นหาเลขบัตร (ตัดอักขระที่ไม่ใช่ตัวเลขก่อน) */
function blindIndex(value) {
  const norm = String(value == null ? '' : value).replace(/\D/g, '');
  return nodeCrypto.createHmac('sha256', INDEX_KEY).update(norm, 'utf8').digest('hex');
}

/** HMAC-SHA256 hex (ค่าเริ่มต้นใช้คีย์ลงนามทดสอบ) */
function hmacSha256(message, key = SIGNING_KEY) {
  return nodeCrypto.createHmac('sha256', key).update(String(message), 'utf8').digest('hex');
}

/** ลายเซ็นเอกสาร: HMAC ของฟิลด์ต่อกันด้วย '|' ตามลำดับที่ส่งมา */
function signFields(fields, key = SIGNING_KEY) {
  return hmacSha256(fields.map((f) => (f == null ? '' : String(f))).join('|'), key);
}

/** เทียบ hex แบบเวลาคงที่ */
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return nodeCrypto.timingSafeEqual(x, y);
}

const SCRYPT_OPTS = { N: 4096, r: 8, p: 1 };

/** 'scrypt$<salt hex>$<hash hex>' */
function hashPassword(password) {
  const salt = nodeCrypto.randomBytes(16);
  const hash = nodeCrypto.scryptSync(String(password), salt, 32, SCRYPT_OPTS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = nodeCrypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT_OPTS);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && nodeCrypto.timingSafeEqual(hash, expected);
}

/** โทเคนสุ่ม hex */
function randomToken(bytes = 32) {
  return nodeCrypto.randomBytes(bytes).toString('hex');
}

/** รหัสสุ่มจากชุดอักขระ (ค่าเริ่มต้น [A-Z0-9] 8 ตัว สำหรับรหัสตรวจเอกสาร) */
function randomCode(len = 8, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[nodeCrypto.randomInt(alphabet.length)];
  return out;
}

module.exports = {
  encrypt,
  decrypt,
  blindIndex,
  hmacSha256,
  signFields,
  safeEqualHex,
  hashPassword,
  verifyPassword,
  randomToken,
  randomCode,
  SIGNING_KEY,
};
