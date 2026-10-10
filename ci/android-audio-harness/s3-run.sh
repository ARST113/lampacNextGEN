#!/usr/bin/env bash
# S3 step 2 (bounded): install the real Lampa client APK on the emulator, launch it
# and record whatever actually happens. Everything is best-effort and time-boxed.
set -uo pipefail
ADB_BIN="$(command -v adb || echo adb)"
adb() { timeout "${ADB_TIMEOUT:-60}" "$ADB_BIN" "$@"; }

OUT=artifacts-s3
mkdir -p "$OUT"
APK="$OUT/lampa.apk"
log() { echo "[s3] $*"; }

timeout 600 "$ADB_BIN" wait-for-device
for i in $(seq 1 120); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
adb shell wm dismiss-keyguard >/dev/null 2>&1

adb shell getprop ro.product.cpu.abi > "$OUT/emulator-abi.txt" 2>&1
adb shell getprop ro.build.version.sdk >> "$OUT/emulator-abi.txt" 2>&1

if [ ! -f "$APK" ]; then
  log "no APK downloaded, nothing to install"
  exit 0
fi

log "installing real Lampa APK"
for attempt in 1 2 3; do
  echo "install attempt $attempt" >> "$OUT/install.txt"
  timeout 420 adb install --no-streaming -r -g "$APK" >> "$OUT/install.txt" 2>&1 && break
  sleep 15
done
log "install exit=$?"
tail -5 "$OUT/install.txt"

PKG=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" "$OUT/apk-badging.txt" 2>/dev/null | head -1)
ACT=$(sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p" "$OUT/apk-badging.txt" 2>/dev/null | head -1)
echo "package=$PKG activity=$ACT" | tee "$OUT/launch.txt"
if [ -z "$PKG" ]; then
  PKG=$(adb shell pm list packages 2>/dev/null | grep -i lampa | head -1 | sed 's/package://' | tr -d '\r')
fi

adb logcat -c 2>/dev/null
if [ -n "$PKG" ] && [ -n "$ACT" ]; then
  adb shell am start -W -n "$PKG/$ACT" >> "$OUT/launch.txt" 2>&1
else
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >> "$OUT/launch.txt" 2>&1
fi
sleep 45
adb exec-out screencap -p > "$OUT/lampa-launched.png" 2>/dev/null
adb logcat -d -v time > "$OUT/logcat-s3.txt" 2>/dev/null
adb shell dumpsys activity activities > "$OUT/dumpsys-activities.txt" 2>&1
adb shell dumpsys window windows 2>/dev/null | grep -i mCurrentFocus > "$OUT/current-focus.txt" 2>&1
adb shell pm list packages 2>/dev/null | grep -i -E 'lampa|lampac' > "$OUT/packages.txt" 2>&1
ls -la "$OUT"
log "done"
exit 0
