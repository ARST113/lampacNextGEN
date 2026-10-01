# PidTor

Торренты в онлайне Lampac: поиск раздач через API **JacRed** (`redapi`, по умолчанию `http://jac.red`), фильтрация и сортировка, добавление magnet в **TorrServer** и выдача потоков **`/lite/pidtor/s…`**.

## Назначение

- **`IModuleOnline`**: пункт **Pid&lt;s&gt;T&lt;/s&gt;or** (`pidtor`) появляется только если заданы **`torrs`** и/или **`auth_torrs`** — иначе список пустой.
- **`with_search`**: добавляется ключ **`pidtor`**.
- **`UpdateCurrentConf`**: **`tsport`** берётся из секции **`TorrServer`** в **`current.conf`** (иначе **9085**) для обращения к локальному TS.
- **`OnlineApiQuality`**: для балансера **`pidtor`** подпись **` ~ 2160p`**.

## NextGen Player

`/pidtor.js` adds the NextGen entry point. `/lite/pidtor/v2` returns distinct release variants and real audio metadata. `/lite/pidtor/probe/{hash}?index=N` probes the exact selected torrent file using `PidTor.probe_torrserver`, or `Tracks.tsuri` as a fallback. Keep server credentials in server configuration, not JavaScript.

The player uses direct streams by default, resolves additional voices progressively, expands playlists when a full-season release arrives, and scopes asynchronous responses and quality controls to the active playback. Each replaced source gets a fresh startup deadline. Existing GST settings are not rewritten.

For a single unnamed `und` audio stream, a single studio credit such as `ПМ (Тайм Медиа Групп)` can supply its display name. Generic `SoundHandler` is not treated as a studio name. Named tracks, original-language tracks, multiple streams, and raw ffprobe metadata are preserved. No extra audio streams are fabricated.

The named 2026 story *Monster: The Lizzie Borden Story* maps anthology-numbered season-four release files to season one on its standalone card. Other stories and ordinary seasons are not remapped.

Regression commands and coverage are documented in [tests/README.md](tests/README.md).

## Legacy HTTP

| Маршрут | Назначение |
|---------|------------|
| `GET lite/pidtor` | Поиск торрентов по параметрам карточки (`title`, `original_title`, `year`, `original_language`, `serial`, сезон `s`). Кеш ~40 мин. Запрос к **`{redapi}/api/v2.0/indexers/all/results`**. |
| `GET lite/pidtor/serial/{id}` | Сериалы: список файлов торрента по hash **`id`**, добавление magnet на TS, шаблон серий. |
| `GET lite/pidtor/s{id}` | Стрим выбранного файла (magnet hash **`id`**, опционально **`tsid`**). |

При **`enable == false`** или при ограничении группы (**`NoAccessGroup`**) — **403** или JSON с **`accsdb`**.

## Логика контроллера (кратко)

- Фильтры: **`min_sid`**, **`max_size`** / **`max_serial_size`**, качество в имени (**720p/1080p/2160p/4K**) или **`forceAll`**, **`emptyVoice`**, regex **`filter`** / **`filter_ignore`**, сортировка **`sort`** (`size`, `sid`, …).
- Трекер **`selezen`** отбрасывается.
- Для стрима выбирается хост TorrServer: из **`torrs`**, **`auth_torrs`** (логин/пароль), **`base_auth`** или локальный **`listen.localhost:{tsport}`** с паролем из **`data/ts/accs.db`**.

## Конфигурация

Секция в `init.conf`: **`PidTor`** (`PidTorSettings`).

| Поле | Смысл |
|------|--------|
| `enable` | Включить модуль и HTTP. |
| `redapi` | Базовый URL JacRed API. |
| `apikey` | Ключ для **`/api/v2.0/indexers/all/results`**. |
| `torrs` | Список URL TorrServer для стриминга (или один хост). |
| `auth_torrs` | Отдельные TS с логином/паролем. |
| `base_auth` | Basic-auth к **`torrs`**. |
| `displayname`, `displayindex`, `group`, `group_hide` | Отображение в UI. |
| `min_sid`, `max_size`, `max_serial_size`, `forceAll`, `sort`, `filter`, `filter_ignore`, `emptyVoice` | Отбор раздач. |

## Связанные модули

- **JacRed** — должен отдавать JSON по **`redapi`**.
- **TorrServer** — приём magnet и отдача **`/stream`** (порт **`tsport`**).

## Файлы

| Файл | Роль |
|------|------|
| `ModInit.cs` | Конфиг, `Invoke`, `tsport`, качество. |
| `Controller.cs` | Класс **`PiTor`**, маршруты `lite/pidtor*`. |
| `Model.cs` | DTO торрентов и ответов TS. |
