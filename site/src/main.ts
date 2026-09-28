import * as Plot from "@observablehq/plot";
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

// ---- Site data: precomputed server-side (in the pipeline, at build time)
// into one small JSON file. No client-side query engine -- the pipeline's
// build_site_data.py already did all the aggregation to daily granularity;
// this file just re-buckets those small daily arrays into week/month
// windows in plain JS for the range selectors below. ----

type DailyPoint = { date: string; value: number };
type DailyPaceByZone = { date: string; zone: string; avg_pace: number; n: number };

type SiteData = {
  summary: { total_workouts: number; running_workouts: number; first_ts: string; last_ts: string };
  pace_by_zone_daily: DailyPaceByZone[];
  active_energy_daily: DailyPoint[];
  exercise_time_daily: DailyPoint[];
  stand_hours_daily: DailyPoint[];
  steps_daily: DailyPoint[];
  resting_hr_daily: DailyPoint[];
  vo2max_daily: DailyPoint[];
};

function parseLocalDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

// ---- Shared range selector (Past Month / YTD / 1 Year / All Time) ----
// Mirrors Apple's own range picker; granularity adapts per range so a
// short range isn't one flat bucket and a long range isn't thousands of
// daily points.

type Range = "month" | "ytd" | "year" | "all";
type Bucket = "day" | "week" | "month";

const RANGE_CONFIG: Record<Range, { bucket: Bucket; since: () => Date | null }> = {
  month: {
    bucket: "day",
    since: () => {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      return d;
    },
  },
  ytd: {
    bucket: "week",
    since: () => new Date(new Date().getFullYear(), 0, 1),
  },
  year: {
    bucket: "month",
    since: () => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      return d;
    },
  },
  all: { bucket: "month", since: () => null },
};

const DEFAULT_RANGE: Range = "ytd";

function bucketStart(d: Date, bucket: Bucket): Date {
  if (bucket === "day") {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  if (bucket === "month") {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  // week: Monday-start, to match how weeks read elsewhere
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return monday;
}

function formatPeriod(d: Date, bucket: Bucket): string {
  if (bucket === "month") {
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function setupRangeSelector(containerId: string, onChange: (range: Range) => void): Range {
  const buttons = document.querySelectorAll<HTMLButtonElement>(`#${containerId} button`);
  const current = DEFAULT_RANGE;
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const range = btn.dataset.range as Range;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      onChange(range);
    });
  });
  return current;
}

// ---- Running pace by heart-rate zone ----

type PaceByZoneRow = { period: Date; zone: string; avg_pace: number };

// A period/zone average from under ~5 minutes of data is noisy enough to
// mislead (found via a real case: 22 samples/5.5 min of Zone 1 in one
// month averaged faster than Zone 2-4 purely from small-N noise, distinct
// from the sensor-dropout and stale-forward-fill issues fixed upstream in
// the pipeline). 15s buckets -> 20 samples = 5 minutes.
const MIN_SAMPLES_PER_ZONE_PERIOD = 20;

function aggregatePaceByZone(daily: DailyPaceByZone[], range: Range): PaceByZoneRow[] {
  const { bucket, since } = RANGE_CONFIG[range];
  const sinceDate = since();
  const sums = new Map<string, { period: Date; zone: string; weightedSum: number; n: number }>();
  for (const row of daily) {
    const date = parseLocalDate(row.date);
    if (sinceDate && date < sinceDate) continue;
    const period = bucketStart(date, bucket);
    const key = `${period.getTime()}|${row.zone}`;
    const existing = sums.get(key);
    if (existing) {
      existing.weightedSum += row.avg_pace * row.n;
      existing.n += row.n;
    } else {
      sums.set(key, { period, zone: row.zone, weightedSum: row.avg_pace * row.n, n: row.n });
    }
  }
  return [...sums.values()]
    .filter((g) => g.n >= MIN_SAMPLES_PER_ZONE_PERIOD)
    .map((g) => ({ period: g.period, zone: g.zone, avg_pace: g.weightedSum / g.n }))
    .sort((a, b) => a.period.getTime() - b.period.getTime() || a.zone.localeCompare(b.zone));
}

function renderPaceByZoneChart(data: PaceByZoneRow[]) {
  const el = document.querySelector<HTMLDivElement>("#pace-by-zone-view")!;
  el.innerHTML = "";
  if (data.length === 0) {
    el.innerHTML = `<p class="muted">No data in this range.</p>`;
    return;
  }
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
      Plot.lineY(data, { x: "period", y: "avg_pace", stroke: "zone", curve: "monotone-x" }),
      Plot.dot(data, { x: "period", y: "avg_pace", stroke: "zone", r: 2.5 }),
    ],
  });
  el.append(plot);
}

