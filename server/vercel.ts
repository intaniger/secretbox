// Vercel Function entry. scripts/build-vercel.mjs bundles this file into
// .vercel/output/functions/api.func, and routes every /api/* request to it.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { migrate } from "./db.ts";
import { pgDb } from "./db-pg.ts";

/**
 * Each address people use is its own passkey domain: the production domain,
 * custom domains from ORIGINS, and (for testing) the preview URLs.
 */
function origins(): string[] {
  const list = (process.env.ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const host of [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ]) {
    if (host) list.push(`https://${host}`);
  }
  return list;
}

/**
 * The pooled Postgres URL. Vercel's Neon integration names it DATABASE_URL,
 * or <PREFIX>_DATABASE_URL when a custom prefix was chosen (this project: DB_).
 */
function databaseUrl(): string | undefined {
  const env = process.env;
  return (
    env.DATABASE_URL ??
    env.DB_DATABASE_URL ??
    env.POSTGRES_URL ??
    Object.entries(env).find(([k, v]) => k.endsWith("_DATABASE_URL") && v)?.[1]
  );
}

// Set up once per cold start; requests in the same instance reuse it.
let appReady: Promise<Hono> | undefined;
function getApp(): Promise<Hono> {
  appReady ??= (async () => {
    const url = databaseUrl();
    if (!url) throw Error("No database URL. Connect a Postgres database (e.g. Neon) to the Vercel project.");
    const db = pgDb(url);
    await migrate(db);
    return createApp(db, { origins });
  })().catch((err) => {
    appReady = undefined; // retry on the next request
    throw err;
  });
  return appReady;
}

const listener = getRequestListener(async (req) => {
  try {
    return (await getApp()).fetch(req);
  } catch (err) {
    console.error(err);
    return Response.json({ error: `Server not ready: ${(err as Error).message}` }, { status: 503 });
  }
});

export default function handler(req: IncomingMessage, res: ServerResponse) {
  // The route rewrites /api/<path> to /api?__path=<path>. Restore the path.
  const url = new URL(req.url ?? "/", "http://internal");
  const path = url.searchParams.get("__path");
  if (path !== null) {
    url.searchParams.delete("__path");
    req.url = `/api/${path}${url.search}`;
  }
  return listener(req, res);
}
