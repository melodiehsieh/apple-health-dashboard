#!/usr/bin/env bash
# Copies the pipeline's precomputed site_data.json into site/public/data
# (gitignored) so the dev server / build can serve it as a static asset.
# Never commits or uploads this through git -- see the repo README for how
# deployment ships it to Cloudflare Pages instead.
#
# All chart aggregation happens server-side, in
# pipeline/build_site_data.py -- the site only fetches this one JSON file
# and re-buckets its small daily arrays into week/month windows in plain
# JS. No Parquet, no client-side query engine.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="../data/site_data.json"
DEST="public/data"

if [ ! -f "$SRC" ]; then
  echo "$SRC not found -- run pipeline/build_site_data.py first (see pipeline/README.md)." >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$SRC" "$DEST/"
echo "Synced site_data.json ($(du -h "$SRC" | cut -f1)) into $DEST"
