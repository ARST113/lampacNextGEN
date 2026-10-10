#!/usr/bin/env bash
# Быстрая выкладка одного файла: воркер с фолбэк-цепочкой сборок.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
export LAMPAC_PW="$PW"
R=/tmp/deploy-worker
LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  lampac-user@lampac.example "mkdir -p $R" </dev/null
LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  "$HERE/deploy/mpvwasm-audio-only-worker.js" "lampac-user@lampac.example:$R/" </dev/null
cat > /tmp/dw.sh <<'EOS'
set -e
PW='""" + PW + """'
S(){ echo "$PW" | sudo -S -p '' "$@"; }
S install -o root -g lampac-editors -m 644 /tmp/deploy-worker/mpvwasm-audio-only-worker.js /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js
md5sum /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js
curl -s -o /dev/null -w 'worker http %{http_code} %{size_download}\n' http://127.0.0.1:8242/mpvwasm/assets/mpvwasm-audio-only-worker.js
grep -c CANDIDATES /home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js
systemctl is-active lampac
EOS
REMOTE_TIMEOUT=180 bash "$ROOT/remote-run.sh" /tmp/dw.sh 2>&1 | tail -8
