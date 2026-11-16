# WORKLOG · การบ้าน Week 2 (e-Service ภาครัฐด้วยทีมเอเจนต์)

> บันทึกทุกขั้นที่ทำจริง: ทำอะไร · คำสั่ง · ผล · ปัญหา + วิธีแก้ · ใครทำ
> เพิ่มแถว/หัวข้อใหม่ต่อท้ายทุกครั้งที่ทำ LAB หรือแก้แผน (ใหม่สุดอยู่ล่าง)
> ทำเป็นคู่ (dev A + dev B) · ส่งต่อเครื่องดูที่ [`HANDOFF.md`](HANDOFF.md)

## สรุปสถานะ

| LAB | สถานะ | ผลงาน | ทำโดย / วันที่ |
|---|---|---|---|
| 1 ทำความเข้าใจโจทย์ | ✅ | [`LAB1-LAB2-NOTES.md`](LAB1-LAB2-NOTES.md) | dev A · 15 พ.ย. 69 |
| 2 วางแผน dag-planner | ✅ (แผนรุ่น 2) | [`egov-eservice/PLAN.md`](egov-eservice/PLAN.md) · `dag.png` · `gantt-plan.png` | A รุ่น 1 · B รุ่น 2 · 15 พ.ย. 69 |
| 3 ทีมเอเจนต์สร้างเว็บ | ✅ 14/15 บล็อก (B14 timeout หลังทำงานครบ) | `app/` · `gantt-actual.png` · `compare.png` · `REPORT.md` | dev B · เริ่ม 15 พ.ย. 69 19:27 |
| 4 Playwright 51 TC | ✅ 51/51 · GIF P1 43/43 | `test-report/` | dev B · 16 พ.ย. 69 |
| 5 BUG_MODE B01–B12 | ✅ จับได้ 12/12 | `BUG-HUNT.md` | dev B · 16 พ.ย. 69 |

## สภาพแวดล้อม

| รายการ | ค่า |
|---|---|
| container | `multi-account` (image `multi-account:1.0`) · JupyterLab `http://localhost:8886/lab` |
| บัญชี | `yolo1` `yolo2` (Claude subscription) · `cyolo1` `cyolo2` (ChatGPT **ฟรี** → ใช้ได้แค่ `gpt-6-luna`) |
| บัญชีของ dev อีกคน | `yolo2` `cyolo2` ล็อกอินโดยเจ้าของบัญชีผ่านลิงก์ยืนยัน (ไม่มีใครส่งรหัสผ่าน/ไฟล์ credential) |
| สกิล | `/root/ai-accounts/.Claude/shared/skills/{agent-team,dag-planner,yolo,cyolo}` |
| path ใน container | โจทย์ `/workspace/egov-brief` · แผน `/workspace/plans/egov-eservice/` · เว็บ `.../app/` · run `/workspace/.agent-team/<run_id>/` |

ล็อกอินบัญชีของคนอื่นอย่างปลอดภัย (ทำใน JupyterLab Terminal):
- Codex: `cyoloN login --device-auth` → ส่ง `https://auth.openai.com/codex/device` + รหัสสั้นทางแชตส่วนตัว (หมดอายุ 15 นาที) → เจ้าของบัญชีกรอกเอง
- Claude: `yoloN` → Claude account with subscription → ส่งลิงก์ให้เจ้าของ → เขาส่ง code กลับมาวาง
- เลิกใช้: `cyoloN logout` · `yoloN` แล้ว `/logout`

---

## LAB 1 · ทำความเข้าใจโจทย์ (dev A)

ดู [`LAB1-LAB2-NOTES.md`](LAB1-LAB2-NOTES.md)

## LAB 2 · วางแผน

### รุ่น 1 (dev A) — 14 บล็อก · 2 บัญชี (yolo1 + cyolo1) · โควตาสมมติ · ≈ 123.8 นาที
ผ่านการตรวจตาราง "ขั้น 2" ของ PROMPTS ครบ

### รุ่น 2 (dev B) — 15 บล็อก · 4 บัญชี · โควตาจริง · ≈ 98.7 นาที

ทดลองแผนก่อน (ไม่ใช้โทเคน, `dagplan plan --accounts ...`):

