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
    pipeline/.venv/bin/python pipeline/build_site_data.py --data data \
        --gpx-root ~/Downloads/apple_health_export
"""
import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pandas as pd

ACTIVITY_TYPE_PREFIX = "HKWorkoutActivityType"
GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}


def humanize_activity_type(activity_type: str) -> str:
    name = activity_type
    if name.startswith(ACTIVITY_TYPE_PREFIX):
        name = name[len(ACTIVITY_TYPE_PREFIX):]
    return re.sub(r"(?<!^)(?=[A-Z])", " ", name)


def today_cutoff(tz) -> pd.Timestamp:
    """Midnight of the current day in `tz`. The day the export was taken is
    always partial (the export runs at some time of day, not at midnight),
    so every daily series excludes it entirely rather than showing a
    misleadingly low final data point -- a real case: an export taken
    mid-morning made the last day of every "Health trends" chart look like
    a sharp drop-off, when it was really just an incomplete day."""
    return pd.Timestamp.now(tz=tz).normalize()


def daily_mean(df: pd.DataFrame, date_col: str, value_col: str) -> pd.DataFrame:
    df = df.dropna(subset=[value_col])
    df = df[df[date_col] < today_cutoff(df[date_col].dt.tz)]
    daily = df.groupby(df[date_col].dt.date)[value_col].mean().reset_index()
    daily.columns = ["date", "value"]
    return daily


def daily_sum(df: pd.DataFrame, date_col: str, value_col: str) -> pd.DataFrame:
    df = df.dropna(subset=[value_col])
    df = df[df[date_col] < today_cutoff(df[date_col].dt.tz)]
    daily = df.groupby(df[date_col].dt.date)[value_col].sum().reset_index()
    daily.columns = ["date", "value"]
    return daily


def daily_sum_dedup_sources(df: pd.DataFrame, start_col: str, end_col: str, value_col: str, source_col: str) -> pd.DataFrame:
    """Steps are logged independently by every source that was worn/carried
    (iPhone, Watch, third-party apps); when two sources cover the same time
    window they're almost always counting the same physical steps, so
    summing every record double- (or triple-) counts on any day more than
    one source was active -- found via a real case: iPhone + Watch both
    logging a full day summed to ~2x the Health app's own total. This
    merges overlapping-time records across sources into clusters and keeps
    only the single highest-total source per cluster instead of summing
    across sources; records that don't overlap anything -- including
    consecutive same-source segments -- are summed normally, since those
    are legitimately additive time periods."""
    df = df.dropna(subset=[value_col])
    df = df[df[start_col] < today_cutoff(df[start_col].dt.tz)]
    df = df.sort_values(start_col).reset_index(drop=True)

    starts = df[start_col].values
    ends = df[end_col].values
    n = len(df)
    cluster_id = np.empty(n, dtype=np.int64)
    cur_cluster = 0
    cur_end = ends[0] if n else None
    if n:
        cluster_id[0] = 0
    for i in range(1, n):
        if starts[i] <= cur_end:
            cluster_id[i] = cur_cluster
            if ends[i] > cur_end:
                cur_end = ends[i]
        else:
            cur_cluster += 1
            cluster_id[i] = cur_cluster
            cur_end = ends[i]
    df["cluster"] = cluster_id

    per_cluster_source = df.groupby(["cluster", source_col])[value_col].sum().reset_index()
    kept = per_cluster_source.sort_values(value_col, ascending=False).drop_duplicates("cluster")
    cluster_start = df.groupby("cluster")[start_col].first().rename("cluster_start")
    kept = kept.merge(cluster_start, on="cluster")
    daily = kept.groupby(kept["cluster_start"].dt.date)[value_col].sum().reset_index()
    daily.columns = ["date", "value"]
    return daily


def to_records(daily: pd.DataFrame) -> list[dict]:
    return [{"date": str(row.date), "value": round(float(row.value), 4)} for row in daily.itertuples()]


# Route clustering: two runs are treated as "the same route" if they start
# within this radius of each other AND cover a similar total distance --
# checked against full-track bounding boxes for a sample of runs, and both
# matched almost exactly for genuinely repeated routes, so no need to
# compare the full GPS shape point-by-point.
ROUTE_START_RADIUS_MI = 0.2
ROUTE_DIST_TOLERANCE_MI = 0.75
ROUTE_DIST_TOLERANCE_PCT = 0.15
MIN_ROUTE_REPEATS = 7  # below this a "cluster" is just a coincidence, not a route run often enough to trend


def _haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _gpx_start_point(gpx_root: Path, gpx_path: str) -> tuple[float, float] | None:
    full_path = gpx_root / gpx_path.lstrip("/")
    if not full_path.exists():
        return None
    pts = ET.parse(full_path).getroot().findall(".//g:trkpt", GPX_NS)
    if not pts:
        return None
    return float(pts[0].get("lat")), float(pts[0].get("lon"))


def cluster_repeated_routes(running: pd.DataFrame, gpx_root: Path | None) -> list[dict]:
    """Groups runs that start in the same place and cover the same
    distance -- almost certainly the same physical route, run again --
    instead of assuming same distance means same route (checked: some
    similar-distance runs turned out to start miles apart). Only routes
    repeated at least MIN_ROUTE_REPEATS times are kept, since a comparison
    across the "same conditions" only means something with enough repeats
    to show a trend."""
    if gpx_root is None:
        return []

    rows = []
    for row in running.itertuples():
        if pd.isna(row.gpx_path) or pd.isna(row.distance_mi):
            continue
        start = _gpx_start_point(gpx_root, row.gpx_path)
        if start is None:
            continue
        rows.append({
            "date": row.start_ts.date(), "distance_mi": row.distance_mi,
            "duration_min": row.duration_min, "lat": start[0], "lon": start[1],
        })
    if not rows:
        return []
    runs = pd.DataFrame(rows).sort_values("date").reset_index(drop=True)

    clusters: list[dict] = []
    cluster_of = {}
    for r in runs.itertuples():
        matched = None
        for ci, c in enumerate(clusters):
            close_enough = _haversine_mi(r.lat, r.lon, c["lat"], c["lon"]) <= ROUTE_START_RADIUS_MI
            same_distance = abs(r.distance_mi - c["dist"]) <= max(ROUTE_DIST_TOLERANCE_MI, ROUTE_DIST_TOLERANCE_PCT * c["dist"])
            if close_enough and same_distance:
                matched = ci
                break
        if matched is None:
            clusters.append({"lat": r.lat, "lon": r.lon, "dist": r.distance_mi, "n": 0})
            matched = len(clusters) - 1
        c = clusters[matched]
        c["n"] += 1
        c["lat"] += (r.lat - c["lat"]) / c["n"]
        c["lon"] += (r.lon - c["lon"]) / c["n"]
        c["dist"] += (r.distance_mi - c["dist"]) / c["n"]
        cluster_of[r.Index] = matched
    runs["cluster"] = runs.index.map(cluster_of)

    qualifying = [ci for ci, c in enumerate(clusters) if c["n"] >= MIN_ROUTE_REPEATS]
    qualifying.sort(key=lambda ci: -clusters[ci]["n"])
    labels = {ci: f"Route {chr(65 + i)} (~{clusters[ci]['dist']:.1f} mi)" for i, ci in enumerate(qualifying)}

    records = []
    for r in runs.itertuples():
        if r.cluster not in labels:
            continue
        records.append({
            "date": str(r.date),
            "route": labels[r.cluster],
            "pace_min_per_mi": round(r.duration_min / r.distance_mi, 4),
            "distance_mi": round(r.distance_mi, 3),
        })
    return records


# Reference heart rate for the "predicted pace at X bpm" chart -- chosen to
# sit in the middle of the real HR-zone config (Z2, just under the Z2/Z3
# boundary), a representative "steady aerobic effort" rather than an easy
# recovery jog or a hard tempo.
REFERENCE_HR_BPM = 150.0

# A run is "steady" (not a workout/intervals) if it spends almost no time in
# the top two zones -- ties directly to the zones the user already reads on
# the pace-by-zone chart, rather than an opaque HR-variance threshold.
STEADY_RUN_MAX_HARD_ZONE_FRACTION = 0.20

MIN_SAMPLES_PER_RUN = 20  # 15s buckets -> 20 samples = 5 minutes, matching the zone chart's own floor.
MIN_HR_RANGE_FOR_REGRESSION = 15.0  # bpm; below this a run's own HR barely moved, so a pace~HR fit is just noise.


def per_run_pace_metrics(hr_pace: pd.DataFrame) -> pd.DataFrame:
    """One row per run: average pace/HR (for an Efficiency Factor -- speed
    per heartbeat, the standard way coaches trend aerobic fitness without
    it being skewed by how hard a given week's runs happened to be), plus a
    per-run linear fit of pace against heart rate so we can read off a
    single 'predicted pace at a fixed reference HR' instead of comparing
    pace only within whichever zone a run happened to spend time in."""
    def summarize(g: pd.DataFrame) -> pd.Series:
        n = len(g)
        avg_hr = float(g["heart_rate"].mean())
        avg_speed_mph = float((60.0 / g["pace_min_per_mi"]).mean())
        hr_min, hr_max = float(g["heart_rate"].min()), float(g["heart_rate"].max())
        hard_zone_fraction = float(g["zone"].isin(["Z4", "Z5"]).mean())

        pred_pace_at_ref_hr = None
        if n >= MIN_SAMPLES_PER_RUN and (hr_max - hr_min) >= MIN_HR_RANGE_FOR_REGRESSION and hr_min <= REFERENCE_HR_BPM <= hr_max:
            slope, intercept = np.polyfit(g["heart_rate"], g["pace_min_per_mi"], 1)
            pred_pace_at_ref_hr = float(slope * REFERENCE_HR_BPM + intercept)

        return pd.Series({
            "date": g["ts"].min().date(),
            "n": n,
            "avg_hr": avg_hr,
            "efficiency_factor": avg_speed_mph / avg_hr * 100,
            "is_steady": hard_zone_fraction <= STEADY_RUN_MAX_HARD_ZONE_FRACTION,
            "pred_pace_at_ref_hr": pred_pace_at_ref_hr,
        })

    return hr_pace.groupby("workout_id").apply(summarize, include_groups=False).reset_index(drop=True)


def build(data_dir: Path, out_path: Path, gpx_root: Path | None):
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
    hr_pace = hr_pace[hr_pace["ts"] < today_cutoff(hr_pace["ts"].dt.tz)]
    grouped = hr_pace.groupby([hr_pace["ts"].dt.date, "zone"])["pace_min_per_mi"].agg(["mean", "count"])
    grouped = grouped.reset_index()
    grouped.columns = ["date", "zone", "avg_pace", "n"]
    pace_by_zone_daily = [
        {"date": str(r.date), "zone": r.zone, "avg_pace": round(float(r.avg_pace), 4), "n": int(r.n)}
        for r in grouped.itertuples()
    ]

    # --- Per-run pace/HR metrics: Efficiency Factor (all runs and steady
    # runs only) and predicted pace at a fixed reference HR -- alternatives
    # to the zone chart that don't fragment when a period's runs didn't
    # touch every zone. One row per run, so same-day runs are averaged
    # together when turned into a daily series (almost always just one). ---
    per_run = per_run_pace_metrics(hr_pace)
    reliable_runs = per_run[per_run["n"] >= MIN_SAMPLES_PER_RUN]

    # --- Same-route comparison: pace on runs that share a start point and
    # distance (almost certainly the same physical loop, controlling for
    # terrain/elevation), instead of any zone- or HR-derived metric. ---
    running_with_distance = running[running["start_ts"] < today_cutoff(running["start_ts"].dt.tz)].copy()
    stats = pd.read_parquet(data_dir / "workout_statistics.parquet")
    run_distance = stats[stats["metric_type"] == "HKQuantityTypeIdentifierDistanceWalkingRunning"][["workout_id", "sum"]]
    run_distance = run_distance.rename(columns={"sum": "distance_mi"})
    running_with_distance = running_with_distance.merge(run_distance, on="workout_id", how="left")
    route_pace = cluster_repeated_routes(running_with_distance, gpx_root)

    def runs_to_daily(df: pd.DataFrame, value_col: str) -> list[dict]:
        df = df.dropna(subset=[value_col])
        daily = df.groupby("date")[value_col].mean().reset_index()
        daily.columns = ["date", "value"]
        return to_records(daily)

    efficiency_factor_daily = runs_to_daily(reliable_runs, "efficiency_factor")
    efficiency_factor_steady_daily = runs_to_daily(reliable_runs[reliable_runs["is_steady"]], "efficiency_factor")
    pace_at_ref_hr_daily = runs_to_daily(per_run, "pred_pace_at_ref_hr")

    # --- Activity rings (already one row per day) ---
    activity = pd.read_parquet(data_dir / "activity_summary.parquet")
    activity["date_ts"] = pd.to_datetime(activity["date"])
    if activity["date_ts"].dt.tz is None:
        activity["date_ts"] = activity["date_ts"].dt.tz_localize("America/New_York")

    active_energy_daily = to_records(daily_mean(activity, "date_ts", "active_energy"))
    exercise_time_daily = to_records(daily_mean(activity, "date_ts", "exercise_time"))
    stand_hours_daily = to_records(daily_mean(activity, "date_ts", "stand_hours"))

    # --- Steps, resting HR, VO2 max (raw records -> daily) ---
    steps = pd.read_parquet(data_dir / "records" / "step_count.parquet", columns=["start_ts", "end_ts", "value", "source_name"])
    steps["value"] = pd.to_numeric(steps["value"], errors="coerce")
    steps_daily = to_records(daily_sum_dedup_sources(steps, "start_ts", "end_ts", "value", "source_name"))

    resting_hr = pd.read_parquet(data_dir / "records" / "resting_heart_rate.parquet", columns=["start_ts", "value"])
    resting_hr["value"] = pd.to_numeric(resting_hr["value"], errors="coerce")
    resting_hr_daily = to_records(daily_mean(resting_hr, "start_ts", "value"))

    vo2max = pd.read_parquet(data_dir / "records" / "vo2_max.parquet", columns=["start_ts", "value"])
    vo2max["value"] = pd.to_numeric(vo2max["value"], errors="coerce")
    vo2max_daily = to_records(daily_mean(vo2max, "start_ts", "value"))

    # --- Calendar: every workout, one row each, for the day-by-day view ---
    calendar_workouts = workouts[workouts["start_ts"] < today_cutoff(workouts["start_ts"].dt.tz)]
    workouts_list = [
        {
            "date": row.start_ts.strftime("%Y-%m-%d"),
            "type": humanize_activity_type(row.activity_type),
            "duration_min": round(float(row.duration_min), 1) if pd.notna(row.duration_min) else None,
        }
        for row in calendar_workouts.itertuples()
    ]

    site_data = {
        "summary": summary,
        "pace_by_zone_daily": pace_by_zone_daily,
        "route_pace": route_pace,
        "efficiency_factor_daily": efficiency_factor_daily,
        "efficiency_factor_steady_daily": efficiency_factor_steady_daily,
        "pace_at_ref_hr_daily": pace_at_ref_hr_daily,
        "active_energy_daily": active_energy_daily,
        "exercise_time_daily": exercise_time_daily,
        "stand_hours_daily": stand_hours_daily,
        "steps_daily": steps_daily,
        "resting_hr_daily": resting_hr_daily,
        "vo2max_daily": vo2max_daily,
        "workouts": workouts_list,
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
    ap.add_argument(
        "--gpx-root", default=None, type=Path,
        help="Directory containing workout-routes/*.gpx (the export.xml folder). "
             "Omit to skip the same-route pace comparison.",
    )
    args = ap.parse_args()
    out_path = args.out or (args.data / "site_data.json")
    build(args.data, out_path, args.gpx_root)


if __name__ == "__main__":
    main()
