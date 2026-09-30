#!/usr/bin/env bash
# Puts the homepage at the site root, next to the dashboard at /health/.
#
# The homepage is built and versioned in its own repo
# (github.com/melodiehsieh/melodiehsieh-home); this copies its built page
# (and the resume PDF next to it) into dist/ after `npm run build`.
#   CI:     the deploy workflow checks that repo out into ../homepage
#   local:  HOMEPAGE_DIR=../../melodiehsieh-home/dist bash scripts/assemble-homepage.sh
# Fails loudly if the homepage is missing, so a deploy can never ship without a root page.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${HOMEPAGE_DIR:-../homepage/dist}"
if [ ! -f "$SRC/index.html" ]; then
  echo "Homepage not found at $SRC/index.html (set HOMEPAGE_DIR, or check out melodiehsieh-home next to this repo)." >&2
  exit 1
fi
if [ ! -d dist/health ]; then
  echo "dist/health is missing -- run 'npm run build' first." >&2
  exit 1
fi

cp "$SRC/index.html" dist/index.html
for f in "$SRC"/*.pdf; do [ -e "$f" ] && cp "$f" dist/; done
echo "Homepage copied into dist/ ($(ls dist | tr '\n' ' '))"
