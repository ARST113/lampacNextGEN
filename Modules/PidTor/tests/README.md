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
