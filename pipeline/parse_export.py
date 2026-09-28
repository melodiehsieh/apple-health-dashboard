#!/usr/bin/env python3
"""
Streams an Apple Health `export.xml` into per-type Parquet tables.

Never loads the file as a DOM: uses ElementTree.iterparse and clears each
element (and periodically the root) as soon as it's been read, so memory
stays bounded regardless of export size. Record rows are buffered per
`type` and flushed to their Parquet file every FLUSH_EVERY rows; the much
smaller Workout/ActivitySummary tables are buffered fully and written once
at the end.

Usage:
    pipeline/.venv/bin/python pipeline/parse_export.py \
        --export ~/Downloads/apple_health_export/export.xml \
        --out data
"""
import argparse
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

FLUSH_EVERY = 200_000

RECORD_COLUMNS = [
    "value", "unit", "source_name", "source_version", "device",
    "start_ts", "end_ts", "created_ts",
]
TS_COLUMNS = {"start_ts", "end_ts", "created_ts"}

TYPE_PREFIXES = ("HKQuantityTypeIdentifier", "HKCategoryTypeIdentifier", "HKDataType")


def type_to_filename(record_type: str) -> str:
    name = record_type
    for prefix in TYPE_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    s2 = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1)
    return s2.lower()


def to_eastern(series: pd.Series) -> pd.Series:
    # Apple's format: "2024-10-27 07:34:29 -0400" (already Eastern, just a
    # fixed offset per-row) -> parse with each row's own offset, then
    # normalize to America/New_York so EST/EDT display correctly and
    # consistently regardless of which offset the original row carried.
    parsed = pd.to_datetime(series, format="%Y-%m-%d %H:%M:%S %z", errors="coerce", utc=True)
    return parsed.dt.tz_convert("America/New_York")


class RecordTypeBuffers:
    """One growing buffer + one open ParquetWriter per Record `type`."""

    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.buffers: dict[str, dict[str, list]] = {}
        self.writers: dict[str, pq.ParquetWriter] = {}
        self.counts: dict[str, int] = defaultdict(int)

    def add(self, record_type: str, attrib: dict):
        buf = self.buffers.get(record_type)
        if buf is None:
            buf = {col: [] for col in RECORD_COLUMNS}
            self.buffers[record_type] = buf
        buf["value"].append(attrib.get("value"))
        buf["unit"].append(attrib.get("unit"))
        buf["source_name"].append(attrib.get("sourceName"))
        buf["source_version"].append(attrib.get("sourceVersion"))
        buf["device"].append(attrib.get("device"))
        buf["start_ts"].append(attrib.get("startDate"))
        buf["end_ts"].append(attrib.get("endDate"))
        buf["created_ts"].append(attrib.get("creationDate"))
        self.counts[record_type] += 1
        if len(buf["value"]) >= FLUSH_EVERY:
            self.flush(record_type)

    def flush(self, record_type: str):
        buf = self.buffers[record_type]
        if not buf["value"]:
            return
        df = pd.DataFrame(buf)
        for col in TS_COLUMNS:
            df[col] = to_eastern(df[col])
        table = pa.Table.from_pandas(df, preserve_index=False)
        writer = self.writers.get(record_type)
        if writer is None:
            path = self.out_dir / f"{type_to_filename(record_type)}.parquet"
            writer = pq.ParquetWriter(path, table.schema)
            self.writers[record_type] = writer
        writer.write_table(table)
        for col in buf:
            buf[col] = []

    def close(self):
        for record_type in list(self.buffers.keys()):
            self.flush(record_type)
        for writer in self.writers.values():
            writer.close()


