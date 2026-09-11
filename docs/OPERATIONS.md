# Operations

Day-to-day operation of an installed instance: backups, upgrades, logs, health checks,
backfill, standards recompute, disk sizing, and troubleshooting.

## Backups

Everything the application knows lives in one PostgreSQL database (the `db` service, backed by
the named volume `fld-db-data`). Back it up on a schedule.

### Logical backup (`pg_dump`) — recommended for routine backups

```bash
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c -f /tmp/fld.dump
docker compose cp db:/tmp/fld.dump ./backups/fld-$(date +%Y%m%d-%H%M).dump
docker compose exec -T db rm /tmp/fld.dump
```

Put this in a nightly cron job on the host (outside the container), rotating old dump files as
your retention policy requires. `POSTGRES_USER` and `POSTGRES_DB` come from your `.env`
(defaults `fld`/`fld`).

### Volume backup — for full disaster-recovery snapshots

Stop the stack (or at least `db`) before copying the volume so files are not mid-write, then
back up the Docker volume:

```bash
docker compose stop
docker run --rm -v fld-db-data:/data -v "$(pwd)/backups":/backup alpine \
  tar czf /backup/fld-db-data-$(date +%Y%m%d).tgz -C /data .
docker compose start
```

(The volume name may be prefixed with your Compose project name — check with
`docker volume ls`.)

## Restore

**From a `pg_dump` file:**

```bash
docker compose stop api collector
docker compose cp ./backups/fld-YYYYMMDD-HHMM.dump db:/tmp/fld.dump
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/fld.dump
docker compose up -d
```

**From a volume tarball:** stop the stack, remove the existing volume, recreate it and extract
the tarball into it, then start the stack again:

```bash
docker compose down
docker volume rm fld-db-data
docker volume create fld-db-data
docker run --rm -v fld-db-data:/data -v "$(pwd)/backups":/backup alpine \
  tar xzf /backup/fld-db-data-YYYYMMDD.tgz -C /data
docker compose up -d
```

## Upgrades

```bash
git pull
docker compose build
docker compose up -d
```

The API applies any pending SQL migrations from `db/migrations/` automatically on start —
there is no separate migration step to run by hand. Check `docker compose logs api` after an
upgrade to confirm migrations applied cleanly (`applying migration ...` / `database schema up
to date`).

## Logs

```bash
docker compose logs -f api
docker compose logs -f collector
docker compose logs -f web
```

`api` and `collector` emit structured **JSON logs** (via pino); in production they are
one-JSON-object-per-line, suitable for shipping to a log aggregator. Verbosity is controlled
by `LOG_LEVEL` in `.env` (`trace` \| `debug` \| `info` \| `warn` \| `error`; default `info`).
The `web` service's logs are nginx's standard access/error logs.

## Health endpoints and the admin Sync page

- `GET /api/health` — overall app health: database reachability, app version, plant time zone,
  whether first-run setup is still needed. Returns HTTP 503 if the database is unreachable.
- `GET /api/health/sync` — collector/integration health: status (`ok` \| `degraded` \| `down`
  \| `never`), last successful poll time, last error, consecutive failure count, whether data
  is currently "delayed", and per-data-source detail (watermark, rows in the last poll, poll
  duration) plus backfill progress.
