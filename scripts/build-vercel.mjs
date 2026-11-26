// Builds the Vercel deployment with the Build Output API
// (https://vercel.com/docs/build-output-api):
//
//   .vercel/output/static/          the web app (vite build)
//   .vercel/output/functions/api.func/   the API, bundled into one file
//   .vercel/output/config.json      routes + security headers
//
// Bundling ourselves means Vercel runs exactly what we tested.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = ".vercel/output";
const FUNC = `${OUT}/functions/api.func`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FUNC, { recursive: true });

// 1. Static web app (run `vite build` first; the npm script does).
cpSync("dist", `${OUT}/static`, { recursive: true });

// 2. API function.
await build({
  entryPoints: ["server/vercel.ts"],
  outfile: `${FUNC}/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  external: ["pg-native"],
  // pg is CommonJS and calls require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
writeFileSync(
  `${FUNC}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: "nodejs24.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
    },
    null,
    2,
  ),
);

// 3. Routes. Same CSP as the local server.
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

writeFileSync(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        {
          src: "^/(?!api/|assets/).*$",
          headers: { "content-security-policy": csp, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
          continue: true,
        },
        { src: "^/api/(.*)$", dest: "/api?__path=$1" },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

console.log(`Vercel build output written to ${OUT}`);
