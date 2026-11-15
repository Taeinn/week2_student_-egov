# CLAUDE.md · egov-week2

งาน LAB Week 2: สร้างเว็บ e-Service กลาง (เทศบาลสมมติ) ด้วยทีมเอเจนต์ใน container + dag-planner แล้วพิสูจน์ด้วย Playwright 51 TC

**เริ่มทุกครั้งให้อ่าน [`week2/HANDOFF.md`](week2/HANDOFF.md) ก่อน** (สถานะ · สภาพแวดล้อม · ขั้นต่อไป · การตัดสินใจ · ข้อควรระวัง)

- `egov-brief/` = ชุดโจทย์ของ TA **ห้ามแก้** · พรอมต์แต่ละขั้นอยู่ใน `egov-brief/PROMPTS.md`
- ผลงานทั้งหมดอยู่ใต้ `week2/egov-eservice/`
- ทำงานใน container ผ่าน `docker exec` เท่านั้น · ห้ามล็อกอินบัญชีแทนผู้ใช้ · ห้ามอ่านไฟล์ credential
- ขั้นที่ใช้โทเคน (`run` ของ dag-planner) ต้องถามผู้ใช้ก่อนเสมอ
- ห้ามแก้ผลที่คาดหวังใน test ให้ตรงหน้าจอ · ตัวเลข/กฎต้องตรง REQUIREMENTS + TEST-DATA
- Git Bash บน Windows: `export MSYS_NO_PATHCONV=1` ก่อนสั่ง docker
- เสร็จแต่ละ LAB ให้อัปเดตตารางความคืบหน้าใน `week2/HANDOFF.md` แล้ว commit + push
