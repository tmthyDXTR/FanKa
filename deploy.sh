#!/usr/bin/env bash
# One-command deploy to FastComet: publish -> sync -> rsync -> restart Passenger.
# Usage: ./deploy.sh [--no-build] [--dry-run]
set -euo pipefail
HOST=fastcomet
REMOTE_DIR=flash.supacoda.de
cd "$(dirname "$0")"

BUILD=1; DRY=()
for a in "$@"; do
  case $a in
    --no-build) BUILD=0 ;;
    --dry-run) DRY=(--dry-run) ;;
    *) echo "unknown arg $a"; exit 1 ;;
  esac
done

if [ $BUILD = 1 ]; then
  dotnet publish -c Release
  (cd node-host && npm run sync-wasm)
fi

# --delete removes stale fingerprinted _framework files; data/, node_modules, .env, .htaccess are never touched.
rsync -az --delete "${DRY[@]}" --itemize-changes node-host/public/ "$HOST:$REMOTE_DIR/public/"
rsync -az "${DRY[@]}" --itemize-changes node-host/server.js node-host/package.json node-host/package-lock.json "$HOST:$REMOTE_DIR/"
rsync -az --delete "${DRY[@]}" --itemize-changes node-host/src/ "$HOST:$REMOTE_DIR/src/"
rsync -az --delete "${DRY[@]}" --itemize-changes node-host/scripts/ "$HOST:$REMOTE_DIR/scripts/"

if [ ${#DRY[@]} -eq 0 ]; then
  ssh "$HOST" "mkdir -p $REMOTE_DIR/tmp && touch $REMOTE_DIR/tmp/restart.txt"
  echo "Deployed. Hard-refresh the browser (Ctrl+Shift+R) to bypass cached assets."
fi
