# Lampac synchronization settings

The user wants **Синхронизация Lampac** inside the existing Settings →
Synchronization page. The basic ID automatically follows that user's Lampac
login password. A user may replace it with any invented common code; entering
that code on other devices joins their history, bookmarks and timecodes.
ContinueWatching keeps its existing URL.

## Behavior

- Add one section to the existing `account` settings component, with **ID
  синхронизации**, **Использовать базовый ID**, **Синхронизировать сейчас** and
  connection status. The basic mode needs no extra user configuration.
- Automatic credentials use `account_email` / `account.email`, then a keyed
  script token, then `lampac_unic_id`. A custom ID survives login changes and
  application restarts; reset returns to the current basic account.
- Any custom code containing 1–128 characters is accepted, excluding controls.
  Trim surrounding whitespace; otherwise preserve case and Unicode exactly.
  It does not require a registered Lampac account alias.
- The existing login still authorizes every request. A custom code selects a
  separate synchronization namespace through `sync_id`, without modifying the
  playback/CUB login. Invalid IDs or unavailable login retain the current choice.
- `/sync/account` is protected by existing middleware. Basic mode returns the
  canonical login UID. Entering an existing basic ID or login password joins its
  existing namespace. Other custom codes return `lampac-sync-` plus SHA-256.
  Codes are not placed in storage paths or socket registrations in plaintext.
- Existing `/sync.js`, `/timecode.js`, `/bookmark.js`, and keyed variants remain
  usable. Each prefix configures one shared runtime; each transport registers once.
- All three REST APIs and storage events resolve the same namespace. Previous
  requests and events cannot import after account/profile changes.
- Keep the existing Lampac profiles; default profiles also compare strictly.
- Preserve each old namespace's local history in a durable cache before changing
  IDs. A destination loads its own local/remote history; an empty destination
  starts empty. Returning to basic restores basic history. Never delete or
  overwrite the previous remote account during an ID change.
- Resolve the basic owner before a first manual selection when startup validation
  is still pending. Store its legacy history under the canonical basic key, so
  reset can restore it. Empty online/torrent watched lists remain native arrays.
- Add `lampac_resume_history_v1` to `sync_view` and its update listener.
  ContinueWatching must reset its in-memory store when the owner changes, so
  previously watched titles are not reintroduced into a new ID.
- Choosing Lampac disables CUB synchronization (`account_use`) while retaining
  CUB login, to prevent two providers from writing the same data.
- Preserve bookmark categories and native/external playback timecodes.
- Sync owns a separate socket slot AND a separate socket ID: the server cancels
  a previous connection when its ID is reused. Playback sockets remain alive.
- ES5 scripts and native Lampa menu/input controls support television browsers.

## Architecture

`Modules/Sync/Shared/sync-account.js` owns selection, validation, requests,
namespace backups and settings. Sync and TimeCode package it beside their module
and prefix their JavaScript endpoints with it. Its interface is `configure`,
`request`, `onChange`, `setId`, `useBaseId`, `refresh`, `ready`, `epoch`, `uid`,
`profile`, and `status`; previous `setPassword` / `useLogin` names remain aliases.

`Modules/Sync/Shared/SyncIdentity.cs` is compiled into Sync, TimeCode and Storage
as an internal helper. This avoids changing the Shared assembly's API during
module delivery. Default storage paths and database identities remain unchanged.

## Validation and delivery

Node VM clients exercise actual production scripts against the HTTP boundary;
a .NET console suite exercises the real controllers' namespace resolution.
Chromium uses the actual deployed Lampa client and native settings/input controls.
The user explicitly requested real-data checks: retrieve the real `sync_view`
read-only and replay its private copy locally. Do not commit that copy or its
credentials. Observed snapshot: 6 resume records and 122 online-view records.

Publish/build the three affected modules and inspect their packaged scripts.
Source publication is not live deployment. The server's SSH variables are ready,
but the configured TCP proxy refuses connection; live installation requires a
working permitted SSH connection.
