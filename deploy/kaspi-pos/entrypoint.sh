#!/bin/sh
# Keep device identity and operation tracking across container rebuilds.
set -eu
mkdir -p /app/state
for f in keypair.json device.json tracked-payments.json webhook-retries.json; do
  ln -sf "/app/state/$f" "/app/$f"
done
exec node server.js
