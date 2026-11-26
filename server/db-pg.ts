// Real Postgres (Neon on Vercel) through node-postgres.
import pg from "pg";
import { numbered, params, type Db, type Queryable } from "./db.ts";

// BIGINT (timestamps, counts) as JS numbers instead of strings. Our values fit.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/**
 * Neon URLs end with `?sslmode=require&channel_binding=require`. node-postgres
 * ignores channel_binding in the URL, and treats `require` as `verify-full`
 * with a warning. Say what we mean: full TLS verification (Neon has public
 * certificates) and SCRAM channel binding when asked for.
 */
function normalize(connectionString: string): { connectionString: string; enableChannelBinding: boolean } {
  const url = new URL(connectionString);
  const enableChannelBinding = url.searchParams.get("channel_binding") === "require";
  url.searchParams.delete("channel_binding");
  if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode") ?? "")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return { connectionString: url.toString(), enableChannelBinding };
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({
    ...normalize(connectionString),
    max: 5,
    idleTimeoutMillis: 10_000,
  });

  const on = (client: pg.Pool | pg.PoolClient): Queryable => ({
    all: async (sql, ...p) => (await client.query(numbered(sql), params(p))).rows,
    one: async (sql, ...p) => (await client.query(numbered(sql), params(p))).rows[0],
    run: async (sql, ...p) => (await client.query(numbered(sql), params(p))).rowCount ?? 0,
  });

  return {
    ...on(pool),
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(on(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
