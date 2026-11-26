// Postgres access, behind a tiny interface so the same app runs on
// real Postgres (Neon on Vercel, via `pg`) and on PGlite (local dev + tests,
// Postgres compiled to WASM, no install needed).
//
// Every column that holds a secret holds an age file (BYTEA). The server can't
// open any of them: it never sees a passkey PRF output or an age identity.

export type Row = Record<string, any>;

export interface Queryable {
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  one(sql: string, ...params: unknown[]): Promise<Row | undefined>;
  /** Returns the number of affected rows. */
  run(sql: string, ...params: unknown[]): Promise<number>;
}

export interface Db extends Queryable {
  /** Runs fn in a transaction. Throwing rolls back. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs several statements in one round trip (no parameters). */
  exec(sql: string): Promise<void>;
}

/** Converts `?` placeholders to Postgres `$1, $2, ...`. Our SQL has no literal `?`. */
export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Byte params go to Postgres as Buffers (a Uint8Array subclass both drivers accept). */
export function params(values: unknown[]): unknown[] {
  return values.map((v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v));
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  nickname         TEXT NOT NULL,
  webauthn_user_id TEXT NOT NULL,
  member_recipient TEXT,              -- age1... public key of the member key
  created_at       BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id         TEXT PRIMARY KEY,        -- WebAuthn credential ID (base64url)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,          -- for login only
  counter    BIGINT NOT NULL,
  transports TEXT NOT NULL,           -- JSON array
  envelope   BYTEA,                   -- age file: member identity, locked to this passkey (fido2prf)
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

-- Short-lived WebAuthn challenges. In the database, not in memory, because
-- serverless functions don't share memory between requests.
CREATE TABLE IF NOT EXISTS webauthn_flows (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  data       TEXT NOT NULL,           -- JSON
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS boxes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  recipient   TEXT NOT NULL,          -- age1... public key of the current box key
  key_version INTEGER NOT NULL DEFAULT 1,
  key_history BYTEA,                  -- age file: JSON array of old box identities, locked to the current box key
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
  key_copy   BYTEA NOT NULL,          -- age file: box identity, locked to the member key
  invited_by TEXT,
  joined_at  BIGINT NOT NULL,
  PRIMARY KEY (box_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,          -- age file, locked to a box key (current or older)
  size       INTEGER NOT NULL,
  added_by   TEXT,                    -- user id, or NULL when added with an ingest token
  source     TEXT NOT NULL,           -- 'app' or 'ingest:<label>'
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_box ON items (box_id);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  box_id       TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
  invite_file  BYTEA,                 -- age file: box identity, locked to a one-time key; NULL once done
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  used_by      TEXT REFERENCES users(id),
  used_at      BIGINT,
  completed_at BIGINT,
  canceled_at  BIGINT
);
CREATE INDEX IF NOT EXISTS invites_box ON invites (box_id);

CREATE TABLE IF NOT EXISTS ingest_tokens (
  token_hash TEXT PRIMARY KEY,
  box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);
`;

/** Creates the tables if needed. The advisory lock stops two cold starts racing. */
export async function migrate(db: Db): Promise<void> {
  await db.exec(`BEGIN; SELECT pg_advisory_xact_lock(727269); ${SCHEMA} COMMIT;`);
}