| ชุดบัญชี | max-agents | เวลาแผน |
|---|---|---|
| yolo1 + cyolo1 | 4 | 123.8 |
| + yolo2 | 4 | 130.6 |
| + cyolo2 | 4 | 128.1 |
| + yolo2 + cyolo2 | 4 | 123.8 |
| + yolo2 + cyolo2 | **6** | **106.9** |

ข้อสรุป: เพิ่มบัญชีอย่างเดียวไม่ช่วยถ้าคอขวดคือจำนวน agent พร้อมกัน · ความเสี่ยงจริงคือโทเคน — cyolo1 (ฟรี) เดิมรับ ≈ 10M ซึ่งเกินโควตาฟรี

สิ่งที่แก้ใน `blocks.json` (เหตุผล: luna อ่อนเรื่องตรรกะ → ให้งานเบา/สร้างรูป/ตรวจ):

| บล็อก | เดิม | ใหม่ |
|---|---|---|
| B04 auth/RBAC · B07 PDF/HMAC · B10 audit/admin · B12 Playwright ชุด A | cyolo | **yolo** |
| B08 แจ้งเตือน SLA (review) | ผู้ทำ cyolo | ผู้ทำ **yolo** · ผู้ตรวจ cyolo |
| B02 seed · B11 โครง test | cyolo diff 3 | cyolo diff **2** |
| **B15 ใหม่** | – | `image` โลโก้เทศบาล `public/img/logo.png` · ไม่มีใครรอ (ล้มได้ไม่กระทบ) |
| B01 | – | เสิร์ฟ `public/` + `<img>` โลโก้ที่ไม่พังถ้าไม่มีไฟล์ |
| timeout | 600 s ทุกบล็อก | บล็อก L 1800 s · B14 3600 s |

งานของ luna (cyolo): B02 · B11 · B15 · ผู้ตรวจ B03 B08 B09

ปัญหา: `team.py check` พัง `KeyError: 'cyolo2'` → สาเหตุ: บัญชี Codex ใหม่ยังไม่มี `models_cache.json` → แก้: เรียก `cyolo2 exec -m gpt-6-luna "ตอบคำว่า OK เท่านั้น"` 1 ครั้ง

คำสั่ง:
```bash
D=/root/ai-accounts/.Claude/shared/skills/dag-planner/scripts/dagplan.py
python3 $D dag  egov-eservice --blocks /workspace/plans/egov-eservice/blocks.json
python3 $D plan egov-eservice --max-agents 6 --accounts yolo1,yolo2,cyolo1,cyolo2   # โควตาจริง
```

## LAB 3 · รันทีมเอเจนต์ (dev B)

- run_id: `egov-eservice-20261115-192743` · เริ่ม 15 พ.ย. 69 19:27 · `--max-agents 6`
- โควตาตอนเริ่ม: yolo1 week 33% (รีเซ็ต 16 พ.ย. 11:59) · yolo2 week 39% (รีเซ็ต 18 พ.ย. 19:00) · cyolo1 week 3%
- คำสั่ง: `dagplan.py export egov-eservice` → `dagplan.py run egov-eservice --detach`
- ดูสถานะ: `python3 /root/ai-accounts/.Claude/shared/skills/agent-team/scripts/team.py status --run egov-eservice-20261115-192743`

### ถ้าโทเคนหมดกลางทาง
- บล็อกในคิวย้ายไปบัญชีอื่นในฝั่งเดียวกันเอง (export ส่งเป็นฝั่ง `yolo`/`cyolo` ไม่ใช่บัญชีเจาะจง)
- บล็อกที่กำลังรันแล้วโควตาหมด → ล้ม · บล็อกที่รอมัน → `blocked` · agent-team **ไม่ retry เอง**
- ทำต่อ: `team.py run --resume <run_id> --workers ...` = รันเฉพาะที่ล้ม/ถูก block

**ตั้ง auto-resume ไว้แล้ว**: [`egov-eservice/autoresume.sh`](egov-eservice/autoresume.sh) รันใน container (`/workspace/plans/egov-eservice/autoresume.log`)
1. รอ run จบ → ถ้าครบทุกบล็อก สั่ง `dagplan report` แล้วจบ
2. ถ้ามีบล็อกไม่ ok → ตรวจ `team.py check` ทุก 15 นาทีจนมีบัญชี yolo พร้อม → `run --resume`
3. resume ได้สูงสุด 3 ครั้ง (กันวนเผาโทเคนถ้าล้มเพราะเหตุอื่น) แล้วหยุดให้คนตรวจ

