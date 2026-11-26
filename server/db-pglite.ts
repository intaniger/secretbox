// PGlite: Postgres compiled to WASM. Used for local development and tests,
// so you don't need a Postgres server. dataDir undefined = in memory.
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { numbered, params, type Db, type Queryable } from "./db.ts";

export function pgliteDb(dataDir?: string): Db {
  const pg = new PGlite(dataDir);

  const on = (q: PGlite | Transaction): Queryable => ({
    all: async (sql, ...p) => (await q.query<Record<string, any>>(numbered(sql), params(p))).rows,
    one: async (sql, ...p) => (await q.query<Record<string, any>>(numbered(sql), params(p))).rows[0],
    run: async (sql, ...p) => (await q.query(numbered(sql), params(p))).affectedRows ?? 0,
  });

  return {
    ...on(pg),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) => pg.transaction((t) => fn(on(t))),
  };
}