- `docker compose ps` — container-level health (the `db` and `api` services have Docker
  healthchecks; `api`'s checks `GET /api/health`).
- **Admin > Sync** in the portal shows the same information as `/api/health/sync` in a UI,
  refreshed every 10 seconds, plus recent `sync_log` entries per data source.

## The circuit breaker and "Data delayed" banner

If a poll to FactoryLogix fails (HTTP error, timeout, or auth failure), the collector counts
consecutive failures. Once that count reaches `breaker_failure_threshold` (default 3), it backs
off: the next attempt waits 2x the normal poll interval, then 4x, doubling up to
`breaker_max_backoff_minutes` (default 10 minutes). Any successful poll resets the counter and
the interval back to normal immediately.

Regardless of the breaker state, the TV and portal treat data as **delayed** whenever the last
successful poll is older than **3x the configured poll interval**, and show a "Data delayed
since HH:MM" banner. The dashboards keep showing the last data they had — nothing disappears,
nothing freezes on a spinner. The banner clears automatically on the next successful poll.

Sync status values you will see in Admin > Sync:

| Status | Meaning |
|---|---|
| `ok` | Last poll succeeded and data is current. |
| `degraded` | Some recent failures (under the breaker threshold) or backing off, but a poll has succeeded recently enough not to be "delayed" yet. |
| `down` | The breaker is open (threshold reached) and the last success is older than 3x the poll interval. |
| `never` | The collector has never completed a poll — either FactoryLogix connection/mapping has not been configured yet, or every attempt so far has failed. |

## Backfill

On first run (and whenever run manually), the collector backfills `backfill_days` (default
180) of history, oldest day first, one day at a time, pausing `backfill_pause_seconds`
(default 5 seconds) between days so FactoryLogix is never hit hard.

- **Off-shift window:** by default backfill only runs inside `backfill_window` (default 22:00
  to 05:00 plant time) so it does not compete with live polling load during production hours.
- **Run now:** Admin > Connection > "Run backfill now" (or the setup wizard's backfill step)
  overrides the window and runs immediately.
- **Resume:** progress is persisted (`sync_state` for source `backfill`), so a collector
  restart mid-backfill picks up where it left off rather than starting over.
- Standards are (re)computed once the backfill finishes.

## Standards nightly recompute

Every night at `std_recompute_time` (default 02:00 plant time), the engine recomputes the
standard (`StdHr`) for every product/operation that received new completed units since the
last run. You can also trigger a recompute on demand from Admin > Standards ("Recompute all
standards now") or from a product's page ("Recompute now" for just that product).

## Retention

`retention_days_raw_events` (default `null` = keep forever) controls how long the raw
FactoryLogix payloads in `raw_events` are kept. Normalized data (`unit_steps`, `defects`,
`work_orders`, `hour_cells`, `standards`, etc.) is never deleted automatically in v1 — only the
raw payload table has an optional retention window, applied once a day by the collector.

## Disk sizing

At roughly 20,000 units/day across 15 operations (≈300,000 `unit_steps` rows/day), plus
defects and raw payloads, expect well under 100 MB/day uncompressed. With TimescaleDB
compression on chunks older than 7 days, a full year of data is realistically tens of GB. The
100 GB disk recommendation in `README.md` leaves comfortable headroom for several years at
that volume, plus OS, images, and backups.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| TV shows a pairing code again after working fine | Browser storage was cleared, or the TV's `localStorage`/cookie was reset (new device, factory reset, private browsing) | In Admin > Displays, use "Re-pair": enter the new code and attach it to the existing display record to keep its name and settings |
| "Dashboard offline since HH:MM" banner on a TV | The TV's browser cannot reach the `web`/`api` containers at all (network issue, host down, container crashed) | Check `docker compose ps` and `docker compose logs api web`; check network connectivity between the TV and the server |
| "Data delayed since HH:MM" banner | The collector cannot reach FactoryLogix, or its last successful poll is older than 3x the poll interval | Check Admin > Sync for the last error; confirm the FactoryLogix server and the Report Scheduler Service are up and reachable on port 6065 |
| Sync status stuck at `never` | FactoryLogix connection and/or field mapping have not been completed yet | Finish Admin > Connection and Admin > Mapping (or the first-run wizard) |
| Hour labels look shifted, or a shift's numbers don't line up with the wall clock | Wrong `plant_timezone`, or `fl_timestamp_mode` mismatched with how FactoryLogix serializes timestamps | Fix the time zone and timestamp mode in Admin > Connection; see `docs/MAPPING.md` |
| No colors on hour cells / StdHr shows a dash | No standard has been computed yet for that product/operation (not enough history) and no FactoryLogix StdHr is mapped as a fallback | Wait for backfill + the nightly recompute, or run Admin > Standards > Recompute now; consider mapping the `standards` dataset for an interim fallback |
| API or collector fails to start with an `ENCRYPTION_KEY` error | `ENCRYPTION_KEY` is missing or is not exactly 64 hex characters | Generate a correct key with `openssl rand -hex 32` and set it in `.env`, then `docker compose up -d` again |
| API fails to start with an argon2-related error | Rare on the provided images; usually indicates a corrupted/incompatible `node_modules` from an interrupted build | Rebuild the image: `docker compose build --no-cache api` |
| `docker compose up -d` fails: port 8080 already in use | Something else on the host is already bound to that port | Set a different `WEB_PORT` in `.env` and run `docker compose up -d` again, or stop the conflicting service |

## Resetting the admin password

There is no SQL snippet or CLI command shipped for this. Use one of:

1. **Preferred:** have another active admin go to Admin > Users and set a new password for the
   locked-out account (or create a new admin account for you).
2. **Last resort (no admin can log in at all):** this instance's `users` table is only ever
   allowed to accept a first-run admin registration (`POST /api/setup/admin`) while it is
   **empty**. If truly nobody can log in, delete every row from `users` to re-trigger the
   first-run setup wizard, then create a fresh admin account:

   ```bash
   docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM users;"
   ```

   This does not touch any production data (jobs, unit steps, standards, shifts, breaks) —
   only accounts. Reopen `http://<host>:8080`, which will present the setup wizard's admin
   step again.
