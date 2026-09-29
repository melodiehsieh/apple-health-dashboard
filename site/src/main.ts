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
type WorkoutEntry = { date: string; type: string; duration_min: number | null; distance_mi: number | null };
type RoutePaceRow = { date: string; route: string; pace_min_per_mi: number; distance_mi: number };

type SiteData = {
  summary: { total_workouts: number; running_workouts: number; first_ts: string; last_ts: string };
  pace_by_zone_daily: DailyPaceByZone[];
  route_pace: RoutePaceRow[];
  running_miles_daily: { date: string; distance_mi: number }[];
  efficiency_factor_daily: DailyPoint[];
  efficiency_factor_steady_daily: DailyPoint[];
  pace_at_ref_hr_daily: DailyPoint[];
  active_energy_daily: DailyPoint[];
  exercise_time_daily: DailyPoint[];
  stand_hours_daily: DailyPoint[];
  steps_daily: DailyPoint[];
  resting_hr_daily: DailyPoint[];
  vo2max_daily: DailyPoint[];
  workouts: WorkoutEntry[];
};

function parseLocalDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

function fmtTipDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function fmtTipValue(v: number): string {
  return v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);
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

const CHART_STYLE = {
  fontFamily: '"DM Mono", monospace',
  fontSize: "10px",
  color: "#7A6F5C",
};

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
    style: CHART_STYLE,
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
      Plot.tip(
        data,
        Plot.pointer({
          x: "period",
          y: "avg_pace",
          title: (d: PaceByZoneRow) => `${fmtTipDate(d.period)}\n${d.zone}: ${d.avg_pace.toFixed(1)} min/mi`,
        }),
      ),
    ],
  });
  el.append(plot);
}

