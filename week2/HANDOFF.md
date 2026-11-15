# HANDOFF · ทำต่อบนเครื่องอื่น

> **อัปเดต 16 พ.ย. 2569: ทำครบ LAB 1–5 แล้ว** · บันทึกทุกขั้น + ผล → [`WORKLOG.md`](WORKLOG.md) (เนื้อหาด้านล่างเป็นสถานะเดิม ณ 15 พ.ย. ใช้อ้างอิงการตั้งเครื่อง)
>
> สถานะ ณ 15 พ.ย. 2569: ทำเสร็จ LAB 1–2 (สรุปโจทย์ + แผน DAG/Gantt) · **ยังไม่มีตัวเว็บ** · LAB 3–5 ยังไม่เริ่ม
> โจทย์ฉบับเต็ม: [`../egov-brief/README.md`](../egov-brief/README.md) · พรอมต์ทีละขั้น: [`../egov-brief/PROMPTS.md`](../egov-brief/PROMPTS.md)

## 1. ความคืบหน้า

| LAB | ผลงาน | สถานะ | อยู่ที่ |
|---|---|---|---|
| 1 | สรุปโจทย์ + ตอบ 3 ข้อเช็ก | ✅ | [`LAB1-LAB2-NOTES.md`](LAB1-LAB2-NOTES.md) |
| 2 | `blocks.json` · `dag.png` · `gantt-plan.png` · `PLAN.md` + ตรวจขั้น 2 ผ่านครบ | ✅ | [`egov-eservice/`](egov-eservice/) |
| 3 | `app/` (ตัวเว็บ) · `gantt-actual.png` · `compare.png` · `REPORT.md` | ❌ | – |
| 4 | `test-report/` (Playwright 51 TC + GIF ของ TC ระดับ P1) | ❌ | – |
| 5 | `BUG-HUNT.md` (B01–B12) | ❌ | – |

ของที่ต้องส่งตามท้าย PROMPTS: ทุกไฟล์ในตารางนี้ อยู่ใต้ `week2/egov-eservice/`

## 2. สภาพแวดล้อมที่ต้องมีบนเครื่องใหม่

| ต้องมี | ตรวจยังไง |
|---|---|
| Docker Desktop + container ทีมเอเจนต์ (`devtools` หรือ `multi-account` จากบท 03 ของ week 2) รันอยู่ | `docker ps` |
| ใน container มีสกิล `dag-planner` `agent-team` `yolo` `cyolo` ที่ `/root/ai-accounts/.Claude/shared/skills/` | `docker exec <container> ls /root/ai-accounts/.Claude/shared/skills` |
| บัญชี **yolo1 (Claude)** และ **cyolo1 (Codex)** ล็อกอินแล้ว | `doctor` ต้องขึ้น "บัญชีพร้อม: cyolo1, yolo1" |
| Git + สิทธิ์ push repo นี้ | `git push` |

ล็อกอินบัญชี (ต้องทำเอง ห้ามให้ AI ล็อกอินแทน): JupyterLab ของ container → **+ → Terminal** → พิมพ์ `yolo1` → **Claude account with subscription** → ยืนยันในเบราว์เซอร์ → **Yes, I trust this folder** · Codex: `cyolo1` → **Sign in with ChatGPT** (หรือ `cyolo1 login --device-auth`)

ทีมนี้มีแค่ 2 บัญชี (yolo1 + cyolo1) · พรอมต์ใน PROMPTS ที่พูดถึง yolo2 / cyolo2 ให้ปรับเป็น 2 บัญชีนี้

## 3. เอาแผนกลับเข้า container (ทำครั้งแรกบนเครื่องใหม่)

แผนใน container เป็นของเครื่องเดิม ไม่ได้ติดมากับ git · `blocks.json` ใน repo คือต้นฉบับ สร้างแผนใหม่ได้ด้วยคำสั่งนี้ (ไม่ใช้โทเคน)

```bash
export MSYS_NO_PATHCONV=1            # Git Bash บน Windows: กันไม่ให้แปลง /root /workspace เป็น path ของ Windows
C=devtools                           # หรือ multi-account ตามชื่อ container ในเครื่องนั้น
D=/root/ai-accounts/.Claude/shared/skills/dag-planner/scripts/dagplan.py
docker cp egov-brief $C:/workspace/egov-brief
docker exec $C mkdir -p /workspace/plans/egov-eservice
docker cp week2/egov-eservice/blocks.json $C:/workspace/plans/egov-eservice/blocks.json
docker exec $C python3 $D doctor
docker exec $C python3 $D dag egov-eservice --blocks /workspace/plans/egov-eservice/blocks.json
docker exec $C python3 $D plan egov-eservice --max-agents 4            # ใช้โควตาจริง (ต้องล็อกอินครบ)
```

