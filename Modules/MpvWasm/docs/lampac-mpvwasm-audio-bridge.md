# Audio WASM bridge для штатного плеера Lampa — установка и проверки

Источник: <https://github.com/ARST113/lampacNextGEN/blob/feat/lampa-audio-wasm-bridge-20261009/Modules/MpvWasm/AUDIO_BRIDGE.md>
Ветка `feat/lampa-audio-wasm-bridge-20261009`, commit `6584f7c4e99b840970cadb72fb69a2edd984b95b` (09.10.2026 22:56 MSK).

Установлено на `lampac.example` (= lampac.fun) 10.10.2026, 00:36–01:00 MSK (включая проверку звука в реальном браузере).

## Что это

Плагин, который добавляет декодирование AC3 / EAC3 / DTS в **штатный** плеер Lampa: видео,
таймлайн, перемотка и внешний вид плеера не меняются, звук для неподдерживаемых браузером
дорожек идёт через FFmpeg WASM (`/mpvwasm/assets/mpvwasm-audio-only-worker.js` + `AudioWorklet`).
Это альтернатива плееру MPV2, который подменяет плеер целиком.

## Что оказалось на сервере до установки

- Модуль `MpvWasm` был **выключен**: `BaseModule.SkipModules` в `init.conf` содержал `"MpvWasm"`,
  поэтому все `/mpvwasm/*` отдавали 404 — без модуля мост работать не может (нет ни прокси, ни
  раздачи WASM-ассетов).
- `mpvwasm.assetsPath = plugins/mpvwasm`, `enableProxy = true`, `enable = true`.
- Демуксер в `plugins/mpvwasm` уже собран с нужным аудио-API: `mpvwasm-demuxer.wasm`
  (md5 `0535bdb11931ce508d030a4575eff092`) совпадает с бинарём из ветки, экспортирует
  `_demux_audio_open/_select/_read/_pcm_ptr/...` — пересборка WASM не нужна.
- MPV2-плагин (`mpvwasm-lampa-loader.js`) в `LampaWeb.customPlugins` имеет `status: 0`, то есть
  не подключается — конфликта «два плеера», о котором предупреждает README, нет. Более того,
  его бинарников (`libmpv.js/.wasm/.data`, `mpvplayer-wrapper.js`) в `plugins/mpvwasm` **нет** —
  старая реализация физически не может загрузиться.

## Что именно интегрировано (разбор PR #6)

Важное уточнение: включать модуль `MpvWasm` — это не «включить старую реализацию», это условие
самого моста. PR #6 (`feat/lampa-audio-wasm-bridge-20261009`, открыт, не влит в `main`) меняет
**ровно 9 файлов**:

| Файл PR #6 | Статус на сервере |
|---|---|
| `Modules/MpvWasm/assets/mpvwasm-audio-only-worker.js` (added) | задеплоен, md5 `8b3c3db5…` = ветке |
| `Modules/MpvWasm/assets/mpvwasm-audio-only-worklet.js` (added) | задеплоен, md5 `b97e9a2c…` = ветке |
| `Modules/MpvWasm/ModInit.cs` (modified) | задеплоен, md5 `c7c8787f…` = ветке |
| `Modules/LampaWeb/plugins/mpvwasm-lampa-audio.js` (added) | задеплоен, md5 `d9b06378…` = ветке |
| `Modules/LampaWeb/plugins/mpvwasm-lampa-audio-loader.js` (added) | задеплоен, md5 `ef1ee832…` = ветке |
| `Modules/MpvWasm/MpvWasm.csproj` (modified, +20) | задеплоен 10.10 (в рантайме не используется, модули компилируются Roslyn'ом) |
| `Modules/MpvWasm/AUDIO_BRIDGE.md` (added) | положен в каталог модуля |
| `tests/lampa-audio-wasm.test.js`, `.github/workflows/wasm-audio-bridge.yml` | репозиторные, локально прогнаны |

Код самого модуля (`MpvWasmController.cs`, `MpvWasmProxyService.cs`, `MpvWasmSecurity.cs`,
демуксер) PR #6 **не трогает вообще** — мост по README (шаг 1) использует его прокси и готовый
FFmpeg WASM. Серверный модуль — это релизная сборка lampac от 06.07.2026 (файлы модуля от
`2026-07-06`); его контроллер отличается от репозиторного в лучшую сторону (добавляет
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` к ассетам), а `mpvwasm-demuxer.wasm`
побайтово совпадает и с `main`, и с веткой (`0535bdb1…`). Итого: старое в мосте — только общая
инфраструктура, которую он обязан переиспользовать; плеер MPV2 не задействован.

## Что установлено

| Путь | Что |
|---|---|
| `/home/lampac/module/MpvWasm/ModInit.cs` | версия из ветки: при загрузке модуля копирует audio-only ассеты в `assetsPath` |
| `/home/lampac/module/MpvWasm/assets/mpvwasm-audio-only-worker.js` | FFmpeg WASM: демукс + декод аудио |
| `/home/lampac/module/MpvWasm/assets/mpvwasm-audio-only-worklet.js` | ресемплинг, микс, рендер PCM |
| `/home/lampac/plugins/mpvwasm/mpvwasm-audio-only-{worker,worklet}.js` | те же файлы в `assetsPath` (раздаются как `/mpvwasm/assets/...`) |
| `/home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js` | основной плагин Lampa |
| `/home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio-loader.js` | лоадер (регистрируется в lampac) |
| `/home/lampac/module/MpvWasm/MpvWasm.csproj`, `AUDIO_BRIDGE.md` | версия из PR #6 (csproj — для полноты, в рантайме не читается) |
| `/home/lampac/wwwroot/lampac-js/uploads/audio-wasm-check.html` | страница-проверка звука для человека (см. ниже) |
| `/home/lampac/wwwroot/lampac-js/uploads/audio-check-{ac3,eac3}.mp4`, `probe-dts.mkv` | тестовые дорожки (30 с; слева 440 Гц, справа 1000 Гц) |
| `/home/lampac/plugins/mpvwasm/mpvwasm-demuxer-st.{js,wasm}` | **однопоточная (Android) сборка**, md5 `1e4b05fe…` / `a8f95275…`, 92 КБ / 2.4 МБ |
| `/home/lampac/plugins/mpvwasm/mpvwasm-audio-only-worker.js` | пропатченный воркер: сам выбирает pthread/однопоточную сборку (`SINGLE_THREAD`) |
| `/home/lampac/wwwroot/lampac-js/uploads/mpvwasm-lampa-audio.js` | плагин с **резервным рендерером** (ScriptProcessor) для `http://` и старых WebView |

Хэши обновлённых 10.10 файлов: воркер `94659941f18b97996d3fb49060af5458`, плагин
`1b1c6e08af27bb8244a81ce087ea2709`, страница `c5d44ff1f394c6a6bd7c4fd7f39da2e4`,
лоадер — с версией `?v=20261010-android-1`.

Хэши md5: worker `8b3c3db5e117f28edb8b0e608ccbc0a3`, worklet `b97e9a2ce8ae96b6ff7c8bbbf225bd2c`,
плагин `d9b06378a6a4f4665b392a4b3a8df6b2`, лоадер `ef1ee832a3169ae0028453d5317376da`,
`ModInit.cs` `c7c8787fd4bfe11e6edfeaa8389a5c18` — совпадают с веткой побайтово.

Копии исходников ветки: `mpvwasm-audio/` (этот каталог), полный sparse-clone —
`mpvwasm-audio/repo/`.

## Изменения `init.conf`

1. `BaseModule.SkipModules` — убран `"MpvWasm"`.
2. `LampaWeb.customPlugins` — добавлена запись
   `"Audio WASM (AC3/EAC3/DTS)"` → `/lampac-js/uploads/mpvwasm-lampa-audio-loader.js?v=20261009-audio-bridge-1`, `status: 1`.
3. `mpvwasm.allowPrivateNetworks` — **оставлен `true`** (см. раздел «Про безопасность»).

Бэкапы: `/home/lampac/init.conf.bak-audio-bridge-*`, `.bak-audio-bridge-ssrf-*`,
`.bak-audio-bridge-prevert-*`; полный набор — в
`/home/lampac_backups/module/MpvWasm-audio-bridge-20261010-003617/` (`README-restore.md`).

Перезапуск: `lampac-restart-safe.sh` → «Активных просмотров нет», простой ~20 с, лампак поднялся,
источники на месте (`/lite/events` отдаёт список).

## Проверки

| Проверка | Результат |
|---|---|
| `node --check` (worker, worklet, плагин, лоадер) | OK на node v22.23.2 (локально) и v18.20.8 (сервер) |
| `node --test tests/lampa-audio-wasm.test.js` | 6/6 pass (оба окружения, тесты гонялись по **задеплоенным** файлам) |
| Загрузка модуля | журнал: `compilation MpvWasm`, `loaded module: MpvWasm` |
| `GET /mpvwasm/assets/mpvwasm-audio-only-worker.js` | 200 `text/javascript`, 4595 б |
| `GET /mpvwasm/assets/mpvwasm-audio-only-worklet.js` | 200, 4219 б |
| `GET /mpvwasm/assets/mpvwasm-demuxer.js` / `.wasm` | 200, 122268 б / 200, 14502994 б |
| Регистрация плагина | `/on.js` содержит URL моста; в живом UI — `[Lampa Audio WASM] audio backend registered` |
| Cross-origin isolation | на `https://lampac.fun` `crossOriginIsolated === true`, `SharedArrayBuffer`, `AudioWorkletNode` доступны |
| E2E в реальном браузере (тестовый MKV h264+AC3 через `/mpvwasm/proxy`) | демукс нашёл `h264` + `ac3`, `select` → 44100 Гц / 1 кан., `read` → 84 PCM-чанка, 129024 сэмпла, пик 0.125, таймстемпы монотонные |
| `AudioWorklet` в реальном браузере | модуль загрузился, процессор создан, 7 status-отчётов, контекст `running` |
| Прокси и Range | `/mpvwasm/proxy` → 200, `Range: bytes=0-1023` → 206 `Partial Content` |

Тестовый файл (`e2e-ac3.mkv`) после проверок удалён.

## Реальная проверка звука в браузере (10.10.2026)

Окружение: живой Chrome 153 (не headless-заглушка), `crossOriginIsolated = true`,
`SharedArrayBuffer` есть; `canPlayType` для `ac-3`, `ec-3`, `dtsc` — **пусто** (то есть мост
включается сам, в режиме «Автоматически»).

Уровень 1 — **живой плеер Lampa** на `https://lampac.fun/`: в консоли вызван
`Lampa.Player.play({url: …/audio-check-ac3.mp4})`, то есть штатный плеер с нашим плагином.
На выход `AudioWorklet` навешен анализатор/рекордер:

| Что мерялось | Результат |
|---|---|
| Активация моста | `video.muted === true` (плагин заглушил нативное аудио), в логе `[Lampa Audio WASM]` без ошибок |
| Спектр реального выхода | два пика: **1001 Гц и 441 Гц** при −38 дБ (в дорожке 440 Гц / 1000 Гц) |
| Уровень | peak 0.124, RMS 0.0625 |
| Запись выхода (MediaRecorder) | 93 632 б Opus; независимый FFT: **L = 440 Гц, R = 1000 Гц**, peak 0.139 / 0.137 |
| Видео | h264 320×180 играло штатно, доиграло до конца, ошибок нет |

Уровень 2 — **страница проверки для человека**: <https://lampac.fun/lampac-js/uploads/audio-wasm-check.html>
(кнопки AC3 / EAC3 / DTS, спектр, буфер, underruns, кнопка «Сохранить то, что слышно»).

| Тест | Результат |
|---|---|
| AC3 2.0 (30 с) | мост активен, доминирующие частоты **431 / 991 Гц**, peak 0.124 / RMS 0.062, буфер до 2.8 с, **underruns 0**, видео идёт, `video.muted = true` |
| EAC3 5.1 (30 с) | мост активен, дорожка `eac3(6ch)`, декодер `48000 Гц / 6 кан.`, **431 / 991 Гц**, peak 0.081 / RMS 0.041, **underruns 0** |
| DTS (проверка декодера, MKV) | декодер DTS **работает**: открыт `dts(2ch)`, декодировано 33 792 сэмпла, peak 0.092, тон 440 Гц (0.031) против 1000 Гц (0.000) |

Запись того, что реально вышло в звук (можно послушать): <https://lampac.fun/lampac-js/uploads/audio-wasm-check-recording.m4a>
Спектрограмма записи (две полосы 440 и 1000 Гц): `audio-check/ac3-spectrogram-2k.png`,
скриншоты живого плеера и страницы: `audio-check/ac3-live.png`, `audio-check/page-ac3-live.png`.

### Про DTS: важная деталь

Сначала DTS «не завёлся» — `Audio decoder unavailable: -28`. Разбор показал, что это дефект
**тестового файла**, а не моста:

- мой `audio-check-dts.mp4` собран ffmpeg'ом, который не умеет DTS в MP4 и записал дорожку с
  тегом `mp4a` (проверка: `codec_tag_string=mp4a`) — то есть получился нестандартный контейнер,
  на нём `demux_audio_open` возвращает `-28` (ENOSPC из XLL-ветки DTS-декодера);
- те же самые DTS-кадры в **MKV** открываются и декодируются штатно (см. таблицу выше);
- этот же ffmpeg вообще отказывается писать корректный `dtsc`-MP4: «Could not find tag for codec dts».

Вывод: DTS-декодер в преднастроенном `mpvwasm-demuxer.wasm` есть и работает; ломается только
нестандартная упаковка DTS-in-MP4. Ведут себя такие файлы при этом корректно — плагин пишет
предупреждение, видео продолжает играть, звук не пропадает нативным (мост не включается).

## Про безопасность

`MpvWasmController` помечен `[AllowAnonymous]`, и прокси `/mpvwasm/proxy?u=...` доступен **без
авторизации** — то есть его можно использовать как открытый HTTP-прокси, а при
`allowPrivateNetworks: true` он умеет ходить и на localhost/в локальную сеть (SSRF). Проверено
снаружи: `https://lampac.fun/mpvwasm/proxy?u=<b64(http://127.0.0.1:8242/testaccsdb?...)>`
возвращает ответ внутреннего эндпоинта.

Пробовал закрыть это настройкой `mpvwasm.allowPrivateNetworks: false` — но тогда прокси
перестаёт отдавать URL самого lampac: .NET на этом хосте резолвит `lampac.fun` не только в
`lampac.example`, но и в `172.17.0.1` + link-local IPv6, и валидация считает хост приватным
(«Host resolves to private network address»). А большинство русских источников отдают поток через
`streamproxy`, то есть ссылкой на хост lampac — с `false` мост ломается на них. Поэтому оставлен
`true`, как в дефолте модуля.

Если захочется закрыть доступ снаружи, правильный путь — убрать `[AllowAnonymous]` у контроллера
и дописать в плагин/воркер передачу `uid` (как делают остальные плагины lampac), иначе accsdb
отрежет запросы воркера к `.wasm` и к прокси. Это отдельная правка, к текущей установке не
относится.

## Как пользоваться

Настройки → Плеер → **Audio WASM (AC3 / EAC3 / DTS)**: `Автоматически` (по умолчанию, WASM
включается только если браузер не умеет декодировать дорожку), `Для AC3 / EAC3 / DTS всегда`,
`Выключено`. Видео, перемотка и пауза остаются штатными — их ведёт нативный плеер.

## Ограничения (из README ветки, подтверждено)

- Нужны HTTPS и cross-origin isolation — на lampac.fun они есть (nginx отдаёт `COOP: same-origin`
  + `COEP: credentialless`).
- Нативный выбор аудиодорожки требует `video.audioTracks`; где его нет — плагин покажет предупреждение.
- Многоканальный звук сводится в стерео в ворклете.
- DTS-in-MP4 с нестандартным тегом (`mp4a` вместо `dtsc`/`dtsh`) не открывается: `-28`.
  Нормальный DTS (MKV/TS, корректный `dtsc`-MP4) работает; при неудаче мост просто не
  включается, воспроизведение видео не ломается.
- Реальную проверку стоит сделать и на живом устройстве (телефон/TV) — для этого и оставлена
  страница `/lampac-js/uploads/audio-wasm-check.html`.
- Тестовые файлы в `/lampac-js/uploads/` (`audio-check-*.mp4`, `probe-dts.mkv`,
  `audio-wasm-check-recording.m4a`, `audio-wasm-check.html`) — служебные, удаляются одной
  командой, если мешают.

## Android: совместимость (сделано 10.10.2026)

Что именно мешало Android и что теперь:

| Блокер | Решение |
|---|---|
| `mpvwasm-demuxer.wasm` собран с pthreads → требует `SharedArrayBuffer`, которого в WebView без `COOP/COEP` нет. Падало с `SharedArrayBuffer is not defined` | пересобрана **однопоточная** сборка `mpvwasm-demuxer-st.{js,wasm}` (emsdk 3.1.74 + FFmpeg 7.1, `--disable-pthreads`, без `-sPTHREAD_POOL_SIZE`); воркер выбирает её, когда нет SAB/изоляции |
| `AudioWorklet` требует защищённого контекста → по `http://IP:порт` звука не было | в плагине появился **резервный рендерер** на `ScriptProcessorNode` (та же логика микса/синхронизации, что в ворклете), включается автоматически или при ошибке worklet |

Проверено в Chrome с ровно теми условиями Android (свой инстанс без прокси, реальный браузер):

| Режим | Окружение | Сборка | Рендерер | Результат |
|---|---|---|---|---|
| `http://127.0.0.1` (secure, без isolation) | `crossOriginIsolated=false`, `SharedArrayBuffer=undefined` | **однопоточная** | AudioWorklet | AC3: пики 1001/441 Гц, peak 0.124; EAC3 5.1: 1001/441 Гц; DTS-декодер: 33 792 сэмпла, 440 Гц |
| `http://mirror-host.example:8099` (обычный http) | `isSecureContext=false` | однопоточная | **ScriptProcessor** | AC3: 441/1001 Гц, peak 0.124 |
| принудительно резервный рендерер | secure | однопоточная | ScriptProcessor | AC3: 1001/441 Гц, peak 0.124 |
| `lampac.fun` (как было) | `crossOriginIsolated=true`, SAB есть | **pthread** (регрессии нет) | AudioWorklet | AC3: 431/991 Гц, peak 0.124, живой Lampa: 1001/441 Гц |

Дополнительно задеплоенная ST-сборка проверена **через настоящий модуль** (не локально):
`demux_open` → `audio_open` → чтение PCM: AC3 339 456 сэмплов, peak 0.1251; DTS (MKV)
144 384 сэмпла, peak 0.0884; полный цикл 0.93 с включая загрузку 2.4 МБ wasm.

Про APK (статический разбор `ARX.TPlayer.v2.1.3-arx6-release.apk`): package
`com.justplus.player`, versionName `2.1.3-arx5`, **minSdk 23**, targetSdk 36, база —
Just Player (`com.brouken.player.App`), внутри Media3 + нативные FFmpeg-библиотеки,
**WebView как такового нет** (одна `PlayerActivity`, нет `WebViewClient`/`addJavascriptInterface`),
есть `ACTION_VIEW` на `http/https/*.m3u8` — то есть это внешний плеер. Значит: пересборка APK
не нужна и не поможет; мост живёт в том браузере/WebView, который рисует страницу Lampa, а если
приложение отдаёт поток внешнему плееру — мост к нему не подключается (ограничение подхода).

Эмулятор Android на этом хосте запустить нельзя: нет `/dev/kvm`, на `/` ~330 МБ свободно,
нет Java. Инструкция для запуска эмулятора у себя и проверки на устройстве —
`lampac-android-instruction.md`.

Скрипты сборки: `mpvwasm-audio/build-st/build-st.sh`, `mpvwasm-audio/build-st/compile-demuxer-st.sh`
(на сервере — `~/wasm-build/`, результат в `~/wasm-build/out/`).

## Два встроенных плеера Lampa (разбор кода, 10.10.2026)

В самой Lampa встроенных плееров два, и переключаются они настройкой `player`
(`src/interaction/settings/params.js:67-80` — на Android это ровно два варианта):

1. **inner** — штатный HTML5 `<video>` внутри страницы (`src/interaction/player/video.js`,
   экспортируется как `Lampa.PlayerVideo`, см. `src/app.js:303`). Именно к нему цепляется
   наш мост (`Lampa.Player.listener.follow('ready')` + `Lampa.PlayerVideo.listener.follow('loadeddata')`).
2. **android** (**дефолт на Android**, `params.js:71`) — нативный/внешний плеер приложения:
   `src/interaction/player.js:561` → `Lampa.Android.openPlayer(url, data)` →
   `src/core/android.js:98` → `AndroidJS.openPlayer(link, JSON.stringify(data))` (проверка версии ≥10).
   Сюда JS-мост достать не может: звук в этом плеере зависит от самого приложения.

Отсюда практический вывод: «звук во встроенном плеере Lampa» = либо inner + наш WASM-мост,
либо android-плеер приложения со своими декодерами (у `Lampa Native` это Media3 + FFmpeg-расширение
с `ac3 eac3 dca mlp truehd` — см. `mpvwasm-audio/android/lampa-app-study.md`).

## Что доработано 10.10.2026 (версия `20261010-android-3`)

| файл | было | стало |
|---|---|---|
| `mpvwasm-audio-only-worker.js` | 256 пакетов / 0.7 с аудио за вызов | 1024 пакета / **2.5 с аудио** за вызов |
| `mpvwasm-demuxer-st.js` (однопоточная сборка) | предзагрузка 1 МБ, XHR-таймаут 12 с | **4 МБ** (как у pthread-сборки), таймаут **30 с** |
| `mpvwasm-audio-only-worklet.js` | очередь блоков ≤100 | ≤4000 (большие пачки больше не теряются) |
| `mpvwasm-lampa-audio.js` | запрос к воркеру мог зависнуть навсегда (`read` без таймаута), буфер 2.8 с | таймауты `open` 15 с / `read` 12 с с повтором вместо смерти сессии; буфер **5 с**; **пере-синхронизация**, когда чтение отстало (буфер пуст >1.5 с → seek на текущую позицию, не чаще раза в 4 с) |
| `mpvwasm-lampa-audio.js` | — | `window.__mpvwasmProxyBase` (уводить чтение на быстрый прокси) и защита от двойного проксирования |
| `mpvwasm-lampa-audio.js` | — | новый режим **«AC3 / EAC3 / DTS во встроенном плеере Lampa»**: перед передачей потока в `android`-плеер мост читает заголовок контейнера и, если аудио действительно AC3/EAC3/DTS, оставляет воспроизведение в inner-плеере (там он и озвучивает). По умолчанию режим не включён — поведение как раньше. |

Все файлы — статические, lampac не перезапускался (`systemctl is-active lampac` → `active`).
Бэкап предыдущих версий: `/home/lampac_backups/module/MpvWasm-audio-bridge-20261010-094807/`.

## Реальный тест на ПК с боевым стримом (The Wild Robot, AC3 5.1, 16.3 ГБ)

Стрим: `http://source-host.example:2367/stream/The.Wild.Robot.2024.1080p.BluRay.x264-ZoroSenpai_EniaHD.mkv?...`
— внутри **8 аудиодорожек**: 5×AC3 5.1 (448/640 кбит/с, русские дубляжи), EAC3 8ch, AAC 2ch (укр.), EAC3 8ch (англ.).

Что показал тест (Chrome, реальная Lampa, inner-плеер, мост):
- видео играет штатно (1920×804, длительность 6101 с, `readyState 4`), мост находит все 8 дорожек,
  выбирает первую AC3, глушит нативный звук (`video.muted = true`) и декодирует PCM (в логе — чтения по 79 чанков,
  PTS растёт монотонно, `eof=false`);
- звук реально идёт: анализатор на выходе ворклёта даёт peak **0.29 / RMS 0.084**, после правок буфер
  наполняется (1.1 → 2.8 с) и держится;
- **узкое место — канал до источника, а не декодер**: демуксер читает контейнер целиком, т.е. со скоростью
  файла (~2.7 МБ/с), а с этого хоста глубокие диапазоны отдаются по 0.2–2 МБ/с (с VPS lampac — 7.7–10 МБ/с,
  через боевой `/mpvwasm/proxy` 4 МБ отдаются за 0.41 с). Когда источник не тянет одновременно видео и
  аудио-демукс, чтение отстаёт, ворклёт выбрасывает «опоздавший» PCM и наступает тишина; поэтому в тестах
  звук то идёт, то пропадает — это ограничение канала, а не моста. На нормальном канале (≥5.5 МБ/с на файл
  такого битрейта) мост успевает: буфер растёт, звук непрерывный.

Проверка уже развёрнутых файлов на боевом сайте (`audio-wasm-check.html`), без тестового стенда:

| условия | сборка | рендерер | AC3 | EAC3 5.1 | DTS |
|---|---|---|---|---|---|
| `https://lampac.fun` (isolated) | pthread | AudioWorklet | 431 / 991 Гц, 0.124/0.062 | 431 / 991 Гц, 0.081/0.041 | 72 704 сэмпла, пик 0.092, тон 440 Гц |
| `http://lampac.fun` (как старый WebView) | однопоточная | ScriptProcessor | 431 / 991 Гц, 0.124/0.063 | 431 / 991 Гц, 0.081/0.033 | 72 704 сэмпла, пик 0.092 |

## Совместимость с Android/WebView: что нашёл эмулятор (10.10.2026, `20261010-android-4`)

Прогоны в GitHub Actions (`mpvwasm-audio/android/emulator-report-final.md`) дали два реальных дефекта:

1. **Синтаксис глю.** Emscripten-обвязка (`mpvwasm-demuxer-st.js`, emsdk 3.1.74) содержит `??=`/`||=`
   (Chrome ≥85) в служебном коде MEMFS/SOCKFS. На WebView Chromium 83 скрипт вообще не парсился —
   страница писала «мост не активен», в консоли `Unexpected token '='`. Исправлено транспиляцией обоих глю
   в **ES2019** (`esbuild --target=es2019`): стало 0 `??=`/`||=`/`?.`. Правильнее на будущее — `-sLEGACY_VM_SUPPORT=1`
   в emcc.
2. **WASM_BIGINT.** После транспиляции глю заработал (демуксер открывает поток, находит дорожки, DTS-декодер
   открывается), но модуль wasm не инстанцируется на Chromium 83: `wasm function signature contains illegal type`.
   Причина — сборка с `-sWASM_BIGINT=1`, а интеграция BigInt в WebAssembly есть только с **Chrome 85**.
   Поэтому собрана **третья (legacy) сборка** `mpvwasm-demuxer-st-legacy.{js,wasm}` с `-sWASM_BIGINT=0`
   (i64 через legalization), она тоже транспилирована в ES2019 и выложена рядом. Воркер выбирает сборку
   сам: проба `WebAssembly` на старте (компиляция + вызов функции с i64), при несовместимости — фолбэк
   по цепочке `pthread → single-thread → single-thread-legacy`, плюс рантайм-повтор сессии
   (`open → select → seek → команда`), если вызов всё-таки упал. Для legacy-сборки i64-аргументы
   передаются двумя 32-битными половинами, а функции с i64-возвратом не вызываются — PTS считается
   накоплением от позиции seek.

### Итог проверки на эмуляторе (WebView 83)

- реальный APK `Lampa-Native-1.13.0-native.2` установлен и запущен на x86_64-эмуляторе (в GitHub Actions, KVM
  обязателен — без него `-accel off` и всё в 20–40 раз медленнее);
- `console.table` с устройства: `secure: true`, `crossOriginIsolated: false`, `SharedArrayBuffer: undefined`,
  `AudioWorkletNode: function`, `webWorker: function`;
- два встроенных плеера подтверждены вживую: `player = "android"` → `[AndroidJS] openPlayer(...)`;
  после `player = "inner"` inner-плеер играет, мост подключается (`opened: true, tracks: 1, selection: 0`)
  и упирается только в `WASM_BIGINT` на этом старом WebView.

## Откат

Полная инструкция — `/home/lampac_backups/module/MpvWasm-audio-bridge-20261010-003617/README-restore.md`.
Минимально: вернуть `"MpvWasm"` в `BaseModule.SkipModules`, убрать запись плагина из
`LampaWeb.customPlugins`, `sudo systemctl restart lampac`.

Дополнительно к бэкапу: исходный `MpvWasm.csproj` (версия от 06.07) лежит там же как
`MpvWasm.csproj.orig`, версия PR #6 — `MpvWasm.csproj.pr6`. Тестовые файлы и страницу проверки
из `/home/lampac/wwwroot/lampac-js/uploads/` можно удалить без последствий для работы лампы.

## Что доработано 10.10.2026 (android-6): почему не было звука на реальных фильмах

### 1. Терялся PCM на длинных дорожках (главная причина тишины)
Резервный рендерер (ScriptProcessor, http/старый WebView) держал очередь всего в 100 блоков
и **молча выбрасывал** PCM, когда демуксер читал быстрее, чем рендерер успевал отдать.
`bufferedUs` при этом не рос (считался от последнего блока), поэтому цикл чтения не
останавливался, мост доходил до EOF на середине фильма и замолкал навсегда.
Внешне: дорожки находятся, но `ready/active = false`, видео не глушится, играет нативная
дорожка — на AC3/EAC3 слышен «гул», на DTS тишина.

Исправлено (plugin-patched.js, worklet):
- очередь резервного рендерера 100 → **600** блоков, выбросы считаются (`dropped`);
- чтение останавливается, когда очередь рендерера заполнена на 60 % (`sinkQueue`);
- цель буфера 5 с → **2.5 с** (ровно столько за один проход отдаёт воркер, `emittedUs < 2.5 с`);
- при выбросе PCM мост делает пере-синхронизацию на текущую позицию видео (`keepUp`).

Проверка на куске **из того самого торрента** (`The.Wild.Robot.2024…`, 24/90 с, оригинальные
дорожки, /lampac-js/uploads/real-frag.mp4, ac3-5.1-90s.mp4): до фикса tap = 0.000 всю дорогу,
после — peak 0.572 / RMS 0.176, буфер 5.0 с, очередь 158/400 без выбросов, непрерывная
запись 8.05 с при живом видео (Lampa, встроенный плеер).

### 2. DTS не открывался, если в файле есть видео
`demux_audio_open()` собирал swresample по `avctx->sample_fmt` сразу после `avcodec_open2`,
а DTS-декодер (dca) сообщает формат сэмплов только после первого кадра → `AV_SAMPLE_FMT_NONE`
→ `swr_init` возвращал `EINVAL` («Audio decoder unavailable: -28», в Emscripten errno 28 = EINVAL).
В файлах без видео параметры приходили из контейнера, поэтому «голый» DTS декодировался —
из-за этого дефект не ловился прежними проверками.

Исправлено в `demuxer.cpp` (пересобраны обе однопоточные сборки, ST и legacy):
- если формат неизвестен — берём FLTP, а на первом кадре swr **пересобирается** под фактический
  формат/частоту/каналы кадра;
- воркер при ошибке декодера переключается на следующую сборку (`switchBuildAndReplay`),
  поэтому pthread-сборка на Android уходит на исправленную ST.

Проверено: `Edward.Scissorhands.x264.DTS-4.0` (MKV + H.264 + DTS 4.0, реальный файл) и
DTS 6.1 (7 кан.) — декодер открывается, PCM есть: worker 103 936 сэмплов / peak 0.366;
Lampa встроенный плеер (dts-5.1-real-60s.mp4) — tap peak 0.212 / RMS 0.038, запись 8.05 с.

### 3. Страница проверки на реальных дорожках
`https://lampac.fun/lampac-js/uploads/audio-wasm-check2.html`: бип 440 Гц (проверка выхода звука),
тестовые тоны, **AC3 5.1 / EAC3 7.1 / DTS 6.1 / AAC 2.0 — нарезаны из реального фильма**,
полный фрагмент с 8 дорожками и переключением дорожек, кнопка «сохранить то, что слышно».
Показывает окружение (Chromium, secure context, worklet), сборку демуксера, буфер, уровень,
очередь рендерера и счётчик выброшенных блоков.

### Итог по развёртыванию
`VERSION = '20261010-android-6'`; загрузчик в `init.conf`/`current.conf` обновлён на `?v=…android-6`
(lampac отдаёт его в `/on.js` без перезапуска). Бэкапы: `/home/lampac_backups/module/MpvWasm-audio-bridge-20261010-133638-android6`.

## 10.10.2026, вечер: почему у пользователя всё ещё «скрипело», а DTS молчал (android-7)

Симптомы с телефона: AC3/EAC3 5.1 и 7.1 — скрипы и прерывания, DTS 6.1 — тишина,
AAC — играет нормально (его играет сам браузер, мост не участвует).

Причина оказалась не в новых правках, а в **устаревших файлах на сервере**: локально
правки android-5/android-6 лежали, а боевые ассеты оставались прежними.

| файл | было на сервере | стало |
|---|---|---|
| `mpvwasm-audio-only-worker.js` | `VERSION = '20261010-android-1'`, **без** фолбэка на ST-сборку | android-7, фолбэк по `audio decoder unavailable` |
| `mpvwasm-audio-only-worklet.js` | 4219 б, `if (this.blocks.length > 100) break;` — PCM молча **выбрасывался** | 6488 б, очередь 600 блоков + учёт выбросов |
| `mpvwasm-demuxer-st.js` | старая сборка | пересобрана с отложенным swresample |

Что из этого давало симптомы:
1. **Скрип и прерывания на AC3/EAC3**: ворклет отбрасывал всё, что не влезало в 100 блоков,
   а плагин читал по 1024 пакета за раз. Дырки в звуке = щелчки и «заикание».
2. **DTS молчит**: старый воркер не умел откатываться на однопоточную сборку, поэтому
   открытие дорожки падало с `Audio decoder unavailable: -28` и звука не было вовсе.
   Проверено прямым вызовом: старый воркер — `select` падает, `glue` так и остаётся
   `mpvwasm-demuxer.js`; новый — `select` ок, `glue` после отката `mpvwasm-demuxer-st.js`.
3. **AAC играет** — потому что браузер декодирует его сам, мост к нему не подключается.

Дополнительно к выкладке (android-7):
- **Пре-ролл 1.5 с** вместо 0.35 с: мост отдаёт звук только набрав запас (в плагине
  видео глушится сразу при выборе дорожки, чтобы не слышать «гул» аппаратного декодера).
- **Часы звука идут сами**: расхождение с видео выбирается ходом ±2.5 %, а не мгновенным
  перескоком (раньше порог 35 мс — каждый перескок выбрасывал кусок PCM и щёлкал).
  Счётчики `gaps` (провалы) и `slips` (перескоки) видны на странице проверки.
- Цель буфера 5 с, чтение не больше 96 пакетов (~1…3 с) за проход, очередь рендерера 600 блоков.
- DTS-проба для страницы: `dts-6.1-loud.mp4` (та же дорожка, нормализована до −18 LUFS,
  перекодирована в DTS 1536 кбит/с) — исходная сцена тихая (−52 dB), на ней «не слышно» путало.

**Проверка скорости декодирования** (`mpvwasm-audio/pc/decode-speed.js`, секунд звука за
секунду времени): AC3 5.1 — 55×, EAC3 7.1 — 41×, DTS 6.1 — 39×, AAC — 118×, фрагмент с 8
дорожками — 8×. То есть дело не в нехватке производительности, а в выброшенном PCM.

**Сверка выкладки**: `mpvwasm-audio/android/verify-deploy.sh` сравнивает md5 всех боевых
файлов с локальными — ровно того шага не хватало, из-за него и жил старый воркер.

Итог по развёртыванию: `VERSION = '20261010-android-7'`, загрузчик в `init.conf`/`current.conf`
`?v=…android-7` (`/on.js` отдаёт его без перезапуска), бэкап
`/home/lampac_backups/module/MpvWasm-audio-bridge-20261010-142509`.

### Итоговая проверка android-8 (10.10.2026, 14:45)

Выложено всё, сверено `verify-deploy.sh` — 9 файлов на сервере побайтово совпадают с локальными,
`/on.js` отдаёт `mpvwasm-lampa-audio-loader.js?v=20261010-android-8`, lampac не перезапускался.

| проверка | результат |
|---|---|
| скорость декодирования | AC3 5.1 — 55×, EAC3 7.1 — 41×, DTS 6.1 — 39×, AAC — 118× (реального времени) |
| страница проверки, AC3 5.1 (https, AudioWorklet) | peak 0.42, буфер 6.0 с, очередь 187/600, выбросов 0 |
| страница проверки, DTS 6.1 (https, AudioWorklet) | peak 0.235, bridge active, выбросов 0 |
| **Lampa, встроенный плеер, AC3 5.1** (http, ScriptProcessor) | запись 8.0 с: peak 0.560, RMS 0.097, **провалов >10 мс — 0**, клиппинга нет |
| **Lampa, встроенный плеер, DTS 6.1** (http, ScriptProcessor) | запись 12.1 с: peak 0.265, RMS 0.039, **провалов >10 мс — 0** |
| воркер на DTS | `select` ок, `glue` после отката — `mpvwasm-demuxer-st.js`, PCM идёт |

Отдельная находка: `open` на телефоне может занимать больше 15 с (загрузка wasm-глu 2.4 МБ
плюс разбор заголовка через прокси) — таймаут `open` в плагине поднят с 15 до 30 с, иначе мост
сдавался и DTS снова оставался без звука.

## 10.10.2026, 15:10–15:55: разбор жалобы «4K: играет только вторая дорожка, в APK ничего, субтитры не работают» (`20261010-android-9`)

Факты (логи nginx lampac + замеры):

| Что | Значение |
|---|---|
| Устройства | Chrome 154 на Android (UA `Android 10; K`) и Lampa-APK (`wv … Chrome/154 … lampa_client`), IP source-host.example |
| Стрим | `https://source.example/TS-DE/stream/Spider-Man.Brand.New.Day.2026.WEB-DL.2160p.HDR.DV.seleZen.mkv?link=…&index=1&play` → source-host.example, `video/x-matroska`, **27 994 729 788 Б (28 ГБ)**, CORS `*`, Accept-Ranges |
| Контейнер (ffprobe) | hevc + eac3(1) · ac3(2) · eac3(3) + 5×**subrip** (rus Forced/Full, eng, eng, eng SDH) |
| Скорость источника | 2–5 МБ/с (замер curl и ffmpeg с lampac-хоста); файл качался во время просмотра (`Last-Modified` = момент сессии) |
| Мост на 4K | читает контейнер через `/mpvwasm/proxy` блоками 1–4 МБ, ~1 МБ/с = **0.3–1.2× реального времени**; нужно ~3.2 МБ/с (26 Мбит/с) |
| Проверка моста на быстром хосте | `real4k-speed.js`: напрямую 0.42×, через прокси 1.22× (PCM 9.2 и 29.6 с за 20 с) |
| ffmpeg на сервере | `-map 0:a:1 -c copy -f mpegts`: 169 с фильма за 42 с (**3.97×**), затем 1.18× (источник плавает); `-map 0:s:0 -c srt` → первая реплика «РАДЫ ВАС ОБСЛУЖИТЬ» 00:01:48 |

Выводы:
- **первая дорожка (eac3/ac3) молчит из-за канала, а не декодера**: мост обязан прочитать весь контейнер второй раз (видео читает его же), источник этого не отдаёт → пре-ролл 1.5 с не набирается, PCM не идёт; вторая дорожка работает, потому что **AAC декодирует сам Chrome** (мост к ней не подключается);
- **субтитры «не работают» потому, что они внутри MKV**: `tracks.js` строит список из ffprobe-метаданных и помечает пункты `ghost: true`, так как `video.textTracks` для MKV пуст → выбор ни к чему не приводит. Chrome 154 контейнер MKV играет (проверено: H.264+AAC MKV, readyState 4), но встроенные subrip-дорожки не показывает (`textTracks: 0`);
- **APK**: наш же режим «AC3/EAC3/DTS во встроенном плеере» мог увести воспроизведение во встроенный WebView без отката → чёрный экран.

Что изменено (`plugin-patched.js`, `VERSION='20261010-android-9'`, md5 `2280a3635e0990c7f5169fdb6d3f93c8`):
1. `checkStarvation()`: 15 с без пре-ролла (<0.8 с буфера) при играющем видео → мост сам снимает глушение, прекращает второе чтение и пишет «Поток не успевает за видео — AC3/EAC3/DTS выключен. Выберите AAC-дорожку» (раньше — вечная тишина и лишняя нагрузка на канал);
2. `guardAndroidPlayer()`: не вмешивается в режиме MPV2 (`mpvwasm_player_mode==='mpv2'`), не отдаёт встроенному плееру заведомо неподдерживаемые контейнеры (`containerLikelyPlayable`), и через 20 с без `readyState>=2` возвращает поток нативному плееру приложения;
3. `attach()`: в MPV2-режиме мост вообще не поднимается (плагин плеера сам декодирует AC3/EAC3/DTS из одного чтения);
4. телеметрия: `GET /mpvwasm/assets/tel-<base64>.js` (404 → запись в nginx-лог) — `env` один раз при старте и `tick` раз в 15 с (`mode, ready, stalled, buf, q, drop, reads, sel, tracks, vrs, vt, vw, np, mut, mpv2, err`), не больше 40 отчётов. Проверено: расшифровывается из лога.

Деплой: `/lampac-js/uploads/mpvwasm-lampa-audio.js` и `…-loader.js` (android-9), `init.conf`/`current.conf` → `mpvwasm-lampa-audio-loader.js?v=20261010-android-9`, lampac не перезапускался (`active`). Проверка: плагин в живой Lampa поднимается без ошибок (`__lampa_audio_wasm_bridge_v1=true`), `/on.js` отдаёт android-9, воркер/ворклет по новому `?v=` — 200.

Дальше (субтитры): серверный разбор контейнера ffmpeg (`-map 0:s:N -c:s srt`) + отдача как настоящей текстовой дорожки в плеер; стартовать разбор по позиции просмотра, чтобы не читать 28 ГБ целиком.
