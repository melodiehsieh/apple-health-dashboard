#!/usr/bin/env python3
"""
Builds data/catalog.duckdb: a local DuckDB file with views over every
Parquet output, for quick ad-hoc querying and validation before shipping
the Parquet files to the site.

Usage:
    pipeline/.venv/bin/python pipeline/build_catalog.py --data data
"""
import argparse
from pathlib import Path

import duckdb


def build(data_dir: Path):
    db_path = data_dir / "catalog.duckdb"
    if db_path.exists():
        db_path.unlink()
    con = duckdb.connect(str(db_path))

    for parquet_path in sorted((data_dir / "records").glob("*.parquet")):
        view = f"record_{parquet_path.stem}"
        con.execute(f"CREATE VIEW {view} AS SELECT * FROM read_parquet('{parquet_path}')")

    for name in ["workouts", "workout_events", "workout_statistics", "activity_summary", "workout_hr_pace"]:
        path = data_dir / f"{name}.parquet"
        if path.exists():
            con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{path}')")

    views = con.execute("SELECT view_name FROM duckdb_views() WHERE internal = false ORDER BY 1").fetchall()
    print(f"wrote {db_path} with {len(views)} views:")
    for (v,) in views:
        count = con.execute(f"SELECT count(*) FROM {v}").fetchone()[0]
        print(f"  {v:35s} {count:>10,} rows")

    con.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path)
    args = ap.parse_args()
    build(args.data)


if __name__ == "__main__":
    main()