function renderPaceByZoneTable(data: PaceByZoneRow[], bucket: Bucket) {
  const el = document.querySelector<HTMLDivElement>("#pace-by-zone-table")!;

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

let paceByZoneData: PaceByZoneRow[] = [];
let paceBucket: Bucket = RANGE_CONFIG[DEFAULT_RANGE].bucket;

function renderPaceByZone() {
  renderPaceByZoneChart(paceByZoneData);
  renderPaceByZoneTable(paceByZoneData, paceBucket);
}

function loadAndRenderPaceByZone(data: SiteData, range: Range) {
  paceBucket = RANGE_CONFIG[range].bucket;
  paceByZoneData = aggregatePaceByZone(data.pace_by_zone_daily, range);
  renderPaceByZone();
}

// ---- Alternatives to the zone chart: per-run metrics that don't
// fragment when a period's runs didn't happen to touch every zone. ----

const REFERENCE_HR_BPM = 150;

const PACE_TREND_CHARTS: Array<{ containerId: string; key: keyof SiteData; yLabel: string }> = [
  { containerId: "ef-chart", key: "efficiency_factor_daily", yLabel: "efficiency factor (speed ÷ HR ×100)" },
  { containerId: "pace-ref-hr-chart", key: "pace_at_ref_hr_daily", yLabel: `predicted pace at ${REFERENCE_HR_BPM} bpm (min/mi)` },
  { containerId: "ef-steady-chart", key: "efficiency_factor_steady_daily", yLabel: "efficiency factor, easy runs only (speed ÷ HR ×100)" },
];

function renderPaceTrendCharts(data: SiteData, range: Range) {
  for (const chart of PACE_TREND_CHARTS) {
    const daily = data[chart.key] as DailyPoint[];
    const series = aggregateTimeSeries(daily, range, "avg");
    renderTimeSeries(chart.containerId, series, chart.yLabel);
  }
}

// ---- Same-route comparison: every run of a route repeated often enough
// to trend. One route selected at a time (left-tab list), rather than all
// routes on one shared scale, since routes run at very different paces
// otherwise squish each other's detail flat. ----

type RoutePoint = RoutePaceRow & { dateObj: Date };
type RouteMeta = { label: string; shortLabel: string; rows: RoutePoint[]; avgDistance: number; startLabel: string; endLabel: string };

let routeMetas: RouteMeta[] = [];
let selectedRoute: string | null = null;

function buildRouteMetas(data: SiteData): RouteMeta[] {
  const rows: RoutePoint[] = data.route_pace.map((r) => ({ ...r, dateObj: parseLocalDate(r.date) }));
  const byRoute = new Map<string, RoutePoint[]>();
  for (const r of rows) {
    const list = byRoute.get(r.route) ?? [];
    list.push(r);
    byRoute.set(r.route, list);
  }
  const fmtMonYr = (d: Date) => `${d.toLocaleDateString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
  return [...byRoute.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => {
      const sorted = [...list].sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
      const avgDistance = list.reduce((s, r) => s + r.distance_mi, 0) / list.length;
      return {
        label,
        shortLabel: label.replace(/\s*\(.*\)/, ""),
        rows: sorted,
        avgDistance,
        startLabel: fmtMonYr(sorted[0].dateObj),
        endLabel: fmtMonYr(sorted[sorted.length - 1].dateObj),
      };
    });
}

function renderRouteChart(meta: RouteMeta) {
  const el = document.querySelector<HTMLDivElement>("#route-pace-chart")!;
  el.innerHTML = "";
  const plot = Plot.plot({
    width: Math.min(700, document.body.clientWidth - 48),
    height: 320,
    marginLeft: 60,
    style: CHART_STYLE,
    x: { label: null },
    y: { label: "pace (min/mi)", grid: true },
    marks: [
      Plot.lineY(meta.rows, { x: "dateObj", y: "pace_min_per_mi", stroke: "#3E7C7B", curve: "monotone-x" }),
      Plot.dot(meta.rows, { x: "dateObj", y: "pace_min_per_mi", stroke: "#3E7C7B", fill: "#3E7C7B", r: 3 }),
      Plot.tip(
        meta.rows,
        Plot.pointerX({
          x: "dateObj",
          y: "pace_min_per_mi",
          title: (d: RoutePoint) => `${fmtTipDate(d.dateObj)}\n${d.pace_min_per_mi.toFixed(1)} min/mi (${d.distance_mi.toFixed(2)} mi)`,
        }),
      ),
    ],
  });
  el.append(plot);
}

function renderRouteTabs() {
  const el = document.querySelector<HTMLDivElement>("#route-tabs")!;
  el.innerHTML = routeMetas
    .map(
      (m) => `
      <button class="route-tab${m.label === selectedRoute ? " active" : ""}" data-route="${m.label}">
        <b>${m.shortLabel}</b>
        <span>~${m.avgDistance.toFixed(1)} mi</span>
        <span>${m.startLabel} &ndash; ${m.endLabel}</span>
      </button>`,
    )
    .join("");
  el.querySelectorAll<HTMLButtonElement>(".route-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRoute = btn.dataset.route!;
      renderRouteTabs();
      renderRouteChart(routeMetas.find((m) => m.label === selectedRoute)!);
    });
  });
}

function renderRouteComparison(data: SiteData) {
  routeMetas = buildRouteMetas(data);
  const tabsEl = document.querySelector<HTMLDivElement>("#route-tabs")!;
  const chartEl = document.querySelector<HTMLDivElement>("#route-pace-chart")!;
  if (routeMetas.length === 0) {
    tabsEl.innerHTML = "";
    chartEl.innerHTML = `<p class="muted">No routes repeated often enough yet.</p>`;
    return;
  }
  selectedRoute = routeMetas[0].label;
  renderRouteTabs();
  renderRouteChart(routeMetas[0]);
}

// ---- Run frequency/volume: bar charts of run count and total mileage
// per period. Always monthly, except Past Month, which buckets by week
// (not day, like every other chart's Past Month view) since a single
// day's bar is either "1 run" or empty and isn't useful at that
// granularity. ----

function runsChartBucket(range: Range): Bucket {
  return range === "month" ? "week" : "month";
}

function renderBarChart(containerId: string, series: TimeSeriesPoint[], yLabel: string, bucket: Bucket, fmt: (v: number) => string) {
  const el = document.querySelector<HTMLDivElement>(`#${containerId}`)!;
  el.innerHTML = "";
  if (series.length === 0) {
    el.innerHTML = `<p class="muted">No data in this range.</p>`;
    return;
  }
  const plot = Plot.plot({
    width: Math.min(880, document.body.clientWidth - 48),
    height: 220,
    marginLeft: 60,
    style: CHART_STYLE,
    x: { label: null, interval: bucket === "month" ? "month" : "week" },
    y: { label: yLabel, grid: true },
    marks: [
      Plot.barY(series, { x: "period", y: "value", fill: "#3E7C7B" }),
      Plot.tip(
        series,
        Plot.pointerX({
          x: "period",
          y: "value",
          title: (d: TimeSeriesPoint) => `${formatPeriod(d.period, bucket)}\n${yLabel}: ${fmt(d.value)}`,
        }),
      ),
    ],
  });
  el.append(plot);
}

function renderRunsVolumeCharts(data: SiteData, range: Range) {
  const bucket = runsChartBucket(range);
  const runsAsDaily: DailyPoint[] = data.running_miles_daily.map((r) => ({ date: r.date, value: 1 }));
  const milesAsDaily: DailyPoint[] = data.running_miles_daily.map((r) => ({ date: r.date, value: r.distance_mi }));
  renderBarChart("runs-count-chart", aggregateTimeSeries(runsAsDaily, range, "sum", bucket), "runs", bucket, (v) => Math.round(v).toString());
  renderBarChart("runs-miles-chart", aggregateTimeSeries(milesAsDaily, range, "sum", bucket), "miles", bucket, (v) => v.toFixed(1));
}

// ---- Trend charts (Activity rings, Steps, Resting HR, VO2 max) ----

type TimeSeriesPoint = { period: Date; value: number };

function aggregateTimeSeries(daily: DailyPoint[], range: Range, agg: "avg" | "sum", bucketOverride?: Bucket): TimeSeriesPoint[] {
  const { bucket: rangeBucket, since } = RANGE_CONFIG[range];
  const bucket = bucketOverride ?? rangeBucket;
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

// Apple's own Activity ring colors (Move/Exercise/Stand), so these charts
// read as the same three metrics from the Activity app rather than
// arbitrary chart colors.
const ACTIVITY_RING_COLORS: Record<string, string> = {
  move: "#FA114F",
  exercise: "#92E82A",
  stand: "#1EEAEA",
};

function renderTimeSeries(containerId: string, data: TimeSeriesPoint[], yLabel: string, color?: string) {
  const el = document.querySelector<HTMLDivElement>(`#${containerId}`)!;
  if (data.length === 0) {
    el.innerHTML = `<p class="muted">No data in this range.</p>`;
    return;
  }
  const plot = Plot.plot({
    width: Math.min(880, document.body.clientWidth - 48),
    height: 220,
    marginLeft: 60,
    style: CHART_STYLE,
    x: { label: null },
    y: { label: yLabel, grid: true },
    marks: [
      Plot.lineY(data, { x: "period", y: "value", curve: "monotone-x", stroke: color }),
      Plot.dot(data, { x: "period", y: "value", r: 2.5, stroke: color, fill: color }),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "period",
          y: "value",
          title: (d: TimeSeriesPoint) => `${fmtTipDate(d.period)}\n${yLabel}: ${fmtTipValue(d.value)}`,
        }),
      ),
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
  color?: string;
}> = [
  { containerId: "active-energy-chart", key: "active_energy_daily", agg: "avg", yLabel: "active energy (cal/day)", color: ACTIVITY_RING_COLORS.move },
  { containerId: "exercise-time-chart", key: "exercise_time_daily", agg: "avg", yLabel: "exercise time (min/day)", color: ACTIVITY_RING_COLORS.exercise },
  { containerId: "stand-hours-chart", key: "stand_hours_daily", agg: "avg", yLabel: "stand hours/day", color: ACTIVITY_RING_COLORS.stand },
  { containerId: "steps-chart", key: "steps_daily", agg: "avg", yLabel: "steps/day" },
  { containerId: "resting-hr-chart", key: "resting_hr_daily", agg: "avg", yLabel: "resting HR (bpm)" },
  { containerId: "vo2-max-chart", key: "vo2max_daily", agg: "avg", yLabel: "VO2 max (mL/min·kg)" },
];

function renderTrendCharts(data: SiteData, range: Range) {
  for (const chart of TREND_CHARTS) {
    const daily = data[chart.key] as DailyPoint[];
    const series = aggregateTimeSeries(daily, range, chart.agg);
    renderTimeSeries(chart.containerId, series, chart.yLabel, chart.color);
  }
}

// ---- Time summary: total time (and distance, for Walking/Running) per
// exact workout type over a browsable week/month/year, instead of a
// fixed range selector -- reads more like "how much of my time went where"
// than a trend chart. ----

type SummaryPeriod = "week" | "month" | "year";
let summaryPeriodType: SummaryPeriod = "month";
let summaryAnchor = new Date();

function periodBounds(anchor: Date, type: SummaryPeriod): { start: Date; end: Date } {
  if (type === "week") {
    const day = anchor.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday-start, matching bucketStart's convention
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + diff);
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
  }
  if (type === "month") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    return { start, end: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) };
  }
  const start = new Date(anchor.getFullYear(), 0, 1);
  return { start, end: new Date(anchor.getFullYear() + 1, 0, 1) };
}

