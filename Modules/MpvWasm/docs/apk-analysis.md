# APK / AC3-EAC3-DTS / inner-guard analysis

Read-only analysis of local checkouts and notes (no server or remote host touched, nothing restarted).
Date: 2026-10-10. Deployed audio plugin: `mpvwasm-audio/android/plugin-patched.js`, `VERSION = '20261010-android-8'`
(line 10), deployed as `/lampac-js/uploads/mpvwasm-lampa-audio.js`.

> **Headline correction up front:** the premise “Chrome/WebView cannot play the MKV container” is **outdated for the
> user's WebView.** Chromium **≥ 145** added Matroska/MKV container support to `<video>` (commit
> `d0813004e27eb2f679dd4a9e26a13baeac4be9f2`, “Add Matroska MIME type support to media and net”, 11 Dec 2025;
> caniuse: “Chromium < 145 … `<source type="video/x-matroska">` was not supported”). The user's WebView UA reports
> **Chrome/154**, so MKV is a recognised container there. What the stock WebView still does **not** have is
> **AC3/EAC3/DTS software decoders** — that is the real gap, and it is exactly what the audio bridge fills.
> Details and caveats in §2.

---

## 1. Does the Lampa APK have a native player with FFmpeg/Media3 decoders for AC3/EAC3/DTS/TrueHD?

There are **two different ARST113 builds**, and the answer differs. No single “the Lampa APK” exists.

### 1a. `ARST113/LAMPA` main (package `top.rootu.lampa`) — **NO built-in decoders**

Local checkout `lampa-study/LAMPA` @ `a09e888` (branch `main`).

- `lampa-study/LAMPA/app/build.gradle:142-211` — the whole `dependencies` block has **no** Media3/ExoPlayer/FFmpeg
  entry. `implementation fileTree(dir: 'libs', include: ['*.jar'])` (line 146) plus flavours
  `liteApi/ruStoreApi/fullApi` with the two Crosswalk AARs (lines 209-211).
- `lampa-study/LAMPA/app/libs/` contains only `org.apache.http.legacy.jar`,
  `xwalk_core_library-23.53.589.4.aar`, `xwalk_shared_library-23.53.589.4.aar`.
- The “android” player is an **external app launched by Intent**:
  `AndroidJS.openPlayer` (`app/src/main/java/top/rootu/lampa/AndroidJS.kt:431`) → `mainActivity.runPlayer(...)`
  (`MainActivity.kt:2237`) → package whitelists / `configurePlayerIntent` (`MainActivity.kt:2369`).
  `JUSTPLUS_PLAYER_PACKAGES = {"com.justplus.player","com.lampaua.player"}` (`MainActivity.kt:211-214`),
  `EXO_PLAYER_PACKAGES` (`:216-218`), `PLAYERS_BLACKLIST` (`:219-237`).
- Conclusion: **the main-fork APK cannot decode AC3/EAC3/DTS itself.** Sound in this path is 100 % determined by
  whichever external player catches the Intent (MX/VLC/Just+/ExoPlayer demo). Notes agree:
  `mpvwasm-audio/android/lampa-app-study.md:159` (“в `main`-клиенте нет ни ExoPlayer, ни Media3, ни FFmpeg”).

### 1b. “Lampa Native” `v1.13.0-native.2` (package `io.github.arst113.lampa`) — **YES**

Built by branch `embedded-justplus`; embeds the Just+ player (`lampa-app-study.md:163-172`):

- Media3 **1.11.0-beta01** (`lampa-app-study.md:163`);
- the decoder_ffmpeg AAR with `ENABLED_DECODERS=(vorbis opus flac alac pcm_mulaw pcm_alaw mp3 amrnb amrwb aac ac3 eac3 dca mlp truehd)`
  (`lampa-app-study.md:167-170`, same file `player/app/libs/README.md:1-7`);
