# Secretbox

A proof of concept for sharing confidential data **without collecting emails**.

- An admin sends a **one-time invite link**. It stops working after one use.
- Readers **unlock the data with their passkey** (Face ID, fingerprint, security key).
- The browser locks and unlocks everything. The server stores **only locked files**.

Encryption is [age](https://age-encryption.org) via [Typage](https://github.com/FiloSottile/typage), which can use a passkey's [WebAuthn PRF extension](https://w3c.github.io/webauthn/#prf-extension) as an age key. No custom cryptography.

## User journey

| Who | Does | Passkey prompts |
|---|---|---|
| Tiger | Creates a box: types his name and a box name | 2 (make passkey, lock key) |
| Tiger | Adds data: a note or a file | 0 |
| Tiger | Creates an invite link and sends it in a private chat | 0 (1 if locked) |
| Nok | Opens the link, types her name, taps **Accept** | 2 (make passkey, lock key) |
| Nok | Comes back later and opens data | 1 per visit |
| A form tool | Adds data with the box's public key and a token | — |
| Tiger | Removes someone. The box key changes. Everyone else keeps access | 0 (1 if locked) |

## How it works

```
Passkey (Face ID + PRF)
  │  unlocks the ENVELOPE      age file, fido2prf stanza      one per passkey
Member key   — one per person, age X25519
  │  unlocks the KEY COPY      age file, X25519 stanza        one per person per box
Box key      — one per box, age X25519
  │  unlocks
Data         — age files
```

- **Why a member key?** In age, encrypting *to a passkey* needs that passkey present. So an admin can't lock a new box key for other people's passkeys. The member key gives each person an ordinary `age1…` public key that an admin can lock to at any time, for example when the box key changes.
- **Adding data needs no secret.** Data is locked to the box's public `age1…` key. That's why outside systems can add data but never read it.
- **Invite links.** The browser makes a one-time age key pair and locks a copy of the box key to it. The one-time secret key goes after `#` in the link: `/join/{id}#AGE-SECRET-KEY-1…`. Browsers never send the `#` part to the server.
- **Joining.** Opening the page changes nothing, so link previews (LINE, Slack, iMessage) can't burn the invite. **Accept** makes the passkey and member key, then `POST /claim` marks the invite used, atomically. The browser opens the invite file with the `#` key and locks the box key again to the new member key. Then the server deletes the invite file and the `#` part is removed from the address bar.
- **Removing someone.** The admin's browser makes a new box key and locks it to each remaining member's public key. Old box keys go into a *key history* file locked to the new key, so old data stays readable without locking it again. Open invites are canceled, because they hold the old box key.
- **Sessions.** The same passkey also signs in to the server (normal WebAuthn login, using [SimpleWebAuthn](https://simplewebauthn.dev)). Unlocked keys live only in the tab's memory: closing the tab or **Lock** forgets them.

### What the server stores

| Table | Contents |
|---|---|
| `users` | nickname, member `age1…` key |
| `passkeys` | credential ID, public key (for login), **envelope** |
| `sessions`, `webauthn_flows` | login sessions (hashed tokens) and short-lived passkey challenges |
| `boxes` | name, box `age1…` key, **key history** |
| `memberships` | role, **key copy** |
| `items` | name, size, **age file** |
| `invites` | label, role, expiry, used by, **invite file** (deleted after use) |
| `ingest_tokens` | SHA-256 of each token |

Everything in **bold** is an age file the server can't open.

## Run it locally

Requires Node.js 22.18+ (it runs the TypeScript server directly) and a passkey provider with PRF support: Apple Passwords (iOS 18+/macOS 15+), Google Password Manager (Chrome 132+), or a recent security key.

```sh
npm install
npm run build
npm start            # http://localhost:8787
```

No database setup is needed: without `DATABASE_URL`, the server uses [PGlite](https://pglite.dev) (Postgres compiled to WASM) and keeps its data in `.data/`. Set `DATABASE_URL` to use a real Postgres.

For development, `npm run dev` runs the server and the Vite dev server (http://localhost:5173) with reload.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Server port |
| `ORIGINS` | `http://localhost:8787,http://localhost:5173` | Addresses people use, comma-separated. Each one is its own **passkey domain** |
| `DATABASE_URL` | — | Postgres URL. Without it: PGlite |
| `DB_PATH` | `.data` | PGlite data directory (`:memory:` for none) |

## Deploy to Vercel

The project deploys with the [Build Output API](https://vercel.com/docs/build-output-api): `npm run build:vercel` writes `.vercel/output/` with the static web app, the API bundled into one Node.js function, and the routes (see `scripts/build-vercel.mjs`). Vercel runs exactly what `npm run test:vercel` tests.

1. Create a Vercel project and connect this repository. `vercel.json` sets the build command.
2. Connect a Postgres database: **Storage → Neon**. The integration adds `DATABASE_URL` (or `<PREFIX>_DATABASE_URL`, which also works). The tables are created on the first request.
3. Put the functions in the database's region (**Settings → Functions**). Each request makes a few queries, so distance adds up.
4. Turn **Vercel Authentication** off for production, or use a custom domain. Otherwise readers hit a Vercel login.

**Passkey domains:** the production domain, preview URLs, and any address in `ORIGINS` are allowed. **Passkeys only work on the domain they were made on**, so choose the final domain before real users join. For a custom domain, add it to `ORIGINS` (e.g. `https://secretbox.example.com`).

**Limit:** Vercel Functions accept request bodies up to 4.5 MB, so items are limited to 4 MB.

## Add data from another system

In the box page, an admin creates a token under **Outside systems**. Then, with the [age CLI](https://github.com/FiloSottile/age):

```sh
age -r age1…box-public-key… answer.txt \
  | curl --data-binary @- \
      -H "Authorization: Bearer sbx_…" \
      "https://your-domain/api/ingest/BOX_ID?name=answer.txt"
```

ASCII-armored files (`age -a`) are accepted too. Plaintext is rejected.

## Test

```sh
npm test                   # builds, then runs test/e2e.mjs against the local server
npm run test:vercel        # the same journey against the Vercel build output
SCREENSHOTS=1 npm test     # also saves phone-size screenshots to test-results/
```

The test runs the full journey in headless Chrome. Each person has their own browser profile and a **virtual passkey authenticator with PRF** (Chrome DevTools Protocol), so the real WebAuthn and PRF code runs. It checks the number of passkey prompts, one-time links, link previews, outside-system uploads, removal with a key change, and that the database holds no plaintext or secret keys. Set `CHROME_PATH` if Chrome isn't found.

`test:vercel` runs the bundled function from `.vercel/output`, routed by the regexes in its `config.json`, talking to Postgres over the wire protocol with `pg` (PGlite behind [pglite-socket](https://pglite.dev) stands in for Neon).

`npm run check` type-checks the server and the web app.

## Limits

This is a PoC. Know these before you trust it with real data:

- **The server serves the code that holds the keys.** A compromised server could serve JavaScript that steals keys after unlock. Mitigations: a strict CSP (in place), hosting the static app separately from the API, and published builds people can check.
- **Removing someone doesn't erase what they read.** They can't get new data, and the server stops serving them. But if they kept an old box key, they can still read *old* data if they ever get those locked files.
- **One leaked member key exposes that person's future key copies.** A "change my key" action isn't built yet.
- **Not encrypted:** file names, sizes, dates, nicknames, box names, member lists.
- **Lost passkey = lost access** for that person. Synced passkeys (iCloud, Google) make this rare. An admin can send a new invite. There's no paper recovery key and no "add device" flow yet.
- **An invite link is a secret until it's used.** Anyone who opens it first gets in. Send it privately, and keep expiry short.
- **PoC infrastructure:** no rate limits, no audit log, items up to 4 MB.
- **Typage's WebAuthn API is marked experimental.** The version is pinned in `package-lock.json`.
- **Keys are X25519, not post-quantum.** Switching to `generateHybridIdentity()` is one line in `web/src/keys.ts`, but outside systems then need age v1.3+.

## Code

```
server/app.ts            API: passkey login, boxes, items, invites, key change (Hono)
server/db.ts             schema + a tiny query interface
server/db-pg.ts          Postgres via node-postgres (Neon on Vercel)
server/db-pglite.ts      PGlite for local development and tests
server/node.ts           local server: API + web app
server/vercel.ts         Vercel Function entry
scripts/build-vercel.mjs Vercel Build Output API
web/src/keys.ts          all cryptography (Typage): key pairs, lock/unlock, passkey identity
web/src/vault.ts         user actions built from keys + API, with prompt counts
web/src/main.ts          UI (no framework)
test/e2e.mjs             end-to-end journey test
test/vercel-harness.mjs  runs the Vercel build output locally
```