ดู log: `docker exec multi-account tail -f /workspace/plans/egov-eservice/autoresume.log`
หยุด: `docker exec multi-account pkill -f autoresume.sh`
⚠ ต้องเปิด Docker Desktop และ container ค้างไว้ (ปิดเครื่อง = หยุดเฝ้า)

### ผลจริง (รายงานเต็ม: [`egov-eservice/REPORT.md`](egov-eservice/REPORT.md) · `gantt-actual.png` · `compare.png`)

- บล็อกเสร็จ **14/15** · B14 สถานะ failed แต่ทำงานจริงครบ (ดูด้านล่าง)
- tokens รวม **4.77M** (แผนประมาณ ≈ 28M → ประเมินเกินจริงมาก) · cyolo (luna) ใช้แค่ ≈ 0.5M
- เวลา: แผน 98.7 นาที · จริง 217.6 นาที (รวมรอโควตา ≈ 1.5 ชม. 20:09–21:40)
- k ใหม่ (calib.json): yolo 0.64 · cyolo 0.17 · review 0.59 · image 0.12 → แผนครั้งหน้าจะแม่นขึ้น

ลำดับเหตุการณ์:

| เวลา | เหตุการณ์ |
|---|---|
| 19:27 | เริ่ม run · B11 B15 (luna) เสร็จใน 1–2 นาที |
| ≈ 20:00 | yolo2 โควตา 5 ชม. 84% ≥ เกณฑ์ 80% → B08 ย้ายไป yolo1 อัตโนมัติ (failover ทำงาน) |
| ≈ 20:04 | yolo1 98% → ฝั่ง yolo หยุดรับงานทั้งคู่ · B05 B06 B08 ล้ม · B14 blocked |
| 20:09–21:40 | autoresume รอโควตา (ตรวจทุก 15 นาที) |
| 21:40 | resume ครั้งที่ 1 → B05 B06 B08 ผ่าน · B14 รัน |
| 23:05 | B14 ชน timeout 3600 s (ยังไม่เขียนสรุปใน INTEGRATION.md) · resume ครั้งที่ 2–3 ล้มทันทีเพราะโควตา ≥ 80% → autoresume หยุดตามเพดาน 3 ครั้ง + สั่ง report |

B14 ก่อน timeout ได้ผลครบแล้ว (`app/test-results/matrix/`, สรุปด้วย `node scripts/summarize.cjs`):
- clean / clean-rerun / clean-final: **51/51 ผ่าน**
- BUG_MODE B01–B12: **จับได้ 12/12** (TC ที่ BUGS.md ระบุล้มจริงทุกตัว) + รวมบั๊ก B03,B07 และ B01,B05,B09 ✅
- ข้อสังเกต: B03 ทำ TC-NOTI-02 ล้มเพิ่ม (กลไกเดียวกัน) → จดเป็นคำถามถึง TA

บทเรียน/สิ่งที่แก้:
- autoresume รุ่นแรกดูแค่ `team.py check` (ล็อกอินได้) แต่ agent-team หยุดรับงานที่โควตา ≥ 80% → resume เปล่า 2 ครั้ง · แก้แล้วให้ดู `status` ของ run ด้วย
- B14 (รวม + 13 รอบ Playwright) ใช้เวลาเกิน 1 ชม. → ครั้งหน้าตั้ง timeout ≥ 7200 s หรือแยกรอบ BUG_MODE เป็นบล็อกเอง
- แผน token เกินจริง ≈ 6 เท่า → ขนาดบล็อก L/M ของ dag-planner ใหญ่เกินสำหรับงานนี้

## LAB 4 · Playwright (dev B · 16 พ.ย. 69 · ไม่ใช้โทเคนของทีม)

ผล: **51/51 ผ่าน** · รายงาน [`egov-eservice/test-report/`](egov-eservice/test-report/) = `results.json` · `html/index.html` · `gif/` (**43 GIF = TC ระดับ P1 ครบ 43 ข้อ**)

