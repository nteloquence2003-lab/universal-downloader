FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

RUN npm ci --omit=dev \
  && node node_modules/youtube-dl-exec/scripts/postinstall.js \
  && node node_modules/ffmpeg-static/install.js \
  && ./node_modules/youtube-dl-exec/bin/yt-dlp -U || true

COPY server.js ./
COPY static ./static

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "server.js"]
