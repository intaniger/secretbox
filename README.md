# Secretbox

A proof of concept for sharing confidential data **without accounts or emails**.

- **No accounts.** Each box membership has its own passkey (Face ID, fingerprint, security key). The phone's passkey list is the list of your boxes.
- A member sends a **one-time invite link**. Opening it uses it up.
- The person who invites types the new member's name. **The new member types nothing**: open the invite, then one tap on Accept.
- **No roles.** Every member can read, add, invite and remove. Encryption can't make anyone read-only anyway: every member holds the box key.
- The browser locks and unlocks everything, names included. The server stores **only locked files and hashes**.

Encryption is [age](https://age-encryption.org) via [Typage](https://github.com/FiloSottile/typage). The passkey's [WebAuthn PRF extension](https://w3c.github.io/webauthn/#prf-extension) output is used directly as an age X25519 key. No custom cryptography.

**How it works, step by step:** [docs/](docs/README.md) explains each scenario with diagrams and real example values.

## User journey

| Who | Does | Passkey prompts |
|---|---|---|
| Tiger | Creates a box: types his name and a box name. His phone saves the passkey "Finance 2026 – Tiger" | 1 (2 on some devices) |
| Tiger | Adds data: a note or a file | 0 |
| Tiger | Creates an invite link for "Nok" and sends it in a private chat | 0 |
| Nok | Opens the link, taps **Open invite**, sees "Tiger invited you", taps **Accept**. Nothing to type | 1 (2 on some devices) |
| Nok | Invites Bee herself. Bee shows as "invited by Nok" | 0 |
| Nok | Comes back later: **Open with passkey**, picks "Finance 2026 – Nok" | 1 per visit |
| A form tool | Adds data with the box's public key and an add key | — |
| Any member | Removes someone: their passkey stops opening the box | 0 |

## How it works

```
Passkey (Face ID + PRF, fixed input)
  │  PRF output = the PASSKEY KEY        age X25519 private key, never stored
  │  unlocks the ENVELOPE                age file, one per member
Box key — one per box, age X25519
  │  unlocks names, labels and data      age files
  └─ gives the ACCESS KEY                HMAC-SHA-256(box private key, label); the server stores its hash
```

- **One passkey per box.** Its user ID is the box ID. "Open with passkey" shows all your passkeys for the site; the one you pick tells the app which box to open and gives the PRF output, in one Face ID. A new device that syncs passkeys (iCloud, Google) needs nothing.
- **Access by possession.** Whoever holds the box private key is a member. The browser derives the *access key* from it and sends it as `Authorization: Bearer`. There are no sessions, cookies or server-side passkey checks.
- **Adding data needs no secret.** Data is locked to the box's public `age1…` key. That's why outside systems can add data but never read it.
- **Invite links.** The browser locks the box private key and the two names to a new one-time age key. The one-time secret key goes after `#` in the link: `/join/{id}#AGE-SECRET-KEY-1…`. Browsers never send the `#` part to the server.
- **Joining.** Loading the page changes nothing, so link previews (LINE, Slack, iMessage) can't burn the invite. **Open invite** sends `POST /claim`, which deletes the invite and returns its file in one statement. The browser opens it with the `#` key, makes the person's passkey for the box, and locks the box key in their own envelope.
- **Removing someone** deletes their envelope. It can't take back a box key they copied: to cut someone off fully, make a new box (see [the security notes](docs/08-security.md)).

### What the server stores

| Table | Contents |
|---|---|
| `boxes` | box ID, public `age1…` key, **box name**, access-key hash, add-key hash |
| `members` | passkey credential ID, **envelope**, **name and who invited them** |
| `items` | **label** (name, type, size, added by), **data** |
| `invites` | **invite file**, **name**, expiry. The row is deleted when the link is opened, canceled or expired |

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
| `DATABASE_URL` | — | Postgres URL. Without it: PGlite |
| `DB_PATH` | `.data` | PGlite data directory (`:memory:` for none) |

## Deploy to Vercel

The project deploys with the [Build Output API](https://vercel.com/docs/build-output-api): `npm run build:vercel` writes `.vercel/output/` with the static web app, the API bundled into one Node.js function, and the routes (see `scripts/build-vercel.mjs`). Vercel runs exactly what `npm run test:vercel` tests.

1. Create a Vercel project and connect this repository. `vercel.json` sets the build command.
2. Connect a Postgres database: **Storage → Neon**. The integration adds `DATABASE_URL` (or `<PREFIX>_DATABASE_URL`, which also works). The tables are created on the first request. A database made by the first version (with accounts) is upgraded by only adding columns, so an older deployment that shares it keeps working.
3. Put the functions in the database's region (**Settings → Functions**). Each request makes a few queries, so distance adds up.
4. Turn **Vercel Authentication** off for production, or use a custom domain. Otherwise readers hit a Vercel login.

**Passkey domains:** passkeys only work on the domain they were made on (the browser uses `location.hostname`), so a passkey made on a preview URL doesn't work in production. Choose the final domain before real users join. The server needs no domain setting.

**Limit:** Vercel Functions accept request bodies up to 4.5 MB, so items are limited to 4 MB.

## Add data from another system

In the box page, any member makes an **add key** under **Outside systems**. A new add key replaces the old one; **Turn off** removes it. Then, with the [age CLI](https://github.com/FiloSottile/age):

```sh
age -r age1…box-public-key… answer.txt \
  | curl --data-binary @- \
      -H "Authorization: Bearer sbx_…" \
      "https://your-domain/api/ingest/BOX_ID"
```

ASCII-armored files (`age -a`) are accepted too. Plaintext is rejected. The add key can only add: it can't read, list or delete. Members see these items as "From an outside system", because the file carries no locked label.

## Test

```sh
npm test                   # builds, then runs test/e2e.mjs against the local server
npm run test:vercel        # the same journey against the Vercel build output
SCREENSHOTS=1 npm test     # also saves phone-size screenshots to test-results/
```

The test runs the full journey in headless Chrome. Each person has their own browser profile and a **virtual passkey authenticator with PRF** (Chrome DevTools Protocol), so the real WebAuthn and PRF code runs. It checks the number of passkey prompts (also on a device that gives the PRF output only when a passkey is used), one passkey per box with the box ID as its user ID, one-time links, a reload while joining, link previews, cancel and removal, outside-system uploads, and that the database holds no plaintext, no names and no private keys. Set `CHROME_PATH` if Chrome isn't found.

`test:vercel` runs the bundled function from `.vercel/output`, routed by the regexes in its `config.json`, talking to Postgres over the wire protocol with `pg` (PGlite behind [pglite-socket](https://pglite.dev) stands in for Neon).

`npm run check` type-checks the server and the web app.

## Limits

This is a PoC. Know these before you trust it with real data. [docs/08-security.md](docs/08-security.md) has the full list.

- **The server serves the code that holds the keys.** A compromised server could serve JavaScript that steals keys after unlock. Mitigations: a strict CSP (in place), hosting the static app separately from the API, and published builds people can check.
- **Removal is not cryptographic.** It deletes the person's envelope, so their passkey stops working. If they copied the box private key, they keep full access, including new data. To cut someone off, make a new box.
- **An invite link is a secret until it's opened.** Whoever opens it first gets the box key and joins under the invited name. Send it privately, and keep expiry short.
- **The access key is a bearer secret.** The server sees it on each request. With it alone, someone can delete or add data, but not read anything.
- **Not encrypted:** sizes, dates, counts of members and items, which passkey opens which box. The passkey label in your password manager shows the box name and your name.
- **Every member can do everything:** invite anyone, remove anyone (also the box creator), delete items.
- **Lost passkey = lost access** for that person. Synced passkeys (iCloud, Google) make this rare. Any member can send a new invite link.
- **PoC infrastructure:** no rate limits, no audit log, items up to 4 MB.
- **Keys are X25519, not post-quantum.** Hybrid keys are possible with Typage; outside systems then need age v1.3+.

## Code

```
server/app.ts            API: boxes, envelopes, items, invites, add keys (Hono)
server/db.ts             schema + a tiny query interface
server/db-pg.ts          Postgres via node-postgres (Neon on Vercel)
server/db-pglite.ts      PGlite for local development and tests
server/node.ts           local server: API + web app
server/vercel.ts         Vercel Function entry
scripts/build-vercel.mjs Vercel Build Output API
web/src/keys.ts          all cryptography (Typage + WebCrypto): key pairs, lock/unlock, access key
web/src/passkey.ts       WebAuthn: one passkey per box, PRF output → passkey key
web/src/vault.ts         user actions built from keys + API, with prompt counts
web/src/main.ts          UI (no framework)
test/e2e.mjs             end-to-end journey test
test/vercel-harness.mjs  runs the Vercel build output locally
```
