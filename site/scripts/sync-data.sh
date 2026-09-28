#!/usr/bin/env bash
# Copies pipeline output Parquet files into site/public/data (gitignored)
# so the dev server / build can serve them as static assets. Never commits
# or uploads these through git -- see the repo README for how deployment
# ships them to Cloudflare Pages instead.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="../data"
DEST="public/data"

if [ ! -d "$SRC" ]; then
  echo "No $SRC directory found -- run the pipeline first (see pipeline/README.md)." >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$SRC"/*.parquet "$DEST"/
echo "Synced $(ls "$DEST"/*.parquet | wc -l | tr -d ' ') Parquet file(s) into $DEST"
