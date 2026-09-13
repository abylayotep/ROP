#!/usr/bin/env bash
# Deploys origin/main to production. Nothing else can be deployed.
#
#   deploy/release.sh            # deploy the current origin/main
#   deploy/release.sh --dry-run  # build and check everything, change nothing on the host
#
# The branch checked out locally and any uncommitted change are irrelevant: the release is
# built from `git archive` of origin/main, so what runs in production is always a commit
# that exists on main. See deploy/README.md, "Releasing".
set -euo pipefail

HOST="${RAKURS_DEPLOY_HOST:-root@194.238.40.152}"
KEY="${RAKURS_DEPLOY_KEY:-$HOME/.ssh/tasbaqa_deploy}"
REMOTE_DIR=/opt/rakurs
RELEASES_DIR=/opt/rakurs-releases
BACKUP_DIR=/opt/rakurs-backups
WEB_ROOT=/var/www/rakurs

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ssh_host() { ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }
step() { printf '\n==> %s\n' "$*"; }

cd "$(git rev-parse --show-toplevel)"

step "Resolving origin/main"
git fetch --quiet origin main
SHA="$(git rev-parse origin/main)"
echo "release $SHA ($(git log -1 --format=%s "$SHA"))"

DEPLOYED="$(ssh_host "cat $REMOTE_DIR/.release.sha 2>/dev/null || true")"
if [[ -n "$DEPLOYED" ]]; then
  # A deployed commit that main does not contain means production runs something main lost.
  if ! git merge-base --is-ancestor "$DEPLOYED" "$SHA" 2>/dev/null; then
    echo "Production runs $DEPLOYED, which is not part of origin/main. Merge it into main first." >&2
    exit 1
  fi
  [[ "$DEPLOYED" == "$SHA" ]] && echo "Production already runs $SHA; redeploying."
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step "Building the frontend from a clean export"
git archive "$SHA" | tar -x -C "$WORK"
(cd "$WORK" && npm ci --no-audit --no-fund >/dev/null && npm --prefix rakurs run build >/dev/null)
test -f "$WORK/rakurs/dist/index.html"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "Dry run: build succeeded, the host was not changed."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

step "Uploading source to $RELEASES_DIR/$SHA"
git archive --format=tar.gz "$SHA" | ssh_host "rm -rf $RELEASES_DIR/$SHA && mkdir -p $RELEASES_DIR/$SHA && tar -xz -C $RELEASES_DIR/$SHA"

step "Backing up the database, installing the source, migrating, restarting the API"
ssh_host bash -s -- "$SHA" "$STAMP" <<'REMOTE'
set -euo pipefail
SHA="$1"; STAMP="$2"
REMOTE_DIR=/opt/rakurs; RELEASES_DIR=/opt/rakurs-releases; BACKUP_DIR=/opt/rakurs-backups
compose() { docker compose -f deploy/compose.yml --env-file deploy/.env "$@"; }

mkdir -p "$BACKUP_DIR"
cd "$REMOTE_DIR"
compose exec -T postgres pg_dump -U rakurs -Fc rakurs > "$BACKUP_DIR/rakurs-$STAMP-${SHA:0:12}.dump"
echo "database backup: $BACKUP_DIR/rakurs-$STAMP-${SHA:0:12}.dump"
docker image inspect rakurs-api:latest >/dev/null 2>&1 && docker tag rakurs-api:latest rakurs-api:rollback

# Files main does not track are moved aside rather than deleted, as are the ones replaced.
rsync -a --delete --backup --backup-dir="$RELEASES_DIR/replaced-$STAMP" \
  --exclude=/deploy/.env --exclude=/.release.sha "$RELEASES_DIR/$SHA/" "$REMOTE_DIR/"

compose build api
compose run --rm --no-deps api npm run migrate
compose up -d --no-deps api
curl --silent --fail --retry 30 --retry-all-errors --retry-delay 1 --max-time 3 \
  http://127.0.0.1:3000/api/health >/dev/null
echo "$SHA" > "$REMOTE_DIR/.release.sha"
echo "api healthy on $SHA"
REMOTE

step "Publishing the frontend"
# Old hashed assets stay for browsers that still have the previous index.html open.
rsync -a -e "ssh -i $KEY -o BatchMode=yes" --exclude=index.html "$WORK/rakurs/dist/" "$HOST:$WEB_ROOT/"
rsync -a -e "ssh -i $KEY -o BatchMode=yes" "$WORK/rakurs/dist/index.html" "$HOST:$WEB_ROOT/index.html.next"
ssh_host "mv $WEB_ROOT/index.html.next $WEB_ROOT/index.html"

step "Released $SHA"
