# mpvwasm-lampa-player.js — read-only code analysis

Target: `mpvwasm-audio/repo/Modules/LampaWeb/plugins/mpvwasm-lampa-player.js` (3555 lines, BUILD `20260809-51-ddd-sync-final`, `VERSION` at line 4/27).
Companion analysed: `mpvwasm-audio/android/plugin-patched.js` (the deployed audio-only bridge, `VERSION '20261010-android-8'`), plus the assets the player plugin loads.

Reference legend used below:

* `player.js:N` — the target file.
* `bridge:N` — `mpvwasm-audio/android/plugin-patched.js`.
* `hybrid:N` — `mpvwasm-audio/repo/Modules/MpvWasm/assets/mpvwasm-hybrid-webcodecs.js` (loaded at runtime by the target, `VERSION '20260723-42-continuous-av'`).
* `demuxer:N` — `mpvwasm-audio/repo/Modules/MpvWasm/demuxer/demuxer.cpp`.
* `lampa:@N` — character offset in `lampa-ref/served-app.min.js` (the served Lampa bundle).

---

## 0. How it gets onto the page

`mpvwasm-audio/repo/Modules/LampaWeb/plugins/mpvwasm-lampa-loader.js` injects `/lampac-js/uploads/mpvwasm-lampa-player.js?v=...`; `mpvwasm-lampa-audio-loader.js` separately injects `/lampac-js/uploads/mpvwasm-lampa-audio.js?v=20261009-audio-bridge-1`. Both are independent `<script>` tags, both `async = false`; nothing coordinates them.

On load the player plugin appends exactly two runtime scripts (player.js:16–21):

```js
append('/mpvwasm/assets/mpvwasm-demuxer-wrapper.js?v=' + VERSION, ...)      // window.MpvWasmDemuxer
append('/mpvwasm/assets/mpvwasm-hybrid-webcodecs.js?v=' + VERSION, ...)      // window.HybridWebCodecsBackend
```

