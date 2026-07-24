#!/bin/sh
set -eu

POT_PORT="${POT_PORT:-4416}"
POT_DIR="${POT_DIR:-/opt/bgutil-ytdlp-pot-provider/server}"

echo "[start] PO Token provider on :${POT_PORT}"
cd "$POT_DIR"
node build/main.js --port "$POT_PORT" &
POT_PID=$!

i=0
ready=0
while [ "$i" -lt 45 ]; do
  if ! kill -0 "$POT_PID" 2>/dev/null; then
    echo "[start] PO Token provider exited early"
    break
  fi
  if wget -q -O /dev/null "http://127.0.0.1:${POT_PORT}/" 2>/dev/null \
    || wget -q -O /dev/null "http://127.0.0.1:${POT_PORT}/ping" 2>/dev/null \
    || node -e "require('net').connect({port:${POT_PORT},host:'127.0.0.1'},()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" = "1" ]; then
  echo "[start] PO Token provider ready"
else
  echo "[start] WARN: PO Token provider may not be ready yet (continue anyway)"
fi

export YT_DLP_BIN="${YT_DLP_BIN:-$(command -v yt-dlp || true)}"
export YT_DLP_POT_BASE_URL="${YT_DLP_POT_BASE_URL:-http://127.0.0.1:${POT_PORT}}"
export YT_DLP_POT_ENABLED="${YT_DLP_POT_ENABLED:-1}"

cd /app
echo "[start] app with YT_DLP_BIN=${YT_DLP_BIN:-bundled}"
exec node server.js
