# PidTor Regression Tests

Client tests execute actual functions extracted from `../plugin.js`, with fake network and player boundaries. Tests cover source ownership, episode file identity, progressive voice hydration, playlist expansion and per-source playback deadlines.

```sh
cd Modules/PidTor/tests
npm install
npm test
dotnet run --project backend/BackendTests.csproj
```

Backend tests exercise the real catalog and exact-file probe code against fixture JacRed responses and a fake TorrServer HTTP handler. They do not contact live trackers or modify a production server.

Two integration tests use small, generated Lampa player-handler snapshots under `fixtures/`. These describe the compatible player contract; they are not a replacement for testing the installed Lampa version in a browser.

## Клиентские проверки быстрого старта (октябрь 2026)

Добавлены офлайн-тесты, которые вырезают реальные функции из `../plugin.js` и прогоняют их на заглушках:

```bash
node client-fast-start.test.cjs   # warmStream + dedupe/abort, warmQualityVariants, startBufferWindow (wait-once)
node client-movie-warm.test.cjs   # warmMovieChoice, буфер перед внешним плеером у фильма, Favorite.add('history')
```

`client-tracks.test.cjs` и `tracks-ownership.test.cjs` — из PR «PidTor NextGen: direct playback, isolated source state and verified voice labels», запускаются через `node` из этой же папки.
