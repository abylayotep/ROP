# Task 9b: The deployment stack

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
Follows [task 9a](2026-08-06-foundation-task-9a-first-user.md).

**Files:**
- Create: `deploy/Dockerfile`, `deploy/compose.yml`, `deploy/nginx.conf`, `deploy/env.example`,
  `deploy/README.md`
- Reference: `rakurs/deploy/nginx.conf.example` — the existing example this supersedes

- [ ] **Step 1: Add the Dockerfile**

`deploy/Dockerfile`. Debian rather than Alpine, with build tools in the build stage only:
`argon2` is a native module and must compile when no prebuilt binary matches the platform.

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY rakurs/package.json rakurs/
COPY server/package.json server/
RUN npm ci
COPY packages/contract packages/contract
COPY server server
RUN npm --prefix server run build

FROM node:22-bookworm-slim
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/drizzle ./drizzle
COPY --from=build /app/server/package.json ./
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Add the compose file**

`deploy/compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: rakurs
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: rakurs
    volumes: ['rakurs-db:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U rakurs']
      interval: 5s
      retries: 10
    restart: unless-stopped

  api:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://rakurs:${POSTGRES_PASSWORD}@postgres:5432/rakurs
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET}
    ports: ['127.0.0.1:3000:3000']
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

volumes:
  rakurs-db:
```

Two deliberate details. `postgres` publishes no ports, so it is reachable only from the compose
network. `api` binds to `127.0.0.1`, so only nginx on the same host can reach it — not the open
internet, whatever the firewall happens to say.

- [ ] **Step 3: Add the environment example**

`deploy/env.example`:

```dotenv
# cp deploy/env.example deploy/.env and fill in. Never commit deploy/.env.
# Generate each secret with: head -c 32 /dev/urandom | base64

POSTGRES_PASSWORD=
SESSION_SECRET=
```

- [ ] **Step 4: Confirm the real env file is ignored**

```bash
cp deploy/env.example deploy/.env
git check-ignore -v deploy/.env
```

Expected: git reports the matching `.gitignore` rule. If it prints nothing, the file would be
committed — stop and add the rule before continuing.

- [ ] **Step 5: Add the nginx config**

`deploy/nginx.conf`, adapted from `rakurs/deploy/nginx.conf.example`:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name rakurs.example.com;

  ssl_certificate     /etc/letsencrypt/live/rakurs.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/rakurs.example.com/privkey.pem;

  root /var/www/rakurs;
  index index.html;

  # The router lives in the browser. Without this, a refresh on /dialogs is a 404.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Meta sync and model analysis take tens of seconds.
    proxy_read_timeout 120s;

    # Plan 3 delivers QR status over WebSocket through this same location.
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}

server {
  listen 80;
  server_name rakurs.example.com;
  return 301 https://$host$request_uri;
}
```

Replace `rakurs.example.com` with the real domain in all four places.

- [ ] **Step 6: Verify the image builds**

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env build
```

Expected: the build completes. A failure compiling `argon2` means the build tools in step 1 are
missing or misspelled.

- [ ] **Step 7: Run the stack locally and confirm Postgres is not exposed**

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run migrate
curl -s localhost:3000/api/health
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

Expected: `{"ok":true}`, and the `postgres` row shows no published port. If it lists
`0.0.0.0:5432`, the database is on the internet — fix that before deploying.

- [ ] **Step 8: Write the deploy guide**

`deploy/README.md`, English, under 200 lines:

````markdown
# Deploying Rakurs

    cp deploy/env.example deploy/.env      # fill both secrets
    npm --prefix rakurs run build
    rsync -a --delete rakurs/dist/ vps:/var/www/rakurs/
    docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
    docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run migrate

Create the first user, once:

    docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run create-user

nginx serves `/var/www/rakurs` and proxies `/api` to `127.0.0.1:3000`; the config is
`deploy/nginx.conf`. `try_files … /index.html` is required — the router is client-side.

Backups: `pg_dump` against the `postgres` service. From plan 3 onward, exclude
`wa_sessions.creds` from any dump that leaves the VPS — it is a live WhatsApp login.
````

- [ ] **Step 9: Full verification**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: all four pass.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add the deployment stack

Postgres publishes no ports and the API binds to loopback, so only nginx
on the host can reach either."
```
