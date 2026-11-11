FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    LLM_MODE=off \
    REPORT_TZ=Asia/Shanghai \
    REPORT_HOUR=6,13,19 \
    REPORT_LOCALE=zh

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN mkdir -p daily_reports logs

VOLUME ["/app/daily_reports", "/app/logs"]
CMD ["npx", "tsx", "scripts/docker-daily.mjs"]
