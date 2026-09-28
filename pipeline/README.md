# Pipeline

Turns `export.xml` (+ `workout-routes/*.gpx`, parsed later, on demand, by the site itself) into the Parquet/DuckDB tables under `data/` (gitignored), then precomputes every chart's data into one small `data/site_data.json`. All aggregation happens here, server-side (i.e. at build time, not in the browser) — the site just fetches that JSON and re-buckets its small daily arrays into week/month windows in plain JS. There is no client-side query engine.

## Setup (one time)

```
python3.13 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

## Run

```
pipeline/.venv/bin/python pipeline/parse_export.py --export /path/to/export.xml --out data
pipeline/.venv/bin/python pipeline/derive_hr_pace.py --data data
pipeline/.venv/bin/python pipeline/validate.py --data data
pipeline/.venv/bin/python pipeline/build_catalog.py --data data
pipeline/.venv/bin/python pipeline/build_site_data.py --data data
```

Re-run all five whenever there's a fresh Apple Health export.

## Before trusting `zone` values

`pipeline/zones_config.json` ships with placeholder heart-rate zone boundaries (the generic %-of-max-HR formula). Replace `max_hr` and the zone boundaries with your real Apple-configured zones before relying on the `zone` column in `workout_hr_pace.parquet` — see that file's `_comment`.
