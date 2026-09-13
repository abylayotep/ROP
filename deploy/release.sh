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
  if ! git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
    echo "Production runs $DEPLOYED, a commit this clone does not have. Fetch it, or merge it into main." >&2
    exit 1
  fi
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
ssh_host "bash $RELEASES_DIR/$SHA/deploy/release-remote.sh $SHA $STAMP" </dev/null

step "Publishing the frontend"
# Old hashed assets stay for browsers that still have the previous index.html open.
rsync -a -e "ssh -i $KEY -o BatchMode=yes" --exclude=index.html "$WORK/rakurs/dist/" "$HOST:$WEB_ROOT/"
rsync -a -e "ssh -i $KEY -o BatchMode=yes" "$WORK/rakurs/dist/index.html" "$HOST:$WEB_ROOT/index.html.next"
# The previous page is kept so a rollback can put it back without rebuilding.
ssh_host "cp -p $WEB_ROOT/index.html $WEB_ROOT/index.html.previous 2>/dev/null || true; mv $WEB_ROOT/index.html.next $WEB_ROOT/index.html"

step "Released $SHA"
