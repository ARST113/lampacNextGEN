#!/usr/bin/env bash
# Runs inside the GitHub Actions job after android-emulator-runner booted the AVD.
# Drives the WebView harness through S1 and S2 and collects evidence into artifacts/.
#
# Hard lessons from run #1 (no KVM on ubuntu-latest -> QEMU TCG, ~20-40x slower):
#   * every adb call is wrapped in `timeout`, the emulator service can hang;
#   * all waits are WALL-CLOCK deadlines, never "iterations x sleep";
#   * polling uses a single `adb exec-out cat` round trip every 5 s.
set -uo pipefail

ADB_BIN="$(command -v adb || echo adb)"
ADB_TIMEOUT="${ADB_TIMEOUT:-90}"
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

log() { echo "[run $(date -u +%H:%M:%S)] $*" | tee -a "$ART/status.txt"; }
sh_() { adb shell "$@" 2>/dev/null; }

# ---------------------------------------------------------------- primitives
# The report file is the primary channel. Fallbacks: the app-internal copy via
# `run-as` (APK is debuggable) and the LAMPAJS logcat mirror.
report_text() {
  local out
  out=$(adb exec-out "cat $REPORT 2>/dev/null" 2>/dev/null)
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    return
  fi
  out=$(adb exec-out "run-as $PKG cat files/harness-report.jsonl 2>/dev/null" 2>/dev/null)
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    return
  fi
  adb logcat -d -t 20000 -s LAMPAJS:V 2>/dev/null | sed -n 's/.*\[JSReport\] //p'
}