def parse(export_path: Path, out_dir: Path, limit: int | None, progress_every: int):
    record_buffers = RecordTypeBuffers(out_dir / "records")

    workouts_rows = []
    workout_events_rows = []
    workout_statistics_rows = []
    activity_summary_rows = []

    pending_workout_attrs = None
    pending_gpx_path = None
    current_workout_id = None
    workout_counter = -1

    top_level_seen = 0
    t0 = time.time()

    context = ET.iterparse(str(export_path), events=("start", "end"))
    _, root = next(context)  # <HealthData>

    for event, elem in context:
        tag = elem.tag

        if event == "start":
            if tag == "Workout":
                workout_counter += 1
                current_workout_id = workout_counter
                pending_workout_attrs = dict(elem.attrib)
                pending_gpx_path = None
            continue

        # event == "end"
        if tag == "Record":
            record_buffers.add(elem.attrib.get("type"), elem.attrib)
            elem.clear()
            root.clear()
            top_level_seen += 1

        elif tag == "Workout":
            a = pending_workout_attrs
            workouts_rows.append({
                "workout_id": current_workout_id,
                "activity_type": a.get("workoutActivityType"),
                "duration_min": a.get("duration"),
                "total_distance": a.get("totalDistance"),
                "distance_unit": a.get("totalDistanceUnit"),
                "total_energy": a.get("totalEnergyBurned"),
                "energy_unit": a.get("totalEnergyBurnedUnit"),
                "source": a.get("sourceName"),
                "start_ts": a.get("startDate"),
                "end_ts": a.get("endDate"),
                "gpx_path": pending_gpx_path,
            })
            current_workout_id = None
            pending_workout_attrs = None
            pending_gpx_path = None
            elem.clear()
            root.clear()
            top_level_seen += 1

        elif tag == "WorkoutEvent":
            a = elem.attrib
            workout_events_rows.append({
                "workout_id": current_workout_id,
                "event_type": a.get("type"),
                "ts": a.get("date"),
            })
            elem.clear()
            continue

        elif tag == "WorkoutStatistics":
            a = elem.attrib
            workout_statistics_rows.append({
                "workout_id": current_workout_id,
                "metric_type": a.get("type"),
                "avg": a.get("average"),
                "min": a.get("minimum"),
                "max": a.get("maximum"),
                "sum": a.get("sum"),
                "unit": a.get("unit"),
            })
            elem.clear()
            continue

        elif tag == "FileReference":
            pending_gpx_path = elem.attrib.get("path")
            elem.clear()
            continue

        elif tag == "ActivitySummary":
            a = elem.attrib
            activity_summary_rows.append({
                "date": a.get("dateComponents"),
                "active_energy": a.get("activeEnergyBurned"),
                "active_energy_goal": a.get("activeEnergyBurnedGoal"),
                "active_energy_unit": a.get("activeEnergyBurnedUnit"),
                "move_time": a.get("appleMoveTime"),
                "move_time_goal": a.get("appleMoveTimeGoal"),
                "exercise_time": a.get("appleExerciseTime"),
                "exercise_time_goal": a.get("appleExerciseTimeGoal"),
                "stand_hours": a.get("appleStandHours"),
                "stand_hours_goal": a.get("appleStandHoursGoal"),
            })
            elem.clear()
            root.clear()
            top_level_seen += 1

        else:
            elem.clear()
            continue

        if progress_every and top_level_seen and top_level_seen % progress_every == 0:
            elapsed = time.time() - t0
            print(f"  ...{top_level_seen:,} top-level elements in {elapsed:,.1f}s", file=sys.stderr)

        if limit and top_level_seen >= limit:
            print(f"Hit --limit {limit}, stopping early.", file=sys.stderr)
            break

    record_buffers.close()

    out_dir.mkdir(parents=True, exist_ok=True)

    def write_small_table(rows, name, numeric_cols=()):
        if not rows:
            return
        df = pd.DataFrame(rows)
        for col in TS_COLUMNS & set(df.columns):
            df[col] = to_eastern(df[col])
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        df.to_parquet(out_dir / f"{name}.parquet", index=False)
        print(f"wrote {name}.parquet: {len(df):,} rows")

    write_small_table(
        workouts_rows, "workouts",
        numeric_cols=("duration_min", "total_distance", "total_energy"),
    )
    write_small_table(
        workout_events_rows, "workout_events",
    )
    write_small_table(
        workout_statistics_rows, "workout_statistics",
        numeric_cols=("avg", "min", "max", "sum"),
    )
    write_small_table(
        activity_summary_rows, "activity_summary",
        numeric_cols=(
            "active_energy", "active_energy_goal", "move_time", "move_time_goal",
            "exercise_time", "exercise_time_goal", "stand_hours", "stand_hours_goal",
        ),
    )

    print("\nRecord types written:")
    for record_type, count in sorted(record_buffers.counts.items(), key=lambda kv: -kv[1]):
        print(f"  {type_to_filename(record_type):40s} {count:>10,}  ({record_type})")

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:,.1f}s. {top_level_seen:,} top-level elements processed.")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--export", required=True, type=Path, help="Path to export.xml")
    ap.add_argument("--out", default=Path("data"), type=Path, help="Output directory (default: data)")
    ap.add_argument("--limit", type=int, default=None, help="Stop after N top-level elements (for smoke tests)")
    ap.add_argument("--progress-every", type=int, default=500_000, help="Print progress every N elements (0 to disable)")
    args = ap.parse_args()

    if not args.export.exists():
        sys.exit(f"export.xml not found at {args.export}")

    parse(args.export, args.out, args.limit, args.progress_every)


if __name__ == "__main__":
    main()
