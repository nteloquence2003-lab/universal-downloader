FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# 系統 yt-dlp + PO Token plugin（雲端防機器人用）
RUN pip3 install --break-system-packages -U \
    "yt-dlp[default]" \
    bgutil-ytdlp-pot-provider

# PO Token HTTP server（預設 :4416）
# 不鎖版號，與 pip 的 bgutil-ytdlp-pot-provider 一併用最新
RUN git clone --depth 1 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
      /opt/bgutil-ytdlp-pot-provider \
  && cd /opt/bgutil-ytdlp-pot-provider/server \
  && npm ci \
  && npx tsc \
  && npm cache clean --force

COPY package.json package-lock.json ./

ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

RUN npm ci --omit=dev \
  && node node_modules/youtube-dl-exec/scripts/postinstall.js \
  && node node_modules/ffmpeg-static/install.js \
  && ./node_modules/youtube-dl-exec/bin/yt-dlp -U || true

COPY server.js ./
COPY static ./static
COPY start.sh ./
RUN chmod +x /app/start.sh

ENV NODE_ENV=production
ENV POT_PORT=4416
ENV YT_DLP_BIN=/usr/local/bin/yt-dlp
ENV YT_DLP_POT_BASE_URL=http://127.0.0.1:4416
ENV YT_DLP_POT_ENABLED=1

EXPOSE 8787

CMD ["/app/start.sh"]
