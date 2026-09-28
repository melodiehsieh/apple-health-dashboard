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

type MonthlyPoint = { month: Date; value: number };

async function loadMonthlySeries(
  file: string,
  valueExpr: string,
  agg: "avg" | "sum",
  dateExpr = "start_ts",
): Promise<MonthlyPoint[]> {
  await registerParquet(file);
  const rows = await query<{ month: string; value: number }>(`
    SELECT
      date_trunc('month', ${dateExpr}) AS month,
      ${agg}(${valueExpr}) AS value
    FROM read_parquet('${file}')
    WHERE ${valueExpr} IS NOT NULL
      AND ${dateExpr} <= current_date  -- a handful of Apple Health exports carry stray future-dated placeholder rows
    GROUP BY month
    ORDER BY month
  `);
  return rows.map((r) => ({ month: new Date(r.month), value: r.value }));
}

function renderMonthlySeries(containerId: string, data: MonthlyPoint[], yLabel: string) {
  const el = document.querySelector<HTMLDivElement>(`#${containerId}`)!;
  if (data.length === 0) {
    el.innerHTML = `<p class="muted">No data.</p>`;
    return;
  }
  const plot = Plot.plot({
    width: Math.min(880, document.body.clientWidth - 48),
    height: 220,
    marginLeft: 60,
    x: { label: null },
    y: { label: yLabel, grid: true },
    marks: [
      Plot.lineY(data, { x: "month", y: "value", curve: "monotone-x" }),
      Plot.dot(data, { x: "month", y: "value", r: 2.5 }),
    ],
  });
  el.innerHTML = "";
  el.append(plot);
}

// DuckDB-WASM's virtual filesystem misbehaves ("no magic bytes found") when
// several registerFileBuffer + query calls race concurrently, so these run
// one at a time -- plenty fast for this data size, and it renders each
// chart as soon as its own data is ready instead of waiting on the rest.
const BASIC_ANALYTICS_CHARTS: Array<{
  containerId: string;
  file: string;
  valueExpr: string;
  agg: "avg" | "sum";
  dateExpr?: string;
  yLabel: string;
}> = [
  {
    containerId: "active-energy-chart",
    file: "activity_summary.parquet",
    valueExpr: "active_energy",
    agg: "avg",
    dateExpr: "CAST(date AS DATE)",
    yLabel: "active energy (cal/day)",
  },
  {
    containerId: "exercise-time-chart",
    file: "activity_summary.parquet",
    valueExpr: "exercise_time",
    agg: "avg",
    dateExpr: "CAST(date AS DATE)",
    yLabel: "exercise time (min/day)",
  },
  {
    containerId: "stand-hours-chart",
    file: "activity_summary.parquet",
    valueExpr: "stand_hours",
    agg: "avg",
    dateExpr: "CAST(date AS DATE)",
    yLabel: "stand hours/day",
  },
  {
    containerId: "steps-chart",
    file: "step_count.parquet",
    valueExpr: "CAST(value AS DOUBLE)",
    agg: "sum",
    yLabel: "total steps",
  },
  {
    containerId: "body-mass-chart",
    file: "body_mass.parquet",
    valueExpr: "CAST(value AS DOUBLE)",
    agg: "avg",
    yLabel: "weight (lb)",
  },
  {
    containerId: "resting-hr-chart",
    file: "resting_heart_rate.parquet",
    valueExpr: "CAST(value AS DOUBLE)",
    agg: "avg",
    yLabel: "resting HR (bpm)",
  },
  {
    containerId: "vo2-max-chart",
    file: "vo2_max.parquet",
    valueExpr: "CAST(value AS DOUBLE)",
    agg: "avg",
    yLabel: "VO2 max (mL/min·kg)",
  },
];

async function renderBasicAnalytics() {
  for (const chart of BASIC_ANALYTICS_CHARTS) {
    const data = await loadMonthlySeries(chart.file, chart.valueExpr, chart.agg, chart.dateExpr);
    renderMonthlySeries(chart.containerId, data, chart.yLabel);
  }
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
    const summary = await loadSummary();
    summaryEl.textContent = summary;
    const paceByZone = await loadPaceByZone();
    renderPaceByZoneChart(paceByZone);
    await renderBasicAnalytics();
  } catch (err) {
    console.error(err);
    summaryEl.textContent = "Failed to load data — see console.";
  }
}

main();
