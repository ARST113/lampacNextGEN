#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/mpv2-android
capture() {
  adb exec-out screencap -p > artifacts/mpv2-android/android-screen.png 2>/dev/null || true
  adb logcat -d -t 3500 '*:W' > artifacts/mpv2-android/android-logcat.txt 2>/dev/null || true
}
trap capture EXIT
adb reverse tcp:8787 tcp:8787
adb forward tcp:9222 localabstract:chrome_devtools_remote
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true
if ! adb shell pm list packages | grep -q '^package:com.android.chrome'; then
  echo 'Android emulator image did not include Chrome' >&2
  exit 3
fi
adb shell am start -a android.intent.action.VIEW -d http://localhost:8787/ com.android.chrome || true
node tests/mpv2-android-ci/runner.js