It never loads `/mpvwasm/player.js` (that file is the only definition of `window.MpvWasmTest`, `Modules/MpvWasm/player.js:196`; it is referenced only from the module's own test page `MpvWasmController.cs:273`). Consequence: `window.MpvWasmTest` is normally **undefined on the Lampa page**, which matters for the sidecar/hardware path (§2, §6).

---

## 1. Takeover mechanism, rendering, container handling

**Takeover is by aborting Lampa's `create` event, not by patching a video element.**

* `player.js:3509` `Lampa.Player.listener.follow('create', function (event) {...})`.
* Gate: `player.js:3510` `var useMpv = !!(event && event.data && shouldUseMpvWasm(event.data));` → `shouldUseMpvWasm` (player.js:362–367) requires:
  * storage `mpvwasm_player_mode === 'mpv2'` (line 363 → 384–391), **and**
  * URL matching `.mkv|.avi|.flv|.m2ts|.ts` **or** containing `/stream/` **or** `/lite/pidtor/` (line 366).
* If matched: `event.abort(); event.preventDefault(); event.stopPropagation(); event.cancel = true;` (player.js:3537–3540), then `Lampa.Player.close()` (3542) and `openMpvPlayer(event.data)` (3543). `ignorePlayerDestroyUntil = Date.now() + 30000` (3541) suppresses its own `destroy` handler (3546–3549).
* In stock Lampa, `Player.play` sends exactly this abortable event (`lampa:@1178301`):

  ```js
  var run = true;
  listener$7.send('create', { data: data, abort: function abort() { return run = false; } });
  if (!run) return console.log('Player', 'play aborted by callback');
  ```

  So when the plugin aborts, Lampa's whole player stack — including `Lampa.PlayerVideo` — is never initialised. `PlayerVideo.video()` returns the module-local `_video` (`lampa:@710191`), which is only assigned inside Lampa's video-element factory (`lampa:@700865`). It therefore stays `undefined` in MPV2 mode (§5).
* Setting `mpvwasm_player_mode = 'default'` makes `shouldUseMpvWasm` return `false` at line 363, i.e. **the player plugin is completely inert in default mode** — no takeover at all.

**Rendering: its own full-screen overlay with a `<canvas>` as the video surface.**

* `openMpvPlayer` (1914) → `createOverlay` (1267–1337): builds `.mpvwasm-lampa-root` from Lampa's own `player`/`player_video`/`player_panel` templates (1268–1270, fallback HTML inline), `document.body.appendChild(root)` (1314).
* `canvas = existingCanvas || document.createElement('canvas')` (1273), `canvas.id = 'canvas'` (1284), appended into `.player-video__display` (1272, 1302).
* The player object is `window.HybridWebCodecsBackend.open(ui.canvas, hybridUrl, callbacks, {...})` (3310–3380, call at 3366) — a WebGL/2D canvas renderer (`hybrid:410–471`, `hybrid:1282` render loop).

**Not MSE, not `<video>` replacement, and MKV is demuxed directly by wasm FFmpeg.**

* Grep of the target file: no `MediaSource`, no `addSourceBuffer`, no `SourceBuffer`, no `new VideoDecoder`, no `new AudioDecoder`. The only WebCodecs touch is a capability probe `typeof window.VideoDecoder === 'function'` / `typeof window.AudioDecoder === 'function'` in `buildMediaProbe` (525–526) and `canDecodeVideoWithWebCodecs` (615–629).
* The hybrid backend opens the file with the wasm demuxer: `window.MpvWasmDemuxer.openWorker(url)` (`hybrid:564`) → `demuxer.cpp` (`avformat_open_input`-based `read_packet`, demuxer:120, 323–331), then decodes video with `VideoDecoder` (`hybrid:604–645`). The `.mkv` is read over HTTP byte ranges through the proxy.
* The only place a real `<video>` is created is the *hardware/fallback* path: `document.createElement('video')` (player.js:1341), `video.src = url` (1780), `video.play()` (1781). That path is used only when `state.hardwareVideo` is true (1938, 3410): `!useHybridWebCodecs && shouldUseHardwareVideo(data)`.

**URL form.** `proxyUrl()` (404–408) → `/mpvwasm/proxy?u=<base64url>`; `directUrl()` (397–402) returns the raw URL only if it matches `/^https:\/\/source\.example\/TS\/+/i`. **That regex does not match the user's host path.** `/TS\/+/` means literal `/TS/` + one-or-more `/`; `https://source.example/TS-DE/stream/...` matches neither `/TS/` nor `/TS//`. Verified by evaluating the regex: `isDirectTorrServerUrl(...) === false`. Consequences: the `TS-DE` stream is always proxied, `shouldUseHardwareVideo` (470–472) falls back to the filename heuristic `isHeavyVideoData`, and the "direct TorrServer" shortcut is effectively dead for this host. (`normalizeUrl` 81–84 rewrites `&preload|&stat|&m3u` → `&play`; `patchTorserverFastStart` 426–443 does the same on `Lampa.Torserver.stream` output.)

---

## 2. Audio path

**The plugin file itself does not decode audio.** It only probes capabilities (526 `hasAudioDecoder`) and delegates to `active.player.setAudioTrack(...)` (2900) / `setVolume` (1735). The decoders live in one of two backends:

**A. Hybrid WebCodecs path (canvas; the normal path in Chrome):**

* Track list/default: `this.audioTrack = tracks.filter(t => t.type === 'audio')[0]` (`hybrid:574`).
* `openSelectedAudioDecoder` (`hybrid:718–745`):
  * `this.audioDecoderMode = 'wasm'` (`hybrid:722`) — the default;
  * native WebCodecs `AudioDecoder` is used only when `audioCodecConfig()` returns a config and `AudioDecoder`+`EncodedAudioChunk` exist (`hybrid:723–740`).
  * otherwise `var ret = await this.session.openAudioDecoder(this.audioTrack.index)` (`hybrid:741`) — i.e. **the wasm FFmpeg audio decoder inside the demux worker** (`demuxer.cpp:358–450`, `_demux_audio_open/decode_current_packet`; worker commands `mpvwasm-demuxer-session-worker.js:139–147`).
* `audioCodecConfig` (`hybrid:311–327`) is the actual codec claim:

  ```js
  if (codec === 'ac3' || codec === 'eac3' || codec === 'dts' || codec === 'truehd') return null;   // → wasm path
  else if (codec === 'aac') mapped = 'mp4a.40.2';
  else if (codec === 'mp3') mapped = 'mp3';
  else if (codec === 'opus') mapped = 'opus';
  else if (codec === 'flac') mapped = 'flac';
  ```

  So **ac3/eac3/dts/truehd are always decoded by the wasm FFmpeg**, and aac/mp3/opus/flac are decoded by the browser's WebCodecs `AudioDecoder` when available.
* PCM output goes through a single `AudioWorkletNode` (`hybrid:652–672`), which is **mandatory**: `hybrid:653` `if (!AudioContextClass || !window.AudioWorkletNode) throw new Error('AudioWorklet is not available');`. The context is `window.__mpvwasm_shared_audio_context` if `primeSharedAudioContext` already made one (`hybrid:654–657`; primer in player.js:655–673, installed on pointerdown/touchstart/keydown at 675–684), otherwise it creates its own (`hybrid:661–665`).
* Track switch: `HybridWebCodecsPlayer.setAudioTrack(id)` (`hybrid:1549–1592`) — stops the pump, re-points `this.audioTrack`, `openSelectedAudioDecoder()`, resumes. `id` is `Number(id)` and matched against `track.index`.

**B. Hardware `<video>` path (native decoder + optional mpv-wasm audio sidecar):**

* `createHardwareVideoPlayer(ui, url, callbacks, sidecarUrl)` (1339). It creates the `<video>` (1341), mutes it if a sidecar exists (1373 `if (sidecarUrl) video.muted = true`), and starts a hidden 2×2 mpv-wasm player for audio only: `startSidecar` (1576–1638), `window.MpvWasmTest.createPlayer(sidecarCanvas, null, sideCallbacks, { initialUrl: sidecarUrl, initialMpvOptions: sidecarOptions(...) })` (1620), with options `'vid=no'` + `start=` (1413–1418). Guard at 1577: `if (!sidecarUrl || !window.MpvWasmTest || !window.MpvWasmTest.createPlayer) return;` (see §0 — `MpvWasmTest` is normally absent, so this sidecar usually never starts).
* `setAudioTrack` (1746–1755): `sidecar.setAudioTrack(id)` if present, else `video.audioTracks[i].enabled = ...`. Note `HTMLVideoElement.audioTracks` does not exist in Chrome, so on this path audio-track selection is a silent no-op and only the browser's default track plays.

**Grep results for the codec strings in the target file:** `'ac-3'`, `'ec-3'`, `'dtsc'`, `'dca'` — **zero hits**. `AudioDecoder` — only lines 526 and 2586 (capability flag / debug text). `'opus'`/`'ac3'`/`'eac3'` appear only in the URL/metadata text heuristic `guessAudioCodec` (505–514), whose result `probe.audioCodec` is never used to pick a decoder. The real codec whitelist `{ac3,eac3,dts,dca}` is in the *other* plugin (`bridge:11`).

**How the track is picked / is there a setting?**

* No storage key and no setting for the audio track. Selection is per-session from the plugin's own overlay: "A" button (1269/1270 template, `bind('.player-panel__tracks', chooseAudio)` around 3094) → `chooseAudio` (2894–2906) → `Lampa.Select.show(...)` via `openTrackSelect` (1132–1179) → `active.player.setAudioTrack(track.id)` (2900). Button hidden unless ≥2 tracks: `syncTrackButtons` `setHidden('.player-panel__tracks', state.audioTracks.length < 2)` (2891).
* `state.audioTracks` is filled only by the backend callback (3249–3253) or, on the hardware path, from `video.audioTracks`/sidecar (1640–1666).
* The only player-related storage knob this plugin defines is `mpvwasm_player_mode` (§3). `mpvwasm_backend_mode` is *read* (566) but has no UI.

---

## 3. Every `Lampa.Storage` key and every `Lampa.SettingsApi.addParam` in this plugin

**`Lampa.SettingsApi.addParam` — exactly one occurrence in the file (line 791):**

| line | component | param.name | type | default | values | field.name / description |
|---|---|---|---|---|---|---|
| 791–806 | `player` | `mpvwasm_player_mode` | `select` | `'default'` | `default: 'Обычный плеер'`, `mpv2: 'MPV2 WebCodecs'` | `'Плеер для торрентов'` / `'MPV WASM перехватывает запуск только когда здесь выбран MPV WASM'` |

It is additionally mirrored into `Lampa.Params.select('mpvwasm_player_mode', {...})` at 784–789. This is the **only** switch the user gets from this plugin ("Настройки → Плеер → Плеер для торрентов"). The bridge adds a second entry in the same section: `mpvwasm_audio_mode` (`bridge:576–588`, field `'Audio WASM (AC3 / EAC3 / DTS)'`, values `auto/force/inner/off`, default `auto`).

**Storage keys — defined/written by this plugin:**

| key | where | notes |
|---|---|---|
| `mpvwasm_player_mode` | read 390; written 782 (`'mpv'` → `'mpv2'` migration); param 791 | the only UI-exposed key |
| `player_size` | read 2927, written 2938 | Lampa's own key, re-written by the size selector |
| `player_volume` | written 3113; read 3127 | Lampa's own key |
| `player_volume_last` | written 3116; read 3128 | Lampa's own key |

**Storage keys — read-only (no param defined here):**

| key | where | default |
|---|---|---|
| `mpvwasm_backend_mode` | 566 | `'auto'` — dead knob: no UI, and ignored in mpv2 mode (`playerMode === 'mpv2' ? 'hybrid' : ...`) |
| `mpvwasm_debug_overlay` | 1264 | `false` — debug `<pre>` overlay only reachable via `window.__MPV_WASM_DEBUG` or localStorage |
| `torrserver_preload` | 284 | `true` (Lampa key) |
| `player_rewind` | 1959 | `10` (Lampa key) |
| `player_timecode` | 2649 | Lampa key (`'again'`) |
| `playlist_next` | 3268, 3273 | `true` (Lampa key) |

So in Настройки the user can switch only `mpvwasm_player_mode` (this plugin) and `mpvwasm_audio_mode` (bridge). `mpvwasm_backend_mode` and `mpvwasm_debug_overlay` are unreachable through the UI.

---

## 4. Subtitles — what the plugin does, and why embedded SubRip never shows

**No subtitle renderer and no `<track>`/WebVTT machinery exists in the target file.** Grep for `addTextTrack`, `<track`, `.vtt`, `webvtt`, `createElement('track')`, `MediaSource` → **0 hits**. `subtitle`/`subs`/`textTrack` hits are only: the overlay template's empty `.player-video__subtitles` div (1269, matching Lampa's real template, `lampa:@` player_video markup), the track plumbing at 1204–1222 / 1599–1665 / 1756–1764, and the "S" menu at 2892/2910–2920/2954/3095.

