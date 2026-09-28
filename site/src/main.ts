import * as Plot from "@observablehq/plot";
import { query, registerParquet } from "./duckdb";
import "./style.css";

const ZONE_ORDER = ["Z1", "Z2", "Z3", "Z4", "Z5"];

type PaceByZoneRow = {
  month: Date;
  zone: string;
  avg_pace: number;
};

async function loadPaceByZone(): Promise<PaceByZoneRow[]> {
  await registerParquet("workout_hr_pace.parquet");
  const rows = await query<{ month: string; zone: string; avg_pace: number }>(`
    SELECT
      date_trunc('month', ts) AS month,
      zone,
      avg(pace_min_per_mi) AS avg_pace
    FROM read_parquet('workout_hr_pace.parquet')
    WHERE zone IS NOT NULL AND pace_min_per_mi IS NOT NULL
    GROUP BY month, zone
    ORDER BY month, zone
  `);
  return rows.map((r) => ({
    month: new Date(r.month),
    zone: r.zone,
    avg_pace: r.avg_pace,
  }));
}

function renderPaceByZoneChart(data: PaceByZoneRow[]) {
  const plot = Plot.plot({
    width: Math.min(880, document.body.clientWidth - 48),
    height: 420,
    marginLeft: 60,
    x: { label: null },
    y: { label: "avg pace (min/mi)", grid: true },
    color: {
      label: "HR zone",
      domain: ZONE_ORDER,
      legend: true,
    },
    marks: [
      Plot.lineY(data, {
        x: "month",
        y: "avg_pace",
        stroke: "zone",
        curve: "monotone-x",
      }),
      Plot.dot(data, {
        x: "month",
        y: "avg_pace",
        stroke: "zone",
        r: 2.5,
      }),
    ],
  });
  const el = document.querySelector<HTMLDivElement>("#pace-by-zone-chart")!;
  el.innerHTML = "";
  el.append(plot);
}

async function loadSummary(): Promise<string> {
  await registerParquet("workouts.parquet");
  const [row] = await query<{
    total: number;
    running: number;
    first_ts: string;
    last_ts: string;
  }>(`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE activity_type = 'HKWorkoutActivityTypeRunning') AS running,
      min(start_ts) AS first_ts,
      max(start_ts) AS last_ts
    FROM read_parquet('workouts.parquet')
  `);
  const fmt = (s: string) =>
    new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short" });
  return `${row.total} workouts (${row.running} runs) from ${fmt(row.first_ts)} to ${fmt(row.last_ts)}`;
}

async function main() {
  const summaryEl = document.querySelector<HTMLParagraphElement>("#summary")!;
  try {
    const [summary, paceByZone] = await Promise.all([
      loadSummary(),
      loadPaceByZone(),
    ]);
    summaryEl.textContent = summary;
    renderPaceByZoneChart(paceByZone);
  } catch (err) {
    console.error(err);
    summaryEl.textContent = "Failed to load data — see console.";
  }
}

main();
