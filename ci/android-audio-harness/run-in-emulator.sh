#!/usr/bin/env bash
# Runs inside the GitHub Actions job, after reactivecircus/android-emulator-runner
# has booted the AVD. Drives the WebView harness through S1 and S2 and collects
# every piece of evidence into artifacts/.
set -uo pipefail

# На мёртвом/подвисшем эмуляторе adb умеет висеть вечно — оборачиваем все вызовы таймаутом.
ADB_BIN="$(command -v adb || echo adb)"
ADB_TIMEOUT="${ADB_TIMEOUT:-60}"
adb() { timeout "$ADB_TIMEOUT" "$ADB_BIN" "$@"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ART="$ROOT/artifacts"
mkdir -p "$ART/logs" "$ART/shots" "$ART/dumps" "$ART/reports"
: > "$ART/status.txt"

APK="$ROOT/ci/android-audio-harness/build/harness.apk"
PKG=fun.lampac.harness
ACT="$PKG/.MainActivity"
REPORT="/sdcard/Android/data/$PKG/files/harness-report.jsonl"
REPORT_DL="/sdcard/Download/harness-report.jsonl"
FILE_OK=0

log() { echo "[run] $*" | tee -a "$ART/status.txt"; }
fail() { echo "[run] FAIL: $*" | tee -a "$ART/status.txt"; }

sh_() { adb shell "$@" 2>/dev/null; }

report_text() {
  if [ "$FILE_OK" = "1" ]; then
    adb shell "cat $REPORT 2>/dev/null" 2>/dev/null
    return
  fi
  local out
  out=$(adb shell "cat $REPORT 2>/dev/null; cat $REPORT_DL 2>/dev/null" 2>/dev/null)
  if [ -n "$out" ]; then
    FILE_OK=1
    printf '%s\n' "$out"
    return
  fi
  adb logcat -d -s LAMPAJS:V 2>/dev/null | sed -n 's/.*\[JSReport\] //p'
}

wait_for() { # pattern timeout_sec [label]
  local pat="$1" t="${2:-120}" i n
  n=$(( t * 2 ))
  for ((i = 0; i < n; i++)); do
    if report_text | grep -qF -- "$pat"; then
      log "seen: $pat"
      return 0
    fi
    sleep 0.5
  done
  log "TIMEOUT waiting for: $pat"
  return 1
}

start_page() { # url asset
  adb shell am force-stop "$PKG" 2>/dev/null
  sh_ rm -f "$REPORT" "$REPORT_DL"
  FILE_OK=0
  adb logcat -c 2>/dev/null
  adb shell "am start -W -n $ACT --es url '$1' --es inject_asset '$2'" >/dev/null 2>&1
}

snap() { adb exec-out screencap -p > "$ART/shots/$1.png" 2>/dev/null; log "screenshot $1.png ($(stat -c%s "$ART/shots/$1.png" 2>/dev/null || echo 0) bytes)"; }
dump() { adb shell "$1" > "$ART/dumps/$2.txt" 2>&1; log "dumpsys $2 ($(wc -l < "$ART/dumps/$2.txt") lines)"; }
dump_head() { adb shell "$1" 2>&1 | head -100 > "$ART/dumps/$2.txt"; log "dumpsys(head100) $2"; }
logcat_save() { adb logcat -d -v time > "$ART/logs/logcat-$1.txt" 2>/dev/null; log "logcat-$1.txt ($(wc -l < "$ART/logs/logcat-$1.txt") lines)"; }

collect_report() {
  {
    adb shell "cat $REPORT 2>/dev/null" 2>/dev/null
    adb shell "cat $REPORT_DL 2>/dev/null" 2>/dev/null
    adb logcat -d -s LAMPAJS:V 2>/dev/null | sed -n 's/.*\[JSReport\] //p'
  } | awk 'NF && !seen[$0]++' > "$ART/reports/report-$1.jsonl"
  log "report-$1.jsonl ($(wc -l < "$ART/reports/report-$1.jsonl") lines)"
}

# ---------------------------------------------------------------- environment
log "=== environment ==="
timeout 600 "$ADB_BIN" wait-for-device
for i in $(seq 1 60); do
  [ "$(sh_ getprop sys.boot_completed)" = "1" ] && break
  sleep 2
done
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
adb shell wm dismiss-keyguard >/dev/null 2>&1
adb shell settings put global stay_on_while_plugged_in 3 >/dev/null 2>&1

{
  echo "== getprop =="
  adb shell getprop | grep -Ei 'ro.build.version|ro.product|abi|webview' || true
  echo "== webview packages =="
  adb shell pm list packages | grep -i webview || true
  echo "== dumpsys webviewupdate (head 30) =="
  adb shell dumpsys webviewupdate 2>/dev/null | head -30
  echo "== audio devices =="
  adb shell dumpsys media.audio_flinger 2>/dev/null | sed -n '1,40p'
} > "$ART/logs/environment.txt" 2>&1
log "environment.txt written"

if [ ! -f "$APK" ]; then
  fail "APK missing at $APK"
  exit 1
fi
adb install -r -g "$APK" 2>&1 | tee -a "$ART/status.txt"
adb shell appops set "$PKG" MANAGE_EXTERNAL_STORAGE allow >/dev/null 2>&1
adb shell appops set "$PKG" LEGACY_STORAGE allow >/dev/null 2>&1

# ------------------------------------------------------------------------ S1
log "=== S1: public check page (AC3 / EAC3 / DTS) ==="
start_page "https://lampac.fun/lampac-js/uploads/audio-wasm-check.html" "s1-check-page.js"
if wait_for '"event":"s1-page"' 90; then
  snap s1-page
  dump_head "dumpsys webviewupdate" s1-webviewupdate
fi
if wait_for '"event":"s1-clicked","codec":"ac3"' 90; then
  if wait_for '"event":"s1-playing","codec":"ac3"' 90; then
    sleep 6
    dump_head "dumpsys media.audio_flinger" s1-audioflinger-ac3
    dump "dumpsys media.audio_flinger" s1-audioflinger-ac3-full
    dump "dumpsys audio" s1-audioservice-ac3
    dump "dumpsys media.player" s1-mediaplayer-ac3
    snap s1-ac3-playing
  fi
fi
if wait_for '"event":"s1-clicked","codec":"eac3"' 120; then
  if wait_for '"event":"s1-playing","codec":"eac3"' 120; then
    sleep 6
    dump_head "dumpsys media.audio_flinger" s1-audioflinger-eac3
    snap s1-eac3-playing
  fi
fi
if wait_for '"event":"s1-clicked","codec":"dts"' 60; then
  if wait_for '"event":"s1-dts"' 150; then
    dump_head "dumpsys media.audio_flinger" s1-audioflinger-dts
    snap s1-dts-probe
  fi
fi
wait_for '"event":"s1-complete"' 150
logcat_save s1
collect_report s1
grep -c 'Audio WASM\|ScriptProcessor\|DTS-декодер' "$ART/reports/report-s1.jsonl" >> "$ART/status.txt" 2>/dev/null || true

# ------------------------------------------------------------------------ S2
log "=== S2: real Lampa on lampac.fun (android vs inner player) ==="
start_page "https://lampac.fun/" "s2-lampa.js"
if wait_for '"event":"s2-lampa"' 240; then
  snap s2-lampa-loaded
  if wait_for '"event":"s2-android-watch"' 240; then
    sleep 8
    dump "dumpsys media.player" s2-mediaplayer-android
    snap s2-android-default-player
  fi
  if wait_for '"event":"s2-player-set"' 240; then
    snap s2-player-inner-set
  fi
  if wait_for '"event":"s2-inner-watch"' 300; then
    sleep 18
    dump_head "dumpsys media.audio_flinger" s2-audioflinger-inner
    dump "dumpsys media.audio_flinger" s2-audioflinger-inner-full
    dump "dumpsys audio" s2-audioservice-inner
    snap s2-inner-player
  fi
  if wait_for '"event":"s2-stream-watch"' 120; then
    sleep 20
    dump_head "dumpsys media.audio_flinger" s2-audioflinger-stream
    dump "dumpsys audio" s2-audioservice-stream
    snap s2-real-stream
  fi
  wait_for '"event":"s2-complete"' 120
fi
logcat_save s2
collect_report s2
adb logcat -d -s LAMPAJS:V 2>/dev/null | grep -F '[Lampa Audio WASM]' > "$ART/logs/s2-plugin-lines.txt" 2>/dev/null
adb logcat -d -s LAMPAJS:V 2>/dev/null | grep -F '[AndroidJS]' > "$ART/logs/s2-androidjs-calls.txt" 2>/dev/null
adb logcat -d 2>/dev/null | grep -iE 'AudioTrack|AudioFlinger|MediaCodec|chromium.*Audio' | tail -200 > "$ART/logs/s2-audio-logcat.txt" 2>/dev/null
log "s2-plugin-lines: $(wc -l < "$ART/logs/s2-plugin-lines.txt" 2>/dev/null || echo 0)"

# ------------------------------------------------------------------- summary
log "=== artifacts ==="
find "$ART" -type f | sort | sed 's|^|  |' | tee -a "$ART/status.txt"
log "=== done ==="
exit 0
