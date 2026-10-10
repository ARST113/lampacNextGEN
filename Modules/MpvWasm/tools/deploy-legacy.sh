#!/usr/bin/env bash
# Выкладка legacy-сборки демуксера (без WASM_BIGINT) для WebView/Chrome < 85.
# Ожидает на сервере ~/wasm-build/out/mpvwasm-demuxer-st-legacy.{js,wasm},
# транспилирует глю в ES2019 локально (esbuild) и кладёт в /home/lampac/plugins/mpvwasm/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
export LAMPAC_PW="$PW"
OUT="$HERE/legacy"
mkdir -p "$OUT"

# 1. забрать сборку с сервера
LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  "lampac-user@lampac.example:/home/lampac-user/wasm-build/out/mpvwasm-demuxer-st-legacy.js" \
  "lampac-user@lampac.example:/home/lampac-user/wasm-build/out/mpvwasm-demuxer-st-legacy.wasm" "$OUT/" </dev/null || {
    echo "нет сборки на сервере — сначала compile-demuxer-st-legacy.sh"; exit 1; }
ls -la "$OUT"

# 2. транспилировать глю в ES2019 (как остальные)
/tmp/tr/node_modules/.bin/esbuild "$OUT/mpvwasm-demuxer-st-legacy.js" \
  --target=es2019 --outfile="$OUT/mpvwasm-demuxer-st-legacy.es2019.js" --allow-overwrite --log-level=warning
mv "$OUT/mpvwasm-demuxer-st-legacy.es2019.js" "$OUT/mpvwasm-demuxer-st-legacy.js"
python3 - "$OUT/mpvwasm-demuxer-st-legacy.js" <<'PY'
import re, sys
t = open(sys.argv[1]).read()
print('после транспиляции: ??= %d ||= %d &&= %d ?. %d' % (
    len(re.findall(r'\?\?=', t)), len(re.findall(r'\|\|=', t)), len(re.findall(r'&&=', t)), len(re.findall(r'\?\.', t))))
PY

# 3. выложить
R=/tmp/deploy-legacy
LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  lampac-user@lampac.example "mkdir -p $R" </dev/null
LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  setsid -w scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \
  "$OUT/mpvwasm-demuxer-st-legacy.js" "$OUT/mpvwasm-demuxer-st-legacy.wasm" \
  "lampac-user@lampac.example:$R/" </dev/null

cat > /tmp/deploy-legacy-inner.sh <<EOS
set -e
PW='$PW'
S(){ echo "\$PW" | sudo -S -p '' "\$@"; }
S install -o root -g lampac-editors -m 644 $R/mpvwasm-demuxer-st-legacy.js   /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st-legacy.js
S install -o root -g lampac-editors -m 644 $R/mpvwasm-demuxer-st-legacy.wasm /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st-legacy.wasm
md5sum /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st-legacy.*
for u in /mpvwasm/assets/mpvwasm-demuxer-st-legacy.js /mpvwasm/assets/mpvwasm-demuxer-st-legacy.wasm; do
  printf '%s ' "\$u"; curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:8242\$u"
done
systemctl is-active lampac
EOS
REMOTE_TIMEOUT=300 bash "$ROOT/remote-run.sh" /tmp/deploy-legacy-inner.sh 2>&1 | tail -10
