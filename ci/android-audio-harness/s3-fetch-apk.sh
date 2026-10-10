#!/usr/bin/env bash
# S3 step 1: fetch the real Lampa client APK from ARST113/LAMPA releases and
# inspect its ABIs, so the emulator job knows whether it can even be installed.
set -uo pipefail

OUT=artifacts-s3
mkdir -p "$OUT"
API="https://api.github.com/repos/ARST113/LAMPA/releases?per_page=30"

echo "== releases =="
curl -sSL "$API" -o "$OUT/releases.json" || true
jq -r '.[] | "\(.tag_name)\t\(.assets[]?.name)"' "$OUT/releases.json" 2>/dev/null | head -40 | tee "$OUT/releases-list.txt" || true

URL=$(jq -r '[.[].assets[]? | select(.name | test("(?i)native.*\\.apk$"))] | (.[0].browser_download_url // empty)' "$OUT/releases.json" 2>/dev/null)
NAME=$(jq -r '[.[].assets[]? | select(.name | test("(?i)native.*\\.apk$"))] | (.[0].name // empty)' "$OUT/releases.json" 2>/dev/null)
if [ -z "$URL" ]; then
  URL=$(jq -r '[.[].assets[]? | select(.name | test("(?i)\\.apk$"))] | (.[0].browser_download_url // empty)' "$OUT/releases.json" 2>/dev/null)
  NAME=$(jq -r '[.[].assets[]? | select(.name | test("(?i)\\.apk$"))] | (.[0].name // empty)' "$OUT/releases.json" 2>/dev/null)
fi

echo "asset=$NAME"
echo "url=$URL"
echo "$NAME" > "$OUT/asset-name.txt"

ABI=""
if [ -n "$URL" ]; then
  curl -sSL "$URL" -o "$OUT/lampa.apk" || true
  ls -la "$OUT/lampa.apk" || true
  unzip -l "$OUT/lampa.apk" > "$OUT/apk-list.txt" 2>&1 || true
  grep -E 'lib/[^/]+/' "$OUT/apk-list.txt" | awk '{print $4}' | awk -F/ '{print $2}' | sort -u > "$OUT/apk-abis.txt" || true
  echo "== ABIs in APK =="; cat "$OUT/apk-abis.txt" || true
  if grep -qx 'x86_64' "$OUT/apk-abis.txt"; then ABI=x86_64
  elif grep -qx 'arm64-v8a' "$OUT/apk-abis.txt"; then ABI=arm64-v8a
  fi
  SDK="${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}"
  BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
  if [ -x "$BT/aapt2" ]; then
    "$BT/aapt2" dump badging "$OUT/lampa.apk" > "$OUT/apk-badging.txt" 2>&1 || true
    head -5 "$OUT/apk-badging.txt" || true
  fi
fi

echo "chosen abi=$ABI"
echo "abi=$ABI" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "asset_name=$NAME" >> "${GITHUB_OUTPUT:-/dev/null}"
{
  echo "### S3 real Lampa APK inspection"
  echo ""
  echo "- asset: \`$NAME\`"
  echo "- ABIs in APK: \`$(tr '\n' ' ' < "$OUT/apk-abis.txt" 2>/dev/null)\`"
  echo "- chosen emulator arch: \`$ABI\`"
  echo ""
  echo '```'
  head -20 "$OUT/apk-badging.txt" 2>/dev/null || true
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
