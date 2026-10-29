# Installation

Step-by-step instructions for installing the FactoryLogix Live Production Dashboard and
Manager Portal on your own server. Read `README.md` first for an overview and the
requirements summary.

## 1. Check the FactoryLogix side first

Before provisioning anything, verify these on the plant network (spec section 4.1):

1. **FactoryLogix version is 2019.1 or later.** Earlier versions do not expose the OData
   endpoint used by the collector.
2. **The Report Scheduler Service is running** on the FactoryLogix server. This Windows
   service also hosts the OData endpoint at `http://<factorylogix-server>:6065/odata`.
3. **`$metadata` opens in a browser.** From a machine on the plant network, open
   `http://<factorylogix-server>:6065/odata/$metadata`. You should be prompted for a
   FactoryLogix user name and password (HTTP Basic auth — not Windows, not SQL) and then see
   an XML document listing entity sets and fields. If you get a connection error, the Report
   Scheduler Service is probably not running or not reachable from this network segment. If
   you get a 401/403 after logging in, the account may lack rights to the OData endpoint.
4. **OData is licensed/enabled.** FactoryLogix modules are licensed individually. Confirm with
   your FactoryLogix administrator or reseller that OData/DataMiner access is included in your
   license. Nothing in the public documentation ties this to a specific add-on, but licensing
   varies by installation — **verify this on-site**.

Keep the `$metadata` page open or saved; you will use it as the reference when you map fields
in the admin mapping wizard (`docs/MAPPING.md`).

## 2. Create a read-only FactoryLogix user

Ask your FactoryLogix administrator to create (or designate) a user account dedicated to this
application:

- Minimum rights needed to **read** DataMiner data sources over OData. No write access to
  anything.
- A password you control (it will be stored, encrypted, in this application's database — see
  `ENCRYPTION_KEY` below).
- Do not reuse an interactive operator or manager account. A dedicated service account makes
  it easy to see this integration's activity in FactoryLogix's own logs, and to revoke it
  independently later.

## 3. Provision the server or VM

Recommended: a small **Ubuntu LTS** virtual machine on your hypervisor, sized at least 4 vCPU,
8 GB RAM, 100 GB disk, with network access to the FactoryLogix server's port `6065` and to the
plant LAN (for TVs and manager workstations to reach it).

**Windows note:** if your infrastructure is Windows-only, run this application in a small
Linux VM (Ubuntu LTS) on the same hypervisor rather than directly on Windows. Docker Desktop
on Windows Server is possible but is not recommended for an always-on service.

### Install Docker

On Ubuntu LTS, install Docker Engine and the Compose plugin using Docker's official
instructions for your release, then confirm both are available:

```bash
docker --version
docker compose version
```

## 4. Clone the repository

```bash
git clone https://github.com/Nathans972/Factory-Logix-Live.git
cd Factory-Logix-Live
```

## 5. Configure `.env`

```bash
cp .env.example .env
```

Then replace the placeholder `POSTGRES_PASSWORD`, `SESSION_SECRET` and `ENCRYPTION_KEY` with
values of your own (`openssl rand -hex 32` makes one for each). The `.env.example` values are
public, so the app refuses to start while `SESSION_SECRET` or `ENCRYPTION_KEY` still has them.

Every variable in `.env.example`:

