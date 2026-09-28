# Apple Health Dashboard

Personal Apple Health data, parsed and charted at [melodiehsieh.com](https://melodiehsieh.com).

- `pipeline/` — scripts that parse the raw Apple Health export (`export.xml` + `workout-routes/*.gpx`) into Parquet/DuckDB tables, then precompute every chart's data into one small `site_data.json`. Raw exports and all generated data live in `data/`, which is gitignored and never committed.
- `site/` — the static site. Fetches `site_data.json` and renders the charts; no client-side query engine, no backend.

Full processing plan and open decisions: see the project doc.
