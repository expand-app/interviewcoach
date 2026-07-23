/**
 * Postgres connection pool + migration runner.
 *
 * Connection: reads DATABASE_URL from env. In production it's set on
 * the EB environment to the Aurora cluster endpoint. In local dev
 * leave it unset and the module short-circuits — store and API
 * routes that need DB will respond with the "DB not configured" path
 * (currently: 503 from API routes, localStorage-only on client).
 *
 * Migration: lib/migrations/001_init.sql is idempotent (CREATE TABLE
 * IF NOT EXISTS everywhere). We run it once per Node process on the
 * first DB call via `ensureMigrated()`. The runner is idempotent and
 * safe to invoke from many concurrent requests; pg-side a CREATE
 * TABLE IF NOT EXISTS is non-blocking when the table exists.
 */

import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";

let pool: Pool | null = null;
let migrationsRun = false;
let migrationPromise: Promise<void> | null = null;

function buildPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  // Aurora's RDS-issued cert is signed by Amazon's RDS root, which
  // Node doesn't trust by default. Two reasonable answers:
  //   (a) bundle the rds-ca-rsa2048-g1 root cert and verify properly,
  //   (b) `rejectUnauthorized: false` — encrypts the channel but
  //       doesn't verify the server identity.
  // Since the connection happens inside the VPC over a private SG
  // (only the EB instance can reach the DB), the MITM risk is
  // negligible. (a) would be cleaner for a public-facing DB; we'll
  // upgrade if/when we ever need that.
  const config: PoolConfig = {
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    // Aurora Serverless v2 with scale-to-zero takes ~10-30s to wake
    // from auto-pause. Default connect timeout (no limit on PG, but
    // Node's net stack often gives up around 10s) needs a bump.
    connectionTimeoutMillis: 30_000,
    // Idle pool connections kept around for reuse. Aurora Serverless
    // bills per ACU-hour — keeping 0 idle when traffic is sparse is
    // fine; the wake-from-pause cost is paid at most once per ~5min.
    max: 10,
    idleTimeoutMillis: 30_000,
  };
  return new Pool(config);
}

export function getPool(): Pool | null {
  if (pool === null) pool = buildPool();
  return pool;
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Run the schema migration if not already done in this process. */
export async function ensureMigrated(): Promise<void> {
  if (migrationsRun) return;
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const p = getPool();
    if (!p) throw new Error("DATABASE_URL not set");
    const sqlPath = path.join(process.cwd(), "lib", "migrations", "001_init.sql");
    const sql = readFileSync(sqlPath, "utf8");
    await p.query(sql);
    migrationsRun = true;
  })();
  try {
    await migrationPromise;
  } finally {
    // Whether it succeeded or threw, drop the in-flight promise so a
    // failure on first request doesn't permanently poison subsequent
    // requests (they'll retry the migration).
    migrationPromise = null;
  }
}

/** Typed wrapper around pg.query. Throws if DB isn't configured —
 *  callers should gate on isDbConfigured(). Always runs migration
 *  first so any first-touch in this process self-heals the schema. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const p = getPool();
  if (!p) throw new Error("DATABASE_URL not set");
  await ensureMigrated();
  return p.query<T>(sql, params);
}

/** Run several statements in a single transaction. The fn receives a
 *  client that supports query(); we BEGIN/COMMIT/ROLLBACK around it. */
export async function withTx<T>(
  fn: (q: <R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ) => Promise<QueryResult<R>>) => Promise<T>
): Promise<T> {
  const p = getPool();
  if (!p) throw new Error("DATABASE_URL not set");
  await ensureMigrated();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ) => client.query<R>(sql, params));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw e;
  } finally {
    client.release();
  }
}
