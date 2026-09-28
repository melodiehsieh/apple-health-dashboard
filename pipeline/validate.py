#!/usr/bin/env python3
"""
Row-count reconciliation: compares each records/<type>.parquet row count
against the counts taken directly from the raw XML with `grep -c` (2026-09-28
scan of this export). Catches a parsing regression before it reaches the site.

Usage:
    pipeline/.venv/bin/python pipeline/validate.py --data data
"""
import argparse
from pathlib import Path

import pyarrow.parquet as pq

# From: grep -o 'Record type="[^"]*"' export.xml | sort | uniq -c  (2026-09-28)
EXPECTED_RECORD_COUNTS = {
    "active_energy_burned": 471469,
    "basal_energy_burned": 423286,
    "heart_rate": 369487,
    "physical_effort": 367516,
    "distance_walking_running": 356062,
    "headphone_audio_exposure": 268911,
    "step_count": 258013,
    "walking_speed": 105905,
    "walking_step_length": 105901,
    "walking_double_support_percentage": 91372,
    "running_power": 53414,
    "running_speed": 53251,
    "apple_stand_time": 40369,
    "apple_exercise_time": 36919,
    "walking_asymmetry_percentage": 33510,
    "environmental_audio_exposure": 24541,
    "running_vertical_oscillation": 19087,
    "flights_climbed": 19068,
    "running_ground_contact_time": 18393,
    "running_stride_length": 16349,
    "apple_stand_hour": 10236,
    "time_in_daylight": 6903,
    "stair_descent_speed": 3718,
    "heart_rate_variability_sdnn": 2624,
    "stair_ascent_speed": 2564,
    "sleep_analysis": 1594,
    "respiratory_rate": 1433,
    "oxygen_saturation": 1009,
    "resting_heart_rate": 687,
    "walking_heart_rate_average": 683,
    "audio_exposure_event": 483,
    "vo2_max": 423,
    "heart_rate_recovery_one_minute": 282,
    "apple_walking_steadiness": 256,
    "body_mass": 203,
    "body_mass_index": 200,
    "body_fat_percentage": 191,
    "lean_body_mass": 191,
    "six_minute_walk_test_distance": 97,
    "menstrual_flow": 52,
    "distance_cycling": 43,
    "distance_downhill_snow_sports": 43,
    "apple_sleeping_breathing_disturbances": 25,
    "height": 16,
    "apple_sleeping_wrist_temperature": 10,
    "sleep_duration_goal": 1,
    "high_heart_rate_event": 1,
}
EXPECTED_TOTALS = {"workouts": 700, "activity_summary": 714}
EXPECTED_GPX_LINKED_WORKOUTS = 432


def row_count(path: Path) -> int:
    return pq.ParquetFile(path).metadata.num_rows


def validate(data_dir: Path) -> bool:
    ok = True
    print("Record type row counts vs. raw XML grep counts:")
    for name, expected in sorted(EXPECTED_RECORD_COUNTS.items(), key=lambda kv: -kv[1]):
        path = data_dir / "records" / f"{name}.parquet"
        if not path.exists():
            print(f"  MISSING  {name}")
            ok = False
            continue
        actual = row_count(path)
        status = "OK" if actual == expected else "MISMATCH"
        if status != "OK":
            ok = False
        print(f"  {status:8s} {name:40s} expected {expected:>9,}  actual {actual:>9,}")

    print("\nOther tables:")
    for name, expected in EXPECTED_TOTALS.items():
        path = data_dir / f"{name}.parquet"
        actual = row_count(path) if path.exists() else None
        status = "OK" if actual == expected else "MISMATCH"
        if status != "OK":
            ok = False
        print(f"  {status:8s} {name:40s} expected {expected:>9,}  actual {actual}")

    import pandas as pd
    workouts = pd.read_parquet(data_dir / "workouts.parquet", columns=["gpx_path"])
    gpx_linked = workouts["gpx_path"].notna().sum()
    status = "OK" if gpx_linked == EXPECTED_GPX_LINKED_WORKOUTS else "MISMATCH"
    if status != "OK":
        ok = False
    print(f"  {status:8s} {'workouts.gpx_path (non-null)':40s} expected {EXPECTED_GPX_LINKED_WORKOUTS:>9,}  actual {gpx_linked}")

    print(f"\n{'ALL CHECKS PASSED' if ok else 'SOME CHECKS FAILED'}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path)
    args = ap.parse_args()
    ok = validate(args.data)
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
