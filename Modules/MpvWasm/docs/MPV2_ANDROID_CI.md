# MPV2 Android emulator CI

## Цель

Проверять экспериментальный MPV2 на настоящем приложении **Lampa Web**, запущенном
в Android Chrome внутри эмулятора GitHub Actions. Это НЕ нативная сборка APK и
не замена проверки на физическом Android TV.

- Публичный workflow для запуска с другим адресом:
  https://github.com/ARST113/lampacNextGEN/actions/workflows/mpv2-android-lab.yml
- Реализация:
  `.github/workflows/mpv2-android-emulator.yml`
- GitHub Actions-артефакт: `artifacts/mpv2-android/`.

## Как запустить с другой ссылкой

1. Открыть **Actions → MPV2 Android test — choose stream URL**.
2. Нажать **Run workflow**.
3. Вставить полную HTTP(S)-ссылку в поле `stream_url`, сохранив все
   `?link=...&index=...&play` параметры. Или создать в GitHub Actions
   secret `MPV2_TEST_VIDEO_URL`, оставить поле пустым.
4. При необходимости выбрать Android 33/34/35 и время теста (15–180 секунд).
5. После завершения открыть **Artifacts**:
   `result.json`, `samples.json`, `console.json`, снимки экрана,
   `android-logcat.txt`, `server.log`.

Важно: **значения workflow_dispatch не являются секретами**. Для
приватных или временных ссылок использовать secret `MPV2_TEST_VIDEO_URL`.

## Устройство теста

- Workflow использует Android Emulator x86_64 (`google_apis_playstore`),
  KVM, Chrome и настоящий статический клиент `yumata/lampa`.
- Клиент и MPV2 обслуживаются локальным Node-сервером на
  `http://localhost:8787` через `adb reverse`.
- Стрим скачивается непосредственно с источника по HTTP Range в процессе теста,
  не коммитится и не выкладывается целиком в GitHub.
- Прокси не является открытым: обслуживает только URL текущего теста.
- MPV2 принудительно запускается в режиме `hybrid-webcodecs` для чистого
  теста своего декодера, а не обычного HTML5 fallback.
- Puppeteer подключается к Android Chrome по DevTools через `adb forward`.
- Программа считает успешным лишь наблюдаемое продвижение playback clock,
  более 15 кадров и последовательный рендер не менее трёх проб.
- В других случаях отчёт **inconclusive** и задача завершается ошибкой с
  сохранением артефактов.

## Что результаты не доказывают

- Реальную частоту кадров на Android TV, нагрузку CPU/GPU на конкретном SoC.
- Прямой вывод HDMI DTS/AC3/EAC3, физический surround 5.1/7.1.
- Качество HDR/Dolby Vision и точность аппаратного декодирования 4K.
- Стабильность при реальном многосерийном воспроизведении в APK.
- Абсолютную задержку аудио без специального физического стенда.

## Отладка

Самый первый CI-прогон (38081973130) подтвердил загрузку Android, но
остановился на приветственном экране Chrome, поэтому DevTools не заработал.
После просмотра скриншота добавлен `chrome_first_run.py`, который выбирает
«Use without an account» по UIAutomator bounds и повторно открывает Lampa.

Сообщения об ошибках доступа к исходному TorrServer не означают регрессию
MPV2. Если источник недоступен с GitHub Actions, нужно заменить его на
доступный извне файл с HTTP Range (206), желательно со звуком AC3/EAC3/DTS.
