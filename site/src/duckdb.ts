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

/** Registers a Parquet file under /data by URL (DuckDB fetches/streams it
 * itself) so queries can reference it as e.g. read_parquet('workouts.parquet').
 * Buffer-based registration (fetch + registerFileBuffer) corrupted larger
 * files here ("no magic bytes found"); registerFileURL is the robust path. */
export async function registerParquet(filename: string): Promise<void> {
  if (registered.has(filename)) return;
  const db = await getDb();
  await db.registerFileURL(
    filename,
    `${window.location.origin}/data/${filename}`,
    duckdb.DuckDBDataProtocol.HTTP,
    false,
  );
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
