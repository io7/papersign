# Self-hosting PaperSign with Docker

PaperSign ships as one container image, `ghcr.io/io7/papersign`, that runs the
web application, the PDF worker, database migrations and the operator commands.
`docker/compose.yaml` starts it together with PostgreSQL, an hourly database
backup and, if you want, Caddy for HTTPS.

| Service | Purpose |
|---|---|
| `postgres` | PostgreSQL 17. Not published outside the compose network. |
| `migrate` | Applies database migrations, then exits. Web and worker wait for it. |
| `web` | The application on port 3176, bound to `127.0.0.1` by default. |
| `worker` | Produces final and image-only PDFs and evidence packages. |
| `backup` | Writes a consistent `pg_dump` to the `backups` volume every hour. |
| `caddy` | Optional (profile `https`): HTTPS on ports 80 and 443 with an automatic certificate. |
| `mailpit` | Optional (profile `try-out`): captures email instead of sending it. |

Profiles are chosen with `COMPOSE_PROFILES` in `docker/.env` (comma-separated)
or with `--profile` on the command line.

## Requirements

- Docker Engine with Compose v2 (`docker compose`).
- 2 CPU cores and 2 GB of memory.
- x86-64. Images for other architectures are not published yet.
- For real use: a domain name pointing at the server, and an SMTP account.
  Email is required: account verification, password recovery and every
  signer's one-time code are sent by email, and those steps fail without it.

You need the `docker` folder of this repository: check out the release tag, or
download `compose.yaml`, `.env.example` and `Caddyfile` from it. Each release's
compose file runs that release's image.

## Try it on one machine

```sh
cd docker
cp .env.example .env
chmod 600 .env
```

In `docker/.env`, set:

```
APP_URL=http://localhost:3176
BETTER_AUTH_SECRET=<output of: openssl rand -hex 32>
POSTGRES_PASSWORD=<output of: openssl rand -hex 32>
COMPOSE_PROFILES=try-out
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_REQUIRE_TLS=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=PaperSign <papersign@example.com>
```

Then:

```sh
docker compose up -d
```

1. Open http://localhost:3176 and register.
2. Open http://localhost:8025, find the verification email and open its link.
3. Make your account the first Admin:
   `docker compose exec web papersign bootstrap-admin --email you@example.com`
4. Sign in again, open **Account security** and set up your authenticator.
   Admin requires it.

Every email in this setup stays in the try-out mailbox. Never invite real
signers to it.

## Run it for real

1. **Domain.** Point the domain's DNS at the server.

2. **Settings.** In `docker/.env`:
   - `APP_URL`: the https address, for example `https://papersign.example.com`.
   - `OPERATOR_NAME`: who runs the installation, shown on the privacy page.
   - `BETTER_AUTH_SECRET` and `POSTGRES_PASSWORD`: generate each with
     `openssl rand -hex 32`.
   - Your SMTP account, with `SMTP_REQUIRE_TLS=true`.
   - `COMPOSE_PROFILES=https` to use the bundled Caddy, or empty if you run
     your own reverse proxy (see below). `CADDY_GLOBAL_OPTIONS` passes extra
     Caddy global options, for example `email you@example.com`.
   - `TRUSTED_PROXY=172.16.0.0/12`, as in the example file. This is Docker's
     default address range, which covers both the bundled Caddy and a proxy on
     the same host. Only addresses listed there may supply the visitor's real
     address, which the sign-in and email-code rate limits use. If your Docker
     uses other address pools, list those instead.

3. **Start.** `docker compose up -d`, then check `docker compose ps`: `web`
   should report `healthy`. With the bundled Caddy, ports 80 and 443 must be
   reachable from the internet; Caddy obtains the certificate on the first
   request and renews it by itself (`docker compose logs caddy` shows progress).

4. **First Admin.** Register, verify your email, run
   `docker compose exec web papersign bootstrap-admin --email you@example.com`,
   and set up your authenticator under **Account security**. The command only
   works while there are no Admins; after that, use **Admin → Users**.

5. **Close sign-up.** Set `REGISTRATION_ENABLED=false` and run
   `docker compose up -d`. People you invite from **Admin → Invitations** can
   still create accounts.

### Your own reverse proxy instead of Caddy

