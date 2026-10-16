# JacRed 3.7.0 for Lampac

This directory wires the current standalone JacRed backend into the existing embedded `Modules/JacRed` Lampac adapter.

## What is being upgraded

`Modules/JacRed` is a Lampac integration layer and local/Jackett fallback. It is not a drop-in copy of the standalone `jacred-fdb/jacred` repository, so replacing that directory with upstream sources would break the Lampac module contract.

The supported setup here is:

`Lampac Modules/JacRed -> http://jacred:9117 -> JacRed 3.7.0 -> tracker parsers`

The backend image is pinned to `ghcr.io/jacred-fdb/jacred:3.7.0`.

## Enable JacRed in Lampac

In the Lampac `init.conf`:

1. Remove `"JacRed"` from `BaseModule.SkipModules`.
2. Add/update the module section:

```json
"JacRed": {
  "typesearch": "webapi",
  "webApiHost": "http://jacred:9117",
  "merge": null,
  "disableJackett": true
}
```

`http://jacred:9117` is correct when Lampac is started with the repository's normal bridge-network Compose file. If Lampac is switched to `network_mode: host`, use a host-reachable JacRed address instead, normally `http://127.0.0.1:9117` with port 9117 published.

## Start

From the repository root:

```bash
docker compose -f docker-compose.yaml -f docker-compose.jacred.yaml pull
docker compose -f docker-compose.yaml -f docker-compose.jacred.yaml up -d
```

The override starts:

- `jacred` — JacRed 3.7.0 API/backend;
- `jacred-cron` — the official 3.7.0 `Data/crontab` + `run-job.sh`, with the URL rewritten from localhost to the Compose service name;
- `flaresolverr` — Cloudflare session helper used by protected trackers such as Rutracker.

JacRed's Docker image deliberately does not install/run cron. The cron sidecar is therefore required when this installation is expected to populate and refresh its own FDB instead of using a remote `syncapi`.

## Verify after start

```bash
# Containers and health
docker compose -f docker-compose.yaml -f docker-compose.jacred.yaml ps
curl -fsS http://127.0.0.1:9117/health

# Check that the scheduler loaded upstream jobs
docker logs --tail=100 jacred-cron

# Database/parser statistics
curl -fsS http://127.0.0.1:9117/stats/torrents
curl -fsS http://127.0.0.1:9117/stats/meta

# Same API route that Modules/JacRed/Engine/WebApi.cs uses
curl -fsS -G --data-urlencode 'query=matrix' \
  http://127.0.0.1:9117/api/v2.0/indexers/all/results

# Long-running parser jobs, when any are active
curl -fsS http://127.0.0.1:9117/health/background-jobs
```

For an easier summary run:

```bash
bash scripts/check-jacred.sh
```

Parser logs are persisted in the `jacred-data` volume under `Data/log/` inside the JacRed container.

## Parser/source audit for 3.7.0

Upstream 3.7.0 declares 25 active tracker slugs:

`anibelka`, `anidub`, `anifilm`, `aniliberty`, `animelayer`, `anistar`, `baibako`, `bitru`, `kinozal`, `knaben`, `korsars`, `leproduction`, `lostfilm`, `mazepa`, `megapeer`, `nnmclub`, `rudub`, `rutor`, `rutracker`, `selezen`, `subsplease`, `toloka`, `torrentby`, `ultradox`, `viruseproject`.

All 25 are kept in `jacred-docker/config/init.conf -> synctrackers`.

The seven parsers introduced by the 3.7.0 release line are:

- `anistar`
- `anibelka`
- `anifilm`
- `korsars`
- `leproduction`
- `ultradox`
- `viruseproject`

The embedded Lampac controller set predates 3.7.0 and must be treated as legacy/fallback. In particular, it still contains AniLibria, which upstream marks as retired, and it lacks most of the new 3.7.0 sources. The standalone 3.7.0 backend is therefore the authoritative parser layer for this deployment.

### Sources that need credentials or network handling

- **Rutracker**: Cloudflare protection may require FlareSolverr. On datacenter/VPS IPs, FlareSolverr may additionally need WARP/SOCKS or a configured alias. WARP is not enabled by default in this repository because it changes host networking and requires extra privileges.
- **Anistar**: requires a valid cookie. Rutracker's FlareSolverr warm-up does not provide Anistar's cookie.
- **Anifilm**: supports login/session cookie; fill the corresponding fields in `jacred-docker/config/init.conf` when anonymous parsing is insufficient.
- **Korsars** and **RuDub**: authentication/cookie fields are present in the 3.7.0 config and should be filled when required by the source.

Do not commit real cookies, passwords, API keys or developer keys to the repository.

## What a source-code/CI audit can and cannot prove

The 3.7.0 parser code and its release CI can establish that the parser implementations compile and the release image is buildable. Actual source reachability is deployment-specific: DNS, geo-blocking, Cloudflare, cookies, account state and proxy egress all affect runtime parsing. Use `/stats/torrents`, `Data/log/{tracker}.log`, `jacred-cron` logs and `/health/background-jobs` on the deployed host to identify individual failing sources.
