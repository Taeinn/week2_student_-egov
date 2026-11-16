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
| autoresume v1→v2 | 16 พ.ย. | ตรวจโควตาจาก `status` ด้วย | resume เปล่า 2 ครั้งเพราะโควตา ≥ 80% | – | ยังไม่ได้ทดสอบจริง | รอทดสอบ |

## สรุปภาพรวม (สำหรับผู้ตรวจ)

| หัวข้อ | ผล |
|---|---|
| ระบบ | e-Service เทศบาล: Node 20 + Express + SQLite · Docker Compose คำสั่งเดียว · TEST_MODE + BUG_MODE |
| ทีมเอเจนต์ | 15 บล็อก · 4 บัญชี (Claude 2 + Codex ฟรี 2) · 24 การเรียก · 4.77M tokens · failover อัตโนมัติ 1 ครั้ง · resume หลังโควตารีเซ็ต 1 ครั้ง |
| การแบ่งงาน | Claude (opus) ทำตรรกะ/test · luna ทำ seed, โครง test, โลโก้ และตรวจไขว้ 3 บล็อก review · แผน vs จริงใน `REPORT.md` + `compare.png` |
| คุณภาพ | Playwright 51/51 · BUG_MODE จับได้ 12/12 · GIF P1 43/43 · ไม่แก้ผลคาดหวังตามหน้าจอ |
| เปิดเว็บเอง | `cd week2/egov-eservice/app && TEST_MODE=1 docker compose up --build -d` → `http://localhost:3000` |
| บทเรียน | แผน token เกินจริง ≈ 6 เท่า (ได้ k ใหม่ใน calib) · บล็อกรวม+ทดสอบต้อง timeout ≥ 2 ชม. · auto-resume ต้องดูเกณฑ์ 80% ของ agent-team · บัญชีฟรีเหมาะกับงานเบา/ตรวจ |