Flows that exist:

1. **Live, hardware path:** `publishTracks()` (1640–1666) enumerates `video.textTracks` (1652–1658) and falls back to sidecar-reported subtitles (`sidecarSubtitleTracks`, 1599–1604, 1659–1663). Selection → `player.setSubtitleTrack(id)` (1756–1764) → `sidecar.setSubtitleTrack(id)` or `video.textTracks[i].mode = i === Number(id) ? 'showing' : 'disabled'` (1760–1762).
2. **Live, hybrid path:** the plugin only forwards `track.id` (2916 → `active.player.setSubtitleTrack`) and caches what the backend reported (3254–3257). Rendering is in the backend asset: `hybrid:1595–1614 setSubtitleTrack`, `hybrid:967` packet dispatch, `hybrid:1110–1119 handleSubtitlePacket` (`new TextDecoder('utf-8').decode(packet.data)` — i.e. it *does* handle raw SubRip text), `hybrid:1240–1267 renderSubtitles` writing into `this.subtitleNode.textContent` found by `hybrid:758–762 findSubtitleNode()` (`.player-video__subtitles` / `.player-video__subtitles-text` inside `canvas.closest('.player-video')`). `clockUs` compared against packet `ptsUs` (`hybrid:231–237`).
3. **Dead:** `publishTracks(audioTracks, subtitleTracks)` at 1181–1223 — the only code that could have called `Lampa.PlayerPanel.setTracks` / `Lampa.PlayerPanel.setSubs` — is never called; the two call sites (1883, 1887) are **inside the commented-out block `/* … */` at 1798–1912** (function `openMpvPlayerLegacyRemoved`). Confirmed: comment opens at 1798, closes at 1912.

