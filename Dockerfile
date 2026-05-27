FROM node:20-slim

# 1. 필수 유틸리티 및 구글 크롬 공식 저장소 등록 (경로 교정 완료)
RUN apt-get update && apt-get install -y wget gnupg ca-certificates procps \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y \
    google-chrome-stable \
    fonts-noto-cjk \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libnss3 \
    libxss1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Node.js 의존성 빌드
COPY package*.json ./
RUN npm install

# 3. 소스코드 전체 카피
COPY . .

# Puppeteer 중복 다운로드 방지
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 3030

CMD ["node", "server.js"]