import { DatabaseSync } from "node:sqlite";

// Every column that holds a secret holds an age file (BLOB). The server can't
// open any of them: it never sees a passkey PRF output or an age identity.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  nickname         TEXT NOT NULL,
  webauthn_user_id TEXT NOT NULL,
  member_recipient TEXT,              -- age1... public key of the member key
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id         TEXT PRIMARY KEY,        -- WebAuthn credential ID (base64url)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,           -- for login only
  counter    INTEGER NOT NULL,
  transports TEXT NOT NULL,           -- JSON array
  envelope   BLOB,                    -- age file: member identity, locked to this passkey (fido2prf)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boxes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  recipient   TEXT NOT NULL,          -- age1... public key of the current box key
  key_version INTEGER NOT NULL DEFAULT 1,
  key_history BLOB,                   -- age file: JSON array of old box identities, locked to the current box key
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
  key_copy   BLOB NOT NULL,           -- age file: box identity, locked to the member key
  invited_by TEXT,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (box_id, user_id)
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  ciphertext BLOB NOT NULL,           -- age file, locked to a box key (current or older)
  size       INTEGER NOT NULL,
  added_by   TEXT,                    -- user id, or NULL when added with an ingest token
  source     TEXT NOT NULL,           -- 'app' or 'ingest:<label>'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  box_id       TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
  invite_file  BLOB,                  -- age file: box identity, locked to a one-time key; NULL once done
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_by      TEXT REFERENCES users(id),
  used_at      INTEGER,
  completed_at INTEGER,
  canceled_at  INTEGER
);

CREATE TABLE IF NOT EXISTS ingest_tokens (
  token_hash TEXT PRIMARY KEY,
  box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction. node:sqlite is synchronous, so this is safe. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