**Why embedded SubRip can never show on the hardware/fallback path (concretely):**

* `video.textTracks` is always empty here: the element is a plain `<video>` given `video.src = <mkv url>` (1341, 1780) and the plugin never adds a `<track>`; the browser cannot demux Matroska text tracks by itself.
* Therefore `subs` in `publishTracks` stays empty (1652–1665), so `state.subtitleTracks.length === 0` → `setHidden('.player-panel__subs', state.subtitleTracks.length < 1)` (2892) hides the "S" button and the Settings entry is `ghost`/`noenter` (2954). The menu is unreachable.
* Even if it were reachable, `setSubtitleTrack` only flips `.mode` on the non-existent `video.textTracks` objects (1760–1762); the sidecar branch (1757) calls a **video-less** mpv instance (`vid=no`, 1415) and cannot paint anything on screen.

**Why embedded SubRip can fail on the hybrid path too (concretely):**

* Subtitle rendering lives entirely in the *dynamically loaded* asset. The target file contains no renderer, so if `/mpvwasm/assets/mpvwasm-hybrid-webcodecs.js` served to the browser is older/different from the repo copy analysed here, there is nothing in the plugin to fall back to. The demuxer itself is fine: `demuxer.cpp:160–162` maps `AVMEDIA_TYPE_SUBTITLE → "subtitle"`, `demux_tracks_json()` emits those streams (demuxer:262–315) and `demux_read_packet()` returns **all** streams unfiltered (demuxer:323–331); the worker does not filter either (`mpvwasm-demuxer-session-worker.js:81–113`).
* The hybrid player never auto-selects a subtitle: `this.subtitleTrack = null` at open (`hybrid:576`), and packets are only handled when `this.subtitleTrack && packet.streamIndex === this.subtitleTrack.index` (`hybrid:967`). So subtitles appear only after the user picks one in the plugin's "S" menu — and that menu is gated on `state.subtitleTracks.length >= 1` (2892), which is empty until the backend's `callbacks.subtitleTracks` (3254) arrives. There is no "subtitles on by default" and no Lampa-level subtitle fallback, because the Lampa player pipeline is aborted (§1) and `Lampa.PlayerPanel.setSubs` is dead code (§4.3).
* Bug worth flagging in the "off" entry: `chooseSubs` sends `id: -1` (2912) → `setSubtitleTrack(-1)`; the hybrid handles `index < 0` (`hybrid:1597–1604`) but the hardware path would compute `i === -1` for all `i`, disabling everything (harmless, but asymmetric).