Leave `https` out of `COMPOSE_PROFILES` and forward your proxy to
`127.0.0.1:3176`. Forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`,
allow 30 MB request bodies (PDF uploads are limited to 25 MB) and turn off
access logging for the site.

Signing links and invitation links carry private tokens in the URL. Whatever
proxy you use must not write them to logs. The bundled Caddy writes no access
log and strips addresses and headers from its error log.

## Everyday commands

Run these in the `docker` folder.

| Task | Command |
|---|---|
| Status | `docker compose ps`, and **Admin → Operations** in PaperSign |
| Logs | `docker compose logs -f web worker` |
| Stop / start | `docker compose stop` / `docker compose up -d` |
| First Admin | `docker compose exec web papersign bootstrap-admin --email EMAIL` |
| Health checks with alerts | `docker compose run --rm web monitor` (schedule it with cron; set `ALERT_WEBHOOK_URL`) |
| List container commands | `docker compose run --rm web help` |

## Data and backups

Everything that matters lives in three named volumes and one file:

- `papersign_postgres`: the database.
- `papersign_data`: uploaded PDFs, signature images, final PDFs and evidence.
- `papersign_backups`: the hourly database dump, `papersign.dump`.
- `docker/.env`: above all `BETTER_AUTH_SECRET`, which also encrypts stored
  signing links. A restore without the same secret cannot open those links or
  existing sessions.

`papersign_caddy-data` holds Caddy's certificates. Caddy obtains new ones if it
is lost, so it does not need a backup.

**Back up** the latest dump, the data volume and `.env` together, for example
nightly:

```sh
docker run --rm -v papersign_backups:/backups:ro -v papersign_data:/data:ro \
  -v "$PWD/backup":/out alpine \
  sh -c 'cp /backups/papersign.dump /out/ && tar -czf /out/papersign-data.tar.gz -C /data .'
cp docker/.env backup/papersign.env
```

Stored files are written once and never changed, so a copy taken shortly after
the dump matches it. Admin → Operations warns when the dump is older than
three hours.

**Restore** on a new host, after copying the `docker` folder, `papersign.env`
(as `docker/.env`), `papersign.dump` and `papersign-data.tar.gz`:

```sh
cd docker
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U papersign -d papersign --no-owner < ../backup/papersign.dump
docker compose run --rm --no-deps -v "$PWD/../backup":/in:ro --entrypoint tar web \
  -xzf /in/papersign-data.tar.gz -C /data
docker compose up -d
```

Restore into an empty database; the `migrate` step then applies any newer
migrations.

## Upgrades

Take a backup, then switch the `docker` folder to the new release (check out
its tag, or download its `compose.yaml`) and run:

```sh
docker compose pull
docker compose up -d
```

The `migrate` step runs before the new web and worker containers start. Read
the release notes first. Going back to an older release after a migration is
not supported; restore the backup instead.

To build the image from a checkout instead of pulling it, set
`PAPERSIGN_IMAGE=papersign:local` in `.env` and run `docker compose up -d --build`.

## Security defaults

- The application containers run as an unprivileged user with a read-only root
  filesystem, no Linux capabilities and `no-new-privileges`. Only `/data` and a
  temporary `/tmp` are writable. Caddy also runs read-only, with only the
  capability to listen on ports 80 and 443.
- PostgreSQL is reachable only inside the compose network, and the web port is
  bound to `127.0.0.1` unless `PAPERSIGN_BIND` says otherwise.
- Admin access requires a verified email and an authenticator, and API keys are
  managed by Admins only (see `docs/api-keys.md`).
- Keep `docker/.env` readable by you only (`chmod 600`).
- Release images are built by GitHub Actions from the tagged source, with build
  provenance and an SBOM attached.

## Not included yet

- Organization certificate sealing uses a separate key-holding service and is
  not part of this compose file. See `CERTIFICATE-SEALING.md`.
- Images for arm64.

## Checking an installation

`docker/smoke-test.mjs` exercises a fresh try-out installation end to end:
registration and email verification, the first Admin, authenticator, an API
key, a two-signer request created with the command-line client, email codes,
signing, the final PDF and evidence, an image-only export and the Admin
operations checks. With `--after-restart` it checks the same data again after
`docker compose down` and `up`. It needs a checkout with `npm ci` done, and it
must not be pointed at an installation with real users. Every release runs it
before the image is published.
