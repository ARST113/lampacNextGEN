#!/usr/bin/env bash
# Реальный тест на ПК с настоящим AC3-стримом через локальное зеркало lampac.fun.
#   pc-mirror-test.sh http      -> http://127.0.0.1:8099  (secure, НЕ isolated: ST-сборка + AudioWorklet)
#   pc-mirror-test.sh https     -> https://127.0.0.1:8099 (secure + COOP/COEP credentialless: pthread + AudioWorklet)
#   pc-mirror-test.sh insecure  -> http://mirror-host.example:8099 (НЕ secure: ST-сборка + ScriptProcessor, как в старом WebView)
set -euo pipefail

MODE="${1:-http}"
PORT="${2:-8099}"
HERE="$(cd "$(dirname "$0")" && pwd)"
AND="$HERE/../android"
STREAM="http://source-host.example:2367/stream/The.Wild.Robot.2024.1080p.BluRay.x264-ZoroSenpai_EniaHD.mkv?link=&lt;hash&gt;&index=1&play"
export LD_LIBRARY_PATH=/srv/deepseek-harness/home/Servers/tfg-runtime/lib/usr/lib/x86_64-linux-gnu

b64url() { python3 -c "import base64,sys;print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip('='))" "$1"; }

case "$MODE" in
  https)    SITE="https://127.0.0.1:$PORT/"
            PLAY_URL="https://127.0.0.1:$PORT/mpvwasm/proxy?u=$(b64url "$STREAM")"
            MIRROR_ENV="ISOLATED=1 PLUGIN_ONLY=1"; MIRROR_ARGS="--tls" ;;
  insecure) SITE="http://mirror-host.example:$PORT/"
            PLAY_URL="$STREAM"
            MIRROR_ENV="ISOLATED=0 PLUGIN_ONLY=1"; MIRROR_ARGS="" ;;
  lampac)   SITE="http://127.0.0.1:$PORT/"
            PLAY_URL="https://lampac.fun/mpvwasm/proxy?u=$(b64url "$STREAM")"
            MIRROR_ENV="ISOLATED=0 PLUGIN_ONLY=1 RELAY=0"; MIRROR_ARGS="" ;;
  *)        SITE="http://127.0.0.1:$PORT/"
            PLAY_URL="$STREAM"
            MIRROR_ENV="ISOLATED=0 PLUGIN_ONLY=1"; MIRROR_ARGS="" ;;
esac

LOG="/tmp/mirror-$MODE.log"
cd "$AND"
env $MIRROR_ENV nohup python3 mirror.py "$PORT" $MIRROR_ARGS > "$LOG" 2>&1 &
MIRROR_PID=$!
trap 'kill $MIRROR_PID 2>/dev/null || true' EXIT
sleep 1
echo "== зеркало pid=$MIRROR_PID ($MODE), сайт=$SITE"
echo "== поток для плеера: ${PLAY_URL:0:110}..."

cd "$HERE"
OUT="$HERE/pc-mirror-$MODE.json"
export OUT
SECONDS="${SECONDS:-95}" timeout 500 \
  xvfb-run -a -s '-screen 0 1400x900x24' node pc-real-stream.js "$SITE" "$PLAY_URL" 2>&1 \
  | grep -vE '\{"t":[0-9]+,"tap"' | tail -30

echo "== какие сборки демуксера запрашивал воркер (по логу зеркала):"
grep -oE 'GET /mpvwasm/assets/(mpvwasm-demuxer[a-z-]*\.(js|wasm))' "$LOG" | sort | uniq -c || true
echo "== сводка:"
python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('контекст:', d.get('context'))
print('tap:', (d.get('final') or {}).get('tap'))
print('запись:', d.get('recording'))
PY
