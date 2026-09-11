# Deploying Rakurs

nginx serves the built frontend from `/var/www/rakurs` and proxies `/api` to
`127.0.0.1:3000`. Everything else runs in Compose.

## First deploy

```bash
cp deploy/env.example deploy/.env       # fill in every value
npm --prefix rakurs run build
rsync -a --delete rakurs/dist/ vps:/var/www/rakurs/
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run migrate
```

`deploy/.env` must hold:

- `SESSION_SECRET` — generate with `head -c 32 /dev/urandom | base64`;
- `POSTGRES_PASSWORD` — letters and digits only, it is spliced into `DATABASE_URL`:
  `head -c 48 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32`;
- `META_APP_SECRET` — the Meta app's secret, signs every webhook delivery;
- `META_WEBHOOK_VERIFY_TOKEN` — the string Meta echoes back during the webhook handshake;
- `META_APP_ID` — the Meta application's id; the browser starts Embedded Signup with it;
- `META_ES_CONFIG_ID` — the Facebook Login for Business configuration id for Embedded Signup;
- `CREDENTIALS_KEY` — encrypts stored WhatsApp access tokens, exactly 32 bytes base64,
  generate with `head -c 32 /dev/urandom | base64`;
- `MEDIA_DIR` — present for consistency with `server/.env`, but `compose.yml` does not read
  it: the container's media path is fixed there to match the named volume;
- `PUBLIC_URL` — must be the real domain (`https://rakurs.example.com`), because the
  integrations screen builds the webhook address Meta is given from it. A wrong value here
  sends Meta's deliveries somewhere else.

Create the first company and its owner — once. There is no sign-up route by design:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api \
  node dist/scripts/create-account.js
```

Add someone to an existing company:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api \
  node dist/scripts/add-member.js
```

The runtime image ships compiled `dist/` only, so this is `node dist/scripts/…`, not the
`npm run create-account` / `npm run add-member` scripts — those run `tsx src/…` and only
work in a checkout.

Copy `deploy/nginx.conf` to the host's nginx, replacing `rakurs.example.com` with the real
domain. It occurs five times: two `server_name`, the two certificate paths, and the reminder
on the first line. `try_files … /index.html` is required: the router is client-side, and
without it a refresh on `/a/:agentId/dialogs` returns 404.

## Updating

Back up PostgreSQL and retain the current API image and frontend before updating. Rehearse
new migrations on an isolated restored database. Build first, migrate before starting the
new API, and publish the frontend only after the API health check succeeds. In particular,
the knowledge-generation startup reconciliation requires migration `0021` to exist.

```bash
npm --prefix rakurs run build
docker compose -f deploy/compose.yml --env-file deploy/.env build api
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm --no-deps api npm run migrate
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --no-deps api
curl --fail --retry 12 --retry-all-errors --retry-delay 1 --max-time 3 http://127.0.0.1:3000/api/health
rsync -a --exclude=index.html rakurs/dist/ vps:/var/www/rakurs/
rsync -a rakurs/dist/index.html vps:/var/www/rakurs/index.html.next
ssh vps 'mv /var/www/rakurs/index.html.next /var/www/rakurs/index.html'
```

These Compose commands run on the VPS; build and transfer the frontend from the release
checkout. Keep old hashed assets for already-open browser sessions; do not use `--delete`
during the cutover. For an application rollback, retain additive migration tables and
restore the previous image and frontend. Restoring production data is a separate recovery
decision, not an automatic rollback step.

The `media` volume survives `down` and `up` — WhatsApp attachments are not lost on an
update. Only `docker compose down -v`, or removing the `media` volume directly, deletes
every file a client has ever sent.

## What is exposed

`postgres` publishes no ports — it is reachable only on the Compose network. `api` binds to
`127.0.0.1:3000`, so only nginx on the same host can reach it regardless of the firewall.
Verify after any change to `compose.yml`:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

The `postgres` row must show `5432/tcp` with no host address. `0.0.0.0:5432` means the
database is on the internet.

## Where the host's other secrets live

The same VPS runs Tasbaqa, whose production values are in `/opt/tasbaqa/.env.prod`
(`POSTGRES_PASSWORD`, `SMTP_PASSWORD`, `OPENROUTER_API_KEY`, the Kaspi keys and the rest).
Written down here because it is the file to open when a deploy needs one of them — not
because Rakurs reads it. Rakurs takes nothing from it automatically: the two products have
separate databases, separate Compose projects and separate `.env` files, and a value copied
from one into the other makes a single leak cost both.

Never run `docker compose` inside `/opt/tasbaqa` while deploying Rakurs.

## Backups

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env exec postgres \
  pg_dump -U rakurs rakurs > rakurs-$(date +%F).sql
```

## Registry access

If image pulls time out against `registry-1.docker.io`, Docker Hub is blocked on that
network. Point the daemon at a mirror rather than working around it per-image — in
`/etc/docker/daemon.json`:

```json
{ "registry-mirrors": ["https://mirror.gcr.io"] }
```

Then restart Docker. On a local colima setup: `colima ssh -- sudo …` followed by
`colima restart`.

## Behind Caddy

On a host that already runs Caddy (the Tasbaqa VPS), skip `deploy/nginx.conf` and append
`deploy/Caddyfile.rop` to `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`. Caddy
obtains the certificate itself once the domain's A record points at the host. The stack
runs from `/opt/rakurs` with the same commands as above; the Compose project is named `rakurs` in
`compose.yml`, so it cannot collide with the other product's.