---

## 5. Interaction / conflict with the audio-only bridge (`android/plugin-patched.js`)

Both plugins are loaded into the same page as separate scripts and both register a `component: 'player'` settings entry. Exact lines:

| aspect | player plugin (mpvwasm-lampa-player.js) | bridge (plugin-patched.js) |
|---|---|---|
| `Lampa.Player.listener` hooks | `follow('create')` 3509; `follow('destroy')` 3546 | `follow('ready')` 653; `follow('destroy')` 654 |
| `Lampa.PlayerVideo.listener` hooks | **none** (no `PlayerVideo` reference at all) | `follow('loadeddata')` 655; `follow('destroy')` 656; `follow('tracks')` 657 |
| video element | its own: `document.createElement('video')` 1341 (hardware path); canvas otherwise | Lampa's: `Lampa.PlayerVideo.video()` 539–540 |
| `video.muted` writes | 1373 `if (sidecarUrl) video.muted = true`; 1407; 1565; 1636; 1741 | 327, 388–389, 457, 468 `video.muted = true`; restore 372, 530–531 (`video.muted = this.originalMuted`) |
| `video.play()` | 1500, 1721, 1781 | never (by design, comment `bridge:138` "Never alter the source video URL or its playback state") |
| AudioContext / worklet | `primeSharedAudioContext` 655–673 (creates `window.__mpvwasm_shared_audio_context` 658–663, resume on gesture 665–671); hybrid reuses that key (`hybrid:654–657`) and creates `AudioWorkletNode` (`hybrid:671`) | own context: `new Context({latencyHint:'playback'})` 309; `audioWorklet.addModule('/mpvwasm/assets/mpvwasm-audio-only-worklet.js')` 339 + `new AudioWorkletNode(ctx,'lampa-audio-wasm-bridge')` 341; fallback `ScriptProcessorNode` 181–303/343 |
| proxy | `proxyUrl`/`directUrl` 397–408 → `/mpvwasm/proxy?u=` (401, 407) | `proxyUrl` 47–55 → `base + '/mpvwasm/proxy?u=' + base64Url(url)` (54), overridable by `window.__mpvwasmProxyBase` (51) |
| `Lampa.PlayerPanel` | **never in the live path** — the only calls are inside the disabled block (1184–1201, 1204–1222, dead at 1798–1912). It builds its own panel instead (1270) | `Lampa.PlayerPanel.setTracks(items)` 158/177 (in `renderTracks`, re-run on `PlayerVideo.listener 'tracks'` 657–661); **no** `setSubs` anywhere |

**Who wins, and can they fight?**

