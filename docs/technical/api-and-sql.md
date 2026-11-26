# Technical details: API calls and database statements

[← All documents](../README.md)

The server is [server/app.ts](../../server/app.ts) (Hono). The schema is in [server/db.ts](../../server/db.ts). The same code runs on Vercel with Neon Postgres, and locally with PGlite.

All private values travel as age files: base64 in JSON, or binary. The server checks that each one starts with `age-encryption.org/v1`. It never accepts plaintext.

"Member" in the table below means: the request has the box's access key in `Authorization: Bearer`. See [passkeys-and-access-keys.md](passkeys-and-access-keys.md).

## Calls

| Call | Who | Body → answer | Scenario |
|---|---|---|---|
| `POST /api/boxes` | Anybody, with a new access key | `{id, publicKey, nameLocked, member: {credentialId, envelope, nameLocked}}` → `{id}` | [1](../01-create-box.md) |
| `GET /api/boxes/:id/envelopes/:credentialId` | Anybody | → `{envelope}` | [2](../02-open-box.md) |
| `GET /api/boxes/:id` | Member | → `{id, publicKey, nameLocked, hasAddKey, members[], items[], invites[]}` | [2](../02-open-box.md) |
| `POST /api/boxes/:id/items` | Member | Form with `label` and `data` → `{id}` | [3](../03-add-item.md) |
| `GET /api/boxes/:id/items/:itemId` | Member | → the data file (binary) | [3](../03-add-item.md) |
| `DELETE /api/boxes/:id/items/:itemId` | Member | → `{ok}` | |
| `POST /api/boxes/:id/add-key` | Member | → `{addKey}` (shown one time) | [3](../03-add-item.md#another-system-adds-an-item) |
| `DELETE /api/boxes/:id/add-key` | Member | → `{ok}` | |
| `POST /api/ingest/:id` | Add key | One age file → `{id}` | [3](../03-add-item.md#another-system-adds-an-item) |
| `POST /api/boxes/:id/invites` | Member | `{inviteFile, nameLocked, ttlHours}` → `{id}` | [4](../04-create-invite.md) |
| `DELETE /api/boxes/:id/invites/:inviteId` | Member | → `{ok}` | [4](../04-create-invite.md#cancel-an-invite) |
| `POST /api/invites/:id/claim` | Anybody | → `{boxId, inviteFile}`, one time | [5](../05-use-invite.md), [6](../06-invite-expired-or-reused.md) |
| `POST /api/boxes/:id/members` | Member | `{credentialId, envelope, nameLocked}` → `{ok}` | [5](../05-use-invite.md) |
| `DELETE /api/boxes/:id/members/:credentialId` | Member | → `{ok}` | [2](../02-open-box.md#if-the-passkey-was-removed) |

## The statements

Placeholders are `?` in the code, and `$1, $2, …` in Postgres.

**Check a member** (each "Member" call):

```sql
SELECT id FROM boxes WHERE id = ? AND access_hash = ?          -- SHA-256 of the bearer key
```

**Make a box** (one transaction):

```sql
INSERT INTO boxes (id, public_key, name_locked, access_hash, created_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (id) DO NOTHING;                                  -- 0 rows: HTTP 409
INSERT INTO members (box_id, credential_id, envelope, name_locked, created_at) VALUES (?, ?, ?, ?, ?);
```

**Get an envelope:**

```sql
SELECT envelope FROM members WHERE box_id = ? AND credential_id = ?   -- no row: HTTP 404
```

**Get a box** (four queries):

```sql
SELECT public_key, name_locked, add_hash IS NOT NULL AS has_add_key FROM boxes WHERE id = ?;
SELECT credential_id, name_locked, created_at FROM members WHERE box_id = ? ORDER BY created_at;
SELECT id, label_locked, octet_length(data_locked) AS size, created_at FROM items
  WHERE box_id = ? ORDER BY created_at DESC;
SELECT id, name_locked, expires_at FROM invites WHERE box_id = ? AND expires_at > ? ORDER BY expires_at;
```

**Add an item:**

```sql
INSERT INTO items (id, box_id, label_locked, data_locked, created_at) VALUES (?, ?, ?, ?, ?);
-- from an outside system: no label_locked
```

**Make an invite:**

```sql
DELETE FROM invites WHERE expires_at <= ?;                      -- now
INSERT INTO invites (id, box_id, invite_file, name_locked, expires_at) VALUES (?, ?, ?, ?, ?);
```

**Claim an invite.** One statement deletes the row and gives it back. So two people who claim at the same time cannot both get it:

```sql
DELETE FROM invites WHERE expires_at <= ?;                      -- now
DELETE FROM invites WHERE id = ? AND expires_at > ? RETURNING box_id, invite_file;
-- no row: HTTP 404 "This link was already used, has expired, or was canceled."
```

**Join:**

```sql
INSERT INTO members (box_id, credential_id, envelope, name_locked, created_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING;                                       -- 0 rows: HTTP 409
```

**Remove a member** (one transaction):

```sql
DELETE FROM members WHERE box_id = ? AND credential_id = ?;
SELECT COUNT(*) AS n FROM members WHERE box_id = ?;             -- 0: roll back, HTTP 409
```

**Add key:**

```sql
UPDATE boxes SET add_hash = ? WHERE id = ?;                     -- a new key, or NULL to turn it off
SELECT id FROM boxes WHERE id = ? AND add_hash = ?;             -- check on POST /api/ingest/:id
```

## Limits

| Limit | Value | Why |
|---|---|---|
| Item size | 4 MB for the whole request | Vercel Functions accept up to 4.5 MB. |
| Invite time limit | 1 hour to 7 days | |
| Box ID | 16 to 64 base64url characters | The browser makes 16 random bytes. |

## Upgrade from the first version

The first version, which had accounts, made the live database on Vercel. A deployment of that version may still use it. So the migration (`UPGRADE_FROM_V1` in [server/db.ts](../../server/db.ts)) only:

- adds the new columns to `boxes`, `items` and `invites`,
- removes `NOT NULL` from old columns that the new version does not fill,
- makes the new `members` table.

The old rows stay. The new version never reads them: old boxes have no `access_hash`, so no access key opens them. A new box cannot use a box ID from the first version (HTTP 409). Later, nothing will use the old columns and old tables. Then a person can delete them. The old tables are `users`, `passkeys`, `sessions`, `webauthn_flows`, `memberships` and `ingest_tokens`.

[← All documents](../README.md)
