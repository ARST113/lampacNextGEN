# Audio-only backend for the original Lampa player

Experimental, opt-in integration. **Does not change the MPV2 player, the source video,
the video decoder, subtitle renderer, remote-control handling or timeline.**

## Files

- `Modules/LampaWeb/plugins/mpvwasm-lampa-audio.js`: independent Lampa plugin.
- `Modules/LampaWeb/plugins/mpvwasm-lampa-audio-loader.js`: optional local Lampac loader.
- `Modules/MpvWasm/assets/mpvwasm-audio-only-worker.js`: FFmpeg WASM audio demux and decoding.
- `Modules/MpvWasm/assets/mpvwasm-audio-only-worklet.js`: audio resampling, mixing and rendering.
- Reuses the existing `mpvwasm-demuxer.js`, `.wasm` and their pthread worker.

## Installation

1. Enable the existing `mpvwasm` module and its proxy, and make sure its
   demuxer JS/WASM binaries are present in the configured `assetsPath`.
2. Deploy the updated module; the module initialization will copy the two
   audio-only JavaScript assets into the configured asset directory.
3. Put `mpvwasm-lampa-audio.js` under `/lampac-js/uploads/` and install
   `/lampac-js/uploads/mpvwasm-lampa-audio-loader.js` **or** register the main
   JS plugin URL directly in Lampa.
4. Disable the standalone MPV2 override plugin for this test: it replaces
   the original Lampa player, which this bridge intentionally does not.
5. Settings > Player > Audio WASM: **Automatic**, **Always** (for the named
   codecs), or **Off**.

Do not simultaneously enable the old `mpvwasm-lampa-loader.js` and this
audio-only integration when testing the original Lampa UI.

## Playback contract

- Video URL and native player are unchanged.
- Audio-only worker reads the same source through `/mpvwasm/proxy` (requires
  byte-range support on source, and `mpvwasm.enableProxy=true`).
- PCM chunks are timestamped and played via `AudioWorklet`.
- `HTMLVideoElement.currentTime` is the authoritative media clock.
- The native video is muted only when WASM reports sufficient buffered audio.
- Native codecs keep native playback. Switching to AC3/EAC3/DTS may use WASM.
- Pauses and native `seeking` events drive the WASM audio pipeline, never
  the other way around.

## Limitations / validation required

**The existing precompiled demuxer is pthread-enabled.** Browsers generally
require `SharedArrayBuffer` and a cross-origin-isolated, HTTPS context
(`COOP: same-origin` and `COEP: require-corp` or compatible policy). An
ordinary HTTP Lampa page may not be able to load it. A new single-thread
FFmpeg+Emscripten WASM build is required to deliver broad Android/macOS
browser compatibility. The existing `demuxer/build-demuxer.sh` currently
depends on an external, prebuilt FFmpeg sysroot; this PR does not claim to
rebuild or verify the binary.

- Browser-level `canPlayType` is a heuristic and cannot completely describe
  Android AVPlay/WebView and Smart TV codec support.
- This integration currently requires an actual browser `<video>` and
  `AudioWorklet`. It does not control native external Android players,
  Tizen AVPlay, or separate webOS platform video objects.
- The video decoder is unchanged; this does not repair unsupported video
  containers/codecs.
- Native audio track selection requires `video.audioTracks`; some platforms
  do not expose it. If unavailable, the plugin shows a warning.
- PCM is downmixed to stereo in the audio worklet. High-quality multichannel
  mixing should be moved into FFmpeg/libswresample in a future rebuilt binary.
- Uses two connections (native video and a range-reading audio worker);
  testing with TorrServer, seeking and slow connections is required.
- Autoplay policy may prevent `AudioContext.resume()` without a user gesture.
- Source URLs are encoded in the proxy query. Never share URLs carrying
  private tokens or cookies, and restrict `mpvwasm.allowedHosts` in public
  installations.

## Checks

The `wasm-audio-bridge.yml` workflow checks JavaScript syntax and runs
lightweight Lampa lifecycle tests. It **does not** prove actual audio decoding
or cross-platform playback. Verify on real Windows, macOS and Android devices
before switching the default plugin.
