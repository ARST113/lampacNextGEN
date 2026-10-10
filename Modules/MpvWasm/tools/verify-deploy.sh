#!/usr/bin/env bash
# Сверка: то, что реально лежит на lampac, совпадает с локальными файлами выкладки.
# Ровно этого шага не хватило 10.10.2026: на сервере оставался старый воркер
# (android-1), и DTS молчал, хотя локально всё было уже починено.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY="$HERE/deploy"
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
export LAMPAC_PW="$PW"

PAIRS=(
  "$DEPLOY/mpvwasm-demuxer-st.js:/home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js"
  "$DEPLOY/mpvwasm-demuxer-st.wasm:/home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.wasm"
  "$DEPLOY/mpvwasm-demuxer-st-legacy.js:/home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st-legacy.js"
  "$DEPLOY/mpvwasm-demuxer.js:/home/lampac/plugins/mpvwasm/mpvwasm-demuxer.js"
  "$DEPLOY/mpvwasm-audio-only-worker.js:/home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js"
  "$DEPLOY/mpvwasm-audio-only-worklet.js:/home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worklet.js"
  "$DEPLOY/mpvwasm-lampa-audio.js:/home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js"
  "$DEPLOY/loader.js:/home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio-loader.js"
  "$HERE/check-page/audio-wasm-check2.html:/home/lampac/wwwroot/lampac-js/uploads/audio-wasm-check2.html"
)

REMOTE_PATHS=""
LOCAL_ROWS=""
for pair in "${PAIRS[@]}"; do
  local_path="${pair%%:*}"; remote_path="${pair##*:}"
  [ -f "$local_path" ] || { echo "НЕТ ЛОКАЛЬНО: $local_path"; continue; }
  REMOTE_PATHS+="$remote_path "
  LOCAL_ROWS+="$(md5sum "$local_path" | awk '{print $1}')  $(basename "$local_path")"$'\n'
done

cat > /tmp/verify-deploy-inner.sh <<EOS
PW='$PW'
S(){ echo "\$PW" | sudo -S -p '' "\$@"; }
S md5sum $REMOTE_PATHS
EOS
REMOTE_MD5="$(REMOTE_TIMEOUT=150 bash "$ROOT/remote-run.sh" /tmp/verify-deploy-inner.sh 2>&1 | grep -E '^[0-9a-f]{32} ' || true)"

echo "== локально"; printf '%s' "$LOCAL_ROWS"
echo "== на сервере"; printf '%s\n' "$REMOTE_MD5"
fail=0
while read -r sum name; do
  [ -n "${sum:-}" ] || continue
  if ! printf '%s\n' "$REMOTE_MD5" | grep -q "$sum"; then
    echo "РАСХОЖДЕНИЕ: $name ($sum)"
    fail=1
  fi
done <<< "$LOCAL_ROWS"
if [ "$fail" = 0 ]; then echo "OK: все файлы на сервере совпадают с локальными"; else echo "ВНИМАНИЕ: есть расхождения — выкладывайте заново"; exit 2; fi
