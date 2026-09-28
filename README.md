# Apple Health Dashboard

Personal Apple Health data, parsed and charted at [melodiehsieh.com](https://melodiehsieh.com).

- `pipeline/` — scripts that parse the raw Apple Health export (`export.xml` + `workout-routes/*.gpx`) into Parquet/DuckDB tables. Raw exports and generated data live in `data/`, which is gitignored and never committed.
- `site/` — the static site that loads those tables client-side with DuckDB-WASM and renders the charts.

Full processing plan and open decisions: see the project doc.
