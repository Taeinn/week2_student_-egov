# BUG-HUNT · LAB 5 (BUG_MODE B01–B12)

> ตามรูปแบบ `egov-brief/BUGS.md` §3–§6 · เว็บและ test มาจาก run ของทีมเอเจนต์ `egov-eservice-20261115-192743` (บล็อก B14)
> ผลดิบ: [`app/test-results/matrix/`](app/test-results/matrix/) (รอบสุดท้าย) · [`app/test-results/matrix-r1/`](app/test-results/matrix-r1/) (รอบแรกก่อนแก้ test)
> รันซ้ำ: `cd app && scripts/bug-matrix.sh` แล้ว `node scripts/summarize.cjs test-results/matrix/*.json`

## สรุป

**จับได้ 12/12 บั๊ก** · TC ที่ BUGS.md §2 ระบุว่าต้องล้ม ล้มจริงทุกตัว · ไม่มี TC ที่ควรล้มแต่ผ่าน · ทุกข้อล้มด้วย assert ค่าต่าง (Expected/Received) ไม่ใช่ timeout

| ขั้น (BUGS.md §3) | ผล |
|---|---|
| 1 เว็บถูกต้อง (`TEST_MODE=1` ไม่มี `BUG_MODE`) | ✅ 51/51 |
| 2 รันซ้ำทันทีไม่ restart | ✅ 51/51 |
| 3 B01–B12 ทีละตัว | ✅ 12/12 (B03 = ✅* ดูข้อสังเกต) |
| 4 ข้อความที่ล้มบอกค่าต่าง | ✅ ทุกตัว (หลังแก้ T1 ของ B08) |
| 5 รวม `B03,B07` · `B01,B05,B09` | ✅ ล้มเท่ากับ union (6 และ 3 TC) |
| 6 ปิดบั๊กทั้งหมดอีกครั้ง | ✅ 51/51 |

## ตารางบันทึกผล (BUGS.md §4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ 50/1 |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ 50/1 |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 | – | ✅* 46/5 |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ 50/1 |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ 50/1 |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | ✅ 50/1 |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | ✅ 50/1 |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | ✅ 50/1 |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ 50/1 |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | ✅ 48/3 |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ 49/2 |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ 50/1 |
| B03,B07 | union ของ B03 + B07 | TC-SLA-01 · 02 · 03 · NOTI-02 · RBAC-02 · RBAC-04 | (NOTI-02 เหมือน B03) | – | ✅ 45/6 |
| B01,B05,B09 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | ตรงกัน | – | – | ✅ 48/3 |

## Triage (BUGS.md §6) · assert แรกที่ล้ม

| บั๊ก | ผลรัน | สรุป |
|---|---|---|
| B01 | TC-FEE-01 `fee-total` พื้นที่ 101 expected `฿1,010` received `฿1,000` | ✅ จับได้ตรงจุด |
| B02 | TC-UPLOAD-01 `file-item` ไฟล์ 5,242,880 ไบต์ expected 1 received 0 | ✅ จับได้ตรงจุด |
| B03 | TC-SLA-01 แถว c `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` · TC-SLA-02 เหมือนกัน · TC-SLA-03 `sla-level` `ใกล้ครบกำหนด`→`ปกติ` · TC-RBAC-04 `dueAt` 12-08→12-04 · TC-NOTI-02 `noti-item` 10→9 | ✅* SLA-03/RBAC-04 อยู่ในรายการ "อาจล้มด้วย" · NOTI-02 ล้มเกิน แต่เป็นกลไกเดียวกัน (ด้านล่าง) |
| B04 | TC-SLA-02 `dueAt` expected `2026-12-08T16:30` received `2026-12-04T16:30` (ไม่หยุดนับ) | ✅ จับได้ตรงจุด |
| B05 | TC-PAY-01 ชำระ `PP-0001` ที่อายุ 15:00 expected 410 received 200 `PAID` | ✅ จับได้ตรงจุด |
| B06 | TC-RBAC-01 สมหญิงเปิดคำขอสมชาย expected 404 received 200 | ✅ จับได้ตรงจุด |
| B07 | TC-RBAC-02 `off.reg2` `POST /api/cases/EG-2569-000014/approve` expected 403 received 200 | ✅ ยิง API ตรง ไม่ผ่านหลอกแบบดูแค่ปุ่ม |
| B08 | TC-QUEUE-02 claim พร้อมกัน 2 context expected `[200, 409]` received `[200, 200]` | ✅ (รอบแรก ⚠️ ล้มด้วยหา `action-error` ไม่เจอ → แก้ test T1 ให้ตรวจ HTTP ตามการ์ด) |
| B09 | TC-PDPA-02 `GET /api/officer/queue` พบเลข 13 หลัก 19 ค่า expected `[]` | ✅ จับได้ตรงจุด |
| B10 | TC-DASH-02 พ.ย. `kpi-ontime-pct` expected `85.7%` received `23.1%` · TC-DASH-01 ธ.ค. `–`→`0.0%` · TC-DASH-03 | ✅ ล้มเกินอยู่ในรายการ "อาจล้มด้วย" (สูตรเดียวกัน) |
| B11 | TC-PDPA-03 `audit-count` expected 1 received 0 · TC-AUDIT-01 16→15 | ✅ จับได้ตรงจุด |
| B12 | TC-WORKFLOW-04 `return-btn` expected 0 received 1 | ✅ จับได้ตรงจุด |

## ข้อสังเกต / คำถามถึง TA

- **B03 → TC-NOTI-02 ล้มเกิน:** ฟังก์ชันวันทำการตัวเดียว (DECISIONS §18) นับ จ.7 ธ.ค. (วันหยุด) เป็นวันทำการ → คำขอ `…000016` วันคงเหลือ 2 วันแทน 1 → `slaLevel` = `normal` แทน `near` → ไม่เกิดแจ้งเตือน → `noti-item` 9 แทน 10 · กลไกเดียวกับ TC-SLA-03 ส่วน B ที่ BUGS.md อนุญาตไว้ · **ไม่แก้เว็บ ไม่แก้ test** · ขอ TA ยืนยันเพิ่ม TC-NOTI-02 ในคอลัมน์ "อาจล้มด้วย" ของ B03 (Q-TA-1 ใน [`app/INTEGRATION.md`](app/INTEGRATION.md) ข้อ 6)
- สิ่งที่แก้ระหว่างล่าบั๊ก (แยกประเภทตาม PROMPTS ขั้น 4): **test ผิด** 1 (T1 · B08 ล้มด้วยหา element ไม่เจอ) · **เว็บผิด** 0 (W1 W2 แก้ตั้งแต่รอบปกติ) · **โจทย์ผิด** 0 (คำถาม TA 3 ข้อ) · ไม่มีการแก้ผลที่คาดหวังให้ตรงหน้าจอ