function renderPaceByZoneTable(data: PaceByZoneRow[], bucket: Bucket) {
  const el = document.querySelector<HTMLDivElement>("#pace-by-zone-view")!;

  if (data.length === 0) {
    el.innerHTML = `<p class="muted">No data in this range.</p>`;
    return;
  }

  const periods = [...new Set(data.map((r) => r.period.getTime()))].sort((a, b) => a - b);
  const byPeriodZone = new Map<string, number>();
  for (const row of data) {
    byPeriodZone.set(`${row.period.getTime()}|${row.zone}`, row.avg_pace);
  }

  const fmtPace = (v: number | undefined) => (v === undefined ? "—" : v.toFixed(1));

  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>${bucket === "month" ? "Month" : bucket === "week" ? "Week of" : "Date"}</th>
        ${ZONE_ORDER.map((z) => `<th><span class="zone-swatch" style="background:${ZONE_COLORS[z]}"></span>${z}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${periods
        .map(
          (t) => `
        <tr>
          <td>${formatPeriod(new Date(t), bucket)}</td>
          ${ZONE_ORDER.map((z) => `<td>${fmtPace(byPeriodZone.get(`${t}|${z}`))}</td>`).join("")}
        </tr>`,
        )
        .join("")}
    </tbody>
  `;
  el.innerHTML = "";
  el.append(table);
}

let paceViewMode: "graph" | "table" = "graph";
let paceByZoneData: PaceByZoneRow[] = [];
let paceBucket: Bucket = RANGE_CONFIG[DEFAULT_RANGE].bucket;

function renderPaceByZone() {
  if (paceViewMode === "graph") {
    renderPaceByZoneChart(paceByZoneData);
  } else {
    renderPaceByZoneTable(paceByZoneData, paceBucket);
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

function loadAndRenderPaceByZone(data: SiteData, range: Range) {
  paceBucket = RANGE_CONFIG[range].bucket;
  paceByZoneData = aggregatePaceByZone(data.pace_by_zone_daily, range);
  renderPaceByZone();
}

// ---- Trend charts (Activity rings, Steps, Resting HR, VO2 max) ----

type TimeSeriesPoint = { period: Date; value: number };

function aggregateTimeSeries(daily: DailyPoint[], range: Range, agg: "avg" | "sum"): TimeSeriesPoint[] {
  const { bucket, since } = RANGE_CONFIG[range];
  const sinceDate = since();
  const sums = new Map<string, { period: Date; sum: number; count: number }>();
  for (const row of daily) {
    const date = parseLocalDate(row.date);
    if (sinceDate && date < sinceDate) continue;
    const period = bucketStart(date, bucket);
    const key = String(period.getTime());
    const existing = sums.get(key);
    if (existing) {
      existing.sum += row.value;
      existing.count += 1;
    } else {
      sums.set(key, { period, sum: row.value, count: 1 });
    }
  }
  return [...sums.values()]
    .map((g) => ({ period: g.period, value: agg === "sum" ? g.sum : g.sum / g.count }))
    .sort((a, b) => a.period.getTime() - b.period.getTime());
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
  key: keyof SiteData;
  agg: "avg" | "sum";
  yLabel: string;
}> = [
  { containerId: "active-energy-chart", key: "active_energy_daily", agg: "avg", yLabel: "active energy (cal/day)" },
  { containerId: "exercise-time-chart", key: "exercise_time_daily", agg: "avg", yLabel: "exercise time (min/day)" },
  { containerId: "stand-hours-chart", key: "stand_hours_daily", agg: "avg", yLabel: "stand hours/day" },
  { containerId: "steps-chart", key: "steps_daily", agg: "sum", yLabel: "total steps" },
  { containerId: "resting-hr-chart", key: "resting_hr_daily", agg: "avg", yLabel: "resting HR (bpm)" },
  { containerId: "vo2-max-chart", key: "vo2max_daily", agg: "avg", yLabel: "VO2 max (mL/min·kg)" },
];

function renderTrendCharts(data: SiteData, range: Range) {
  for (const chart of TREND_CHARTS) {
    const daily = data[chart.key] as DailyPoint[];
    const series = aggregateTimeSeries(daily, range, chart.agg);
    renderTimeSeries(chart.containerId, series, chart.yLabel);
  }
}

function formatSummary(s: SiteData["summary"]): string {
  const fmt = (t: string) => new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short" });
  return `${s.total_workouts} workouts (${s.running_workouts} runs) from ${fmt(s.first_ts)} to ${fmt(s.last_ts)}`;
}

let paceRange: Range = DEFAULT_RANGE;
let trendRange: Range = DEFAULT_RANGE;
let siteData: SiteData | null = null;

async function main() {
  const summaryEl = document.querySelector<HTMLParagraphElement>("#summary")!;

  setupPaceViewToggle();
  paceRange = setupRangeSelector("pace-range-selector", (range) => {
    paceRange = range;
    if (siteData) loadAndRenderPaceByZone(siteData, paceRange);
  });
  trendRange = setupRangeSelector("trend-range-selector", (range) => {
    trendRange = range;
    if (siteData) renderTrendCharts(siteData, trendRange);
  });

  let data: SiteData;
  try {
    const res = await fetch("/data/site_data.json");
    if (!res.ok) throw new Error(`Failed to fetch site_data.json: ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(err);
    summaryEl.textContent = "Failed to load data — see console.";
    return;
  }
  siteData = data;

  summaryEl.textContent = formatSummary(data.summary);
  loadAndRenderPaceByZone(data, paceRange);
  renderTrendCharts(data, trendRange);
}

main();
