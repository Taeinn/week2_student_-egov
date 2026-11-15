#!/usr/bin/env bash
# รันชุด Playwright เต็ม 51 TC กับเว็บใน Docker Compose ทีละโหมด แล้วสรุปเทียบ BUGS.md §2 (บล็อก B14)
#   scripts/bug-matrix.sh                          # clean B01 … B12 (13 รอบ)
#   scripts/bug-matrix.sh clean B03,B07 B01,B05,B09
#   NO_RESTART=1 scripts/bug-matrix.sh clean-rerun # รันซ้ำทันทีโดยไม่ restart เว็บ (BUGS.md §3 ขั้น 2)
# โหมด clean* = ไม่ตั้ง BUG_MODE · ผลอยู่ที่ test-results/matrix/<โหมด>.{log,json,serverlog}
# ก่อนรัน: docker compose build (ถ้าแก้โค้ด) · npm ci (devDeps) · npx playwright install chromium
#          (หรือตั้ง PW_CHROMIUM_PATH ให้ชี้ Chromium ที่มีในเครื่อง)
# ตัวแปรเสริม: NOTEST_PORT (ค่าเริ่มต้น 3001) = พอร์ตของอินสแตนซ์ที่ไม่ตั้ง TEST_MODE สำหรับ TC-NFR-03
#              (สคริปต์เปิดคอนเทนเนอร์ egov-notest จาก image เดียวกันให้เอง · NOTEST=0 = ไม่เปิด)
set -u
cd "$(dirname "$0")/.."
OUT=test-results/matrix
mkdir -p "$OUT"
if [ $# -eq 0 ]; then set -- clean B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12; fi
export BASE_URL="${BASE_URL:-http://localhost:3000}"
export DB_PATH="${DB_PATH:-$PWD/data/egov.db}"

# อินสแตนซ์ที่ปิด TEST_MODE (ตรวจ /api/test/* = 404 ใน TC-NFR-03) · DB อยู่ใน /tmp ของคอนเทนเนอร์ ไม่ชน DB หลัก
if [ "${NOTEST:-1}" != 0 ]; then
  NOTEST_PORT="${NOTEST_PORT:-3001}"
  if ! docker ps --format '{{.Names}}' | grep -qx egov-notest; then
    docker run -d --rm --name egov-notest -p "$NOTEST_PORT:3000" -e DB_PATH=/tmp/notest.db \
      -e BASE_URL="http://localhost:$NOTEST_PORT" egov-eservice:latest >/dev/null || true
    for i in $(seq 1 30); do curl -sf "http://localhost:$NOTEST_PORT/api/health" >/dev/null && break; sleep 0.5; done
  fi
  export NO_TEST_MODE_BASE_URL="http://localhost:$NOTEST_PORT"
fi

files=()
for mode in "$@"; do
  case "$mode" in clean*) bug="" ;; *) bug="$mode" ;; esac
  if [ "${NO_RESTART:-}" != 1 ]; then
    echo "### [$mode] docker compose up (TEST_MODE=1 BUG_MODE=$bug)"
    TEST_MODE=1 BUG_MODE="$bug" docker compose up -d --force-recreate --wait >/dev/null 2>&1 \
      || { echo "docker compose up ล้มเหลว"; docker compose logs --tail 30; exit 2; }
  else
    echo "### [$mode] ไม่ restart เว็บ (NO_RESTART=1)"
  fi
  docker compose logs --no-log-prefix web 2>/dev/null | grep 'BUG_MODE=' | tail -1 > "$OUT/$mode.serverlog"
  cat "$OUT/$mode.serverlog"
  PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/$mode.json" npx --no-install playwright test --reporter=list,json > "$OUT/$mode.log" 2>&1
  tail -4 "$OUT/$mode.log"
  files+=("$OUT/$mode.json")
done
node scripts/summarize.cjs "${files[@]}"