function shiftPeriod(anchor: Date, type: SummaryPeriod, dir: 1 | -1): Date {
  if (type === "week") return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * dir);
  if (type === "month") return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  return new Date(anchor.getFullYear() + dir, 0, 1);
}

function formatPeriodLabel(anchor: Date, type: SummaryPeriod): string {
  const { start, end } = periodBounds(anchor, type);
  if (type === "month") return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  if (type === "year") return String(start.getFullYear());
  const endInclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  const sameMonth = start.getMonth() === endInclusive.getMonth();
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = endInclusive.toLocaleDateString("en-US", sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
  return `${startStr}–${endStr}, ${start.getFullYear()}`;
}

function renderTimeSummary() {
  const { start, end } = periodBounds(summaryAnchor, summaryPeriodType);
  document.querySelector<HTMLSpanElement>("#summary-period-label")!.textContent = formatPeriodLabel(summaryAnchor, summaryPeriodType);

  const byType = new Map<string, { duration: number; distance: number; hasDistance: boolean }>();
  for (const [dateStr, items] of workoutsByDate) {
    const d = parseLocalDate(dateStr);
    if (d < start || d >= end) continue;
    for (const w of items) {
      const cur = byType.get(w.type) ?? { duration: 0, distance: 0, hasDistance: false };
      cur.duration += w.duration_min ?? 0;
      if ((w.type === "Walking" || w.type === "Running") && w.distance_mi != null) {
        cur.distance += w.distance_mi;
        cur.hasDistance = true;
      }
      byType.set(w.type, cur);
    }
  }

  const el = document.querySelector<HTMLDivElement>("#summary-table")!;
  const rows = [...byType.entries()].sort((a, b) => b[1].duration - a[1].duration);
  if (rows.length === 0) {
    el.innerHTML = `<p class="muted">No workouts in this period.</p>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead><tr><th>Activity</th><th>Time</th><th>Distance</th></tr></thead>
    <tbody>
      ${rows
        .map(
          ([type, v]) => `
        <tr>
          <td>${type}</td>
          <td>${(v.duration / 60).toFixed(1)} hrs</td>
          <td>${v.hasDistance ? v.distance.toFixed(1) + " mi" : "—"}</td>
        </tr>`,
        )
        .join("")}
    </tbody>
  `;
  el.innerHTML = "";
  el.append(table);
}

function setupTimeSummary(data: SiteData) {
  const maxDateStr = data.workouts.reduce(
    (max, w) => (w.date > max ? w.date : max),
    data.workouts[0]?.date ?? new Date().toISOString().slice(0, 10),
  );
  summaryAnchor = parseLocalDate(maxDateStr);

  document.querySelectorAll<HTMLButtonElement>("#summary-period-type button").forEach((btn) => {
    btn.addEventListener("click", () => {
      summaryPeriodType = btn.dataset.period as SummaryPeriod;
      document.querySelectorAll("#summary-period-type button").forEach((b) => b.classList.toggle("active", b === btn));
      renderTimeSummary();
    });
  });
  document.querySelector("#summary-prev")!.addEventListener("click", () => {
    summaryAnchor = shiftPeriod(summaryAnchor, summaryPeriodType, -1);
    renderTimeSummary();
  });
  document.querySelector("#summary-next")!.addEventListener("click", () => {
    summaryAnchor = shiftPeriod(summaryAnchor, summaryPeriodType, 1);
    renderTimeSummary();
  });

  renderTimeSummary();
}

// ---- Personal records: hand-maintained (Apple Health has no 1RM data).
// Stored in Cloudflare KV via a Pages Function (functions/api/prs.ts),
// logged from /log-pr.html on your phone -- no code changes or redeploys
// needed to add one. ----

type PRRecord = { id: string; exercise: string; weight_lbs: number; reps: number; date: string };

async function renderPRs() {
  const el = document.querySelector<HTMLDivElement>("#prs-table")!;
  let records: PRRecord[];
  try {
    const res = await fetch("/api/prs");
    if (!res.ok) throw new Error(`prs fetch failed: ${res.status}`);
    records = await res.json();
  } catch (err) {
    console.error(err);
    el.innerHTML = `<p class="muted">Couldn't load PRs — see console.</p>`;
    return;
  }
  if (records.length === 0) {
    el.innerHTML = `<p class="muted">No PRs logged yet — log one at <a href="/log-pr.html">/log-pr.html</a> and it'll show up here.</p>`;
    return;
  }
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead><tr><th>Exercise</th><th>Weight</th><th>Reps</th><th>Date</th></tr></thead>
    <tbody>
      ${sorted
        .map(
          (r) => `
        <tr>
          <td>${r.exercise}</td>
          <td>${r.weight_lbs} lb</td>
          <td>${r.reps}</td>
          <td>${parseLocalDate(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
        </tr>`,
        )
        .join("")}
    </tbody>
  `;
  el.innerHTML = "";
  el.append(table);
}

// ---- Top-level tabs ----

function setupTabs() {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#top-tabs button");
  const panels = document.querySelectorAll<HTMLElement>("[data-tab-panel]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((p) => {
        p.hidden = p.dataset.tabPanel !== tab;
      });
    });
  });
}

// ---- Workout calendar ----

// Broad categories instead of one color per workout type -- with 19
// distinct types, a full legend was impossible to scan at a glance. Each
// category gets one color; the chip's own text still names the exact type.
const CATEGORIES: Array<{ name: string; color: string; types: string[] }> = [
  { name: "Cardio", color: "#3E7C7B", types: ["Walking", "Running", "Stair Climbing", "Cross Training", "Mixed Cardio", "Jump Rope", "Kickboxing"] },
  { name: "Strength", color: "#C1442D", types: ["Traditional Strength Training", "Functional Strength Training", "Core Training"] },
  { name: "Racquet Sports", color: "#D9A441", types: ["Pickleball", "Tennis", "Squash"] },
  { name: "Mind & Recovery", color: "#8B6FA8", types: ["Yoga", "Pilates", "Cooldown"] },
  { name: "Outdoor & Other", color: "#5C8158", types: ["Hiking", "Snowboarding", "Climbing"] },
];
const DEFAULT_CATEGORY = CATEGORIES[0];
const typeToCategory = new Map<string, (typeof CATEGORIES)[number]>();
CATEGORIES.forEach((c) => c.types.forEach((t) => typeToCategory.set(t, c)));
function categoryOf(type: string) {
  return typeToCategory.get(type) ?? DEFAULT_CATEGORY;
}

// Short chip labels so a busy day's full workout list still fits.
const TYPE_ABBR: Record<string, string> = {
  Walking: "Walk", Running: "Run", "Traditional Strength Training": "Strength",
  "Functional Strength Training": "Strength", "Stair Climbing": "Stairs", Pickleball: "Pickleball",
  Yoga: "Yoga", Kickboxing: "Kickbox", "Cross Training": "Cross-tr", Tennis: "Tennis",
  Cooldown: "Cooldown", "Core Training": "Core", Snowboarding: "Snowboard", "Mixed Cardio": "Mix cardio",
  Hiking: "Hike", "Jump Rope": "Jump rope", Squash: "Squash", Climbing: "Climb", Pilates: "Pilates",
};

// Distance is the meaningful number for Walking/Running; everything else
// only has duration.
function workoutMetricLabel(w: WorkoutEntry): string {
  if ((w.type === "Walking" || w.type === "Running") && w.distance_mi != null) {
    return `${w.distance_mi.toFixed(1)} mi`;
  }
  return w.duration_min != null ? `${Math.round(w.duration_min)} min` : "";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let calendarMonth = new Date();
let workoutsByDate = new Map<string, WorkoutEntry[]>();

function renderCalendarLegend() {
  const el = document.querySelector<HTMLDivElement>("#calendar-legend")!;
  el.innerHTML = CATEGORIES.map(
    (c) => `<div class="calendar-legend-item"><span class="calendar-legend-swatch" style="background:${c.color}"></span>${c.name}</div>`,
  ).join("");
}

function renderCalendar() {
  const grid = document.querySelector<HTMLDivElement>("#calendar-grid")!;
  const label = document.querySelector<HTMLSpanElement>("#calendar-month-label")!;
  label.textContent = calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = DAY_NAMES.map((d) => `<div class="calendar-day-name">${d}</div>`).join("");
  for (let i = 0; i < firstDayOfWeek; i++) html += `<div class="calendar-day empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayWorkouts = [...(workoutsByDate.get(dateStr) ?? [])].sort((a, b) => (b.duration_min ?? 0) - (a.duration_min ?? 0));
    const chips = dayWorkouts
      .map(
        (w) =>
          `<span class="calendar-chip" style="background:${categoryOf(w.type).color}"><span class="calendar-chip-label">${TYPE_ABBR[w.type] ?? w.type}</span><span class="calendar-chip-metric">${workoutMetricLabel(w)}</span></span>`,
      )
      .join("");
    html += `<div class="calendar-day" data-date="${dateStr}"><span class="calendar-day-number">${day}</span>${chips}</div>`;
  }
  grid.innerHTML = html;
}

function getOrCreateTooltipEl(): HTMLDivElement {
  let el = document.querySelector<HTMLDivElement>("#calendar-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "calendar-tooltip";
    el.className = "hover-tooltip";
    document.body.append(el);
  }
  return el;
}

function setupCalendarTooltip() {
  const grid = document.querySelector<HTMLDivElement>("#calendar-grid")!;
  const tooltip = getOrCreateTooltipEl();

  const hide = () => {
    tooltip.style.display = "none";
  };

  grid.addEventListener("mousemove", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".calendar-day[data-date]");
    const dateStr = cell?.dataset.date;
    const dayWorkouts = dateStr ? workoutsByDate.get(dateStr) : undefined;
    if (!cell || !dateStr || !dayWorkouts || dayWorkouts.length === 0) {
      hide();
      return;
    }
    const dateLabel = parseLocalDate(dateStr).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const rows = dayWorkouts
      .map((w) => {
        const color = categoryOf(w.type).color;
        const metric = workoutMetricLabel(w);
        return `<div class="hover-tooltip-row"><span class="hover-tooltip-swatch" style="background:${color}"></span>${w.type}${metric ? ` — ${metric}` : ""}</div>`;
      })
      .join("");
    tooltip.innerHTML = `<div class="hover-tooltip-title">${dateLabel}</div>${rows}`;
    tooltip.style.display = "block";
    // Flip to the cursor's other side rather than run off the viewport.
    const { offsetWidth: w, offsetHeight: h } = tooltip;
    const left = e.clientX + 14 + w > window.innerWidth ? e.clientX - 14 - w : e.clientX + 14;
    const top = e.clientY + 14 + h > window.innerHeight ? e.clientY - 14 - h : e.clientY + 14;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, top)}px`;
  });
  grid.addEventListener("mouseleave", hide);
}

// ---- Heatmaps: trailing 12 months, one cell per day, so a year fits in
// the space the month grid above uses for four weeks. Two variants share
// the same grid/alignment/tooltip scaffold: volume (color = total minutes)
// and type (color = category, split into bands on a multi-category day). ----

const HEATMAP_COLOR_STOPS = ["#E9DFC4", "#C9DBC3", "#8FB386", "#5C8158", "#2E4A2A"];

function buildHeatmapGrid(monthsId: string, gridId: string, endDate: Date, backgroundFor: (iso: string) => string) {
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const start = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate() + 1);
  const startAligned = new Date(start);
  startAligned.setDate(startAligned.getDate() - startAligned.getDay());

  const monthsRow = document.querySelector<HTMLDivElement>(`#${monthsId}`)!;
  const grid = document.querySelector<HTMLDivElement>(`#${gridId}`)!;
  monthsRow.innerHTML = "";
  grid.innerHTML = "";

  let cur = new Date(startAligned);
  let lastMonth = -1;
  while (cur <= end) {
    if (cur.getDay() === 0) {
      const label = document.createElement("div");
      label.className = "heatmap-month-label";
      if (cur.getMonth() !== lastMonth) {
        label.textContent = cur.toLocaleDateString("en-US", { month: "short" });
        lastMonth = cur.getMonth();
      }
      monthsRow.appendChild(label);
    }
    const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    if (cur >= start && cur <= end) {
      cell.style.background = backgroundFor(iso);
      cell.dataset.date = iso;
    } else {
      cell.style.background = "transparent";
    }
    grid.appendChild(cell);
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }

  const tooltip = getOrCreateTooltipEl();
  const hide = () => { tooltip.style.display = "none"; };
  grid.addEventListener("mousemove", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".heatmap-cell[data-date]");
    const dateStr = cell?.dataset.date;
    const dayWorkouts = dateStr ? workoutsByDate.get(dateStr) : undefined;
    if (!cell || !dateStr) { hide(); return; }
    const dateLabel = parseLocalDate(dateStr).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const totalMin = Math.round((dayWorkouts ?? []).reduce((sum, w) => sum + (w.duration_min ?? 0), 0));
    const rows = (dayWorkouts ?? [])
      .map((w) => {
        const metric = workoutMetricLabel(w);
        return `<div class="hover-tooltip-row"><span class="hover-tooltip-swatch" style="background:${categoryOf(w.type).color}"></span>${w.type}${metric ? ` — ${metric}` : ""}</div>`;
      })
      .join("");
    const summary = totalMin > 0 ? ` — ${totalMin} min` : " — no workouts";
    tooltip.innerHTML = `<div class="hover-tooltip-title">${dateLabel}${summary}</div>${rows}`;
    tooltip.style.display = "block";
    const { offsetWidth: w, offsetHeight: h } = tooltip;
    const left = e.clientX + 14 + w > window.innerWidth ? e.clientX - 14 - w : e.clientX + 14;
    const top = e.clientY + 14 + h > window.innerHeight ? e.clientY - 14 - h : e.clientY + 14;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, top)}px`;
  });
  grid.addEventListener("mouseleave", hide);
}

function renderWorkoutHeatmap(workouts: WorkoutEntry[], endDate: Date) {
  const dailyTotal = new Map<string, number>();
  for (const w of workouts) {
    dailyTotal.set(w.date, (dailyTotal.get(w.date) ?? 0) + (w.duration_min ?? 0));
  }
  const maxMin = Math.max(1, ...dailyTotal.values());
  function colorFor(iso: string): string {
    const mins = dailyTotal.get(iso) ?? 0;
    if (!mins) return HEATMAP_COLOR_STOPS[0];
    const t = Math.min(1, mins / maxMin);
    const idx = Math.min(HEATMAP_COLOR_STOPS.length - 1, Math.floor(t * (HEATMAP_COLOR_STOPS.length - 1)) + 1);
    return HEATMAP_COLOR_STOPS[idx];
  }
  buildHeatmapGrid("heatmap-months", "heatmap-grid", endDate, colorFor);
}

// Same fixed category order every time (Cardio, Strength, Racquet Sports,
// Mind & Recovery, Outdoor & Other) so two days sharing the same
// combination of categories always split into the same order -- duration
// only decides which 3 survive on a day with more than 3, never the
// display order.
function splitCategoriesForDay(dateStr: string): string[] {
  const items = workoutsByDate.get(dateStr) ?? [];
  const durationByCategory = new Map<(typeof CATEGORIES)[number], number>();
  for (const w of items) {
    const c = categoryOf(w.type);
    durationByCategory.set(c, (durationByCategory.get(c) ?? 0) + (w.duration_min ?? 0));
  }
  const survivors = [...durationByCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);
  const kept = new Set(survivors);
  return CATEGORIES.filter((c) => kept.has(c)).map((c) => c.color);
}

function renderWorkoutTypeHeatmap(endDate: Date) {
  function backgroundFor(iso: string): string {
    const colors = splitCategoriesForDay(iso);
    if (colors.length === 0) return HEATMAP_COLOR_STOPS[0];
    if (colors.length === 1) return colors[0];
    const step = 100 / colors.length;
    const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
    return `linear-gradient(to bottom, ${stops.join(", ")})`;
  }
  buildHeatmapGrid("type-heatmap-months", "type-heatmap-grid", endDate, backgroundFor);

  const legend = document.querySelector<HTMLDivElement>("#type-heatmap-legend")!;
  legend.innerHTML = CATEGORIES.map(
    (c) => `<div class="calendar-legend-item"><span class="calendar-legend-swatch" style="background:${c.color}"></span>${c.name}</div>`,
  ).join("");
}

function setupCalendar(data: SiteData) {
  workoutsByDate = new Map();
  for (const w of data.workouts) {
    const list = workoutsByDate.get(w.date) ?? [];
    list.push(w);
    workoutsByDate.set(w.date, list);
  }

  const maxDateStr = data.workouts.reduce(
    (max, w) => (w.date > max ? w.date : max),
    data.workouts[0]?.date ?? new Date().toISOString().slice(0, 10),
  );
  const maxDate = parseLocalDate(maxDateStr);
  calendarMonth = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);

  document.querySelector("#calendar-prev")!.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.querySelector("#calendar-next")!.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  renderCalendarLegend();
  renderCalendar();
  setupCalendarTooltip();
  renderWorkoutHeatmap(data.workouts, maxDate);
  renderWorkoutTypeHeatmap(maxDate);
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

  setupTabs();
  paceRange = setupRangeSelector("pace-range-selector", (range) => {
    paceRange = range;
    if (siteData) {
      loadAndRenderPaceByZone(siteData, paceRange);
      renderPaceTrendCharts(siteData, paceRange);
      renderRunsVolumeCharts(siteData, paceRange);
    }
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
  renderPaceTrendCharts(data, paceRange);
  renderRouteComparison(data);
  renderRunsVolumeCharts(data, paceRange);
  renderTrendCharts(data, trendRange);
  setupCalendar(data);
  setupTimeSummary(data);
  renderPRs();
}

main();