| Variable | Purpose |
|---|---|
| `POSTGRES_DB` | Database name used by the `db`, `api`, and `collector` containers. Default `fld`. |
| `POSTGRES_USER` | Postgres role used by the app. Default `fld`. |
| `POSTGRES_PASSWORD` | Postgres password. **Required** — Compose refuses to start without it. Use a strong, unique password. |
| `SESSION_SECRET` | Signs the login session cookie (`fld_session`). **At least 32** random characters. Generate with `openssl rand -hex 32`. **Required** — the API refuses to start if this is missing, too short, or still the `.env.example` placeholder. |
| `ENCRYPTION_KEY` | AES-256-GCM key used to encrypt the FactoryLogix password at rest. Must be **exactly 64 hex characters** (32 bytes). Generate with `openssl rand -hex 32`. **Required** — the API and collector both refuse to start if this is missing, the wrong length, or still the all-zero `.env.example` placeholder. |
| `PLANT_TIMEZONE` | IANA time zone used to seed settings on first start (e.g. `America/New_York`). Can be changed later in Admin > Settings. |
| `WEB_PORT` | Host port published by the `web` (nginx) container. Default `8080`. This is the only port you need to expose. |
| `LOG_LEVEL` | Log verbosity for `api` and `collector`: `trace` \| `debug` \| `info` \| `warn` \| `error`. Default `info`. |
| `FACTORYLOGIX_CA_CERT` | Only for an `https://` FactoryLogix whose certificate is self-signed or issued by your own CA: the file name of that CA's certificate (PEM) in the `certs/` folder, e.g. `plant-ca.pem`. Empty by default. See [section 10](#factorylogix-over-https). |

Everything else (poll interval, eligibility rules, color bands, shifts, breaks, standards
settings, and the FactoryLogix connection itself) is configured later in the admin UI, not in
`.env`.

## 6. Start the application

```bash
docker compose up -d
```

This builds and starts four containers: `db` (PostgreSQL 16 + TimescaleDB 2.31.0, pinned in
`docker-compose.yml` as `timescale/timescaledb:2.31.0-pg16`), `api`, `collector`, and `web`. The API applies database migrations automatically on start; there is nothing to run
by hand.

## 7. Verify it is healthy

```bash
docker compose ps
```

All four services should show as `running`/`healthy`. Then check:

```bash
curl http://localhost:8080/api/health        # {"ok":true, "db":true, ...}
curl http://localhost:8080/api/health/sync   # collector state; "status":"never" until you finish setup
```

If a service is not healthy, check its logs:

```bash
docker compose logs -f api
docker compose logs -f collector
docker compose logs -f web
docker compose logs -f db
```

## 8. Complete the first-run setup wizard

Open `http://<host>:8080` in a browser. With an empty database the app opens directly into the
setup wizard (spec 10.10):

1. **Create admin user** — the first login account. It is created with the `admin` role.
2. **Plant time zone** — the IANA zone used for every hour bucket, shift, break, and displayed
   clock (e.g. `America/New_York`). Get this right before you backfill; changing it later does
   not retroactively re-bucket historical hours.
3. **FactoryLogix connection** — server URL (`http://<factorylogix-server>:6065/odata`), the
   read-only user name and password from step 2, and the timestamp mode (see
   `docs/MAPPING.md`). Use **Test connection** to confirm `$metadata` is reachable before
   continuing. An `https://` URL whose certificate is self-signed or issued by your own CA needs
   `FACTORYLOGIX_CA_CERT` first (see [section 10](#factorylogix-over-https)).
4. **Mapping wizard** — pick the entity set and fields for each dataset. See `docs/MAPPING.md`
   for a full walkthrough of every field.
5. **Shifts** — define your plant's shift schedule (name, local start/end time, days of week,
   effective date).
6. **Breaks** — define scheduled breaks (name, local start time, duration, days, which shifts
   they apply to).
7. **Backfill** — start the historical backfill, either now or on the configured schedule (see
   `docs/OPERATIONS.md` for what backfill does and how long it takes).

The app is usable for **live** data immediately after the connection and mapping steps.
Standards (StdHr) populate after the first backfill and the first nightly recompute (or a
manual "Recompute now" from Admin > Standards), so early on you may see StdHr as a dash — this
is expected.

## 9. Claim TVs

On each TV, open `http://<host>:8080/tv` in the browser, in full-screen/kiosk mode. It shows a
4-digit pairing code. In the portal, go to **Admin > Displays**, enter the code, give the
display a name, and assign it a job. The TV renders the dashboard within one poll interval.

The server takes at most 10 new TVs a minute from one address. If your TVs reach it through a
single proxy or NAT, a TV that shows "Dashboard unavailable" during a large rollout tries again
by itself every minute and shows its code once the server takes it. A TV that is switched off
for more than a day before it is claimed can lose its code; it shows a new one when it is
switched on again.

## 10. Optional: TLS

### HTTPS for the dashboard

The application does not terminate TLS itself. If you want HTTPS, put your own reverse proxy
(e.g. nginx, Traefik, or an existing corporate proxy) in front of port `8080` and terminate TLS
there; point it at `http://<host>:8080`.

Then set `TRUSTED_PROXIES` in `.env` to that proxy's address as the app sees it (comma-separated;
CIDR ranges such as `10.1.0.0/16` work too) and run `docker compose up -d` again. Without it,
the API takes your proxy for the client, so everyone who signs in through it shares one limit of
10 sign-in attempts a minute. To find the address, fail one sign-in through the proxy: the
`failed login` line in `docker compose logs api` shows the address the API counted.

