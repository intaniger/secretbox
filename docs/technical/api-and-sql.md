# Technical details: API calls and database statements

[← All documents](../README.md)

This document lists each API call: what it gets, what it checks, what it does in the database, and what it gives back. The code is in `server/app.ts`.

**Auth** means: the request must have a valid `sb_session` cookie. The server calculates `SHA-256(token)` and finds the row in `sessions`. If the row is missing or expired, the server sends `401`.

**Locked** values are age files. In JSON they are base64. The server checks that each one starts with `age-encryption.org/v1`, but it cannot unlock them.

## Sign-up and sign-in

| Call | Auth | Input | Checks and database | Output | Scenario |
|---|---|---|---|---|---|
| `POST /api/register/options` | No | `nickname`: typed by the box creator, or the name from the invite | Origin is allowed. `DELETE` expired `webauthn_flows`. `INSERT webauthn_flows` (challenge, origin, passkey domain, name, 5 minutes). | `flowId`, WebAuthn options | 1, 5 |
| `POST /api/register/verify` | No | `flowId`, passkey `response` | `DELETE webauthn_flows … RETURNING`. PRF is enabled. WebAuthn checks. Transaction: `INSERT users`, `INSERT passkeys`. Then `INSERT sessions`. | Cookie `sb_session` | 1, 5 |
| `POST /api/login/options` | No | | Origin is allowed. `INSERT webauthn_flows`. | `flowId`, options | 2, 5 |
| `POST /api/login/verify` | No | `flowId`, `response` | `DELETE webauthn_flows … RETURNING`. `SELECT passkeys`. Verify the signature. `UPDATE passkeys SET counter`. `INSERT sessions`. | Cookie `sb_session` | 2, 5 |
| `POST /api/logout` | Cookie | | `DELETE sessions` for this token. | | |

## Member key

| Call | Auth | Input | Checks and database | Output | Scenario |
|---|---|---|---|---|---|
| `GET /api/me` | Yes | | `SELECT users`, `SELECT passkeys`. | Nickname, member public key, passkey ID and transports | All |
| `PUT /api/me/keys` | Yes | `memberRecipient` (public key), `envelope` (locked) | Transaction: `UPDATE users SET member_recipient = ? WHERE id = ? AND member_recipient IS NULL`. It must change 1 row, else `409`. `UPDATE passkeys SET envelope`. | | 1, 5 |
| `GET /api/me/envelope` | Yes | | `SELECT envelope FROM passkeys` for the passkey of this session. | `envelope` (locked) | 3, 4 |

## Boxes and items

| Call | Auth | Input | Checks and database | Output | Scenario |
|---|---|---|---|---|---|
| `GET /api/boxes` | Yes | | `SELECT` boxes of this person, with item and member counts. | List | 2 |
| `POST /api/boxes` | Yes | `name`, `recipient` (box public key), `keyCopy` (locked) | The person has a member public key. Transaction: `INSERT boxes`, `INSERT memberships` with the person's name. | Box ID | 1, 2 |
| `GET /api/boxes/:id` | Member | | `SELECT` the box, the members with who invited them, the item list, the invites, the token labels. | Box public key, key version, key history (locked), my key copy (locked), members with names and public keys, items without data | 3, 4 |
| `POST /api/boxes/:id/items?name=` | Member | Raw age file, at most 4 MB | The server decodes armored files. The body must start with `age-encryption.org/v1`. `INSERT items`. | Item ID | 3 |
| `GET /api/boxes/:id/items/:itemId` | Member | | `SELECT ciphertext FROM items`. | Raw age file, `cache-control: private, no-store` | 3 |
| `DELETE /api/boxes/:id/items/:itemId` | Member | | `DELETE FROM items`. | | |
| `POST /api/boxes/:id/ingest-tokens` | Member | `label` | `INSERT ingest_tokens` with `SHA-256(token)`. | The token `sbx_…`, one time | 3 |
| `POST /api/ingest/:boxId?name=` | Bearer token | Raw age file, at most 4 MB | `SELECT ingest_tokens` by hash and box. Same age file checks. `INSERT items` with `source = 'ingest:<label>'`. | Item ID | 3 |

