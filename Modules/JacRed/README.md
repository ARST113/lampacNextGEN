# JacRed

Интеграция с экосистемой **JacRed / Jackett**: REST API торрент-поиска, кеш на диске (`cache/jacred`), фоновые задачи синхронизации и мониторинг доступности трекеров.

> **Актуальный backend:** для самостоятельного парсинга используйте standalone **JacRed 3.7.0** из `docker-compose.jacred.yaml`. Этот каталог является адаптером Lampac и legacy/local fallback, а не копией upstream `jacred-fdb/jacred`. Инструкция, cron и аудит парсеров: [`jacred-docker/README.md`](../../jacred-docker/README.md).

## Рекомендуемый режим с JacRed 3.7.0

В `init.conf` Lampac модуль должен быть включён (уберите `JacRed` из `BaseModule.SkipModules`) и направлен на backend из Compose:

```json
"JacRed": {
  "typesearch": "webapi",
  "webApiHost": "http://jacred:9117",
  "merge": null,
  "disableJackett": true
}
```

`Engine/WebApi.cs` использует `GET /api/v2.0/indexers/all/results`; этот маршрут сохранён в JacRed 3.7.0. Встроенные `Controllers/*` остаются для legacy/local/Jackett-сценариев и не считаются актуальным каталогом upstream-парсеров.

## Назначение

- Выдаёт клиенту Lampac торрент-результаты через общий API (префиксы **`/api/v1.0/`**, **`/api/v2.0/`** — см. лимиты WAF в `ModInit`).
- Поддерживает режимы **`typesearch`** / **`merge`** (в т.ч. связка с Jackett); при доступности конфигурации Jackett периодически проверяется «живость» отдельных трекеров (`showdown`).
- Добавляет в белый список query-параметр **`query`** для базовой валидации модулей (`BaseModValidQueryValueWhiteList`).

## Фоновые процессы

При старте в пул потоков ставятся:

- **`SyncCron.Run`** — синхронизация с backend JacRed;
- **`FileDB.Cron`** / **`FileDB.CronFast`** — обслуживание локального кеша;
- цикл раз в **5 минут** — обновление флагов `showdown` для индексов Jackett (если тип поиска или merge предполагает Jackett).

Важно: эти фоновые процессы Lampac не заменяют parser cron standalone JacRed. Docker-образ JacRed 3.7.0 не запускает `Data/crontab` самостоятельно; в `docker-compose.jacred.yaml` для этого добавлен `jacred-cron`.

## Конфигурация

Секция в `init.conf`: **`JacRed`** (`JacRedConf`).

Ключевые поля: `typesearch`, `webApiHost`, `merge`, `disableJackett`, вложенный объект **`Jackett`** с настройками трекеров и таймаутами, **`limit_map`** для WAF.

## HTTP API (фрагмент)

Центральный **`ApiController`** (версии API могут дополняться в коде):

| Маршрут | Назначение |
|---------|------------|
| `GET /api/v1.0/conf` | Конфигурация клиента JacRed. |
| `GET /api/v2.0/indexers/{status}/results` | Поиск по индексаторам (**используется PidTor** через `{redapi}`). |
| `GET /api/v1.0/torrents` | Расширенный поиск торрентов по параметрам (`search`, фильтры и т.д. — см. `ApiController.Api`). |

Отдельные встроенные трекеры вынесены в контроллеры с префиксами вида **`rutor/[action]`**, **`kinozal/[action]`**, **`lostfilm/[action]`**, **`anilibria/[action]`** и др. — см. каталог **`Controllers/`**. Этот список старше upstream 3.7.0: например, AniLibria в актуальном JacRed уже retired, а ряд новых 3.7.0-парсеров здесь отсутствует.

## Зависимости

- HTTP-клиент хоста, Serilog, доступ к сети для API и трекеров.
- Для standalone 3.7.0: Docker/Compose; для Cloudflare-защищённых источников — FlareSolverr, а на некоторых VPS для Rutracker также WARP/SOCKS или alias.

## Остановка

`IsDispose` переводится в `true` при выгрузке модуля; фоновые циклы должны завершаться корректно при поддержке в коде JacRed.
