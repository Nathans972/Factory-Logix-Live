# Operations

Day-to-day operation of an installed instance: backups, upgrades, logs, health checks,
backfill, standards recompute, disk sizing, and troubleshooting.

## Backups

Everything the application knows lives in one PostgreSQL database (the `db` service, backed by
the Compose volume `fld-db-data`). Back it up on a schedule.

### Logical backup (`pg_dump`) — recommended for routine backups

`scripts/backup.sh` dumps the database to `backups/fld-YYYYMMDD-HHMM.dump` in the project
directory (the one with `docker-compose.yml`). Run it once by hand first, with the directory you
cloned into in place of `/path/to/Factory-Logix-Live`:

```bash
/path/to/Factory-Logix-Live/scripts/backup.sh
```

It works from any directory and needs nothing from `.env` in your shell: the `db` container
fills in `POSTGRES_USER` and `POSTGRES_DB` itself (from your `.env`, defaults `fld`/`fld`). It
ends with `backup written:` and the file name. If a step fails, it stops there, prints the error
and `backup FAILED`, and leaves no dump file.

Then run it every night from root's crontab (`sudo crontab -e`), here at 03:00:

```
0 3 * * * /path/to/Factory-Logix-Live/scripts/backup.sh >>/var/log/fld-backup.log 2>&1
```

Keep the `>>/var/log/fld-backup.log 2>&1`. Without it cron mails the output to a local mailbox,
and a server with no mail set up throws it away, so a failing backup would go unnoticed. Check
the end of that log the morning after you add the line, and whenever you look in on the server:
the last line should be last night's `backup written`.

The script keeps every dump. To delete old ones as your retention policy requires, add
`&& find /path/to/Factory-Logix-Live/backups -name 'fld-*.dump' -mtime +30 -delete` to the end
of the cron line (30 days here). After `&&` it only runs when that night's backup worked, so
failed nights never delete the dumps you still have.

### Volume backup — for full disaster-recovery snapshots

Stop the stack (or at least `db`) before copying the volume so files are not mid-write, then
back up the Docker volume. Run this in the project directory:

```bash
docker compose stop
docker compose run --rm -v "$(pwd)/backups":/backup db \
  tar czf /backup/fld-db-data-$(date +%Y%m%d).tgz -C /var/lib/postgresql/data .
docker compose start
```

`docker compose run` starts a one-off `db` container on the volume the database really uses,
whatever Docker named it. That isn't `fld-db-data`: Compose puts the project name in front
(`factory-logix-live_fld-db-data` for the clone in `docs/INSTALL.md`). Don't replace it with a
`docker run` or `docker volume` command that names the volume: given a name that doesn't exist,
Docker quietly makes a new, empty volume by that name and backs up or restores that one
instead. The project name comes from the project directory's name, so don't rename that
directory either: Compose would start the database on a new, empty volume.

Then check that the archive holds the database. This lists its `PG_VERSION` files, and prints
nothing for an empty archive:

```bash
tar tzf backups/fld-db-data-YYYYMMDD.tgz | grep PG_VERSION
```

Archives made with this section's earlier commands, which used the bare name `fld-db-data`,
can be empty: check those too.

## Restore

**From a `pg_dump` file:** a dump of a TimescaleDB database restores correctly only into a new,
empty database, between `SELECT timescaledb_pre_restore()` and
`SELECT timescaledb_post_restore()`. Without them TimescaleDB's background jobs and hooks run
during the restore, and a `pg_restore --clean` over the running database also tries to drop the
extension: the restore ends with errors, and the hypertables (`unit_steps`, `defects`,
`raw_events`, `hour_cells`) can come back incomplete.

