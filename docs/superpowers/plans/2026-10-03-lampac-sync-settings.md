# Lampac synchronization settings implementation plan

> Execute inline with superpowers:executing-plans. Each task uses test-driven-development.

**Goal:** One editable Lampac synchronization ID, automatically inherited
from login with an optional arbitrary shared code, controls history, timecodes and bookmarks.

**Architecture:** Prefix each synchronization script with a shared account
runtime. All transports resolve its current validated identity and reject stale
responses. Local caches isolate account/profile changes.

**Tech Stack:** ES5 JavaScript, ASP.NET Core 10, Node VM tests, Chromium.

**Spec:** `docs/superpowers/specs/2026-10-03-lampac-sync-settings-design.md`.

## Global constraints

- Preserve old plugin routes and saved data formats; keep ContinueWatching's URI.
- Preserve each old account's local and remote history; use the authorized private real-data copy for browser compatibility checks.
- Custom sync IDs must not modify the server playback/CUB login.
- Do not ship login credentials or real history in logs, public artifacts or documentation.
- Television compatibility: ES5 scripts and Lampa's native settings/input controls.

## Review focus

- A default plugin loading before a token-bearing plugin must use the final shared identity.
- Invalid or late password checks must not select an unintended account.
- A late old-account import must not replace new-account history.
- Empty destination accounts must not be seeded with the previous user's data.
- Sync socket reconnects must leave online-playback sockets alive.

### Task 1: Shared account and settings

**Files:** `Modules/Sync/Shared/sync-account.js`, Sync controller, Sync/TimeCode
project files, `tests/lampac-sync-settings.test.js` and test utilities.

**Interfaces:** Produce `window.LampacSync.configure(host, token)`,
`request(method, path, body, callback, options)`, `onChange(callback)`,
`setPassword(value, callback)`, `useLogin(callback)`, `refresh()`, `ready()`,
`epoch()`, `uid()`, `profile()`, `status()`.

- [x] Add failing tests for automatic credentials, one menu section, custom
  override/restart, invalid IDs and preserving old account data.
- [x] Run `node --test --test-isolation=none tests/lampac-sync-settings.test.js`;
  expect failures because the shared runtime/settings are absent.
- [x] Implement the runtime, `/sync/account`, controller prefix and packaging.
- [x] Repeat the tests; expect the account/settings cases to pass.

### Task 2: Integrate all synchronization transports

**Files:** Sync v2 script, bookmark script, timecode script, sync event socket,
their controllers and `tests/lampac-sync-modules.test.js`.

**Interfaces:** Consume Task 1's runtime; existing `/storage`, `/timecode` and
`/bookmark` payloads remain unchanged.

- [x] Add failing tests for default/token module order, selected-ID requests,
  full cross-client transfer, stale replies/events, profile/account switches and
  sync socket isolation.
- [x] Run the module tests; expect the old independent transports to fail.
- [x] Route each module through the shared account; register refresh callbacks,
  include resume history in `sync_view`, and isolate event sockets.
- [x] Run both test files; expect all account and integration cases to pass.

### Task 3: Browser, build, review and delivery

**Files:** Browser acceptance driver, Sync documentation, deployment artifact.

- [x] Check the actual Lampa Synchronization menu, remote-control focus and
  password entry in isolated Chromium with a private copy of the authorized real history.
- [x] Publish Sync, TimeCode and Storage with .NET 10 and inspect the copied shared script.
- [x] Run all added tests, JavaScript syntax checks and `git diff --check`.
- [x] Review the complete change, fix material findings and publish the result.
- [x] Deliver the requested manual-installation ZIP and Russian instructions
  through GitHub; verify the unchanged ContinueWatching URL serves its update.

## Progress

- Exploration: all three old scripts choose credentials independently and use
  singleton guards; adding another sync URL cannot reliably change an account.
- Current source branch matches the remote main base `57ecd07`.
- Source `/reqinfo` is anonymous and cannot validate a password: its fallback UID
  can be present for unknown tokens. Use the protected `/sync/account` endpoint.
- Selected server SSH variables are ready, but its configured TCP connect proxy
  currently refuses connections. Prepare and verify the deployable result first.

- Ruling: the user's latest explicit requirement replaces password-only selection
  with any invented shared ID; retain login authorization and isolate the selected
  ID using one resolver compiled into all three affected modules.
- Ruling: the user explicitly authorized real-data checks; use a read-only snapshot
  locally without publishing private history. The copy contains 6 resume records
  and 122 online-view records.
- Account and transport suites: 31/31 pass; all ContinueWatching checks: 36/36
  pass. New regressions were observed RED then GREEN for owner memory,
  native WebSocket device-ID collision, and swallowed Lampa localStorage quota.
- Backend namespace/controller suite: 18 checks pass, including joining an
  existing basic ID/password manually. The internal linked helper avoids a
  Shared API deployment change.
- Existing module code used removed Staticache/ContentTo/PoolInvk overloads;
  updated those touched modules to the current Shared API to make them build.
- Actual Chromium/Lampa menu and native remote-keyboard checks pass with the
  private real snapshot (6 resume cards, 122 watched records), including exact
  restoration after a custom ID and reset. No browser errors; no live writes.
- Latest ContinueWatching main `82ef286` contains a concurrent 90-percent
  next-episode change. Retained it and added only the owner-memory fix/test.
- The one final independent reviewer found two Important issues: `{}` defaults
  broke native watched-list array operations, and first manual selection during
  startup stranded legacy history. Added three failing regressions, then fixed
  array defaults and canonical basic-owner lookup before manual commitment.
  All 31 account/transport checks now pass. No Critical findings.
- Module publishing stages the correct source manifests explicitly; duplicate
  referenced-project publish metadata cannot overwrite those staged manifests.
- The user selected manual installation and then explicitly requested GitHub
  publication. Deliver source and the built ZIP with Russian INSTALL.txt through
  the existing lampacNextGEN repository. Live installation is outside the final
  selected delivery scope. ContinueWatching's minimal owner-memory fix was
  published as `1a23747`; its unchanged GitHub Pages URL serves the exact file.
