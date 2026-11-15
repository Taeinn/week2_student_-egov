#!/usr/bin/env bash
# autoresume.sh — เฝ้า run ของ agent-team · จบแล้วถ้ามีบล็อกล้ม/ถูก block (เช่นโควตาหมด)
# รอจนบัญชีพร้อม (หลังโควตารีเซ็ต) แล้ว `run --resume` ให้เอง · ครบแล้วสั่ง dagplan report
# รันใน container:  nohup bash autoresume.sh <RUN_ID> > autoresume.log 2>&1 &
set -u
RUN=${1:?run_id}
PLAN=egov-eservice
WORKERS=${WORKERS:-yolo1,yolo2,cyolo1,cyolo2}
MAX_RESUME=${MAX_RESUME:-3}        # กันวนเผาโทเคนถ้าล้มเพราะเหตุอื่นที่ไม่ใช่โควตา
CHECK_EVERY=${CHECK_EVERY:-900}    # วินาที ระหว่างตรวจความพร้อมบัญชี
T=/root/ai-accounts/.Claude/shared/skills/agent-team/scripts/team.py
D=/root/ai-accounts/.Claude/shared/skills/dag-planner/scripts/dagplan.py
ST=/workspace/.agent-team/$RUN/state.json
log(){ echo "[$(date '+%F %T')] $*"; }

not_ok(){ python3 - "$ST" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
print(" ".join(f"{k}:{v['status']}" for k,v in s["nodes"].items() if v["status"]!="ok"))
PY
}

n=0
while :; do
  while pgrep -f "team.py run .*$RUN|--resume $RUN" >/dev/null; do sleep 60; done
  bad=$(not_ok)
  if [ -z "$bad" ]; then log "ทุกบล็อก ok → report"; python3 $D report $PLAN; log "DONE"; exit 0; fi
  log "ยังไม่ครบ: $bad"
  if [ $n -ge $MAX_RESUME ]; then log "resume ครบ $MAX_RESUME ครั้งแล้ว หยุด · ให้คนตรวจสาเหตุ"; python3 $D report $PLAN; exit 1; fi
  # รอจนมีบัญชี Claude พร้อมอย่างน้อย 1 (งานหลักเป็นฝั่ง yolo)
  # ต้องผ่านทั้ง check (ล็อกอิน/เรียกได้) และ status ของ run (โควตา < เกณฑ์ 80% ของ agent-team)
  # รุ่นแรกดูแค่ check → resume ทันทีทั้งที่โควตา 80–98% แล้วล้มทันที 2 ครั้งติด (15 พ.ย. 23:05)
  until python3 $T check --workers "$WORKERS" 2>/dev/null | grep -E '^\| yolo[0-9] \| พร้อม' >/dev/null \
     && python3 $T status --run "$RUN" 2>/dev/null | grep -E '^\| yolo[0-9] \| ลูกทีม \|.*\| พร้อม \|$' >/dev/null; do
    log "ยังไม่มีบัญชี yolo พร้อม (โควตาหมด?) · ตรวจใหม่ใน ${CHECK_EVERY}s"
    python3 $T quota --workers "$WORKERS" 2>/dev/null | grep -E '^\| (c?yolo[0-9])' | grep -E 'yolo1|yolo2'
    sleep "$CHECK_EVERY"
  done
  n=$((n+1)); log "resume ครั้งที่ $n"
  python3 $T run --resume "$RUN" --workers "$WORKERS"
done
