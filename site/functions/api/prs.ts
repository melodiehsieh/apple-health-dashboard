// Cloudflare Pages Function backing the PRs tab and the log-pr.html form.
// GET returns all records (public, read-only, same data the deployed site
// already shows). POST/DELETE require PR_PASSCODE (set via
// `wrangler pages secret put PR_PASSCODE`) so a stumbled-on URL can't write
// garbage into the log -- viewing the site was already fully public by
// choice, but writes are a different risk than reads.

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  PRS_KV: KVNamespace;
  PR_PASSCODE: string;
}

type PagesFunction<E> = (context: { request: Request; env: E }) => Response | Promise<Response>;

type PRCategory = "push" | "pull" | "legs" | "other";

type PRRecord = { id: string; exercise: string; weight_lbs: number | null; reps: number; date: string; note?: string; category: PRCategory };

const KEY = "records";
const MAX_EXERCISE_LEN = 80;
const MAX_NOTE_LEN = 280;
const CATEGORIES: PRCategory[] = ["push", "pull", "legs", "other"];

async function readRecords(env: Env): Promise<PRRecord[]> {
  const raw = await env.PRS_KV.get(KEY);
  return raw ? JSON.parse(raw) : [];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // ?verify=<passcode> checks a passcode without any side effect or
  // exposing the real value -- used by log-pr.html's entry gate, so the
  // list/form only render after a correct passcode, without needing a
  // separate write-side-effect endpoint just to check it.
  const url = new URL(request.url);
  const verify = url.searchParams.get("verify");
  if (verify !== null) {
    return json({ ok: !!env.PR_PASSCODE && verify === env.PR_PASSCODE });
  }
  return json(await readRecords(env));
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid request body" }, 400);

  const { passcode, exercise, weight_lbs, reps, date, note, category } = body as Record<string, unknown>;
  if (!env.PR_PASSCODE || passcode !== env.PR_PASSCODE) {
    return json({ error: "Incorrect passcode" }, 401);
  }
  // Weight is optional -- pull-ups etc. only have reps.
  const hasWeight = weight_lbs !== undefined && weight_lbs !== null && weight_lbs !== "";
  const weightNum = hasWeight ? Number(weight_lbs) : null;
  const repsNum = Number(reps);
  if (
    typeof exercise !== "string" ||
    !exercise.trim() ||
    (hasWeight && !Number.isFinite(weightNum)) ||
    !Number.isFinite(repsNum) ||
    typeof date !== "string" ||
    !date ||
    !CATEGORIES.includes(category as PRCategory)
  ) {
    return json({ error: "Missing or invalid fields" }, 400);
  }

  const trimmedNote = typeof note === "string" ? note.trim().slice(0, MAX_NOTE_LEN) : "";
  const records = await readRecords(env);
  records.push({
    id: crypto.randomUUID(),
    exercise: exercise.trim().slice(0, MAX_EXERCISE_LEN),
    weight_lbs: weightNum,
    reps: Math.round(repsNum),
    date,
    category: category as PRCategory,
    ...(trimmedNote ? { note: trimmedNote } : {}),
  });
  await env.PRS_KV.put(KEY, JSON.stringify(records));
  return json(records);
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const passcode = url.searchParams.get("passcode");
  if (!env.PR_PASSCODE || passcode !== env.PR_PASSCODE) {
    return json({ error: "Incorrect passcode" }, 401);
  }
  const records = (await readRecords(env)).filter((r) => r.id !== id);
  await env.PRS_KV.put(KEY, JSON.stringify(records));
  return json(records);
};
