#!/usr/bin/env bash
# Забрать свежие сборки ST/legacy с сервера, транспилировать в ES2019 и выложить
# в /home/lampac/plugins/mpvwasm/. lampac не перезапускается.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY="$HERE/deploy"
SRV=lampac-user@lampac.example
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
export LAMPAC_PW="$PW"
SSHOPT=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password
        -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR)
scp_() { LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
         setsid -w scp "${SSHOPT[@]}" "$@" </dev/null; }
ssh_() { LAMPAC_PW="$PW" SSH_ASKPASS="$ROOT/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
         setsid -w ssh "${SSHOPT[@]}" "$SRV" "$@" </dev/null; }

for g in mpvwasm-demuxer-st mpvwasm-demuxer-st-legacy; do
  scp_ "$SRV:/home/lampac-user/wasm-build/out/$g.js" "$SRV:/home/lampac-user/wasm-build/out/$g.wasm" "$DEPLOY/"
  /tmp/tr/node_modules/.bin/esbuild "$DEPLOY/$g.js" --target=es2019 \
    --outfile="$DEPLOY/$g.es2019.js" --allow-overwrite --log-level=warning
  mv "$DEPLOY/$g.es2019.js" "$DEPLOY/$g.js"
  echo "локально: $g"
done
md5sum "$DEPLOY"/mpvwasm-demuxer-st*.js "$DEPLOY"/mpvwasm-demuxer-st*.wasm

R=/tmp/deploy-glue
ssh_ "rm -rf $R && mkdir -p $R"
scp_ "$DEPLOY/mpvwasm-demuxer-st.js" "$DEPLOY/mpvwasm-demuxer-st.wasm" \
      "$DEPLOY/mpvwasm-demuxer-st-legacy.js" "$DEPLOY/mpvwasm-demuxer-st-legacy.wasm" "$SRV:$R/"

cat > /tmp/deploy-glue-inner.sh <<EOS
set -e
PW='$PW'
S(){ echo "\$PW" | sudo -S -p '' "\$@"; }
for f in mpvwasm-demuxer-st.js mpvwasm-demuxer-st.wasm mpvwasm-demuxer-st-legacy.js mpvwasm-demuxer-st-legacy.wasm; do
  S install -o root -g lampac-editors -m 644 $R/\$f /home/lampac/plugins/mpvwasm/\$f
done
echo "== на сервере"
md5sum /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.js /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.wasm \
       /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st-legacy.js /home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st-legacy.wasm
for u in /mpvwasm/assets/mpvwasm-demuxer-st.js /mpvwasm/assets/mpvwasm-demuxer-st.wasm \
         /mpvwasm/assets/mpvwasm-demuxer-st-legacy.js /mpvwasm/assets/mpvwasm-demuxer-st-legacy.wasm; do
  printf '%s ' "\$u"; curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:8242\$u"
done
systemctl is-active lampac
EOS
REMOTE_TIMEOUT=300 bash "$ROOT/remote-run.sh" /tmp/deploy-glue-inner.sh 2>&1 | tail -14