**Member** means: Auth, and a row in `memberships` for this box. Else `403`. There are no roles: each member can call each endpoint of the box.

## Invites

| Call | Auth | Input | Checks and database | Output | Scenario |
|---|---|---|---|---|---|
| `POST /api/boxes/:id/invites` | Member | `name` (the invited person), `ttlHours` (1 to 168), `keyVersion`, `inviteFile` (locked) | Transaction: `SELECT key_version FROM boxes … FOR SHARE`. The version must agree, else `409`. `INSERT invites`. | Invite ID | 4 |
| `DELETE /api/boxes/:id/invites/:inviteId` | Member | | `UPDATE invites SET canceled_at = now, invite_file = NULL WHERE … AND completed_at IS NULL`. | | 6 |
| `GET /api/invites/:id` | No | | `SELECT` the invite, the box name and the inviter's name. Nothing changes. | Box name, name of the invited person, inviter, status, expiry | 5, 6 |
| `POST /api/invites/:id/claim` | Yes | | See below. | `boxId`, `inviteFile` (locked) | 5, 6 |
| `POST /api/invites/:id/complete` | Yes | `keyCopy` (locked) | See below. | `boxId` | 5 |

### Claim

```sql
-- 1. Refuse without changes if the person has no member key, or is already a member.

-- 2. Mark the invite. Only one request can change the row.
UPDATE invites SET used_by = :me, used_at = :now
WHERE id = :id
  AND used_by IS NULL
  AND canceled_at IS NULL
  AND invite_file IS NOT NULL
  AND expires_at > :now;

-- 3. If 0 rows changed: allow it only if used_by = :me and the invite is not
--    completed or canceled (a retry). Else 410 with the reason.
SELECT * FROM invites WHERE id = :id;
```

### Complete

```sql
BEGIN;
UPDATE invites SET completed_at = :now, invite_file = NULL
WHERE id = :id AND used_by = :me AND completed_at IS NULL AND canceled_at IS NULL
RETURNING box_id, name, created_by;          -- 0 rows: 410

INSERT INTO memberships (box_id, user_id, name, key_copy, invited_by, joined_at)
VALUES (:box_id, :me, :name, :key_copy, :created_by, :now);   -- the name from the invite
COMMIT;
```

## Remove a member and change the box key

`POST /api/boxes/:id/rotate`, Member. Input: `removeUserIds`, `recipient` (new box public key), `keyHistory` (locked), `keyCopies` (one locked key copy for each member who stays), `expectedKeyVersion`.

```sql
BEGIN;
SELECT key_version FROM boxes WHERE id = :box FOR UPDATE;   -- version must agree, else 409
-- A member cannot remove themselves.
-- keyCopies must have exactly one entry for each member who stays, else 409.
DELETE FROM memberships WHERE box_id = :box AND user_id = :removed;
UPDATE memberships SET key_copy = :copy WHERE box_id = :box AND user_id = :member;  -- for each member
UPDATE boxes SET recipient = :new_public, key_history = :history, key_version = key_version + 1 WHERE id = :box;
UPDATE invites SET canceled_at = :now, invite_file = NULL
WHERE box_id = :box AND completed_at IS NULL AND canceled_at IS NULL;
COMMIT;
```

See [document 7](../07-storage.md#key-history-after-a-member-is-removed).

## On each cold start (Vercel)

The function runs `CREATE TABLE IF NOT EXISTS …` for all tables, inside a transaction with `pg_advisory_xact_lock`. The lock stops two new instances from making tables at the same time. The schema is in `server/db.ts`.

The same step upgrades a database from the first version. It adds the `name` columns and fills them. It makes the old `role` and `label` columns optional, but it does not delete them. So an older deployment that uses the same database continues to work.

[← All documents](../README.md)
