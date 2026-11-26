# Secretbox

Share confidential data with a link and Face ID. **No accounts. No emails.** The browser locks everything. The server keeps only locked files and hashes, so it cannot read names or contents.

A proof of concept. Encryption is [age](https://age-encryption.org) via [Typage](https://github.com/FiloSottile/typage). The key comes from a passkey through the [WebAuthn PRF extension](https://w3c.github.io/webauthn/#prf-extension). No custom cryptography.

## The idea

- **One passkey per box.** The passkey list on your phone is your list of boxes.
- **One-time invite links.** The person who invites types the new member's name. The new member types nothing: open the link, tap **Accept**.
- **No roles.** Every member can read, add, invite and remove.

## What people do

| Step | Passkey prompts | Explained in |
|---|---|---|
| Tiger makes the box "Finance 2026" | 1* | [1. Make a box](docs/01-create-box.md) |
| Tiger opens the box later | 1 | [2. Open a box](docs/02-open-box.md) |
| A member adds a note or a file. A form or script can too | 0 | [3. Add an item](docs/03-add-item.md) |
| Tiger sends Nok an invite link | 0 | [4. Make an invite](docs/04-create-invite.md) |
| Nok opens the link and taps **Accept** | 1* | [5. Use an invite](docs/05-use-invite.md) |
| Somebody opens a used or expired link | — | [6. Expired or used link](docs/06-invite-expired-or-reused.md) |
| A member removes another member | 0 | [8. Security, §2](docs/08-security.md#2-removal-deletes-only-the-envelope) |

\* Some devices ask two times when they make a passkey.

## How it works

```
Face ID → passkey PRF output = passkey private key   (never stored)
  └─ unlocks your envelope                           (one per member)
       └─ box private key                            (one per box)
            ├─ unlocks names, labels and items
            └─ gives the access key                  (the server keeps only its hash)
```

- **Lock with the public key, unlock with the private key.** The box public key (`age1…`) can lock data. Only members can unlock it. Outside systems also need an add key to upload.
- **Invite links** carry a one-time private key after `#`: `/join/{id}#AGE-SECRET-KEY-1…`. Browsers never send the `#` part to the server. A link preview does not use up the link. Only **Open invite** does.

**The full explanation**, with diagrams and real example values, is in **[docs/](docs/README.md)**. What the database keeps: [docs/07-storage.md](docs/07-storage.md).

## Run it locally

You need Node.js 22.18+ and a passkey provider with PRF: Apple Passwords (iOS 18+, macOS 15+), Google Password Manager (Chrome 132+), or a recent security key.

```sh
npm install
npm run build
npm start      # http://localhost:8787
```

No database setup: data goes to `.data/` ([PGlite](https://pglite.dev)). `npm run dev` runs with reload on http://localhost:5173.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Server port |
| `DATABASE_URL` | — | Postgres URL. Without it: PGlite |
| `DB_PATH` | `.data` | PGlite folder (`:memory:` for none) |

## Deploy to Vercel

1. Connect the repository to a Vercel project. `vercel.json` sets the build ([Build Output API](https://vercel.com/docs/build-output-api), see `scripts/build-vercel.mjs`).
2. Add Postgres: **Storage → Neon**. It adds `DATABASE_URL` (`<PREFIX>_DATABASE_URL` also works). The tables are made on the first request.
3. Put the functions in the database's region (**Settings → Functions**).
4. Turn off **Vercel Authentication** for production, or use a custom domain.

> **Choose the final domain first.** A passkey works only on the domain where it was made. A passkey from a preview URL does not work in production.

Items are limited to 4 MB (Vercel accepts request bodies up to 4.5 MB).

## Add items from a form or script

A member makes an **add key**: **Items** tab → **Let a form or script add items**. The add key can only add. It cannot read, list or delete. **Turn off** removes it.

```sh
age -r age1…box-public-key… answer.txt \
  | curl --data-binary @- -H "Authorization: Bearer sbx_…" \
      "https://your-domain/api/ingest/BOX_ID"
```

Details: [docs/03-add-item.md](docs/03-add-item.md#another-system-adds-an-item).

## Test

```sh
npm test               # the full journey in headless Chrome, with virtual PRF passkeys
npm run test:vercel    # the same journey against the Vercel build output
npm run check          # type-check
```

`SCREENSHOTS=1 npm test` also saves phone-size screenshots to `test-results/`. Set `CHROME_PATH` if the test cannot find Chrome.

## Limits

This is a PoC. These are the main limits. [docs/08-security.md](docs/08-security.md) lists all 14.

- **The server sends the code that holds the keys.** A changed server can steal keys after unlock.
- **Removal is not cryptographic.** A removed member who copied the box private key keeps access. To cut somebody off, make a new box.
- **An invite link is a secret until somebody opens it.** The first person to open it joins.
- **Not locked:** sizes, dates and counts. The passkey label shows the box name and the person's name.
- **A lost passkey means lost access** for that person. Another member can send a new link.

## Code

```
server/app.ts            API (Hono)
server/db*.ts            schema, Postgres, PGlite
server/node.ts           local server
server/vercel.ts         Vercel Function entry
scripts/build-vercel.mjs Vercel Build Output API
web/src/keys.ts          all cryptography (Typage + WebCrypto)
web/src/passkey.ts       WebAuthn: one passkey per box, PRF → passkey key
web/src/vault.ts         user actions, with prompt counts
web/src/main.ts          UI (no framework)
test/e2e.mjs             end-to-end journey test
```
