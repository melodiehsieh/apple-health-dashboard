import * as duckdb from "@duckdb/duckdb-wasm";

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function initDb(): Promise<duckdb.AsyncDuckDB> {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerBlob = new Blob([`importScripts("${bundle.mainWorker!}");`], {
    type: "text/javascript",
  });
  const workerUrl = URL.createObjectURL(workerBlob);

  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  return db;
}

/** Lazily-initialized, shared DuckDB-WASM instance. */
export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

const registered = new Set<string>();

/** Fetches a Parquet file from /data and registers it under its filename so
 * queries can reference it as e.g. read_parquet('workouts.parquet'). */
export async function registerParquet(filename: string): Promise<void> {
  if (registered.has(filename)) return;
  const db = await getDb();
  const res = await fetch(`/data/${filename}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch /data/${filename}: ${res.status}`);
  }
  const buffer = new Uint8Array(await res.arrayBuffer());
  await db.registerFileBuffer(filename, buffer);
  registered.add(filename);
}

export async function query<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    return result.toArray().map((row) => row.toJSON() as T);
  } finally {
    await conn.close();
  }
}
