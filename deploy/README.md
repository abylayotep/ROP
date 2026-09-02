# Deploying Rakurs

nginx serves the built frontend from `/var/www/rakurs` and proxies `/api` to
`127.0.0.1:3000`. Everything else runs in Compose.

## First deploy

```bash
cp deploy/env.example deploy/.env       # fill both secrets
npm --prefix rakurs run build
rsync -a --delete rakurs/dist/ vps:/var/www/rakurs/
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run migrate
```

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

```bash
npm --prefix rakurs run build
rsync -a --delete rakurs/dist/ vps:/var/www/rakurs/
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run migrate
```

## What is exposed

`postgres` publishes no ports — it is reachable only on the Compose network. `api` binds to
`127.0.0.1:3000`, so only nginx on the same host can reach it regardless of the firewall.
Verify after any change to `compose.yml`:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

The `postgres` row must show `5432/tcp` with no host address. `0.0.0.0:5432` means the
database is on the internet.

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