ถ้าบัญชียังไม่พร้อมแต่อยากดูแผน: เติม `--accounts yolo1:80,cyolo1:90` ท้ายคำสั่ง `plan` (โควตาสมมติ ไม่แตะบัญชี)

## 4. ขั้นต่อไป

1. **LAB 3** วางพรอมต์ "ขั้น 3" จาก PROMPTS (เปลี่ยน `multi-account` เป็นชื่อ container จริง) ⚠️ ใช้โทเคนทั้ง 2 บัญชี ≈ 25M ตามแผน ≈ 2 ชม. · ตกลงในกลุ่มก่อน · ผลคัดลอกกลับมาที่ `week2/egov-eservice/`
   - คำสั่งหลัก: `dagplan.py export egov-eservice` → `run egov-eservice --detach` → `report egov-eservice`
   - ตัวเว็บที่ทีมสร้างอยู่ใน container ที่ `/workspace/plans/egov-eservice/app/`
2. **LAB 4** พรอมต์ "ขั้น 4" → `test-report/` ห้ามแก้ผลที่คาดหวังใน test ให้ตรงหน้าจอ · ข้อที่ล้มต้องจำแนก เว็บผิด / test ผิด / โจทย์ผิด
3. **LAB 5** พรอมต์ "ขั้น 5" → `BUG-HUNT.md`
4. ทุกขั้นเสร็จแล้ว commit + push

## 5. การตัดสินใจที่ทำไปแล้ว (อย่าเปลี่ยนโดยไม่ตั้งใจ)

| เรื่อง | ตัดสินใจ | เหตุผล |
|---|---|---|
| container | ใช้ `devtools` แทน `multi-account` | เครื่องเดิมมีสกิลและบัญชีที่ล็อกอินอยู่ที่ `devtools` เท่านั้น (เครื่องใหม่ใช้ตัวไหนก็ได้ที่มีครบ) |
| บัญชี | yolo1 + cyolo1 (`--max-agents 4` = 2 slot ต่อบัญชีขึ้นไป) | ทีมมีแค่ 2 บัญชี |
| stack | Node.js 20 + Express + better-sqlite3 (`DB_PATH`) + HTML render ฝั่งเซิร์ฟเวอร์ (template literal ไม่มี build) + pdfkit + exceljs | ให้ทุกบล็อกสร้างไปทางเดียวกัน · กำหนดไว้ใน `goal` ของ `blocks.json` |
| เวลา | อ่านจาก `src/lib/clock.js` เท่านั้น (Asia/Bangkok) | กฎ README ข้อ 5 + test hook `/api/test/clock` |
| BUG_MODE | `isBug('Bxx')` ใน `src/lib/bugs.js` · แต่ละบล็อกฝังบั๊กของส่วนตัวเอง | ไม่ต้องมีบล็อกที่แก้ไฟล์คนอื่น |
| บั๊ก → บล็อก | B01 B03 B04 → B03 rules · B02 B05 B06 → B05 citizen · B07 B08 B09 B11 B12 → B06 officer · B10 → B09 dashboard | ตาม BUGS.md |
| Playwright | B11 (โครง + helper) → B12 ชุด A 22 TC / B13 ชุด B 29 TC · ห้ามอ่านโค้ดเว็บ | test เป็นอิสระจากเว็บ ทำขนานได้ (ตามขั้น 1) |
| repo | repo นี้แยกจาก `Teaching_CWN2026` (ห้าม push repo นั้นเด็ดขาด) | – |

## 6. ข้อควรระวังที่เจอมาแล้ว

- Git Bash แปลง `/root/...` `/workspace/...` เป็น path ของ Windows → `export MSYS_NO_PATHCONV=1` ก่อนสั่ง `docker exec`/`docker cp` (หรือใช้ PowerShell)
- `/workspace` ของ `devtools` bind-mount มาจากโฟลเดอร์บน host (เครื่องเดิม: `...\00_Devtool_Container\workspace`) ควรอยู่บนไดรฟ์ที่มีที่ว่าง (เครื่องเดิม C: เกือบเต็ม จึงทำทุกอย่างบน D:)
- zip ของ TA (`week2_student.zip`) ไม่มีโฟลเดอร์ชั้นนอก → ต้องแตกเข้าโฟลเดอร์ `egov-brief/` เอง (ใน repo ทำไว้แล้ว)
- `doctor` เตือน "มีบัญชีพร้อมแค่ฝั่งเดียว" = บล็อก yolo/review จะไม่มีใครรับ → อย่าเพิ่ง `run`
- ห้ามอ่าน/แสดง `.credentials.json` `.claude.json` `auth.json` · ห้ามลบ/หยุด container
