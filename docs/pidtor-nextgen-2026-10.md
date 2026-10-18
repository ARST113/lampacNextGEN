# PidTor NextGen и клиентские фиксы — октябрь 2026

Сводка работ, которые выполнялись на рабочем Lampac и перенесены в репозиторий.
Сервер не менялся при публикации: источник правды — текущее развёрнутое состояние.

## PidTor NextGen (модуль + клиент)

| Что | Где |
|-----|-----|
| Модуль: поиск, варианты качества, `probe`, буфер `Prewarm`, `ProfileGst` | `Modules/PidTor/*.cs`, `manifest.json` |
| Клиент Lampa (сборка `20261017-81-movie-warm`) | `Modules/PidTor/plugin.js` |
| Серверный буфер предзагрузки | `Modules/Prewarm` |
| Тесты | `Modules/PidTor/tests` |
| Документация по итерациям | `Modules/PidTor/docs` |

Итерации:

1. **Прямое воспроизведение и изолированное состояние источника** (PR «PidTor NextGen: direct playback, isolated source state and verified voice labels»): `/lite/pidtor/v2`, `probe/{hash}`, отдельные состояния асинхронных ответов, реальные названия дорожек.
2. **Штатная передача во внешний плеер.** Вместо самодельной ротации плейлиста серия отдаётся Android-плееру так же, как это делает штатный торрент-экран Lampa: полный список файлов + правильный стартовый `url`, без перезаписи карты качеств.
3. **Возврат вариантов качества.** Качества снова показываются и переключаются, прогреваются заранее.
4. **Быстрый старт.** `warmStream` на нажатие, `warmQualityVariants`, опрос `/lite/pidtor/preload/{hash}` каждые 500 мс, окно «Наполняем буфер…».
5. **Фильмы + история.** `warmMovieChoice` греет фильм в момент нажатия; окно буфера открывается до внешнего плеера; обе точки старта пишут штатную историю Lampa (`Favorite.add('history', card, 100)`).

## Лента «Для вас»

`Core/wwwroot/lampac-live/recommendations-v3.js` — клиентский плагин: собирает персональную ленту из истории/избранного активного профиля, нормализует карточки и открывает штатный экран `full`. Плагин только читает избранное и ничего не записывает; источник данных — история профиля, которую теперь пополняет и PidTor.

## Синхронизация закладок

`Core/wwwroot/lampac-js/uploads/sync-guard-v8.js` + `bookmark-silent.js` — исправленная синхронизация: без эхо-петли, без фоновой активности, с правильным адресом сервера; `nav-probe.js` — диагностический зонд перезагрузок страницы.

## Zetflix

`Modules/OnlineRUS/Zetflix` — самообновляемые ссылки на поток: плееру отдаётся маршрут `/lite/zetflix/stream`, который на каждый запрос заново получает ссылку у площадки и переписывает плейлист/сегменты. Подробности — `Modules/OnlineRUS/Zetflix/README-live-fix.md`.

## Профильные галочки плагинов (LampaWeb)

`Modules/LampaWeb/ProfilePluginGate.cs` + endpoint `/lampac/profile-plugins.js` + правка `plugins/lampainit.js`: набор запрещённых для профиля плагинов теперь реально учитывается на клиенте. Подробности — `docs/lampa-profile-plugin-gate.md`.

## Проверки

```bash
# клиентские тесты PidTor
cd Modules/PidTor/tests && node client-fast-start.test.cjs && node client-movie-warm.test.cjs

# сборка сервера
dotnet build NextGen.slnx -c Release
```
