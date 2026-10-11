# Android и Audio WASM: что сделано и как проверить

Дата: 10.10.2026. Сервер: `lampac.example` (lampac.fun). APK **не пересобирался** — все изменения
серверные (WASM + плагин + модуль).

## Коротко: что изменилось

| Было | Стало |
|---|---|
| `mpvwasm-demuxer.wasm` 14.5 МБ, собран с pthreads → требовал `SharedArrayBuffer` и cross-origin isolation. В Android WebView без COOP/COEP падал: `SharedArrayBuffer is not defined` | добавлена **однопоточная сборка** `mpvwasm-demuxer-st.wasm` (2.4 МБ, без pthread/SAB). Воркер сам выбирает сборку |
| `AudioWorklet` требует защищённого контекста (HTTPS/localhost) → по `http://IP:порт` звука не было | добавлен **резервный рендерер** на `ScriptProcessorNode` (есть везде, работает и по http) |

Логика выбора (файл `mpvwasm-audio-only-worker.js`):

```js
var SINGLE_THREAD = !(typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated);
var GLUE = SINGLE_THREAD ? 'mpvwasm-demuxer-st.js' : 'mpvwasm-demuxer.js';
```

то есть на десктопе в lampac.fun всё как раньше (pthread), а в Android WebView/по http —
однопоточная сборка. Если pthread почему-то не поднялся, воркер сам переключается на `-st`.

## 1. Проверка на телефоне/ТВ (2 минуты, без эмулятора)

1. Открой на устройстве: <https://lampac.fun/lampac-js/uploads/audio-wasm-check.html>
2. Сверху будет четыре плашки — это тот самый чек-лист:

   | Плашка | Android-браузер (HTTPS) | WebView без isolation | По `http://IP:порт` |
   |---|---|---|---|
   | `isSecureContext` | да | да | **нет** |
   | `crossOriginIsolated` | да/нет | нет | нет |
   | `SharedArrayBuffer` | да/нет | нет | нет |
   | `AudioWorkletNode` | да | да | **нет** |
   | `ScriptProcessor (резерв)` | да | да | да |

   Звук должен быть во всех трёх случаях — просто разными рендерерами.
3. Нажми **AC3 (2.0)** → услышишь ровный тон: **440 Гц в левом ухе, 1000 Гц в правом**
   (в дорожке так и записано), в спектре два пика; в строке «Сборка демуксера / рендерер»
   будет написано, что именно загрузилось (`однопоточная`/`многопоточная`).
4. **EAC3 (5.1)** — то же самое, 6 каналов сводятся в стерео.
5. **DTS (только декодер)** — проверяет DTS-декодер без видео: должно быть
   «декодировано … сэмплов, пик …, тон 440 Гц».
6. «Сохранить то, что слышно» — скачает 6 секунд того, что реально вышло в звук.

Если на этом этапе всё зелёное — в Lampa звук тоже пойдёт.

## 2. Включить в Lampa (APK не нужен)

Плагин уже зарегистрирован в lampac (`LampaWeb.customPlugins` → `Audio WASM (AC3/EAC3/DTS)`),
лоадер обновлён на `?v=20261010-android-1`. На устройстве:

- Настройки → Плеер → **Audio WASM (AC3 / EAC3 / DTS)**:
  - `Автоматически` — WASM включается, только если браузер не умеет декодировать дорожку (рекомендую);
  - `Для AC3 / EAC3 / DTS всегда`;
  - `Выключено`.
- Видео, перемотка, пауза, выбор дорожки — штатные, мост трогает только звук.

Требования к браузеру/WebView: специальных требований больше нет — воркер сам выбирает сборку
демуксера и умеет откатываться:

- modern (Chrome/WebView ≥ 85, есть BigInt в WebAssembly): `mpvwasm-demuxer.js` (pthread) при
  `crossOriginIsolated`, иначе `mpvwasm-demuxer-st.js`;
- старые WebView (< 85, например Chromium 83): `mpvwasm-demuxer-st-legacy.js` — та же однотпточная
  сборка, но `-sWASM_BIGINT=0` (i64 через legalization), плюс проба `WebAssembly` на старте и
  рантайм-фолбэк, если вызов упал на несовместимости wasm;
- обвязки (глю) транспилированы в ES2019 — на Chromium 83 больше нет падения `Unexpected token '='`.

Важно: мост работает в **HTML5-плеере** (то, что внутри страницы Lampa). Если приложение
отдаёт видео внешнему плееру (MX Player, VLC, наш ARX/Just Player), мост к его звуковому
тракту не подключится — это ограничение подхода, а не поломка.

## 3. Эмулятор Android

**Локально на этом хосте эмулятор запустить нельзя** (нет `/dev/kvm`, ~330 МБ свободно на `/`, нет Java),
поэтому прогон делается **в GitHub Actions** — репозиторий `ARST113/lampacNextGEN`, ветка
`ci/android-audio-emulator-20261010`, файл `.github/workflows/android-audio-emulator.yml`.

Что важно знать про этот прогон:

- на `ubuntu-latest` KVM **есть**, но права на `/dev/kvm` надо включить отдельным шагом — иначе
  `android-emulator-runner` уходит в QEMU TCG (`-accel off`) и всё медленнее в 20–40 раз (boot ~17 мин,
  установка 10-КБ APK ~84 с, `adb install` 107-МБ APK падает с `Broken pipe`):

  ```yaml
  - name: Enable KVM group perms
    run: |
      echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
      sudo udevadm control --reload-rules
      sudo udevadm trigger --name-match=kvm
  ```