* In **MPV2 mode** the player plugin wins outright. Its `follow('create')` aborts Lampa's `Player.play` (3537–3540) before Lampa's `PlayerVideo` is ever built, so `Lampa.PlayerVideo.video()` returns `undefined` (`lampa:@710191` + `lampa:@700865`), the bridge's `attach()` bails at `bridge:541` (`if (!video || !video.tagName || video.tagName.toLowerCase() !== 'video') return;`), and the bridge's `follow('ready')` handler (`bridge:653`) never fires because Lampa's player never reaches `ready`. Net effect: **the bridge is dormant in MPV2 mode** — no double audio, no mute war. Note the mute war is structurally impossible anyway: the two plugins mutate *different* `<video>` objects (bridge mutates `_video`; player plugin mutates its own element created at 1341).
* In **default mode** the player plugin is inert (`shouldUseMpvWasm` → `false`, line 363/3510), Lampa's normal player runs, and the bridge is the active component (`bridge:649–664`). This is the intended split — the two modes are mutually exclusive, and there is no shared storage key (`mpvwasm_player_mode` vs `mpvwasm_audio_mode`).
* Residual risks that are real:
  * **Mode switch mid-session / stale bridge session.** The bridge only tears down when its 120 ms timer sees a source change (`bridge:558–567`: `if (sourceUrl(video) !== target.url) { target.destroy(); ... attach(); }`) or on `Lampa.Player.listener 'destroy'` (654). If MPV2 takes over while a bridge session is live and the old `<video>` keeps its `src`, the bridge keeps decoding into its own AudioContext (its `video.muted` remains `true`) — overlap/double audio is possible for that window.
  * **Android `openPlayer` hijack vs takeover.** The bridge's `guardAndroidPlayer` (624–648) wraps `Lampa.Android.openPlayer` and, in `mpvwasm_audio_mode === 'inner'`, calls `Lampa.Player.play({... launch_player: 'inner'})` (642–643). If `mpvwasm_player_mode === 'mpv2'`, that very call is intercepted by the player plugin and turned into the canvas player — so "inner Audio WASM" silently becomes MPV2. If both settings are off/auto, the stock Android external-player branch runs and neither plugin decodes.
  * **Shared resources:** both use the same `/mpvwasm/proxy` and the same `mpvwasm-audio-only-worker.js` (bridge:111, 607); the bridge additionally pre-probes the container (`probeStream`, 596–623) in parallel with the player plugin's own demux open when both are triggered.
  * **Track-list ownership.** Because the player plugin uses its own panel and never calls `Lampa.PlayerPanel.setTracks`, the bridge's `setTracks` (177) writes into Lampa's own (hidden) panel DOM, not into the mpvwasm overlay the user actually sees. In MPV2 mode the bridge's tracks are invisible; the "A" button of the overlay is the only working track menu.

---

## 6. Android WebView without WebCodecs — which player is used

Backend selection first: `selectBackend` (563–613). Two cases:

