// Postgres access, behind a tiny interface so the same app runs on
// real Postgres (Neon on Vercel, via `pg`) and on PGlite (local dev + tests,
// Postgres compiled to WASM, no install needed).
//
// Every column that holds something private holds an age file (BYTEA). The
// server can't open any of them: it never sees a passkey PRF output or an age
// identity. It sees the access key on each request, but only stores its hash.

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

// Four tables. There are no accounts: a member is a passkey that has an
// envelope for the box. "_locked" columns are age files locked to the box's
// public key, so only members can read them.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes (
  id          TEXT PRIMARY KEY,       -- also the user ID of every passkey for this box
  public_key  TEXT NOT NULL,          -- age1... anybody can lock data to it
  name_locked BYTEA NOT NULL,         -- age file: the box name
  access_hash TEXT NOT NULL,          -- SHA-256 of the access key (derived from the box private key)
  add_hash    TEXT,                   -- SHA-256 of the add key for outside systems, if one exists
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  box_id        TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,        -- the passkey's ID (base64url)
  envelope      BYTEA NOT NULL,       -- age file: the box private key, locked to this passkey's key
  name_locked   BYTEA NOT NULL,       -- age file: {"name", "invitedBy"}
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (box_id, credential_id)
);

CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  box_id       TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  label_locked BYTEA,                 -- age file: {"name", "type", "addedBy"}; NULL from outside systems
  data_locked  BYTEA NOT NULL,        -- age file: the data
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_box ON items (box_id);

-- One row per open invite. Opening the link deletes the row.
CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  box_id      TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  invite_file BYTEA NOT NULL,         -- age file: box private key + names, locked to a one-time key
  name_locked BYTEA NOT NULL,         -- age file: {"name", "invitedBy"}, for the list of open invites
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_box ON invites (box_id);
CREATE INDEX IF NOT EXISTS invites_expires ON invites (expires_at);
`;

// The live database on Vercel was made by the first version (accounts, roles,
// plain-text names). A deployment of that version may still share it, so this
// only adds columns and relaxes old NOT NULL columns. Old rows stay, and the
// app never reads them: old boxes have no access_hash. Remove this once the
// old tables are dropped.
export const UPGRADE_FROM_V1 = `
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS name_locked BYTEA;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS access_hash TEXT;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS add_hash TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS label_locked BYTEA;
ALTER TABLE items ADD COLUMN IF NOT EXISTS data_locked BYTEA;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS name_locked BYTEA;
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND is_nullable = 'NO'
      AND (table_name::text, column_name::text) IN (
        ('boxes', 'name'), ('boxes', 'recipient'), ('boxes', 'created_by'),
        ('items', 'name'), ('items', 'ciphertext'), ('items', 'size'), ('items', 'source'),
        ('invites', 'label'), ('invites', 'role'), ('invites', 'created_by'), ('invites', 'created_at'))
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', c.table_name, c.column_name);
  END LOOP;
END $$;
`;

/** Creates the tables if needed. The advisory lock stops two cold starts racing. */
export async function migrate(db: Db): Promise<void> {
  await db.exec(`BEGIN; SELECT pg_advisory_xact_lock(727269); ${SCHEMA} ${UPGRADE_FROM_V1} COMMIT;`);
}
