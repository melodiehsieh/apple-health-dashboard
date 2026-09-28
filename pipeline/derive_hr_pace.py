#!/usr/bin/env python3
"""
Builds data/workout_hr_pace.parquet: one row per (workout, time bucket),
joining heart rate and running pace onto a common grid so pace-by-HR-zone
trends can be plotted across runs, independent of any whole-run label.

For each Running workout, HeartRate and RunningSpeed records inside that
workout's [start_ts, end_ts] window are each resampled onto a fixed-width
grid using the last known value at/before each grid point (both are
point-in-time instantaneous readings, not sums), after dropping the first
`warmup_exclude_minutes` of the run (HR lags actual effort at the start,
which otherwise shows up as false Zone 1). Zone boundaries and the warmup
window come from pipeline/zones_config.json -- see that file's comments if
you haven't replaced the placeholder zone values with your real
Apple-configured zones yet.

Usage:
    pipeline/.venv/bin/python pipeline/derive_hr_pace.py --data data
"""
import argparse
import json
from pathlib import Path

import pandas as pd

BUCKET = "15s"
MPS_TO_MIN_PER_MI = 26.8224  # 60 / 2.23694; min/mi = MPS_TO_MIN_PER_MI / speed_m_s


def load_config(config_path: Path):
    with open(config_path) as f:
        cfg = json.load(f)
    return cfg["zones"], cfg.get("warmup_exclude_minutes", 0)


def assign_zone(hr, zones):
    if pd.isna(hr):
        return None
    for z in zones:
        if z["min_bpm"] <= hr < z["max_bpm"]:
            return z["name"]
    return None


def resample_last_known(df: pd.DataFrame, grid: pd.DatetimeIndex, value_col: str, out_col: str) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame({"ts": grid, out_col: pd.NA})
    df = df.sort_values("ts")
    grid_df = pd.DataFrame({"ts": grid})
    merged = pd.merge_asof(grid_df, df[["ts", value_col]], on="ts", direction="backward")
    merged = merged.rename(columns={value_col: out_col})
    return merged


def derive(data_dir: Path, zones_config: Path):
    workouts = pd.read_parquet(data_dir / "workouts.parquet")
    running = workouts[workouts["activity_type"] == "HKWorkoutActivityTypeRunning"].copy()
    print(f"{len(running)} running workouts out of {len(workouts)} total")

    hr = pd.read_parquet(data_dir / "records" / "heart_rate.parquet", columns=["start_ts", "value"])
    hr = hr.rename(columns={"start_ts": "ts"})
    hr["value"] = pd.to_numeric(hr["value"], errors="coerce")

    speed_path = data_dir / "records" / "running_speed.parquet"
    speed = pd.read_parquet(speed_path, columns=["start_ts", "value", "unit"])
    speed = speed.rename(columns={"start_ts": "ts"})
    speed["value"] = pd.to_numeric(speed["value"], errors="coerce")

    unit_to_mps = {"m/s": 1.0, "mi/hr": 0.44704, "km/hr": 1 / 3.6}
    speed_units = speed["unit"].dropna().unique().tolist()
    unhandled = [u for u in speed_units if u not in unit_to_mps]
    if unhandled:
        print(f"WARNING: unhandled running_speed unit(s) {unhandled} -- those rows' pace will be null")
    speed["value"] = speed.apply(
        lambda r: r["value"] * unit_to_mps[r["unit"]] if r["unit"] in unit_to_mps else pd.NA, axis=1
    )
    # `value` is now always m/s regardless of the source unit.

    zones, warmup_exclude_minutes = load_config(zones_config)
    warmup_delta = pd.Timedelta(minutes=warmup_exclude_minutes)
    print(f"Excluding the first {warmup_exclude_minutes} minute(s) of each run (HR warmup lag)")

    all_rows = []
    skipped_all_warmup = 0
    for row in running.itertuples():
        start, end = row.start_ts, row.end_ts
        if pd.isna(start) or pd.isna(end) or end <= start:
            continue

        grid_start = start + warmup_delta
        if grid_start >= end:
            skipped_all_warmup += 1
            continue

        hr_slice = hr[(hr["ts"] >= start) & (hr["ts"] <= end)]
        speed_slice = speed[(speed["ts"] >= start) & (speed["ts"] <= end)]
        if hr_slice.empty and speed_slice.empty:
            continue

        grid = pd.date_range(start=grid_start, end=end, freq=BUCKET, tz=start.tzinfo)
        hr_grid = resample_last_known(hr_slice, grid, "value", "heart_rate")
        speed_grid = resample_last_known(speed_slice, grid, "value", "speed_m_s")

        out = hr_grid.merge(speed_grid, on="ts", how="outer")
        out["workout_id"] = row.workout_id
        out["pace_min_per_mi"] = out["speed_m_s"].apply(
            lambda s: (MPS_TO_MIN_PER_MI / s) if pd.notna(s) and s > 0 else pd.NA
        )
        out["zone"] = out["heart_rate"].apply(lambda hr_val: assign_zone(hr_val, zones))
        all_rows.append(out[["workout_id", "ts", "heart_rate", "pace_min_per_mi", "zone"]])

    if skipped_all_warmup:
        print(f"{skipped_all_warmup} run(s) shorter than the warmup exclusion window were skipped entirely")

    if not all_rows:
        print("No running workouts with HR/speed data found -- nothing written.")
        return

    result = pd.concat(all_rows, ignore_index=True)
    out_path = data_dir / "workout_hr_pace.parquet"
    result.to_parquet(out_path, index=False)
    print(f"wrote {out_path}: {len(result):,} rows across {result['workout_id'].nunique()} workouts")
    print(result["zone"].value_counts(dropna=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path, help="Data directory (default: data)")
    ap.add_argument("--zones-config", default=Path("pipeline/zones_config.json"), type=Path)
    args = ap.parse_args()
    derive(args.data, args.zones_config)


if __name__ == "__main__":
    main()
