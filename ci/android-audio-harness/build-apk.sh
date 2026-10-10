#!/usr/bin/env bash
# Build the minimal WebView harness APK without Gradle:
#   aapt2 link  -> javac -> d8 -> zipalign -> apksigner
# Uses only the Android SDK already installed on the GitHub runner.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}"
BT="${BUILD_TOOLS_DIR:-$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)}"
PLATFORM_JAR="$(ls -d "$SDK"/platforms/android-3[0-9]*/android.jar 2>/dev/null | sort -V | tail -1)"

echo "[build] SDK=$SDK"
echo "[build] build-tools=$BT"
echo "[build] android.jar=$PLATFORM_JAR"

if [ ! -x "$BT/aapt2" ]; then echo "[build] aapt2 not found in $BT" >&2; exit 1; fi
if [ ! -f "$PLATFORM_JAR" ]; then echo "[build] android.jar not found" >&2; exit 1; fi

BUILD="$HERE/build"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/gen" "$BUILD/apk"

echo "[build] aapt2 link"
"$BT/aapt2" link \
  -o "$BUILD/apk/base.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$HERE/AndroidManifest.xml" \
  -A "$HERE/assets" \
  --java "$BUILD/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0 \
  --auto-add-overlay

echo "[build] javac"
find "$HERE/java" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -encoding UTF-8 --release 11 -Xlint:none \
  -classpath "$PLATFORM_JAR" \
  -d "$BUILD/classes" \
  @"$BUILD/sources.txt"

echo "[build] d8"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$BT/d8" --release --lib "$PLATFORM_JAR" --min-api 24 \
  --output "$BUILD/dex" @"$BUILD/classes.txt"

echo "[build] package dex into apk"
cp "$BUILD/apk/base.apk" "$BUILD/apk/unsigned.apk"
( cd "$BUILD/dex" && zip -q -X "$BUILD/apk/unsigned.apk" classes.dex )
unzip -l "$BUILD/apk/unsigned.apk" | sed -n '1,40p'

echo "[build] keystore"
KEYSTORE="$BUILD/debug.keystore"
keytool -genkeypair -keystore "$KEYSTORE" \
  -storepass android -keypass android \
  -alias androiddebugkey \
  -dname "CN=Android Debug,O=Android,C=US" \
  -keyalg RSA -keysize 2048 -validity 10000 -noprompt >/dev/null 2>&1

echo "[build] zipalign + apksigner"
"$BT/zipalign" -f -p 4 "$BUILD/apk/unsigned.apk" "$BUILD/apk/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$BUILD/harness.apk" "$BUILD/apk/aligned.apk"

"$BT/apksigner" verify --print-certs "$BUILD/harness.apk" | head -5
ls -la "$BUILD/harness.apk"
echo "[build] OK -> $BUILD/harness.apk"
