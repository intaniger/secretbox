// Local / self-hosted server: the API plus the built web app from dist/.
//
//   DATABASE_URL set   → real Postgres
//   otherwise          → PGlite (Postgres in WASM) stored in DB_PATH (default .data/)

import { readFileSync, existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, HTML_HEADERS } from "./app.ts";
import { migrate, type Db } from "./db.ts";

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = process.env.STATIC_DIR ?? "dist";
const ORIGINS = (process.env.ORIGINS ?? `http://localhost:${PORT},http://localhost:5173`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let db: Db;
let where: string;
if (process.env.DATABASE_URL) {
  const { pgDb } = await import("./db-pg.ts");
  db = pgDb(process.env.DATABASE_URL);
  where = "Postgres (DATABASE_URL)";
} else {
  const { pgliteDb } = await import("./db-pglite.ts");
  const dir = process.env.DB_PATH ?? ".data";
  db = pgliteDb(dir === ":memory:" ? undefined : dir);
  where = `PGlite in ${dir}`;
}
await migrate(db);

const app = createApp(db, { origins: () => ORIGINS });

if (existsSync(`${STATIC_DIR}/index.html`)) {
  app.use("/assets/*", serveStatic({ root: STATIC_DIR }));
  const indexHtml = readFileSync(`${STATIC_DIR}/index.html`, "utf8");
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml, 200, HTML_HEADERS)));
} else {
  console.warn(`No ${STATIC_DIR}/index.html. Run "npm run build", or use "npm run dev" for the Vite dev server.`);
}

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Secretbox on http://localhost:${PORT}  (${where}; origins ${ORIGINS.join(", ")})`);
});
