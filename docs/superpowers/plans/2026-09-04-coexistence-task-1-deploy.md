# Task 1: Deploy to `rop.tasbaqa.ru`

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Independent of every
other task. Embedded Signup only runs from an HTTPS origin listed in the Meta app, so nothing
in this stage can be tried end to end until this is done.

**Files:**
- Create: `deploy/Caddyfile.rop`
- Modify: `deploy/README.md` (new section «Behind Caddy»)
- Host: `/opt/rakurs` on `ubuntu@194.238.40.152`, `/etc/caddy/Caddyfile`, `/var/www/rakurs`

**Interfaces:**
- Produces: a live `https://rop.tasbaqa.ru` whose `/api/health` answers `{"status":"ok"}` and whose `/api/whatsapp/webhook` handshake works with the verify token in `deploy/.env`.

## Facts about the host

- Tasbaqa's production stack lives in `/opt/tasbaqa`; Caddy on the host terminates TLS and proxies `tasbaqa.ru` to `127.0.0.1:8080`. Host port `3000` is free.
- SSH: `ssh -i ~/.ssh/tasbaqa_deploy ubuntu@194.238.40.152`, passwordless sudo.
- **Never run a bare `docker compose` in `/opt/tasbaqa`.** This task never enters that directory.
- Reloading Caddy is zero-downtime, but it is a shared production process. **Stop and ask the owner before Step 6.**

- [ ] **Step 1: The Caddy site block**

Create `deploy/Caddyfile.rop`:

```
# Site block for a host that already runs Caddy for another product. Append it to
# /etc/caddy/Caddyfile and `sudo systemctl reload caddy`. The api container binds to
# 127.0.0.1:3000 (deploy/compose.yml); the built frontend is copied to /var/www/rakurs.
#
# /api/* is proxied untouched: the webhook signature is over the exact bytes Meta sent.
rop.tasbaqa.ru {
    handle /api/* {
        reverse_proxy 127.0.0.1:3000 {
            transport http {
                read_timeout 120s
            }
        }
    }
    handle {
        root * /var/www/rakurs
        try_files {path} /index.html
        file_server
    }
}
```

- [ ] **Step 2: Document it**

Append to `deploy/README.md`:

```markdown
## Behind Caddy

On a host that already runs Caddy (the Tasbaqa VPS), skip `deploy/nginx.conf` and append
`deploy/Caddyfile.rop` to `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`. Caddy
obtains the certificate itself once the domain's A record points at the host. The stack
runs from `/opt/rakurs` with the same commands as above; the Compose project name is the
directory name, so it cannot collide with the other product's.

Two more variables are required from stage 7 on:

- `META_APP_ID` — the Meta application's id, shown to the browser to start Embedded Signup;
- `META_ES_CONFIG_ID` — the Facebook Login for Business configuration id.
```

- [ ] **Step 3: DNS**

Ask the owner to add `A rop → 194.238.40.152` at the registrar of `tasbaqa.ru`. Verify from the Mac (outside the sandbox):

```bash
dig +short rop.tasbaqa.ru A
```

Expected: `194.238.40.152`. Do not continue past Step 5 until it resolves; Caddy cannot get a certificate before that.

- [ ] **Step 4: Copy the checkout and build the frontend**

From the repository root, on the Mac:

```bash
npm --prefix rakurs run build
rsync -a --delete --exclude='.claude/' --exclude='node_modules/' --exclude='.git/' \
  --exclude='var/' --exclude='server/.env' --exclude='deploy/.env' \
  ./ ubuntu@194.238.40.152:/opt/rakurs/ -e 'ssh -i ~/.ssh/tasbaqa_deploy'
rsync -a --delete rakurs/dist/ ubuntu@194.238.40.152:/var/www/rakurs/ -e 'ssh -i ~/.ssh/tasbaqa_deploy'
```

If `/opt/rakurs` or `/var/www/rakurs` do not exist yet:

```bash
ssh -i ~/.ssh/tasbaqa_deploy ubuntu@194.238.40.152 'sudo mkdir -p /opt/rakurs /var/www/rakurs && sudo chown -R ubuntu:ubuntu /opt/rakurs /var/www/rakurs'
```

- [ ] **Step 5: Environment on the host**

On the host, create `/opt/rakurs/deploy/.env` from `deploy/env.example`. Generate the three secrets there, never in chat:

```bash
ssh -i ~/.ssh/tasbaqa_deploy ubuntu@194.238.40.152 'cd /opt/rakurs && cp -n deploy/env.example deploy/.env && for v in POSTGRES_PASSWORD SESSION_SECRET CREDENTIALS_KEY; do s=$(head -c 32 /dev/urandom | base64); sed -i "s|^$v=.*|$v=$s|" deploy/.env; done && sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://rop.tasbaqa.ru|" deploy/.env && sed -i "s|^META_WEBHOOK_VERIFY_TOKEN=.*|META_WEBHOOK_VERIFY_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d /+=)|" deploy/.env && grep -c = deploy/.env'
```

`META_APP_SECRET` (and after Task 2, `META_APP_ID`, `META_ES_CONFIG_ID`) the owner pastes in by hand: App Dashboard → Settings → Basic. The agent must not type it.

- [ ] **Step 6: Ask, then start the stack and register the site**

Ask the owner in chat: «Поднимаю стек в /opt/rakurs и добавляю rop.tasbaqa.ru в Caddy, катим?». Only after «катим»:

```bash
ssh -i ~/.ssh/tasbaqa_deploy ubuntu@194.238.40.152 'cd /opt/rakurs && sudo docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build && sudo docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api npm run migrate && sudo sh -c "cat deploy/Caddyfile.rop >> /etc/caddy/Caddyfile" && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

Expected: containers `rakurs-postgres-1` and `rakurs-api-1` up, migrations applied, `caddy validate` prints `Valid configuration`.

- [ ] **Step 7: Verify**

```bash
curl -s https://rop.tasbaqa.ru/api/health
curl -s "https://rop.tasbaqa.ru/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$(ssh -i ~/.ssh/tasbaqa_deploy ubuntu@194.238.40.152 'grep ^META_WEBHOOK_VERIFY_TOKEN= /opt/rakurs/deploy/.env | cut -d= -f2')&hub.challenge=4242"
curl -s -o /dev/null -w '%{http_code}\n' https://rop.tasbaqa.ru/a/anything
```

Expected: `{"status":"ok"}`, `4242`, `200`.

- [ ] **Step 8: First company and owner**

```bash
ssh -i ~/.ssh/tasbaqa_deploy -t ubuntu@194.238.40.152 'cd /opt/rakurs && sudo docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/scripts/create-account.js'
```

Interactive: the owner types the password. Record nothing.

- [ ] **Step 9: Commit**

```bash
git add deploy/Caddyfile.rop deploy/README.md
git commit -m "Deploy behind Caddy on a host shared with another product"
```
