import * as Plot from "@observablehq/plot";
import { query, registerParquet } from "./duckdb";
import "./style.css";

const ZONE_ORDER = ["Z1", "Z2", "Z3", "Z4", "Z5"];

// Apple's Heart Rate Zone colors (Fitness app workout summary / Watch
// "Heart Rate Zones" view): blue -> green -> yellow -> orange -> red.
const ZONE_COLORS: Record<string, string> = {
  Z1: "#007AFF",
  Z2: "#34C759",
  Z3: "#FFCC00",
  Z4: "#FF9500",
  Z5: "#FF3B30",
};

type PaceByZoneRow = {
  month: Date;
  zone: string;
  avg_pace: number;
};

let paceByZoneData: PaceByZoneRow[] = [];
let paceViewMode: "graph" | "table" = "graph";

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
  const el = document.querySelector<HTMLDivElement>("#pace-by-zone-view")!;
  el.innerHTML = "";
  const plot = Plot.plot({
    width: Math.min(880, document.body.clientWidth - 48),
    height: 420,
    marginLeft: 60,
    x: { label: null },
    y: { label: "avg pace (min/mi)", grid: true },
    color: {
      label: "HR zone",
      domain: ZONE_ORDER,
      range: ZONE_ORDER.map((z) => ZONE_COLORS[z]),
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
  el.append(plot);
}

function renderPaceByZoneTable(data: PaceByZoneRow[]) {
  const el = document.querySelector<HTMLDivElement>("#pace-by-zone-view")!;

  const months = [...new Set(data.map((r) => r.month.getTime()))].sort((a, b) => a - b);
  const byMonthZone = new Map<string, number>();
  for (const row of data) {
    byMonthZone.set(`${row.month.getTime()}|${row.zone}`, row.avg_pace);
  }

  const fmtMonth = (t: number) =>
    new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short" });
  const fmtPace = (v: number | undefined) => (v === undefined ? "—" : v.toFixed(1));

  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Month</th>
        ${ZONE_ORDER.map((z) => `<th><span class="zone-swatch" style="background:${ZONE_COLORS[z]}"></span>${z}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${months
        .map(
          (t) => `
        <tr>
          <td>${fmtMonth(t)}</td>
          ${ZONE_ORDER.map((z) => `<td>${fmtPace(byMonthZone.get(`${t}|${z}`))}</td>`).join("")}
        </tr>`,
        )
        .join("")}
    </tbody>
  `;
  el.innerHTML = "";
  el.append(table);
}

function renderPaceByZone() {
  if (paceViewMode === "graph") {
    renderPaceByZoneChart(paceByZoneData);
  } else {
    renderPaceByZoneTable(paceByZoneData);
  }
}

function setupPaceViewToggle() {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#pace-view-toggle button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode as "graph" | "table";
      if (mode === paceViewMode) return;
      paceViewMode = mode;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      renderPaceByZone();
    });
  });
}

// ---- Trend charts (Activity rings, Steps, Resting HR, VO2 max) ----

type TrendRange = "month" | "ytd" | "year" | "all";

const RANGE_CONFIG: Record<TrendRange, { bucket: "day" | "week" | "month"; sinceSql: string | null }> = {
  month: { bucket: "day", sinceSql: "current_date - INTERVAL 1 MONTH" },
  ytd: { bucket: "week", sinceSql: "date_trunc('year', current_date)" },
  year: { bucket: "month", sinceSql: "current_date - INTERVAL 1 YEAR" },
  all: { bucket: "month", sinceSql: null },
};

let trendRange: TrendRange = "all";

type TimeSeriesPoint = { period: Date; value: number };

async function loadTimeSeries(
  file: string,
  valueExpr: string,
  agg: "avg" | "sum",
  range: TrendRange,
  dateExpr = "start_ts",
): Promise<TimeSeriesPoint[]> {
  await registerParquet(file);
  const { bucket, sinceSql } = RANGE_CONFIG[range];
  const rows = await query<{ period: string; value: number }>(`
    SELECT
      date_trunc('${bucket}', ${dateExpr}) AS period,
      ${agg}(${valueExpr}) AS value
    FROM read_parquet('${file}')
    WHERE ${valueExpr} IS NOT NULL
      AND ${dateExpr} <= current_date  -- a handful of Apple Health exports carry stray future-dated placeholder rows
      ${sinceSql ? `AND ${dateExpr} >= ${sinceSql}` : ""}
    GROUP BY period
    ORDER BY period
  `);
  return rows.map((r) => ({ period: new Date(r.period), value: r.value }));
}

function renderTimeSeries(containerId: string, data: TimeSeriesPoint[], yLabel: string) {
  const el = document.querySelector<HTMLDivElement>(`#${containerId}`)!;
  if (data.length === 0) {
    el.innerHTML = `<p class="muted">No data in this range.</p>`;
    return;
  }
  const plot = Plot.plot({
    width: Math.min(880, document.body.clientWidth - 48),
    height: 220,
    marginLeft: 60,
    x: { label: null },
    y: { label: yLabel, grid: true },
    marks: [
      Plot.lineY(data, { x: "period", y: "value", curve: "monotone-x" }),
      Plot.dot(data, { x: "period", y: "value", r: 2.5 }),
    ],
  });
  el.innerHTML = "";
  el.append(plot);
}

const TREND_CHARTS: Array<{
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

// DuckDB-WASM only tolerates one registerFileURL/query in flight at a time
// here (see duckdb.ts), so these run sequentially -- plenty fast for this
// data size, and each chart appears as soon as its own data is ready.
async function renderTrendCharts(range: TrendRange) {
  for (const chart of TREND_CHARTS) {
    const data = await loadTimeSeries(chart.file, chart.valueExpr, chart.agg, range, chart.dateExpr);
    renderTimeSeries(chart.containerId, data, chart.yLabel);
  }
}

function setupTrendRangeSelector() {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#trend-range-selector button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const range = btn.dataset.range as TrendRange;
      if (range === trendRange) return;
      trendRange = range;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      await renderTrendCharts(trendRange);
    });
  });
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
  setupPaceViewToggle();
  setupTrendRangeSelector();
  try {
    const summary = await loadSummary();
    summaryEl.textContent = summary;
    paceByZoneData = await loadPaceByZone();
    renderPaceByZone();
    await renderTrendCharts(trendRange);
  } catch (err) {
    console.error(err);
    summaryEl.textContent = "Failed to load data — see console.";
  }
}

main();