คำสั่ง (ใน container ที่ `/workspace/plans/egov-eservice/app`):
```bash
TEST_MODE=1 docker compose up -d                        # ไม่ตั้ง BUG_MODE
export PW_VIDEO=1 BASE_URL=http://localhost:3000 DB_PATH=$PWD/data/egov.db \
       NO_TEST_MODE_BASE_URL=http://localhost:3001 \
       PW_CHROMIUM_PATH=/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell
npx playwright test -c playwright.report.config.ts      # json + html + วิดีโอ
cd test-report && python3 ../scripts/make-gifs.py /workspace/egov-brief/TEST-PLAN.md
```

ข้อล้มระหว่างพัฒนาและการจำแนก (จาก [`app/INTEGRATION.md`](egov-eservice/app/INTEGRATION.md) ข้อ 4–6 ที่ B14 ทำ):

| ข้อ | TC | ประเภท | แก้อะไร |
|---|---|---|---|
| W1 | TC-DASH-03 (รอบแรก 50/51) | **เว็บผิด** (`<a download>` ทำให้ตรวจ header ไม่ได้) | ปุ่มส่งออกใช้ fetch + blob |
| W2 | TC-NOTI-01/02 เสี่ยงสุ่ม | **เว็บผิด** (healthcheck HTTP สร้างแจ้งเตือน) | healthcheck เป็น TCP probe |
| T1 | TC-QUEUE-02 ภายใต้ B08 | **test ผิด** (ตรวจแค่ข้อความ → หา element ไม่เจอ) | ตรวจ HTTP `[200, 409]` + `ALREADY_CLAIMED` ตามการ์ด |
| T2 | ทั้งชุด | **test ผิด** (ไม่มี config / axe ตัวปลอม) | เพิ่ม config + devDeps + axe จริง |
| Q-TA-1..3 | NOTI-02 / health / DASH-03 | **โจทย์ไม่ครบ** | ไม่แก้เอง → คำถามถึง TA |

ไม่มีการแก้ผลที่คาดหวังใน test ให้ตรงหน้าจอ

สิ่งที่ทำเพิ่มใน LAB 4 (เพื่อได้ GIF): test สร้าง browser context เอง วิดีโอของ config จึงไม่ถูกบันทึก → เพิ่ม `recordVideo` ที่เปิดเฉพาะเมื่อ `PW_VIDEO=1` ใน `tests/helpers.ts` และ `newPage/newActor` ของ 2 spec (ไม่แตะ assert) · เพิ่ม `playwright.report.config.ts` และ `scripts/make-gifs.py` (โฟลเดอร์วิดีโอชื่อยาวถูกตัด → จับคู่กับชื่อ test ผ่าน `results.json`)

## LAB 5 · BUG_MODE (dev B · 16 พ.ย. 69)

ผล: **จับได้ 12/12** · รายละเอียด [`egov-eservice/BUG-HUNT.md`](egov-eservice/BUG-HUNT.md) · ผลดิบ `app/test-results/matrix/`
- เมทริกซ์รันโดยบล็อก B14 ก่อน timeout (17 รอบ: clean · clean-rerun · B01–B12 · 2 ชุดรวม · clean-final) → LAB 5 ใช้ผลนั้น ไม่รันซ้ำ (ประหยัดเวลา/ไม่ใช้โทเคน)
- ✅* B03 ทำ TC-NOTI-02 ล้มเกิน → คำถาม TA (Q-TA-1)

## บันทึกการปรับปรุง (ใช้พิสูจน์ว่าดีขึ้นจริง)