- `DefaultRenderersFactory` puts the platform `MediaCodecAudioRenderer` first and the FFmpeg renderer behind it, with
  `setEnableDecoderFallback(true)` (`lampa-app-study.md:171`); heavyweight MKV audio mimes are hidden from MediaCodec so
  the FFmpeg decoder is used (`:172`).

So **yes**: that build's own native player decodes AC3, E-AC-3, DTS (`dca`), MLP/TrueHD — but I have not read the
embedded player's sources (repo `ARST113/just-plus-player2` is private, API 404 — `lampa-app-study.md:299`); the
conclusion rests on `.so`/AAR contents and the sibling fork.

### 1c. The local external `ARX.TPlayer` APK — **YES (verified on the artifact)**

`ARX.TPlayer.v2.1.3-arx6-release.apk`, package `com.justplus.player`, versionName `2.1.3-arx5`, minSdk 23, targetSdk 36
(`lampac-mpvwasm-audio-bridge.md:223-226`). Verified by listing the APK in this workspace:

- native libs `lib/arm64-v8a/libavcodec.so`, `libavutil.so`, `libswresample.so`, `libffmpegJNI.so`,
  `libmedia3ext.so` (also `armeabi-v7a`);
- `strings classes.dex` → `androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer`, “Loaded FfmpegAudioRenderer.”

**Verdict for §1:** the plain `ARST113/LAMPA` APK's native path has **no own decoders** (Intent to an external player);
the “Lampa Native” build and the external `ARX.TPlayer` build **do** have them (`ac3 eac3 dca mlp truehd`).
Which of the two the user has is **not recorded anywhere locally** (see §6).

---

## 2. Can the APK's WebView play an MKV through the inner `<video>`?

**The old blanket “Chrome/WebView does not support MKV” is wrong for the user's engine.** Primary evidence:

- Chromium source `media/base/mime_util_internal.cc` registers the container:
  `AddContainerWithCodecs("video/matroska", mkv_codecs)`, `("video/x-matroska", …)`, `("audio/x-matroska", …)`.
  `mkv_video_codecs` includes VP8/VP9, and under `BUILDFLAG(USE_PROPRIETARY_CODECS)` H.264 and (under
  `ENABLE_PLATFORM_HEVC`) HEVC; `mkv_audio_codecs` includes AAC, and under `ENABLE_PLATFORM_AC3_EAC3_AUDIO` AC3/EAC3,
  under `ENABLE_PLATFORM_DTS_AUDIO` DTS.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/mime_util_internal.cc>
- The container/MIME support was added by commit `d0813004e27eb2f679dd4a9e26a13baeac4be9f2`
  (“Add Matroska MIME type support to media and net”, 11 Dec 2025, `refs/heads/main@{#1557734}`),
  because before it “accessing .mkv … triggers a download”.
  <https://chromium.googlesource.com/chromium/src/+/d0813004e27eb2f679dd4a9e26a13baeac4be9f2>
- caniuse issue #7347 comment: “Chromium < 145 would also need to be marked as partial because
  `<source type="video/x-matroska">` was not supported.”
  <https://github.com/fyrd/caniuse/issues/7347>

So on **Chromium 154** the WebView *will* attempt to demux an MKV. What it can actually decode:

- **Video:** H.264 always; HEVC only via the Android platform HEVC decoder (`ENABLE_PLATFORM_HEVC`); a 4K HEVC
  stream is device/profile dependent (10-bit/HDR/Dolby Vision may fail). AV1/VP9 depend on the device.
- **Audio:** AC3/EAC3/DTS are present in the codec tables **only if** the corresponding *platform* decoder is enabled.
  A stock Android System WebView on a normal phone (no licensed Dolby/DTS MediaCodec) has no AC3/EAC3/DTS decoder, so
  `canPlayType('audio/mp4; codecs="ac-3"')` is empty — exactly the behaviour the project measured
  (`lampac-mpvwasm-audio-bridge.md:117`) and the reason the bridge exists.

