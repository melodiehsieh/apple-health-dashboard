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

# A hand-picked subset of per-type records: small/legible "basic analytics"
# metrics, not the full 3M-row records/ directory (that stays local-only
# until a specific analysis needs it -- see the process doc).
for name in step_count body_mass resting_heart_rate vo2_max; do
  if [ -f "$SRC/records/$name.parquet" ]; then
    cp "$SRC/records/$name.parquet" "$DEST/"
  fi
done

echo "Synced $(ls "$DEST"/*.parquet | wc -l | tr -d ' ') Parquet file(s) into $DEST"