- образ берём лёгкий (`api-level: 30`, `target: default`), ABI `x86_64`, `ram-size: 3072`, `cores: 4`;
  все вызовы `adb` в скрипте обёрнуты в `timeout` (на подвисшем эмуляторе `adb` умеет висеть вечно);
- harness-APK (WebView-обёртка с поддельным `AndroidJS` и JS-интерфейсом для отчётов) собирается прямо в CI
  через `aapt2` + `d8` + `apksigner`, без Gradle: `ci/android-audio-harness/build-apk.sh`;
- сценарии в `ci/android-audio-harness/run-in-emulator.sh`: S1 — страница проверки (AC3/EAC3/DTS),
  S2 — настоящая Lampa с поддельным `AndroidJS`: сначала видно, какой из двух встроенных плееров выбирает
  Lampa (`AndroidJS.openPlayer` = нативный), потом `Lampa.Storage.set('player','inner')` и проверка моста;
  S3 — установка реального APK `Lampa-Native-1.13.0-native.2` (в нём есть x86_64).

Если эмулятор нужен у себя — обычный рецепт (Linux/macOS/Windows, с аппаратным ускорением):

```bash
mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk/cmdline-tools
# commandlinetools-*.zip с developer.android.com/studio#command-tools -> распаковать в latest/
export ANDROID_HOME=~/android-sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "system-images;android-30;default;x86_64"
avdmanager create avd -n lampa30 -k "system-images;android-30;default;x86_64" -d pixel_5
emulator -avd lampa30 -no-snapshot -gpu swiftshader_indirect &
adb wait-for-device
```

Дальше: открыть `https://lampac.fun/` (или `chrome://inspect` → WebView) и выполнить в консоли Lampa

```js
console.table({
  secure: window.isSecureContext,
  audioWorklet: typeof AudioWorkletNode !== 'undefined',
  webWorker: typeof Worker !== 'undefined',
  isolated: window.crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
});
```

Ожидание после наших правок: `secure` и `audioWorklet` — **true только по HTTPS**; `isolated` и
`sharedArrayBuffer` — необязательны (для этого и сделана однопоточная сборка); `webWorker` — true.
Затем на странице проверки нажать AC3 — должны быть два пика (440/1000 Гц) и звук.

## 4. Пересобрать WASM (если понадобится)

Скрипты лежат здесь: `mpvwasm-audio/build-st/build-st.sh` (emsdk + FFmpeg) и
`mpvwasm-audio/build-st/compile-demuxer-st.sh` (компиляция `demuxer.cpp`). На сервере
результат сборки — `~/wasm-build/` (`out/mpvwasm-demuxer-st.{js,wasm}`), туда же пишется
`build.log`/`compile.log`.

```bash
# на сервере (или на своей машине), ~10 минут
bash build-st.sh          # emsdk 3.1.74 + FFmpeg 7.1: --disable-pthreads --disable-everything + нужные демуксеры/декодеры
bash compile-demuxer-st.sh  # em++ demuxer.cpp -O3 ... без -sPTHREAD_POOL_SIZE
# проверка, что сборка действительно однопоточная:
grep -c 'shared: true\|PThread' out/mpvwasm-demuxer-st.js   # должно быть 0
```

Текущие артефакты: `mpvwasm-demuxer-st.js` md5 `1e4b05fef5f7111a8273655e13222bef`,
`mpvwasm-demuxer-st.wasm` md5 `a8f952752dc31b47bce3b8d54fa74095` (2 455 371 б).

Куда класть готовое: `/home/lampac/plugins/mpvwasm/` (раздаётся как `/mpvwasm/assets/...`)
и в `/home/lampac/module/MpvWasm/assets/` (исходники модуля).

## 5. Откат

- вернуть старый воркер: `/home/lampac_backups/module/MpvWasm-audio-bridge-20261010-003617/st-build/mpvwasm-audio-only-worker.js.orig`;
- вернуть старый плагин: там же `mpvwasm-lampa-audio.js.orig`, лоадер — `mpvwasm-lampa-audio-loader.js.orig`;
- `init.conf`: вернуть версию лоадера `?v=20261009-audio-bridge-1` (бэкапы `.bak-android-st-*`);
- ST-файлы можно просто удалить: `mpvwasm-demuxer-st.js/.wasm` — тогда воркер будет использовать
  только pthread-сборку (на Android снова не заработает).

## 6. Диагностика

| Симптом | Причина | Что делать |
|---|---|---|
| `SharedArrayBuffer is not defined` | загружен старотипный воркер (кеш) | обновить страницу, проверить `?v=20261010-android-1` в `/on.js` |
| Плашка `AudioWorkletNode: нет`, звука нет | очень старый WebView (<66) | резервный рендерер включится сам, если `ScriptProcessor` есть; иначе обновить WebView/Android System WebView |
| Звук есть, видео «дёргается» | два соединения (видео + аудио-воркер) на слабом канале | уменьшить качество источника; это описано в README ветки |
| Тона нет, в спектре пусто | дорожка нативно поддерживается браузером | режим `Для AC3 / EAC3 / DTS всегда` либо проверка «как задумано» |
| Внешний плеер открывает видео | Lampa отдаёт ссылку наружу | смотреть в браузере/WebView, либо ждать Android-адаптацию приложения |