Consequence for the user's file (4K HEVC MKV, 3× eac3/ac3): the WebView can in principle demux the MKV and may play
the **video silently**, while the AC3/EAC3 **audio** is the missing part. Forcing `inner` is therefore **not**
automatically fatal in the way the question assumes; the risk is narrower and is spelled out in §3.

Caveat / contradiction inside the project: the sibling plugin `mpvwasm-lampa-player.js` hardcodes
`if (container === 'matroska') return false;` in `canPlayNativeSource()` (line 542) and routes all `.mkv`/`.ts`/`/stream/`
URLs to the WASM/hybrid player (`shouldUseMpvWasm`, lines 362-367). That is a conservative, **possibly outdated**
assumption for Chromium ≥145. No note records a successful `<video>` MKV playback test; the MKV test in
`lampa-study/chromium-repo/codec-next.md:10` is still listed as “to verify”, and the only *verified* Cefrium playback was
12-second **MP4** clips (`lampa-study/release-meta/aec3-max15-test-2026.10.04/body.md:5`).

---

## 3. Can the `inner` guard break playback? Exact path, what the user sees, container checks

The guard is `guardAndroidPlayer()` — `mpvwasm-audio/android/plugin-patched.js:624-648`, armed once from `init()`
(`:652`, log line “Android inner-player guard armed”, seen in the emulator logs).

Code path (line by line):

1. `:625` bails if there is no `Lampa.Android.openPlayer` or the guard already ran.
2. `:627` replaces `Lampa.Android.openPlayer`.
3. `:630` — **the only gate**: `storage('mpvwasm_audio_mode','auto') !== 'inner'` → call the original native/external
   path; or the URL is not `/^https?:/i` → same. **There is no container check and no video-codec check here.**
4. `:633` `probeStream(url)` → `:596-623`: starts `/mpvwasm/assets/mpvwasm-audio-only-worker.js`, sends `open` with
   `proxyUrl(url)` (`:617`) = `/mpvwasm/proxy?u=<base64url>`, waits ≤ 6 s, returns only `{audio:[codec names]}`.
5. `:634` `needed = audio.some(codec ∈ {ac3,eac3,dts,dca})`.
6. `:636` notice; `:637-642` copies the data object, sets `payload.url = url`, **`payload.launch_player = 'inner'`**;
   `:643` `Lampa.Player.play(payload)`.

In Lampa (`lampa-ref/app.min.js`, function `start$6`): `if (data.launch_player) launch_player = data.launch_player;`
then `if (launch_player == 'lampa' || launch_player == 'inner' || PlayerVideo.verifyTube(data.url)) launchInner();`
→ the inner HTML5 `<video>` (`Lampa.PlayerVideo`), not `Android.openPlayer`. (`launch_player` is only reset in
`backward$1()`, i.e. on player close.)

For the user's MKV the probe returns `eac3/ac3` → `needed = true` → inner is forced. What happens next:

- If the WebView can demux the MKV and decode its video → the inner player plays video, mutes it, the bridge decodes
  AC3/EAC3 to PCM → sound. This is the intended design.
- If it cannot (unsupported HEVC profile/4K/HDR, or the 28 GB file simply never buffers) → the `<video>` never reaches
  `loadeddata`; Lampa's error handler maps `error.code == 4` to `player_error_two` = **«Видео не найдено или
  повреждено»** and `code == 3` to `player_error_one` = **«Не удалось декодировать видео»**, both `fatal: true`
  (handler in `lampa-ref/app.min.js`, langs `player_error_one`/`player_error_two`) → player closes. The bridge may
  still have read the header (this is exactly the phone-log symptom: demuxer loaded and reading the MKV through
  `/mpvwasm/proxy`) but with no playing timeline it produces no usable sound.
- **There is no fallback**: if the forced inner player errors, nothing calls `original.call(self, link, data)` to re-open
  the native player. The `catch` at `:644` only covers a rejected *probe*, not a failed inner playback.