A dump also has to be restored on the TimescaleDB release it was made on. If you have moved the
`db` image to a newer release since the dump was made (see
[The database image](#the-database-image)), don't restore it with these commands: they can stop
with errors in `_timescaledb_catalog` tables after deleting the database you have now.

In the project directory, stop the api and collector, copy the dump into the `db` container and
restore it:

```bash
docker compose stop api collector
docker compose cp ./backups/fld-YYYYMMDD-HHMM.dump db:/tmp/fld-restore.dump && \
docker compose exec -T db sh -c 'set -e
  pg_restore -f /dev/null /tmp/fld-restore.dump
  dropdb --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/fld-restore.dump
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT timescaledb_post_restore()"
  rm /tmp/fld-restore.dump
  echo restore finished'
```

Keep the single quotes: inside them the `db` container fills in `POSTGRES_USER` and
`POSTGRES_DB` from your `.env`. Your own shell doesn't have them, and would pass empty values.

It first reads the whole dump without touching the database; only then does it delete the
database you have now and restore the dump into a new one. It stops at the first step that
fails. Start the stack again only when its last line is `restore finished`:

```bash
docker compose up -d
```

If it stops with an error instead, the database is incomplete: leave the stack stopped, fix the
cause and run the commands again. Each run starts over with a new, empty database. A dump file
that is missing, cut short or unreadable stops them before anything is deleted, so the database
you had is still there.

**From a volume tarball:** in the project directory, first check that the archive holds a
database:

```bash
tar tzf backups/fld-db-data-YYYYMMDD.tgz | grep PG_VERSION
```

If that prints nothing, stop here: the commands below delete the database you have now, and an
empty archive puts nothing back. Otherwise stop the stack and remove its volume, extract the
tarball into a new one, then start the stack again:

```bash
docker compose down --volumes
docker compose run --rm -v "$(pwd)/backups":/backup db \
  tar xzf /backup/fld-db-data-YYYYMMDD.tgz -C /var/lib/postgresql/data
docker compose up -d
```

**Onto a rebuilt or different server:** neither kind of backup holds `ENCRYPTION_KEY` (it is in
`.env`), and the saved FactoryLogix password is encrypted with it. With another key in `.env`,
that password cannot be decrypted: Admin > Connection asks for it again, and until it is typed
Admin > Sync shows `could not decrypt the FactoryLogix password` and the dashboards show "Data
delayed". Type the password in Admin > Connection and save, and the collector starts polling
again. Or put the old server's `ENCRYPTION_KEY` in `.env` and run `docker compose up -d` again.
Keep any copy of the key apart from the backups: anyone who has both can read the password.

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

### The database image

The `db` service is pinned to an exact TimescaleDB release, `timescale/timescaledb:2.31.0-pg16`
(TimescaleDB 2.31.0 on PostgreSQL 16), so a routine upgrade never changes the database version
on its own. Until October 2026 it was `latest-pg16`; an install from before then may be running
an older 2.x until it is upgraded as below.

To move to a newer TimescaleDB release:

1. Read the TimescaleDB release notes for the target version. Releases that aren't patch
   releases can list extra steps.
2. Take a backup (see [Backups](#backups)).
3. In `docker-compose.yml`, change the tag to the new exact `2.x.y-pg16` tag from Docker Hub.
   Keep `-pg16`: moving to a new PostgreSQL major version is a different, bigger upgrade.
4. Pull the new image and restart the database on the same data volume:

   ```bash
   docker compose pull db
   docker compose up -d db
   ```

5. Update the extension in each database that has it. The image installs it in your database,
   `postgres` and `template1`. Use `psql -X`, so no `.psqlrc` loads TimescaleDB first:

   ```bash
   docker compose exec db sh -c 'for db in "$POSTGRES_DB" postgres template1; do psql -X -U "$POSTGRES_USER" -d "$db" -c "ALTER EXTENSION timescaledb UPDATE;"; done'
   ```

6. Check the version, then start the rest of the stack:

   ```bash
   docker compose exec db sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dx timescaledb"'
   docker compose up -d
   ```

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

Docker keeps each container's log in files on the host, on the same disk as the database, and
`docker-compose.yml` caps them: every service has `logging:` with `max-size: "50m"` and
`max-file: "5"`, so it keeps at most five 50 MB files and deletes the oldest as it goes, and the
four logs never take more than about 1 GB together. The `api` writes the most, two lines for
every request: with 20 TVs about 35 MB a day, so its log goes back about a week (further with
fewer TVs). A container's log is also deleted when the container is recreated, which
`docker compose up -d` does to every container an upgrade changed.

To change the limits, or to use another Docker logging driver, put the services' `logging:` in
a `docker-compose.override.yml` next to `docker-compose.yml`, not in `docker-compose.yml`
itself: Compose reads the override file by itself, and the next `git pull` does not conflict
with it. For example, to keep twice as much of the api's log:

```yaml
services:
  api:
    logging:
      options:
        max-file: "10"
```

Then run `docker compose up -d`: a container takes its log settings when it is created.

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
  refreshed every 10 seconds, plus recent `sync_log` entries per data source. Managers can open
  it too (read-only); every action stays admin-only.
- **Rows, Ingested, Skipped** in the recent-polls table: `Rows` is what FactoryLogix returned,
  `Ingested` what reached the normalized tables, and `Skipped` what was dropped because a
  required field was missing or the product or operation could not be resolved (for example a
  unit step whose work order has not arrived yet and no product number mapped). Pulls with
  skipped rows are highlighted. A few skipped rows that disappear on the next poll are normal;
  a steady count usually means a mapping problem (check the field mapping and the collector
  logs). Pulls logged before migration `0005` show a dash.
- The hourly late-data re-pull reports as source `late_data`. If it fails, the error and the
  failure count show on that row; the next attempt waits an hour, doubling after each further
  failure up to 6 hours. Nothing is lost while it waits, because every re-pull covers the whole
  `late_data_hours` window, and it never counts against the main circuit breaker. It re-pulls
  only the data sources whose regular poll succeeded that cycle, so a failing defects data
  source does not hold up the re-pull of unit steps.

## The circuit breaker and "Data delayed" banner

If a poll to FactoryLogix fails (HTTP error or timeout), the collector counts consecutive
failures. Once that count reaches `breaker_failure_threshold` (default 3), it backs
off: the next attempt waits 2x the normal poll interval, then 4x, doubling up to
`breaker_max_backoff_minutes` (default 10 minutes). Any successful poll resets the counter and
the interval back to normal immediately.

A refused login is different: FactoryLogix answers the same until someone changes the password
or the account, and every refused login counts towards locking the account. When FactoryLogix
refuses the saved login (HTTP 401, or a 403 while nothing else came back that poll), the
collector stops at once and sends nothing more with that login, not on a timer and not after
other admin edits. Admin > Sync shows `FactoryLogix refused the saved login` under "Last error".
Polling starts again when Admin > Connection is saved again: with a new password, or unchanged
once the account works again (for example after a FactoryLogix admin unlocks it). Restarting
the collector also tries once more. A backfill chunk that FactoryLogix refuses stops the
backfill until the next poll, which tells whether the login is still refused.

One data source failing does not hold up the others: the poll records the error on that data
source's row in Admin > Sync and goes on with the next one. It stops early only when
FactoryLogix itself is down (no answer, a timeout, a refused login, or "busy") before anything
came back that poll. Unit steps wait while work orders fail, because they need the work orders
to find each job's product. A poll counts as successful for the breaker and the banner below
when the two required data sources, work orders and unit steps, came in. When only an optional
one (defects, operators, routes, FactoryLogix standards) fails, the numbers stay current and
there is no backoff, but the status shows `degraded` with that data source's error.

Regardless of the breaker state, the TV and portal treat data as **delayed** whenever the last
successful poll is older than **3x the configured poll interval**, and show a "Data delayed
since HH:MM" banner. The dashboards keep showing the last data they had — nothing disappears,
nothing freezes on a spinner. The banner clears automatically on the next successful poll.

A poll only counts as successful once what it brought in has reached the hour cells the TVs and
portal show. When they cannot be recomputed (a database error such as a deadlock or a full disk,
or a row the calculation fails on), the status shows `degraded` at once, with `could not
recompute the hour cells of N hours` under "Last error", and the banner follows once that has
lasted 3 poll intervals. There is no backoff, since FactoryLogix answered. The collector tries
those hours again after every poll, and the error and the banner clear once they go through.

Sync status values you will see in Admin > Sync:

| Status | Meaning |
|---|---|
| `ok` | Last poll succeeded and data is current. |
| `degraded` | Some recent failures (under the breaker threshold) or backing off, but a poll has succeeded recently enough not to be "delayed" yet. Also shown while an optional data source keeps failing and work orders and unit steps come in, or while hour cells cannot be recomputed; the last error names it. |
| `down` | The breaker is open (threshold reached, or FactoryLogix refused the login) and the last success is older than 3x the poll interval. |
| `never` | The collector has never completed a poll — either FactoryLogix connection/mapping has not been configured yet, or every attempt so far has failed. |

## Backfill

On first run (and whenever run manually), the collector backfills `backfill_days` (default
180) of history, oldest day first, one day at a time, pausing `backfill_pause_seconds`
(default 5 seconds) between days so FactoryLogix is never hit hard.

- **Off-shift window:** by default backfill only runs inside `backfill_window` (default 22:00
  to 05:00 plant time) so it does not compete with live polling load during production hours.
- **Run now:** Admin > Connection > "Run backfill now" (or the setup wizard's backfill step)
  overrides the window and runs immediately.
- **Fixed range:** the first day of the range is saved when the backfill starts, and every
  later chunk counts from it, so a backfill that runs across midnight (or over several nights)
  still processes every day exactly once.
- **Recoloring:** while days download, their hour cells get counts but no colors, because no
  standards exist yet. When the download finishes, the backfill shows status `recoloring`: it
  recomputes standards once, then recomputes the hour cells of every backfilled day again, one
  day per chunk with the same pause and window rules, so the history gets standards and colors.
  The Sync and Connection pages show "Recoloring X of Y days". The status becomes `done` after
  the last day.
- **Resume:** progress is persisted (`sync_state` for source `backfill`: days downloaded, the
  saved first day, and for the recoloring phase whether standards ran and how many days were
  re-colored), so a collector restart picks up at the next day of whichever phase it was in
  rather than starting over. The day that was in progress when the collector stopped is done
  again; that is harmless because every write is idempotent.
- **Running it again:** "Run backfill now" on a backfill that is `done` or `error` starts a new
  one from scratch (new range, counters reset). On one that is still in progress it only lifts
  the off-shift window.

## Standards nightly recompute

Every night at `std_recompute_time` (default 02:00 plant time), the engine recomputes the
standard (`StdHr`) for every product/operation that received new completed units since the
last recompute of all products (the nightly run, "Recompute all standards now" or the one after
a backfill; Admin > Standards shows it as "Last recompute"). You can also trigger a recompute on
demand from Admin > Standards ("Recompute all standards now") or from a product's page
("Recompute now" for just that product). A single product's recompute does not move that
cutoff, so the other products' new units are still picked up that night.

## Retention

`retention_days_raw_events` (default `null` = keep forever) controls how long the raw
FactoryLogix payloads in `raw_events` are kept. Normalized data (`unit_steps`, `defects`,
`work_orders`, `hour_cells`, `standards`, etc.) is never trimmed by age in v1 — only the
raw payload table has an optional retention window, applied once a day by the collector.

`raw_events` stores a payload only when it is new or changed. The overlap window, the hourly
late-data re-pull and the backfill read many rows again; the collector keeps the sha256 of the
last payload stored per (data source, natural key) in `raw_event_hashes` (migration `0004`)
and skips rows whose payload is identical. So `raw_events` holds one row per version of a
FactoryLogix record, not one row per read. `raw_event_hashes` is one small row per natural key
and is not trimmed by the retention window; after retention removes an old payload, an
unchanged re-read is still skipped (the normalized tables already have that data).

Upserts into `unit_steps`, `defects` and `work_orders` likewise leave a row untouched when none
of its mapped values changed, so `updated_at` on those tables means "last changed", not "last
seen". The nightly standards recompute uses it to find new and changed rows.

A unit step or defect that comes back with a different time (the timestamp mode or plant time
zone was fixed, or the time was corrected in FactoryLogix) keeps its natural key, so the
collector deletes the copy stored at the old time, if it is within two days of the new one, and
recomputes the hours that copy was counted in. Rows stored before such a fix are corrected as
they are read again: the hourly late-data re-pull covers the last `late_data_hours`, and "Run
backfill now" covers older history.

## Disk sizing

At roughly 20,000 units/day across 15 operations (≈300,000 `unit_steps` rows/day), plus
defects and raw payloads, expect well under 100 MB/day uncompressed. With TimescaleDB
compression on chunks older than 7 days, a full year of data is realistically tens of GB. The
100 GB disk recommendation in `README.md` leaves comfortable headroom for several years at
that volume, plus OS, images, and backups. The container logs share that disk but are capped
at about 1 GB in total (see [Logs](#logs)).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| TV shows a pairing code again after working fine | Browser storage was cleared, or the TV's `localStorage`/cookie was reset (new device, factory reset, private browsing) | In Admin > Displays, use "Re-pair": enter the new code and attach it to the existing display record to keep its name and settings |
| TV shows a new pairing code after its display was deleted, or after another TV was re-paired onto its record | The server no longer knows the TV's token, so the TV registered again at its next check-in | Claim the new code in Admin > Displays to use the TV again, or switch the TV off |
| Admin > Displays finds no display for the code an unclaimed TV shows | Its code was freed for new TVs (it was offline for more than a day, or more than 1,000 other unclaimed TVs checked in after it), and the TV has not checked in since | Wait a minute: at its next check-in the TV registers again and shows a new code to claim. If it shows "Dashboard offline since HH:MM", it cannot reach the server (see below) |
| "Dashboard offline since HH:MM" banner on a TV | The TV's browser cannot reach the `web`/`api` containers at all (network issue, host down, container crashed) | Check `docker compose ps` and `docker compose logs api web`; check network connectivity between the TV and the server |
| `docker compose logs api` shows `SSE stream limit reached`; some TVs only refresh once a minute | 1,000 live-update streams are open at once, far more than the site's TVs and browser tabs: something is holding streams open | Find the address with many connections (`docker compose exec web netstat -tn`) and block it on the network. Streams are let in again as others close; `docker compose restart api` closes them all, and TVs reconnect by themselves |
| "Data delayed since HH:MM" banner | The collector cannot reach FactoryLogix, or its last successful poll is older than 3x the poll interval | Check Admin > Sync for the last error; confirm the FactoryLogix server and the Report Scheduler Service are up and reachable on port 6065 |
| Admin > Sync says `could not recompute the hour cells of N hours` | The database refused to rewrite them (deadlock, lock timeout, disk full) or the calculation failed on one of their rows. The TVs and portal show those hours as they were before | Wait a poll or two: the collector tries again after every poll, and the error clears once they go through. If it stays, `docker compose logs collector` shows each `hour cell recompute failed`, and `docker compose logs db` and the free disk space show whether the database is the cause. A restarted collector no longer knows which hours to redo: the last `late_data_hours` are recomputed within the hour, older ones by "Run backfill now" |
| Test connection or Admin > Sync still says `certificate not trusted` after `FACTORYLOGIX_CA_CERT` was set | The containers could not use the file, it is not the CA that issued FactoryLogix's certificate, or they have not been restarted since the file was replaced | `docker compose logs api collector \| grep FACTORYLOGIX_CA_CERT` shows whether each read it and, if not, why (no such file, not readable, DER instead of PEM). Check that the certificate's issuer is the CA in the file. After replacing the file, run `docker compose restart api collector`. See `docs/INSTALL.md`, section 10 |
| Sync status stuck at `never` | FactoryLogix connection and/or field mapping have not been completed yet, or what is saved cannot be used: Admin > Sync then shows why under "Last error" | Finish Admin > Connection and Admin > Mapping (or the first-run wizard), or fix what the last error names |
| After a restore, Admin > Connection asks for the password again, or Admin > Sync shows `could not decrypt the FactoryLogix password` | The database came from an install with another `ENCRYPTION_KEY`. The key is in `.env`, not in the backup, so the saved password cannot be decrypted here | Type the FactoryLogix password in Admin > Connection and save. Or put the old install's `ENCRYPTION_KEY` in `.env` and run `docker compose up -d` (see [Restore](#restore)) |
| Admin > Sync says `FactoryLogix refused the saved login` and nothing is polled any more | The FactoryLogix account's password was changed, or the account is locked, disabled or without rights to the OData service. The collector stopped retrying so that it cannot lock the account | Fix the account in FactoryLogix if needed, type the current password in Admin > Connection, Test connection, then save. Saving restarts polling, even with the password left blank once the account works again |
| Saving Admin > Connection says "enter the password again", or Test connection gets `HTTP 401` after the server URL or user name was changed | The saved password is only ever sent with the server URL and user name it was saved with, so any change to either (even just the path) needs it typed again | Type the FactoryLogix password in the Password box, then test and save again |
| Admin > Sync or Test connection says `the FactoryLogix server URL must not contain a user name or password` | The server URL was saved as `http://user:password@server:6065/odata` by an earlier version. Such a URL is never used: it is stored in clear text, and fetch repeats it, password included, in its errors | In Admin > Connection, enter the URL without the user name and password, type the password in the Password box, and save. Earlier versions repeated that URL in the poll errors `/api/health/sync` shows without a login, so change that password in FactoryLogix too |
| Hour labels look shifted, or a shift's numbers don't line up with the wall clock | Wrong `plant_timezone`, or `fl_timestamp_mode` mismatched with how FactoryLogix serializes timestamps | Fix the time zone and timestamp mode in Admin > Connection; see `docs/MAPPING.md`. The last `late_data_hours` are corrected within the hour; "Run backfill now" corrects older history (see [Retention](#retention)) |
| No colors on hour cells / StdHr shows a dash | No standard has been computed yet for that product/operation (not enough history) and no FactoryLogix StdHr is mapped as a fallback | Wait for backfill + the nightly recompute, or run Admin > Standards > Recompute now; consider mapping the `standards` dataset for an interim fallback |
| API or collector fails to start with an `ENCRYPTION_KEY` error | `ENCRYPTION_KEY` is missing, is not exactly 64 hex characters, or is still the all-zero placeholder from `.env.example` | Generate a correct key with `openssl rand -hex 32` and set it in `.env`, then `docker compose up -d` again. If the FactoryLogix password was saved under the old key, Admin > Connection then asks for it again and Admin > Sync says it could not be decrypted: enter the password again in Admin > Connection. The all-zero key is public, so change that password in FactoryLogix too |
| API fails to start with a `SESSION_SECRET` error | `SESSION_SECRET` is missing, shorter than 32 characters, or still the placeholder from `.env.example` | Generate one with `openssl rand -hex 32` and set it in `.env`, then `docker compose up -d` again. Everyone has to log in again |
| API keeps restarting and `docker compose logs api` shows `database not reachable yet (attempt N/30)` | The `err` on each of those lines says why. `password authentication failed`: `POSTGRES_PASSWORD` or `POSTGRES_USER` in `.env` was changed after the first start, but the database keeps the login it was created with. `database "…" does not exist`: the same for `POSTGRES_DB`. The `db` container uses these three only when it creates the database, and still shows as healthy | Put the first values back in `.env` and run `docker compose up -d` again. To keep a new password instead, give it to the database: run `docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, type `\password`, enter the new password twice, type `\q`, then run `docker compose up -d` |
| Someone else may be using a user's login (a shared PC left signed in, a lost tablet) | A login stays valid for 30 days unless it is ended on the server | In Admin > Users, reset the user's password or deactivate them: either ends every session they have at once. The user logging out does the same, on every device |
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
   docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM users;"'
   ```

   This does not touch any production data (jobs, unit steps, standards, shifts, breaks) —
   only accounts. Reopen `http://<host>:8080`, which will present the setup wizard's admin
   step again.
