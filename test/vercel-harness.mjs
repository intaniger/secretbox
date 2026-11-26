// Runs the *Vercel build output* locally, as close to production as we can:
//
// - the bundled function from .vercel/output/functions/api.func (not the source),
// - talking to Postgres over the real wire protocol through `pg`
//   (PGlite behind pglite-socket stands in for Neon),
// - routed by the regexes in .vercel/output/config.json.
//
//   npm run test:vercel   (builds, then runs the e2e test against this)

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const OUT = ".vercel/output";
const PORT = Number(process.env.PORT ?? 8787);
const DB_PORT = PORT + 1000;

const pglite = new PGlite(process.env.DB_PATH);
const pgServer = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: "127.0.0.1", maxConnections: 10 });
await pgServer.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`;

const { default: handler } = await import(`../${OUT}/functions/api.func/index.mjs`);
const { routes } = JSON.parse(readFileSync(`${OUT}/config.json`, "utf8"));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filesystemDone = false;
  for (const r of routes) {
    if (r.handle === "filesystem") {
      const file = join(OUT, "static", url.pathname);
      if (url.pathname !== "/" && existsSync(file) && statSync(file).isFile()) return serveFile(res, file);
      filesystemDone = true;
      continue;
    }
    const m = url.pathname.match(new RegExp(r.src));
    if (!m) continue;
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    if (r.continue) continue;
    const dest = new URL(r.dest.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ""), url);
    for (const [k, v] of url.searchParams) dest.searchParams.append(k, v); // Vercel merges the query
    if (dest.pathname === "/api") {
      req.url = dest.pathname + dest.search;
      return handler(req, res);
    }
    if (filesystemDone || dest.pathname === "/index.html") return serveFile(res, join(OUT, "static", dest.pathname));
  }
  res.writeHead(404).end("Not found");
}).listen(PORT, () => console.log(`Secretbox on http://localhost:${PORT} (Vercel build output, pg -> PGlite socket)`));

function serveFile(res, file) {
  res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
}