| รอบ | วันที่ | เปลี่ยนอะไร (≤ 3 จุด) | เหตุผล | ผลก่อน | ผลหลัง | ตัดสิน |
|---|---|---|---|---|---|---|
| แผน v2 | 15 พ.ย. | ย้ายงานตรรกะจาก luna → Claude · เพิ่ม image · agent 6 | luna ฟรีโควตาน้อย/อ่อนตรรกะ | 123.8 นาที (แผน) | 98.7 นาที (แผน) · จริง 217.6 นาที (รวมรอโควตา ≈ 90 นาที) | ACCEPT: luna ใช้แค่ ≈ 0.5M ไม่หมดโควตา · งาน luna ผ่านทุกบล็อก · ผู้ตรวจ luna จับให้ B08 แก้รอบ 2 |
| เว็บ r0→r1 | 15 พ.ย. | W1 W2 (เว็บ) · T2 (test) | TC-DASH-03 ล้ม | 50/51 | 51/51 | ACCEPT |
| test r1→r2 | 15 พ.ย. | T1 (TC-QUEUE-02 ตรวจ HTTP) | B08 ล้มเพราะหา element ไม่เจอ ⚠️ | 12/12 แต่ B08 ⚠️ | 12/12 ✅ ทุกตัวล้มด้วยค่าต่าง | ACCEPT |
| UI theme | 16 พ.ย. | ธีม "white engineering blueprint" (DESIGN-visitor.md) ใน `layout.js` + แท็บ login + KPI dashboard · ตารางมือถือเลื่อนในกรอบ | ปรับหน้าตา · ตารางมือถือเดิมบีบจนตัวอักษรแตกบรรทัดละตัว | 51/51 | 51/51 × 3 รอบ (axe WCAG ผ่าน) · ไม่แตะ HTML/`data-testid` | ACCEPT |
| UI polish | 16 พ.ย. | โลโก้ใหม่โทนลาเวนเดอร์ (cyolo1 · luna · ≈ 1K output tok) + SVG สำรอง · การ์ดบริการมีไอคอน/hover · timeline จุดลาเวนเดอร์ · dialog/รายการไฟล์/แจ้งเตือนมุมโค้ง · dl/figure ไม่เยื้อง · หัวการ์ดไม่เว้นเกิน | ความเรียบร้อยตามธีม | 51/51 | 51/51 × 2 · B07 ยังจับได้ (50/1) | ACCEPT |
| PDF theme | 16 พ.ย. | เอกสาร PDF: แถบสีลาเวนเดอร์ · โลโก้ · กล่องข้อมูลมุมโค้ง · กรอบ QR (ข้อความ/บรรทัดเครื่องอ่าน/ลายเซ็นเดิมทุกตัว) | ให้เอกสารเข้าชุดกับเว็บ | 51/51 | 51/51 · TC-DOC ผ่าน · ตรวจภาพด้วย pdftoppm | ACCEPT |
| seed PDF | 16 พ.ย. | ไฟล์แนบ seed (`id-card.pdf` ฯลฯ) เป็น PDF จริง 1 หน้า 1,024 ไบต์ (มี pages/xref) | **เว็บผิด**: TEST-DATA ข้อ 4 กำหนด "PDF จริงขนาดเล็ก" แต่ B02 (luna) ใส่แค่ header + ช่องว่าง → เปิดไม่ได้ · test ไม่จับเพราะตรวจแค่ชนิด/ขนาด/ดาวน์โหลด | เปิดไม่ได้ | pdfinfo: 1 หน้า · 1,024 ไบต์ · 51/51 | ACCEPT |
| UI/UX รอบ 1 | 16 พ.ย. | ผู้ตรวจ (Fable) ถ่ายภาพทุกหน้า 70 ภาพด้วย `scripts/ui-shots.cjs` แล้วแก้เอง: stepper ขั้นยื่นคำขอ · หน้าแรกประชาชน · หน้าคำขอเจ้าหน้าที่ · ปุ่ม/ตาราง · หน้า 403/404/หน้าว่าง · security headers (CSP ฯลฯ) | หลายหน้ายังดูไม่เสร็จ · ไม่มี security headers | 51/51 | 51/51 | ACCEPT |
| UI/UX รอบ 2 | 16 พ.ย. | **แบ่งบทบาท: Fable ตรวจ + เขียนรายการแก้ → Opus (subagent) ลงมือ → Fable ตรวจภาพ/diff/รัน test ซ้ำก่อน commit** · header มือถือ 2 แถว · `.kv` ใช้ร่วมฝั่งเจ้าหน้าที่/ประชาชน · ส่วนเอกสาร+QR · ฟอร์มตีกลับ/ไม่อนุมัติ/แสดงเลขเต็ม · ตารางมือถือไม่ตัดคำ · แก้ `/admin/users` ล้นจอ 375px (496px) · หน้า verify · KPI มือถือ 2 คอลัมน์ | ประหยัดโทเคนของรุ่นตรวจ · งานแก้ไฟล์เดียวกันไม่เหมาะแตก DAG ขนาน | 51/51 | 51/51 × 3 (Opus 2 + ผู้ตรวจ 1) · B07 ยังจับได้ 50/1 · ไม่มี `data-testid` ถูกแก้ | ACCEPT |
| ล่าบั๊กนอก 51 TC | 16 พ.ย. | Opus ไล่ FR-01–29 / BR-01–29 ด้วยการใช้งานจริง (API + เบราว์เซอร์) → แก้ 4 จุด (ดูหัวข้อ "ล่าบั๊กนอกชุดทดสอบ") + ชุด regression `tests/extra/` | test 51 ข้อผ่านหมดแต่ยังมีพฤติกรรมที่ไม่มีข้อไหนตรวจ | 51/51 · บั๊ก 4 ตัวที่ test มองไม่เห็น | 51/51 × 3 · extra 4/4 (ล้ม 4/4 เมื่อถอดการแก้) · เมทริกซ์ B01–B12 ตรง BUGS.md ทุกตัว | ACCEPT |
| autoresume v1→v2 | 16 พ.ย. | ตรวจโควตาจาก `status` ด้วย | resume เปล่า 2 ครั้งเพราะโควตา ≥ 80% | – | ยังไม่ได้ทดสอบจริง | รอทดสอบ |