wait_for() { # pattern wall_seconds
  local pat="$1" t="${2:-180}" deadline
  deadline=$(( $(date +%s) + t ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if report_text | grep -qF -- "$pat"; then
      log "seen: $pat"
      return 0
    fi
    sleep 5
  done
  log "TIMEOUT(${t}s) waiting for: $pat"
  return 1
}

start_page() { # url asset [intercept]
  adb shell am force-stop "$PKG" 2>/dev/null
  sh_ rm -f "$REPORT" "$REPORT_DL"
  adb logcat -c 2>/dev/null
  adb shell "am start -W -n $ACT --es url '$1' --es inject_asset '$2' --es intercept_demuxer '${3:-0}'" >/dev/null 2>&1
  log "started $2 -> $1 (intercept=${3:-0})"
}

snap() { adb exec-out screencap -p > "$ART/shots/$1.png" 2>/dev/null; log "screenshot $1.png ($(stat -c%s "$ART/shots/$1.png" 2>/dev/null || echo 0) bytes)"; }
dump_head() { adb shell "$1" 2>&1 | head -100 > "$ART/dumps/$2.txt"; log "dumpsys(head100) $2"; }
dump() { adb shell "$1" > "$ART/dumps/$2.txt" 2>&1; log "dumpsys $2"; }
logcat_save() { adb logcat -d -v time > "$ART/logs/logcat-$1.txt" 2>/dev/null; log "logcat-$1.txt ($(wc -l < "$ART/logs/logcat-$1.txt") lines)"; }

collect_report() {
  {
    adb exec-out "cat $REPORT 2>/dev/null" 2>/dev/null
    adb exec-out "cat $REPORT_DL 2>/dev/null" 2>/dev/null
    adb exec-out "run-as $PKG cat files/harness-report.jsonl 2>/dev/null" 2>/dev/null
    adb logcat -d -s LAMPAJS:V 2>/dev/null | sed -n 's/.*\[JSReport\] //p'
  } | awk 'NF && !seen[$0]++' > "$ART/reports/report-$1.jsonl"
  log "report-$1.jsonl ($(wc -l < "$ART/reports/report-$1.jsonl") lines)"
}

# ---------------------------------------------------------------- environment
log "=== environment ==="
timeout 600 "$ADB_BIN" wait-for-device
for i in $(seq 1 300); do
  [ "$(sh_ getprop sys.boot_completed)" = "1" ] && break
  sleep 2
done
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
adb shell wm dismiss-keyguard >/dev/null 2>&1
adb shell settings put global stay_on_while_plugged_in 3 >/dev/null 2>&1

{
  echo "== getprop (selected) =="
  adb shell getprop | grep -Ei 'ro.build.version.sdk|ro.product.cpu|ro.product.model|webview' || true
  echo "== dumpsys webviewupdate (head 30) =="
  adb shell dumpsys webviewupdate 2>/dev/null | head -30
  echo "== media.audio_flinger (head 40) =="
  adb shell dumpsys media.audio_flinger 2>/dev/null | sed -n '1,40p'
} > "$ART/logs/environment.txt" 2>&1
log "environment.txt written"

if [ ! -f "$APK" ]; then
  log "FAIL: APK missing at $APK"
  exit 1
fi
adb install -r -g --no-streaming "$APK" 2>&1 | tee -a "$ART/status.txt"
adb shell appops set "$PKG" MANAGE_EXTERNAL_STORAGE allow >/dev/null 2>&1
adb shell appops set "$PKG" LEGACY_STORAGE allow >/dev/null 2>&1

# ------------------------------------------------------------------------ S1
log "=== S1: public check page (AC3 / EAC3 / DTS) ==="
start_page "https://lampac.fun/lampac-js/uploads/audio-wasm-check.html" "s1-check-page.js" 1
if wait_for '"event":"s1-page"' 420; then
  snap s1-page
  dump_head "dumpsys webviewupdate" s1-webviewupdate
fi
if wait_for '"event":"s1-clicked","codec":"ac3"' 240; then
  if wait_for '"event":"s1-playing","codec":"ac3"' 420; then
    sleep 10
    dump_head "dumpsys media.audio_flinger" s1-audioflinger-ac3
    dump "dumpsys media.audio_flinger" s1-audioflinger-ac3-full
    dump "dumpsys audio" s1-audioservice-ac3
    dump "dumpsys media.player" s1-mediaplayer-ac3
    snap s1-ac3-playing
  fi
fi
if wait_for '"event":"s1-clicked","codec":"eac3"' 300; then
  if wait_for '"event":"s1-playing","codec":"eac3"' 420; then
    sleep 10
    dump_head "dumpsys media.audio_flinger" s1-audioflinger-eac3
    snap s1-eac3-playing
  fi
fi
if wait_for '"event":"s1-clicked","codec":"dts"' 300; then
  if wait_for '"event":"s1-dts"' 420; then
    dump_head "dumpsys media.audio_flinger" s1-audioflinger-dts
    snap s1-dts-probe
  fi
fi
wait_for '"event":"s1-complete"' 300
logcat_save s1
collect_report s1

# ------------------------------------------------------------------------ S2
log "=== S2: real Lampa on lampac.fun (android vs inner player) ==="
start_page "https://lampac.fun/" "s2-lampa.js" 1
if wait_for '"event":"s2-lampa"' 720; then
  snap s2-lampa-loaded
  if wait_for '"event":"s2-player-set"' 420; then
    snap s2-player-inner-set
  fi
  if wait_for '"event":"s2-inner-watch"' 600; then
    sleep 20
    dump_head "dumpsys media.audio_flinger" s2-audioflinger-inner
    dump "dumpsys media.audio_flinger" s2-audioflinger-inner-full
    dump "dumpsys audio" s2-audioservice-inner
    snap s2-inner-player
  fi
  if wait_for '"event":"s2-stream-watch"' 600; then
    sleep 25
    dump_head "dumpsys media.audio_flinger" s2-audioflinger-stream
    dump "dumpsys audio" s2-audioservice-stream
    snap s2-real-stream
  fi
  if wait_for '"event":"s2-android-watch"' 420; then
    sleep 10
    dump "dumpsys media.player" s2-mediaplayer-android
    snap s2-android-default-player
  fi
  wait_for '"event":"s2-complete"' 420
fi
logcat_save s2
collect_report s2
adb logcat -d -s LAMPAJS:V 2>/dev/null | grep -F '[Lampa Audio WASM]' > "$ART/logs/s2-plugin-lines.txt" 2>/dev/null
adb logcat -d -s LAMPAJS:V 2>/dev/null | grep -F '[AndroidJS]' > "$ART/logs/s2-androidjs-calls.txt" 2>/dev/null
log "s2-plugin-lines: $(wc -l < "$ART/logs/s2-plugin-lines.txt" 2>/dev/null || echo 0)"
log "s2-androidjs-calls: $(wc -l < "$ART/logs/s2-androidjs-calls.txt" 2>/dev/null || echo 0)"

# ------------------------------------------------------------------- summary
log "=== artifacts ==="
find "$ART" -type f | sort | sed 's|^|  |' | tee -a "$ART/status.txt"
log "=== done ==="
exit 0
