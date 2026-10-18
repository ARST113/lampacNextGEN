# Профильные галочки плагинов в админке LampaWeb

## Проблема

В админке у каждого профиля (`users.json` → `user._admin.plugins`) есть галочки плагинов.
Панель пишет их как `{ "p" + sha256(url плагина)[:12]: bool }`, но во время работы эту
карту никто не читал: клиент всегда получал общий список, поэтому снятая у одного
профиля галочка действовала на всех.

## Решение

- `Modules/LampaWeb/ProfilePluginGate.cs` — для `uid` запроса собирает набор **запрещённых**
  плагинов (учитываются встроенные файлы LampaWeb и `custom_plugins` из конфига) и отдаёт
  его клиенту; ответ кэшируется на 20 секунд без `Staticache`.
- `Modules/LampaWeb/Controllers/ApiController.cs` — новый маршрут
  `GET /lampac/profile-plugins.js?uid=…&account_email=…` (AllowAnonymous, `no-store`).
- `Modules/LampaWeb/plugins/lampainit.js` — загружает карту до старта очереди плагинов и
  учитывает её в `lampacPluginAllowed()`; `plugins.load` ждёт ответ сервера, чтобы первый
  плагин не проскочил до применения галочек.
- `Modules/LampaWeb/manifest.json` — `ProfilePluginGate.cs` добавлен в `tree`.

## Проверка

```bash
curl -s 'http://127.0.0.1:9118/lampac/profile-plugins.js?uid=<uid>' | head
```

Ответ — JavaScript вида `window.lampac_profile_plugins = { "<hash>": false, ... };`.