## ล่าบั๊กนอกชุดทดสอบ (16 พ.ย. 69)

วิธี: ผู้ตรวจ (Fable) เขียนโจทย์ → Opus (subagent) ใช้งานจริงทุก FR/BR เทียบกับ `egov-brief` → จำแนก เว็บผิด / โจทย์ไม่ชัด / ไม่ใช่บั๊ก → แก้เฉพาะเว็บผิด + เขียน regression test → ผู้ตรวจอ่าน diff เทียบข้อกฎ และรัน test ซ้ำเองก่อน commit

| # | กฎ | อาการ (เว็บผิด) | แก้ | test |
|---|---|---|---|---|
| F1 | FR-17 · CONTRACT §2.6 | ส่วน "เอกสารดิจิทัล" มี `</div>` เกิน 1 ตัว → หลังกด "ออกเอกสาร" ลิงก์ PDF และไทม์ไลน์หายจนกว่าจะโหลดหน้าใหม่ | `src/routes/documents.js` ลบแท็กเกิน | EX-01 |
| F2 | DECISIONS A-41 · FR-22 | "งานในมือรายเจ้าหน้าที่" เปลี่ยนตามตัวกรองบริการ (เลือก SV-01 แล้ว off.reg2 = 3 แทน 9) กระทบไฟล์ส่งออกด้วย | `src/routes/dashboard.js` นับจากทุกบริการ | EX-02 |
| F3 | DECISIONS A-38 | URL ที่ %-encoding เสีย (เช่น `/verify/%`) ตอบ 500 + stack trace แทน 400 | `src/server.js` แปลง decode error เป็น 400 `BAD_REQUEST` | EX-03 |
| F4 | BR-19 · A-32 · BR-27 | เหตุผลตีกลับ/ไม่อนุมัติ/แสดงเลขเต็มที่ส่งเป็น object กลายเป็น "[object Object]" ผ่านเกณฑ์ 10 ตัวอักษรและถูกบันทึกลง audit | `src/routes/officer.js` รับเฉพาะข้อความ | EX-04 |

รันชุด regression: `npx playwright test -c playwright.extra.config.ts` (แยกจาก 51 TC ของโจทย์ ไม่กระทบตาราง BUG_MODE)

ตรวจแล้วถูกต้อง (ไม่ใช่บั๊ก): ค่าธรรมเนียม/SLA/วันหยุดที่ admin แก้มีผลจริง · ยอดล็อกเมื่อสร้าง QR ใหม่ · callback ซ้ำ · ยกเลิกอัตโนมัติ 168 ชม. · แจ้งเตือนหลังเลื่อนนาฬิกา · audit ครบ 10 เหตุการณ์ · ตัวเลข dashboard หลังมีรายการใหม่ · ไฟล์ดาวน์โหลดทุกชนิดเปิดได้ · 401/403/404/413 · CSP ไม่บล็อกอะไร