- Two extra risks confirmed by the notes: (a) the bridge opens a **second full-file read** of the container through
  `/mpvwasm/proxy`, and the notes name the channel — not the decoder — as the bottleneck that makes sound drop
  (`lampac-mpvwasm-audio-bridge.md:280-285`); on a 28 GB 4K file this is far worse. (b) the guard calls
  `Lampa.Player.play` **asynchronously** (after the 0.1–6 s probe), while the outer `Player.play` has already run
  `Android.openPlayer(...)` and `listener.send('external', data)` and considers the external player launched; the
  emulator logs show such a race (`[Player] play aborted by callback`, `[WT] Player destroyed. Leaving room.` —
  `gh-emulator/final83/reports/report-s2.jsonl` around the real-stream phase). This part is inference, not proof.

**Container check today: none.** Grep of `plugin-patched.js` for `mkv|matroska|container|extension` → nothing; the only
`canPlayType` is the *audio* one at `:35` (`audio/mp4; codecs="ac-3"`), and in `inner` mode `needsDecoder()` returns
`true` at `:33` **before** that check — so even the audio capability is not consulted in this mode.

---

## 4. What would actually give sound for AC3/EAC3/DTS in the APK

| Option | AC3/EAC3 | DTS/DTS-HD/TrueHD | MKV video | Risk |
|---|---|---|---|---|
| **(a) player = `android`, Lampa Native (in-app Just+)** | yes (FFmpeg ext.) | yes | yes (Media3 Matroska extractor) | Only if the user actually runs the `-native.2` build; Lampa loses its own player UI/timeline control |
| **(a′) player = `android`, plain Lampa + external player** | depends on that app | depends | depends | If no FFmpeg-capable player is installed/selected → chooser dialog or nothing; results vary per app |
| **(b) player = `inner` + audio bridge** | yes (WASM PCM) | yes (WASM `dca`) | only if the WebView decodes the video, and only if the channel keeps up | Second full-file connection starves a 28 GB/4K stream (notes: sound drops, video stutters); no fallback if the video errors |
| **(c) external `ARX.TPlayer` (com.justplus.player, 2.1.3-arx5)** | yes | yes | yes | Out-of-app; Lampa only sends Intent extras, no track control; arm64-v8a + armeabi-v7a only (no Intel ABI) |

**Recommendation.** For this specific title (4K HEVC MKV, eac3/ac3) use the **native path with an FFmpeg-capable
player**: either the in-app Just+ of “Lampa Native” (if that is the installed build) or the external
`ARX.TPlayer`/Just+ app (option (c)/(a)). Keep **inner + bridge for MP4/M4V/MOV/WebM and HLS**, where the container is
certainly WebView-native and the bridge is the only way to get AC3/EAC3/DTS. Do not let the guard force inner for
containers/codecs the WebView cannot render without a fallback.

---

## 5. What to change in `plugin-patched.js`

Goal: never force the inner player when the WebView cannot actually demux/decode the stream, while keeping the option
for streams that do work. Concrete, minimal edit:

1. **Add a container+codec gate** and put it in the `:630` condition (before the probe, so a 28 GB MKV is not read
   twice just to learn it cannot play):

   ```js
   function fileExtension(url) {
     var clean = String(url || '').split('#')[0].split('?')[0].toLowerCase();
     var m = clean.match(/\.([a-z0-9]+)$/);
     return m ? m[1] : '';
   }
   // Can this WebView actually render the stream? Extension gate + explicit canPlayType probe.
   function webViewCanPlayContainer(url) {
     var ext = fileExtension(url);
     // containers Chromium can open natively (MKV since Chromium 145, MP4/MOV/WebM always)
     if (!/^(mp4|m4v|mov|webm|mkv|mk3d|ts|m2ts|m3u8)$/.test(ext)) return false;
     if (ext === 'mkv' || ext === 'mk3d') {
       // MKV: a container probe on the <video> element; codec-qualified is better than bare
       try {
         var v = document.createElement('video');
         // probe the codecs the demuxer reported; a bare video/x-matroska probe is enough to
         // detect the pre-145 "download instead of play" behaviour.
         return v.canPlayType('video/x-matroska') !== '';
       } catch (_) { return false; }
     }
     try { return document.createElement('video').canPlayType('video/' + (ext === 'm3u8' ? 'mp4' : ext)) !== '' || true; }
     catch (_) { return true; }
   }
   ```

   and at `:630`:

   ```js
   if (storage('mpvwasm_audio_mode','auto') !== 'inner' || !/^https?:/i.test(url) ||
       !webViewCanPlayContainer(url)) {
     return original.apply(self, arguments);
   }
   ```

   The condition to name is **`webViewCanPlayContainer(url)`** (extension whitelist + `video.canPlayType`). A single
   `video.canPlayType('video/mp4')` check is *not* enough: the user's engine answers that positively and still cannot
   decode AC3, and it would wrongly exclude MKV on Chromium ≥145.

2. **Strengthen the probe** (`probeStream`, `:596-623`) to return the **container and the video codec** as well as audio
   (the demuxer already enumerates all tracks — `worker-patched.js:109`/`demux_tracks_json`), then decide:
   force inner only if the container is playable **and** the video codec is decodable
   (e.g. `canPlayType('video/x-matroska; codecs="hvc1.1.6.L153.B0"')` or
   `navigator.mediaCapabilities.decodingInfo({type:'file', video:{contentType:…, …}})`) **and** the audio codec needs the
   bridge.

3. **Add a one-shot fallback**: in the forced-inner branch, listen for `error`/`MEDIA_ERR_SRC_NOT_SUPPORTED` on
   `Lampa.PlayerVideo` (or a timeout without `loadeddata`) and, if it fires, call `original.call(self, link, data)` once.
   Without this, any inner failure is terminal (see §3).

4. **Do not probe a huge remote file twice.** For MKV the guard currently opens the container through `/mpvwasm/proxy`
   before the player even starts; gate by extension first (point 1) so the double read happens only for containers the
   WebView can open.

5. Keep the existing settings/mode semantics (`auto`/`force`/`inner`/`off`, `:579-587`); the change is only “never
   force inner when the WebView cannot play the container”.

---

## 6. `player/` repo, the user's APK version/flavour, and the Cefrium AC3 build

- `player/` is **not** a Lampa APK. It is `ARST113/just-plus-player2` = the external **ARX.TPlayer** (Just Player fork):
  `player/app/build.gradle:66-71` minSdk 23 / targetSdk 36 / versionName `2.1.3-arx5`; `:174` `media3_version = '1.11.1'`;
  `player/app/libs/README.md:1-7` lists the FFmpeg decoders `… ac3 eac3 dca mlp truehd`; `player/README.md:12`
  states the FFmpeg extension. It has **no WebView and no `AndroidJS` bridge** (`lampac-mpvwasm-audio-bridge.md:223-229`),
  so Lampa can only launch it as an external player (`com.justplus.player`, `MainActivity.kt:211-214`, `:2402`).
  Releases are arm64-v8a + armeabi-v7a only — `lampa-app-study.md:238`.
