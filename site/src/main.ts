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
type WorkoutEntry = { date: string; type: string; duration_min: number | null };

type SiteData = {
  summary: { total_workouts: number; running_workouts: number; first_ts: string; last_ts: string };
  pace_by_zone_daily: DailyPaceByZone[];
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

// A qualitative palette distinct from the HR zone colors, assigned by
// overall frequency (most common workout types first) so the everyday
// ones (Walking, Running, Strength Training) stay maximally distinct;
// rare types share less-distinct hues, which is fine since they're rare.
const CALENDAR_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948",
  "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC", "#86BCB6", "#D37295",
  "#B6992D", "#499894", "#F1CE63", "#79706E", "#D4A6C8", "#FABFD2", "#8CD17D",
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let calendarMonth = new Date();
let typeColors = new Map<string, string>();
let workoutsByDate = new Map<string, WorkoutEntry[]>();

function buildTypeColors(workouts: WorkoutEntry[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const w of workouts) counts.set(w.type, (counts.get(w.type) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  const map = new Map<string, string>();
  sorted.forEach((type, i) => map.set(type, CALENDAR_PALETTE[i % CALENDAR_PALETTE.length]));
  return map;
}

function renderCalendarLegend() {
  const el = document.querySelector<HTMLDivElement>("#calendar-legend")!;
  el.innerHTML = [...typeColors.entries()]
    .map(
      ([type, color]) =>
        `<div class="calendar-legend-item"><span class="calendar-legend-swatch" style="background:${color}"></span>${type}</div>`,
    )
    .join("");
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
    const dayWorkouts = workoutsByDate.get(dateStr) ?? [];
    const dots = dayWorkouts
      .map((w) => {
        const color = typeColors.get(w.type) ?? "#999";
        return `<span class="calendar-workout-dot" style="background:${color}"></span>`;
      })
      .join("");
    html += `<div class="calendar-day" data-date="${dateStr}"><span class="calendar-day-number">${day}</span>${dots}</div>`;
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
        const color = typeColors.get(w.type) ?? "#999";
        const duration = w.duration_min != null ? ` — ${Math.round(w.duration_min)} min` : "";
        return `<div class="hover-tooltip-row"><span class="hover-tooltip-swatch" style="background:${color}"></span>${w.type}${duration}</div>`;
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

function setupCalendar(data: SiteData) {
  typeColors = buildTypeColors(data.workouts);
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
  setupCalendar(data);
}

main();