คำถามถึง TA เพิ่ม (โจทย์ไม่ชัด · ไม่แก้เอง):
1. admin เปลี่ยนบทบาท/ฝ่ายของเจ้าหน้าที่ที่ถือเรื่องอยู่ (A-28, FR-27) → เรื่องยังติดชื่อเดิม · ถ้าลดบทบาทหัวหน้าคนเดียว เรื่องรออนุมัติไม่มีผู้อนุมัติ
2. ไฟล์ที่แนบตอนส่งแก้ไขนับรวมเพดาน 5 ไฟล์ (BR-07, A-29) → คำขอที่มี 5 ไฟล์แล้วแนบฉบับแก้ไม่ได้
3. การเปลี่ยนบทบาทมีผลเมื่อใด: CONTRACT §6.5 "login ครั้งถัดไป" แต่เว็บมีผลทันทีที่ request ถัดไป
4. รูปแบบ PDF ของ dashboard: A-50 กับ CONTRACT §7 เขียนไม่ตรงกัน (เว็บทำตาม CONTRACT)
5. ร่างรอชำระไม่มีวันหมดอายุ · รหัสตรวจสอบเอกสารแยกตัวพิมพ์ · ชื่อวันหยุดที่ส่งเป็น object ถูกเก็บเป็น "[object Object]" (ยังไม่แก้)

## สรุปภาพรวม (สำหรับผู้ตรวจ)

| หัวข้อ | ผล |
|---|---|
| ระบบ | e-Service เทศบาล: Node 20 + Express + SQLite · Docker Compose คำสั่งเดียว · TEST_MODE + BUG_MODE |
| ทีมเอเจนต์ | 15 บล็อก · 4 บัญชี (Claude 2 + Codex ฟรี 2) · 24 การเรียก · 4.77M tokens · failover อัตโนมัติ 1 ครั้ง · resume หลังโควตารีเซ็ต 1 ครั้ง |
| การแบ่งงาน | Claude (opus) ทำตรรกะ/test · luna ทำ seed, โครง test, โลโก้ และตรวจไขว้ 3 บล็อก review · แผน vs จริงใน `REPORT.md` + `compare.png` |
| คุณภาพ | Playwright 51/51 · BUG_MODE จับได้ 12/12 · GIF P1 43/43 · ไม่แก้ผลคาดหวังตามหน้าจอ |
| เปิดเว็บเอง | ดูหัวข้อ "เปิดเว็บและรัน test บนเครื่อง" ด้านล่าง → `http://localhost:3000` |

## เปิดเว็บและรัน test บนเครื่อง

ทุกคำสั่งเริ่มจาก **โฟลเดอร์ root ของ repo** (`week2_student_-egov`) · ต้องเปิด Docker Desktop ก่อน · ทดสอบแล้วบน Windows 16 พ.ย. 69

**PowerShell (Windows / terminal ของ VS Code)** — PowerShell ไม่รองรับรูปแบบ `TEST_MODE=1 คำสั่ง` ต้องตั้ง `$env:` ก่อน
```powershell
cd week2\egov-eservice\app
$env:TEST_MODE = '1'; $env:BUG_MODE = ''        # เปิดบั๊ก: $env:BUG_MODE = 'B01'
docker compose up --build -d --wait             # → http://localhost:3000
# ล็อกอินประชาชน: เลขบัตร 1101700123456 · OTP 123456 · เจ้าหน้าที่: off.reg1 / Test@1234

npm ci; npx playwright install chromium         # ครั้งแรกครั้งเดียว
$env:BASE_URL = 'http://localhost:3000'; $env:DB_PATH = "$PWD\data\egov.db"
npx playwright test                             # คาดหวัง 51 passed
docker compose down                             # ปิดเว็บ
```

**bash (Git Bash / Linux / ใน container)**
```bash
cd week2/egov-eservice/app
TEST_MODE=1 docker compose up --build -d --wait
npm ci && npx playwright install chromium
BASE_URL=http://localhost:3000 DB_PATH=$PWD/data/egov.db npx playwright test
```

หมายเหตุ: TC-NFR-03 ส่วน "ปิด hook" ต้องมีเว็บตัวที่สองที่ไม่ตั้ง `TEST_MODE` (`NO_TEST_MODE_BASE_URL`) · ถ้าไม่ตั้ง test จะข้ามส่วนนั้นแต่ยังผ่าน · ชุดเต็มพร้อม BUG_MODE ใช้ `scripts/bug-matrix.sh` (bash)
| บทเรียน | แผน token เกินจริง ≈ 6 เท่า (ได้ k ใหม่ใน calib) · บล็อกรวม+ทดสอบต้อง timeout ≥ 2 ชม. · auto-resume ต้องดูเกณฑ์ 80% ของ agent-team · บัญชีฟรีเหมาะกับงานเบา/ตรวจ |
