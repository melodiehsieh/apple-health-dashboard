#!/usr/bin/env python3
"""
Precomputes every chart's data server-side (i.e. here, in the pipeline, not
in the browser) into one small JSON file the static site just fetches and
renders. Replaces client-side DuckDB-WASM querying entirely -- the site no
longer ships or queries Parquet at all.

Everything is aggregated to DAILY granularity here; the site re-aggregates
daily rows into week/month buckets in plain JS for the different range
selectors (Past Month/YTD/1 Year/All Time), which is cheap over a few
hundred/thousand small rows and needs no query engine.

Usage:
    pipeline/.venv/bin/python pipeline/build_site_data.py --data data
"""
import argparse
import json
from pathlib import Path

import pandas as pd


def daily_mean(df: pd.DataFrame, date_col: str, value_col: str) -> pd.DataFrame:
    df = df.dropna(subset=[value_col])
    df = df[df[date_col] <= pd.Timestamp.now(tz=df[date_col].dt.tz)]
    daily = df.groupby(df[date_col].dt.date)[value_col].mean().reset_index()
    daily.columns = ["date", "value"]
    return daily


def daily_sum(df: pd.DataFrame, date_col: str, value_col: str) -> pd.DataFrame:
    df = df.dropna(subset=[value_col])
    df = df[df[date_col] <= pd.Timestamp.now(tz=df[date_col].dt.tz)]
    daily = df.groupby(df[date_col].dt.date)[value_col].sum().reset_index()
    daily.columns = ["date", "value"]
    return daily


def to_records(daily: pd.DataFrame) -> list[dict]:
    return [{"date": str(row.date), "value": round(float(row.value), 4)} for row in daily.itertuples()]


def build(data_dir: Path, out_path: Path):
    workouts = pd.read_parquet(data_dir / "workouts.parquet")
    running = workouts[workouts["activity_type"] == "HKWorkoutActivityTypeRunning"]
    summary = {
        "total_workouts": int(len(workouts)),
        "running_workouts": int(len(running)),
        "first_ts": workouts["start_ts"].min().isoformat(),
        "last_ts": workouts["start_ts"].max().isoformat(),
    }

    # --- Pace by HR zone: daily (avg_pace, n) per zone, so the site can
    # weight-average correctly when it re-buckets into week/month. ---
    hr_pace = pd.read_parquet(data_dir / "workout_hr_pace.parquet")
    hr_pace = hr_pace[hr_pace["zone"].notna() & hr_pace["pace_min_per_mi"].notna()]
    hr_pace = hr_pace[hr_pace["ts"] <= pd.Timestamp.now(tz=hr_pace["ts"].dt.tz)]
    grouped = hr_pace.groupby([hr_pace["ts"].dt.date, "zone"])["pace_min_per_mi"].agg(["mean", "count"])
    grouped = grouped.reset_index()
    grouped.columns = ["date", "zone", "avg_pace", "n"]
    pace_by_zone_daily = [
        {"date": str(r.date), "zone": r.zone, "avg_pace": round(float(r.avg_pace), 4), "n": int(r.n)}
        for r in grouped.itertuples()
    ]

    # --- Activity rings (already one row per day) ---
    activity = pd.read_parquet(data_dir / "activity_summary.parquet")
    activity["date_ts"] = pd.to_datetime(activity["date"])
    if activity["date_ts"].dt.tz is None:
        activity["date_ts"] = activity["date_ts"].dt.tz_localize("America/New_York")

    active_energy_daily = to_records(daily_mean(activity, "date_ts", "active_energy"))
    exercise_time_daily = to_records(daily_mean(activity, "date_ts", "exercise_time"))
    stand_hours_daily = to_records(daily_mean(activity, "date_ts", "stand_hours"))

    # --- Steps, resting HR, VO2 max (raw records -> daily) ---
    steps = pd.read_parquet(data_dir / "records" / "step_count.parquet", columns=["start_ts", "value"])
    steps["value"] = pd.to_numeric(steps["value"], errors="coerce")
    steps_daily = to_records(daily_sum(steps, "start_ts", "value"))

    resting_hr = pd.read_parquet(data_dir / "records" / "resting_heart_rate.parquet", columns=["start_ts", "value"])
    resting_hr["value"] = pd.to_numeric(resting_hr["value"], errors="coerce")
    resting_hr_daily = to_records(daily_mean(resting_hr, "start_ts", "value"))

    vo2max = pd.read_parquet(data_dir / "records" / "vo2_max.parquet", columns=["start_ts", "value"])
    vo2max["value"] = pd.to_numeric(vo2max["value"], errors="coerce")
    vo2max_daily = to_records(daily_mean(vo2max, "start_ts", "value"))

    site_data = {
        "summary": summary,
        "pace_by_zone_daily": pace_by_zone_daily,
        "active_energy_daily": active_energy_daily,
        "exercise_time_daily": exercise_time_daily,
        "stand_hours_daily": stand_hours_daily,
        "steps_daily": steps_daily,
        "resting_hr_daily": resting_hr_daily,
        "vo2max_daily": vo2max_daily,
    }

    out_path.write_text(json.dumps(site_data, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")
    for key, val in site_data.items():
        if isinstance(val, list):
            print(f"  {key}: {len(val)} rows")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path)
    ap.add_argument("--out", default=None, type=Path, help="Output path (default: <data>/site_data.json)")
    args = ap.parse_args()
    out_path = args.out or (args.data / "site_data.json")
    build(args.data, out_path)


if __name__ == "__main__":
    main()
