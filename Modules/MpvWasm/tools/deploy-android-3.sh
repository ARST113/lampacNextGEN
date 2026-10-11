#!/usr/bin/env bash
# Выкладка доработанного аудио-моста (android-3) на lampac.
#   файлы: android/deploy/*  -> /home/lampac/{plugins/mpvwasm,wwwroot/lampac-js/uploads}
#   бэкап: /home/lampac_backups/module/MpvWasm-audio-bridge-<ts>/
# lampac НЕ перезапускается: всё это статические файлы.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY="$HERE/deploy"
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
export LAMPAC_PW="$PW"
REMOTE=/tmp/deploy-audio-4
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"
echo "== заливаю файлы в $REMOTE"
LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  lampac-user@lampac.example "rm -rf $REMOTE && mkdir -p $REMOTE" </dev/null

LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  "$DEPLOY/mpvwasm-demuxer-st.js" "$DEPLOY/mpvwasm-demuxer.js" "$DEPLOY/mpvwasm-audio-only-worker.js" \
  "$DEPLOY/mpvwasm-audio-only-worklet.js" "$DEPLOY/mpvwasm-lampa-audio.js" \
  "$DEPLOY/loader.js" "lampac-user@lampac.example:$REMOTE/" </dev/null

cat > /tmp/deploy-audio-4-inner.sh <<REMOTE_SCRIPT
set -e
PW='$PW'
S(){ echo "\$PW" | sudo -S -p '' "\$@"; }
TS='$STAMP'
BK=/home/lampac_backups/module/MpvWasm-audio-bridge-\$TS
S mkdir -p "\$BK"
S cp -a /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js            "\$BK/mpvwasm-demuxer-st.js.orig"
S cp -a /home/lampac/plugins/mpvwasm/mpvwasm-demuxer.js               "\$BK/mpvwasm-demuxer.js.orig"
S cp -a /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js      "\$BK/mpvwasm-audio-only-worker.js.orig"
S cp -a /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worklet.js    "\$BK/mpvwasm-audio-only-worklet.js.orig"
S cp -a /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js "\$BK/mpvwasm-lampa-audio.js.orig"
S cp -a /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio-loader.js "\$BK/mpvwasm-lampa-audio-loader.js.orig"
echo "backup: \$BK"

S install -o root -g lampac-editors -m 644 $REMOTE/mpvwasm-demuxer-st.js         /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js
S install -o root -g lampac-editors -m 644 $REMOTE/mpvwasm-demuxer.js            /home/lampac/plugins/mpvwasm/mpvwasm-demuxer.js
S install -o root -g lampac-editors -m 644 $REMOTE/mpvwasm-audio-only-worker.js  /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js
S install -o root -g lampac-editors -m 644 $REMOTE/mpvwasm-audio-only-worklet.js /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worklet.js
S install -o root -g lampac-editors -m 644 $REMOTE/mpvwasm-lampa-audio.js        /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js
S install -o root -g lampac-editors -m 644 $REMOTE/loader.js                     /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio-loader.js

echo "== md5 на сервере"
md5sum /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js \
       /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js \
       /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worklet.js \
       /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js \
       /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio-loader.js

echo "== проверка по HTTP"
for p in /mpvwasm/assets/mpvwasm-demuxer-st.js /mpvwasm/assets/mpvwasm-demuxer.js /mpvwasm/assets/mpvwasm-audio-only-worker.js /mpvwasm/assets/mpvwasm-audio-only-worklet.js /lampac-js/uploads/mpvwasm-lampa-audio.js /lampac-js/uploads/mpvwasm-lampa-audio-loader.js; do
  printf '%s ' "\$p"
  curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:8242\$p"
done
grep -c 'mpvwasm-demuxer-st' /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js >/dev/null && echo "st glue: 4MB/30s -> \$(grep -o 'Math.max(length,4\*1024\*1024)' /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js | head -1)"
grep -o "v=20261010-android-3" /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio-loader.js | head -1
echo "== версия плагина:"; grep -o "VERSION = '[^']*'" /home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js | head -1
echo "== systemd:"; systemctl is-active lampac
echo DONE
REMOTE_SCRIPT

REMOTE_TIMEOUT=300 bash "$ROOT/remote-run.sh" /tmp/deploy-audio-4-inner.sh 2>&1 | tail -30
