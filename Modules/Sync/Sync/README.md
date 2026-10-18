# Sync

Синхронизация **закладок Lampa** и пользовательских данных с **сервером**: REST API, JS-плагины, БД **SQLite** через `SqlContext`, плюс лёгкий запуск **NWS** только в режиме регистрации.

## Настройка в Lampa

Откройте **Настройки → Синхронизация → Синхронизация Lampac**. По умолчанию
используется базовый ID из входа в Lampac. Чтобы объединить устройства общим
кодом, выберите **ID синхронизации** и введите одинаковый произвольный код
на каждом устройстве. Регистрировать этот код заранее не нужно; вход в Lampac
по-прежнему нужен для доступа к серверу.

Если ввести существующий базовый ID или пароль входа, подключится его прежняя
история. Другой произвольный код создаёт отдельную общую область синхронизации.

**Использовать базовый ID** возвращает текущую привязку из входа. Каждый ID
имеет свою историю; при переключении прежняя история сохраняется отдельно и
восстанавливается при возврате. Синхронизация Lampac отключает синхронизацию CUB,
сохраняя сам вход в CUB.

Старые адреса плагинов сохраняются. `sync.js` подключает закладки и тайм-коды
автоматически. Общий раздел настроек появляется один раз, даже когда сервер
дополнительно установил все три скрипта.

## Назначение

- Хранит и объединяет закладки между устройствами (списки, добавление/удаление, общие endpoint’ы для клиента).
- Регистрирует лимит WAF для префикса **`^/bookmark`**.
- Создаёт каталоги `database/storage` и `database/storage/temp` для связки со Storage-модулем (общая структура данных на сервере).
- Запускает `NwsEvents.Start(onlyreg: true)` — обслуживаются преимущественно регистрационные сообщения WebSocket без полного набора обработчиков (полный режим даёт модуль **SyncEvents**).

## HTTP-маршруты (обзор)

| Префикс / файл | Назначение |
|----------------|------------|
| `sync.js`, `sync/js/{token}` | Плагин синхронизации для клиента. |
| `invc-ws.js`, `invc-ws/js/{token}` | Вспомогательный скрипт для WebSocket / инвентаризации (см. контроллер). |
| `sync/account` | Проверка входа и выбранного ID; защищённый GET, необязательный `sync_id`. |
| **`BookmarkController`** | `bookmark.js`, `/bookmark/list`, `/bookmark/set`, `/bookmark/add`, `/bookmark/added`, `/bookmark/remove` и др. |

Подробная семантика параметров — в `Controllers/BookmarkController.cs` и `SyncController.cs`.

## Конфигурация

Секция в `init.conf`: **`Sync`** — **`ModuleInvoke.Init("Sync", new ModuleConf { … })`**.

В **`updateConf`** по умолчанию задаётся только **`limit_map`** для закладок:

| Префикс WAF | Лимит |
|-------------|--------|
| **`^/bookmark`** | **10** запросов за **1** с |

Полная схема **`ModuleConf`** — в **`Models/ModuleConf.cs`**.

## Связь с SyncEvents

В **`Loaded`**: **`NwsEvents.Start(onlyreg: true)`** ( **`using SyncEvents`** ) — укороченный режим WebSocket. Для **полной** обработки сообщений подключите модуль **SyncEvents** (**`onlyreg: false`**). В **`Dispose`**: **`NwsEvents.Stop()`** — остановка совпадает с жизненным циклом модуля **Sync**.

## Интерфейсы

**`IModuleLoaded`**, **`IModuleConfigure`** — в **`Configure`** регистрируется **`AddDbContextFactory<SqlContext>`**.

## Пути на диске

**`modpath = baseconf.path`**; создаются **`database/storage`** и **`database/storage/temp`**. При загрузке правила **`conf.limit_map`** вставляются в начало **`CoreInit.conf.WAF.limit_map`**.

## Компоненты

| Путь | Роль |
|------|------|
| `Controllers/SyncController.cs` | JS sync / invc-ws. |
| `Controllers/BookmarkController.cs` | API закладок. |
| `SqlContext.cs` | Контекст БД. |

После загрузки вызывается **`SqlContext.Initialization(baseconf.app.ApplicationServices)`** — подготовка БД под DI хоста.

## Зависимости

**Entity Framework**: **`IModuleConfigure.Configure`** → **`AddDbContextFactory<SqlContext>`**. Модуль **SyncEvents** при необходимости дополняет режим **`NwsEvents`** (см. раздел выше).

## Проверки

```sh
node --test --test-isolation=none tests/lampac-sync-settings.test.js tests/lampac-sync-modules.test.js
dotnet run --project tests/Lampac.Sync.Tests/Lampac.Sync.Tests.csproj --configuration Release
```

Общий `sync_id` использует одинаковую область данных в Storage, Sync и TimeCode.
Без него сохраняются прежние области аккаунтов и профилей. Обновляйте эти три
модуля вместе; Sync и TimeCode должны получить `sync-account.js` из публикации.