1. **`mpvwasm_player_mode === 'default'`** → `shouldUseMpvWasm` is false (363) → no takeover, Lampa's stock `<video>` player is used (and the audio bridge may attach there). Nothing in this plugin changes behaviour.
2. **`mpvwasm_player_mode === 'mpv2'`** → the mpv2 branch (577–584) unconditionally sets `decision.selected = 'hybrid-webcodecs'`; with no WebCodecs it only records `reason = 'mpv2-requires-webcodecs'`. Then `openMpvPlayer` sees `useHybridWebCodecs = true` (1937) and `hardwareVideo = false` (1938), so `playUrl = proxyUrl(...)` (1939) and `startSelectedPlayer` goes to `createHybridPlayer()` (3410).

   The runtime fallback chain:
   * `waitHybridRuntime(12000)` (3363) resolves because `mpvwasm-hybrid-webcodecs.js` always loads.
   * `backend.open(...)` (3366) → `HybridWebCodecsPlayer.init` → `await ensureDemuxer()` then **`hybrid:558–561`**:
     `if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') throw new Error('WebCodecs VideoDecoder is not available');`
   * `player.js:3396–3401` catches it: `var unsupportedVideo = /WebCodecs unsupported|VideoDecoder is not available/i.test(lastError); if (unsupportedVideo) return activateNativeFallback('webcodecs-video-unsupported', error, null);`
   * `activateNativeFallback` (3324–3361) sets `state.hybridWebCodecs = false; state.hardwareVideo = true` (3330–3331), destroys the hybrid player, and returns
     `createHardwareVideoPlayer(ui, directUrl(data.url), callbacks, proxyUrl(data.url))` (3347).

   So the answer is: **it falls back to an HTML5 `<video>` (the WebView's own decoder) plus an mpv-wasm audio-only sidecar** (`createHardwareVideoPlayer`, 1339; sidecar `vid=no` via `window.MpvWasmTest.createPlayer`, 1576–1638). Because `/mpvwasm/player.js` is not loaded by this plugin (§0), `window.MpvWasmTest` is normally `undefined` and the sidecar is skipped by the guard at 1577 — leaving bare native `<video>` playback. In an Android WebView that cannot decode HEVC/Matroska natively, `video.src`/`play()` (1780–1781) fails and `video.addEventListener('error')` (1703–1705) surfaces "HTML5 video error" → the plugin's promise chain rejects → `notify('MPV WASM error: …')` + `closeActive()` (3434–3440). This matches "in the APK nothing works".
   * A second WebView-specific failure mode that the fallback regex does **not** cover: the hybrid requires AudioWorklet (`hybrid:653` throws `'AudioWorklet is not available'` in an insecure context or old WebView). `player.js:3398`'s regex does not match that string, so instead of falling back the whole open is rethrown (`3402–3404` `reason = 'hybrid-open-failed'`) → `3434–3440` closes the player. The bridge deliberately has a `ScriptProcessorNode` fallback for exactly this (`bridge:131–135, 179–303, 336–347`), but the hybrid backend has none.

---

## 7. Bottom line per reported symptom

* **(a) AC3/EAC3 track silent in the browser while another track plays.** In MPV2 mode the aac/mp3/opus/flac tracks take the native `AudioDecoder` path while **ac3/eac3/dts/truehd take the wasm path** (`hybrid:315` returns `null` → `hybrid:722/741` `session.openAudioDecoder`). A failure/return `<0` there is not checked (`hybrid:741–743`), so the track can end up with an open decoder that yields no PCM while the native-decoder tracks keep working — exactly the reported split. The plugin file contributes nothing here except the selection UI (2894–2906) and volume handling (3110–3119); it has no codec whitelist of its own (grep for `ac-3`/`ec-3`/`dtsc`/`dca` = 0 hits).
* **(b) Embedded SubRip never renders.** The plugin has no subtitle renderer at all; on the hardware/fallback path `video.textTracks` is always empty and `setSubtitleTrack` is a no-op (1652–1665, 1756–1764, button hidden at 2892), and `Lampa.PlayerPanel.setSubs` (1204–1222) is dead code inside the disabled block (1798–1912). On the hybrid path the capability exists in the backend asset, but only after an explicit manual selection (`hybrid:576`, `hybrid:967`), and nothing in the plugin auto-enables or falls back — so the served `mpvwasm-hybrid-webcodecs.js` revision and the "S"-menu gating (2892/2954) are the decisive factors.
* **(c) APK: nothing works.** Without WebCodecs, MPV2 mode always lands on the native-`<video>` fallback (3396–3401 → 3324–3361 → 1339), which cannot play HEVC/MKV in a WebView; and the audio sidecar that could at least supply sound is usually gated off by the missing `window.MpvWasmTest` (1577). Additionally, if WebCodecs *is* present but AudioWorklet is not (insecure context), the hybrid throws a message the fallback regex does not match (`hybrid:653` vs `player.js:3398`) and the session is closed instead of falling back. Either way, toggling `mpvwasm_player_mode` to `default` is the only in-app switch that removes the plugin from the equation (363), leaving Lampa's stock player + the audio bridge.

## 8. Suggested verification (no changes made)

1. `Lampa.Storage.get('mpvwasm_player_mode')` and `Lampa.Storage.get('mpvwasm_audio_mode')` on the device — establishes which of the two plugins is actually in charge.
2. On the device, fetch `/mpvwasm/assets/mpvwasm-hybrid-webcodecs.js` and compare `VERSION` (`hybrid:4`) plus the presence of `handleSubtitlePacket`/`renderSubtitles` with the repo copy analysed here.
3. `window.MpvWasmTest` presence on the Lampa page — decides whether the fallback path has any audio at all.
4. `window.__mpvwasm_log` (player.js:638–653) and `window.__mpvwasmState()` (`bridge:546–556`) after reproducing, to see whether the wasm audio decoder returned a negative code (`hybrid:741`).