- **The user's exact APK/flavour is not recorded in any local note.** What can be inferred:
  - The phone-log UA is `…; wv … Chrome/154 … lampa_client` — a **system Android WebView**, version 154.
  - The Cefrium AC3 builds are **Chromium 152** (`lampa-study/chromium-repo/README.md:5`,
    `lampa-app-study.md:193-204`: `chromium_tag 152.0.7977.82`, `enable_platform_ac3_eac3_audio = true`,
    `enable_passthrough_audio_codecs = false`) and are **arm64-v8a only** (`lampa-app-study.md:236`). Existing
    AC3/EAC3 APKs: `lampa-aec3-2026.09.28` (`top.rootu.lampa.aec3`), `lampa-repair-2026.09.27` /
    `-2026.09.28-proxy` (`top.rootu.lampa.repair`), `aec3-max15-test-2026.10.04` (`lampa-app-study.md:185-188`).
    Release notes say such a build was “проверена на телефоне” (`lampa-study/release-meta/lampa-repair-2026.09.27/body.md:3`,
    `aec3-max15-test-2026.10.04/body.md:5` — verified on ARM64 Android 17 with **MP4** AC3/EAC3 clips).
  - A UA of Chrome/**154** does not match a Chromium-**152** Cefrium runtime; and the bridge engaging at all means
    `canPlayType` for the audio codec was empty — i.e. the engine has no AC3/EAC3 decoder. Both point to the session
    running on the **system WebView**, **not** the Cefrium AC3 build.
  **This is an inference, not a recorded fact.** `unknown`: whether the installed app is plain `ARST113/LAMPA`
  (`top.rootu.lampa`) or “Lampa Native” (`io.github.arst113.lampa`), and its version.
- **Would the Cefrium Chromium 152 AC3 build help?** Partially: it gives software FFmpeg AC3/EAC3 in the inner player
  (`lampa-app-study.md:264-269`), but **not DTS** (only `enable_platform_ac3_eac3_audio` is set, no `dca`), and it does
  not add an AC3 pass-through (`enable_passthrough_audio_codecs = false`). Its media-playback measurements are still
  listed as pending in `lampa-study/chromium-repo/codec-progress.md` (“Post-change input regression and media playback
  measurements remain pending”), and the only verified playback used MP4, not MKV. So even that build would not by
  itself guarantee the user's 4K HEVC MKV + AC3 case.

---

## Bottom line

1. Plain `ARST113/LAMPA` has **no** AC3/EAC3/DTS decoders (external Intent only); “Lampa Native” and the external
   `ARX.TPlayer` have them (`ac3 eac3 dca mlp truehd`).
2. MKV **is** playable by Chromium ≥ 145, so the user's WebView 154 can demux MKV; the genuine missing piece is
   **AC3/EAC3/DTS audio**, not the container. (The project's own `canPlayNativeSource` hardcodes matroska → false —
   conservative/outdated.)
3. The `inner` guard has **no container or video-codec check** (`:630` only tests mode + `http(s)`); for this MKV it
   always forces inner, with **no fallback** if the inner `<video>` fails, and it reads the whole container a second
   time. Those are the concrete ways it can turn a playable stream into “ничего не работает”.
4. For AC3/EAC3/DTS on MKV in the APK, prefer the native `android` player backed by an FFmpeg-capable player
   (“Lampa Native” in-app Just+, or the external `ARX.TPlayer`); keep inner + bridge for MP4/WebM/HLS.
5. Fix `plugin-patched.js` by adding `webViewCanPlayContainer(url)` (extension whitelist + `canPlayType`, MKV allowed
   with a container probe), extending the probe to the video codec, and adding a one-shot fallback to the native
   player on inner failure.
6. `player/` = external ARX.TPlayer (Media3 1.11.1 + FFmpeg), not the Lampa APK. No note names the user's installed
   Lampa APK; the Chrome/154 UA indicates system WebView rather than the Cefrium Chromium-152 AC3 build.

### External sources used (untrusted content, cited as evidence only)

- Chromium commit `d0813004e27eb2f679dd4a9e26a13baeac4be9f2` — Matroska MIME support:
  <https://chromium.googlesource.com/chromium/src/+/d0813004e27eb2f679dd4a9e26a13baeac4be9f2>
- Chromium `media/base/mime_util_internal.cc` (MKV codec tables):
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/mime_util_internal.cc>
- caniuse issue #7347 (“Chromium < 145 … partial”): <https://github.com/fyrd/caniuse/issues/7347>
