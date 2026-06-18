FROM node:20-slim

# Install Chromium + build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    python3 make g++ \
    --no-install-recommends \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV DOCKER=1

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY data/favicon.ico ./data/
COPY data/qr.html ./data/

# WhatsApp session + SQLite data persisted via volume
VOLUME ["/app/.wwebjs_auth", "/app/data"]

EXPOSE 3099

CMD ["node", "src/index.js"]