List only your proxy. The API believes whatever client address a listed address passes on, so a
range that also covers the computers people sign in from lets anyone at one of them name a new
address on every attempt and never reach the limit. Afterwards, fail one more sign-in from a
workstation: the `failed login` line should now show that workstation's own address, and
`TRUSTED_PROXIES` must not cover it.

### FactoryLogix over https

The default FactoryLogix address, `http://<factorylogix-server>:6065/odata`, needs nothing here,
and neither does an `https://` address whose certificate comes from a public CA. If the
certificate is self-signed or issued by your plant's own CA (an Active Directory Certificate
Services CA, for example), Test connection and Admin > Sync say `certificate not trusted` until
the dashboard has that CA's certificate. Both the `api` (Test connection, mapping preview) and the
`collector` (polls) use it:

1. Get the CA certificate as PEM: a text file that starts with `-----BEGIN CERTIFICATE-----`.
   For a certificate issued by your own CA, that is the CA's root certificate (if an intermediate
   CA issued the FactoryLogix certificate, add the intermediate's certificate to the same file,
   after the root's). For a self-signed certificate, it is that certificate itself. Your IT
   department can provide it. On a Windows machine that trusts the CA, export it from
   `certlm.msc` (Trusted Root Certification Authorities > the CA > All Tasks > Export) as
   **Base-64 encoded X.509 (.CER)**. The wizard's default, **DER encoded binary**, also makes a
   `.cer` file, but one the dashboard cannot read; convert it with
   `openssl x509 -inform der -in plant-ca.cer -out plant-ca.pem`.
2. Copy it into the `certs/` folder next to `docker-compose.yml` and let everyone read it. It is a
   public certificate, not a key, and the containers do not run as root:

   ```bash
   cp plant-ca.pem certs/
   chmod 644 certs/plant-ca.pem
   ```

3. Put its file name, without the folder, in `.env`: `FACTORYLOGIX_CA_CERT=plant-ca.pem`.
4. Run `docker compose up -d`. Both containers say on start whether they could use the file:

   ```bash
   docker compose logs api collector | grep FACTORYLOGIX_CA_CERT
   ```

   `holds 1 certificate, trusted for https:// FactoryLogix` (from each) means it was read;
   anything else says what to fix.
5. Press **Test connection** again.

The certificate must still be made out to the host name or IP address in the server URL, and be
in date: trusting its CA does not change that. The containers read the file when they start, so
after replacing it (a renewed CA, for example) run `docker compose restart api collector`.

## 11. Firewall notes

- **Inbound:** only `WEB_PORT` (default `8080`) needs to be reachable, from the plant LAN
  (TVs and manager workstations). Nothing else needs to be exposed.
- **Outbound:** the `collector` container needs to reach the FactoryLogix server on port
  `6065`. No other outbound access is required at runtime.

## Next steps

- `docs/MAPPING.md` — map every FactoryLogix data source in detail, with a worked example.
- `docs/OPERATIONS.md` — backups, upgrades, logs, health checks, and troubleshooting.
- `docs/CALCULATIONS.md` — what the numbers on the TV and portal mean.
