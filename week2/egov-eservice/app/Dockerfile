# e-Service กลาง เทศบาลนครตัวอย่าง · Node.js 20 + Express + better-sqlite3
# build stage: มี python3/make/g++ เผื่อ better-sqlite3 ต้องคอมไพล์เอง (ถ้าโหลด prebuilt ไม่ได้)
FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

FROM node:20-bookworm-slim
WORKDIR /app
# ฟอนต์ไทยสำหรับ PDF (pdfkit) · ถ้าติดตั้งไม่ได้ เว็บยังทำงานได้ (PDF ใช้ฟอนต์ ASCII แทน)
RUN apt-get update \
 && (apt-get install -y --no-install-recommends fonts-tlwg-garuda-ttf || true) \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/egov.db \
    THAI_FONT_PATH=/usr/share/fonts/truetype/tlwg/Garuda.ttf \
    THAI_FONT_BOLD_PATH=/usr/share/fonts/truetype/tlwg/Garuda-Bold.ttf \
    TZ=Asia/Bangkok
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
# healthcheck = เปิด TCP ไปที่พอร์ตเว็บเท่านั้น (ไม่ส่ง HTTP request) เพราะทุก HTTP request ยกเว้น /api/test/*
# ต้องประเมินแจ้งเตือน SLA ตามนาฬิกาปัจจุบัน (CONTRACT §0.7) ถ้า probe ยิง /api/health ตกช่วงระหว่าง
# POST /api/test/reset กับ PUT /api/test/clock จะสร้างแจ้งเตือนที่ 09:00 ทำให้ TC-NOTI-* ล้มแบบสุ่ม (B14)
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=5 \
  CMD node -e "require('net').connect(+(process.env.PORT||3000),'127.0.0.1').on('connect',function(){this.destroy();process.exit(0)}).on('error',function(){process.exit(1)})"
CMD ["node", "src/server.js"]
