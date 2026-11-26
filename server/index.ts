import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import * as age from "age-encryption";
import { openDb, tx } from "./db.ts";

// ---------------------------------------------------------------------------
// Config

const PORT = Number(process.env.PORT ?? 8787);
const RP_ID = process.env.RP_ID ?? "localhost";
const RP_NAME = process.env.RP_NAME ?? "Secretbox";
const ORIGINS = (process.env.ORIGINS ?? `http://localhost:${PORT},http://localhost:5173`)
  .split(",")
  .map((s) => s.trim());
const DB_PATH = process.env.DB_PATH ?? "secretbox.db";
const STATIC_DIR = process.env.STATIC_DIR ?? "dist";
const SECURE_COOKIE = ORIGINS[0].startsWith("https://");

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const FLOW_TTL = 5 * 60 * 1000;
const MAX_INVITE_TTL_HOURS = 24 * 7;
const MAX_ITEM_BYTES = 10 * 1024 * 1024;

const db = openDb(DB_PATH);

// ---------------------------------------------------------------------------
// Helpers

const now = () => Date.now();
const newId = (bytes = 16) => randomBytes(bytes).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const toB64 = (u: Uint8Array | null | undefined) => (u ? Buffer.from(u).toString("base64") : null);
const fromB64 = (s: unknown, field: string): Uint8Array => {
  if (typeof s !== "string" || s.length === 0) bad(`${field} is required`);
  const buf = Buffer.from(s as string, "base64");
  if (!isAgeFile(buf)) bad(`${field} is not an age file`);
  return new Uint8Array(buf);
};
const isAgeFile = (u: Uint8Array) =>
  Buffer.from(u.subarray(0, 21)).toString("latin1") === "age-encryption.org/v1";
const isRecipient = (s: unknown): s is string =>
  typeof s === "string" && /^age1[0-9a-z]{20,}$/.test(s);

function bad(message: string, status: 400 | 401 | 403 | 404 | 409 | 410 = 400): never {
  throw new HTTPException(status, { message });
}

type Row = Record<string, any>;
const one = (sql: string, ...args: any[]): Row | undefined =>
  db.prepare(sql).get(...args) as Row | undefined;
const all = (sql: string, ...args: any[]): Row[] => db.prepare(sql).all(...args) as Row[];
const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);

// Short-lived WebAuthn ceremonies. In-memory is fine for a single-process PoC.
type Flow = { challenge: string; expires: number; data?: Row };
const flows = new Map<string, Flow>();
function startFlow(challenge: string, data?: Row): string {
  for (const [id, f] of flows) if (f.expires < now()) flows.delete(id);
  const id = newId();
  flows.set(id, { challenge, data, expires: now() + FLOW_TTL });
  return id;
}
function takeFlow(id: unknown): Flow {
  const flow = typeof id === "string" ? flows.get(id) : undefined;
  if (!flow || flow.expires < now()) bad("Passkey request expired, try again");
  flows.delete(id as string);
  return flow!;
}

function startSession(c: Context, userId: string, passkeyId: string) {
  const token = newId(32);
  run(
    "INSERT INTO sessions (token_hash, user_id, passkey_id, expires_at) VALUES (?, ?, ?, ?)",
    sha256(token), userId, passkeyId, now() + SESSION_TTL,
  );
  setCookie(c, "sb_session", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: SECURE_COOKIE,
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

function auth(c: Context): { userId: string; passkeyId: string } {
  const token = getCookie(c, "sb_session");
  if (!token) bad("Sign in first", 401);
  const s = one("SELECT user_id, passkey_id, expires_at FROM sessions WHERE token_hash = ?", sha256(token!));
  if (!s || s.expires_at < now()) bad("Sign in first", 401);
  return { userId: s!.user_id, passkeyId: s!.passkey_id };
}

function membership(boxId: string, userId: string): Row {
  const m = one("SELECT role, key_copy FROM memberships WHERE box_id = ? AND user_id = ?", boxId, userId);
  if (!m) bad("You are not a member of this box", 403);
  return m!;
}

function requireAdmin(boxId: string, userId: string): Row {
  const m = membership(boxId, userId);
  if (m.role !== "admin") bad("Only admins can do this", 403);
  return m;
}

function inviteStatus(inv: Row): "open" | "used" | "expired" | "canceled" {
  if (inv.canceled_at) return "canceled";
  if (inv.completed_at || inv.used_by) return "used";
  if (inv.expires_at < now()) return "expired";
  return "open";
}

// ---------------------------------------------------------------------------
// App

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// CSRF: browsers can't send this header cross-site without a CORS preflight,
// which this server never approves. Ingest uses a bearer token instead.
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && !c.req.path.startsWith("/api/ingest/")) {
    if (c.req.header("x-secretbox") !== "1") bad("Missing x-secretbox header", 403);
  }
  await next();
});

// --- Passkey registration (new account) ------------------------------------

app.post("/api/register/options", async (c) => {
  const { nickname } = await c.req.json();
  if (typeof nickname !== "string" || !nickname.trim() || nickname.length > 60) bad("Nickname is required");
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: nickname.trim(),
    userDisplayName: nickname.trim(),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    // PRF is what lets the same passkey also unlock the member key.
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  });
  const flowId = startFlow(options.challenge, { nickname: nickname.trim(), webauthnUserId: options.user.id });
  return c.json({ flowId, options });
});

app.post("/api/register/verify", async (c) => {
  const { flowId, response } = await c.req.json();
  const flow = takeFlow(flowId);
  if (response?.clientExtensionResults?.prf?.enabled !== true) {
    bad("This passkey provider does not support PRF, so it can't unlock data. Try Apple Passwords, Google Password Manager or a recent security key.");
  }
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: flow.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  }).catch((e) => bad(`Passkey check failed: ${e.message}`));
  if (!result.verified) bad("Passkey check failed");
  const { credential } = result.registrationInfo;

  const userId = newId();
  tx(db, () => {
    run(
      "INSERT INTO users (id, nickname, webauthn_user_id, created_at) VALUES (?, ?, ?, ?)",
      userId, flow.data!.nickname, flow.data!.webauthnUserId, now(),
    );
    run(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      credential.id, userId, credential.publicKey, credential.counter,
      JSON.stringify(credential.transports ?? []), now(),
    );
  });
  startSession(c, userId, credential.id);
  return c.json({ ok: true });
});

// --- Passkey login ---------------------------------------------------------

app.post("/api/login/options", async (c) => {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required" });
  return c.json({ flowId: startFlow(options.challenge), options });
});

app.post("/api/login/verify", async (c) => {
  const { flowId, response } = await c.req.json();
  const flow = takeFlow(flowId);
  const pk = one("SELECT * FROM passkeys WHERE id = ?", response?.id);
  if (!pk) bad("Unknown passkey. Was it made for another site or deleted?", 401);
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: flow.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: {
      id: pk!.id,
      publicKey: pk!.public_key,
      counter: pk!.counter,
      transports: JSON.parse(pk!.transports) as AuthenticatorTransport[],
    },
  }).catch((e) => bad(`Passkey check failed: ${e.message}`, 401));
  if (!result.verified) bad("Passkey check failed", 401);
  run("UPDATE passkeys SET counter = ? WHERE id = ?", result.authenticationInfo.newCounter, pk!.id);
  startSession(c, pk!.user_id, pk!.id);
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  const token = getCookie(c, "sb_session");
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  deleteCookie(c, "sb_session", { path: "/" });
  return c.json({ ok: true });
});

// --- Me: member key ----------------------------------------------------------

app.get("/api/me", (c) => {
  const { userId, passkeyId } = auth(c);
  const u = one("SELECT id, nickname, member_recipient FROM users WHERE id = ?", userId)!;
  const pk = one("SELECT id, transports, envelope IS NOT NULL AS has_envelope FROM passkeys WHERE id = ?", passkeyId)!;
  return c.json({
    id: u.id,
    nickname: u.nickname,
    memberRecipient: u.member_recipient,
    passkey: { id: pk.id, transports: JSON.parse(pk.transports), hasEnvelope: !!pk.has_envelope },
  });
});

// Called once, right after registration: the browser made a member key and
// locked it to this passkey. The server stores the public half and the envelope.
app.put("/api/me/keys", async (c) => {
  const { userId, passkeyId } = auth(c);
  const { memberRecipient, envelope } = await c.req.json();
  if (!isRecipient(memberRecipient)) bad("memberRecipient must be an age1... recipient");
  const env = fromB64(envelope, "envelope");
  const u = one("SELECT member_recipient FROM users WHERE id = ?", userId)!;
  if (u.member_recipient) bad("Member key already set", 409);
  tx(db, () => {
    run("UPDATE users SET member_recipient = ? WHERE id = ?", memberRecipient, userId);
    run("UPDATE passkeys SET envelope = ? WHERE id = ?", env, passkeyId);
  });
  return c.json({ ok: true });
});

app.get("/api/me/envelope", (c) => {
  const { passkeyId } = auth(c);
  const pk = one("SELECT envelope FROM passkeys WHERE id = ?", passkeyId)!;
  if (!pk.envelope) bad("No envelope for this passkey", 404);
  return c.json({ envelope: toB64(pk.envelope) });
});

// --- Boxes -------------------------------------------------------------------

app.get("/api/boxes", (c) => {
  const { userId } = auth(c);
  const boxes = all(
    `SELECT b.id, b.name, m.role,
       (SELECT COUNT(*) FROM items i WHERE i.box_id = b.id) AS item_count,
       (SELECT COUNT(*) FROM memberships x WHERE x.box_id = b.id) AS member_count
     FROM boxes b JOIN memberships m ON m.box_id = b.id
     WHERE m.user_id = ? ORDER BY b.created_at DESC`,
    userId,
  );
  return c.json({ boxes });
});

app.post("/api/boxes", async (c) => {
  const { userId } = auth(c);
  const { name, recipient, keyCopy } = await c.req.json();
  if (typeof name !== "string" || !name.trim() || name.length > 100) bad("Box name is required");
  if (!isRecipient(recipient)) bad("recipient must be an age1... recipient");
  const copy = fromB64(keyCopy, "keyCopy");
  const u = one("SELECT member_recipient FROM users WHERE id = ?", userId)!;
  if (!u.member_recipient) bad("Set up your member key first", 409);
  const id = newId();
  tx(db, () => {
    run(
      "INSERT INTO boxes (id, name, recipient, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      id, name.trim(), recipient, userId, now(),
    );
    run(
      "INSERT INTO memberships (box_id, user_id, role, key_copy, joined_at) VALUES (?, ?, 'admin', ?, ?)",
      id, userId, copy, now(),
    );
  });
  return c.json({ id });
});

app.get("/api/boxes/:id", (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  const me = membership(boxId, userId);
  const box = one("SELECT * FROM boxes WHERE id = ?", boxId)!;
  const isAdmin = me.role === "admin";
  return c.json({
    box: {
      id: box.id,
      name: box.name,
      recipient: box.recipient,
      keyVersion: box.key_version,
      keyHistory: toB64(box.key_history),
    },
    me: { userId, role: me.role, keyCopy: toB64(me.key_copy) },
    members: all(
      `SELECT u.id AS userId, u.nickname, u.member_recipient AS recipient, m.role, m.joined_at AS joinedAt
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.box_id = ? ORDER BY m.joined_at`,
      boxId,
    ),
    items: all(
      `SELECT i.id, i.name, i.size, i.source, i.created_at AS createdAt, u.nickname AS addedBy
       FROM items i LEFT JOIN users u ON u.id = i.added_by WHERE i.box_id = ? ORDER BY i.created_at DESC`,
      boxId,
    ),
    invites: isAdmin
      ? all(
          `SELECT i.*, u.nickname AS used_by_name FROM invites i LEFT JOIN users u ON u.id = i.used_by
           WHERE i.box_id = ? ORDER BY i.created_at DESC LIMIT 50`,
          boxId,
        ).map((i) => ({
          id: i.id, label: i.label, role: i.role, status: inviteStatus(i),
          expiresAt: i.expires_at, usedBy: i.used_by_name, createdAt: i.created_at,
        }))
      : [],
    ingestTokens: isAdmin
      ? all("SELECT label, created_at AS createdAt FROM ingest_tokens WHERE box_id = ? ORDER BY created_at", boxId)
      : [],
  });
});

// --- Items ---------------------------------------------------------------------

function storeItem(boxId: string, name: string, body: Uint8Array, addedBy: string | null, source: string) {
  let bytes = body;
  // Accept ASCII-armored files from the age CLI (`age -a`) and store them as binary.
  if (Buffer.from(bytes.subarray(0, 34)).toString("latin1") === "-----BEGIN AGE ENCRYPTED FILE-----") {
    try {
      bytes = age.armor.decode(Buffer.from(bytes).toString("utf8"));
    } catch {
      bad("Invalid armored age file");
    }
  }
  if (!isAgeFile(bytes)) bad("Body must be an age file. The server never accepts plaintext.");
  if (!name.trim() || name.length > 200) bad("name is required");
  const id = newId();
  run(
    "INSERT INTO items (id, box_id, name, ciphertext, size, added_by, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id, boxId, name.trim(), bytes, bytes.length, addedBy, source, now(),
  );
  return id;
}

app.post("/api/boxes/:id/items", bodyLimit({ maxSize: MAX_ITEM_BYTES }), async (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  requireAdmin(boxId, userId);
  const body = new Uint8Array(await c.req.arrayBuffer());
  const id = storeItem(boxId, c.req.query("name") ?? "", body, userId, "app");
  return c.json({ id });
});

app.get("/api/boxes/:id/items/:itemId", (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  membership(boxId, userId);
  const item = one("SELECT ciphertext FROM items WHERE id = ? AND box_id = ?", c.req.param("itemId"), boxId);
  if (!item) bad("Not found", 404);
  return c.body(Buffer.from(item!.ciphertext), 200, { "content-type": "application/octet-stream" });
});

app.delete("/api/boxes/:id/items/:itemId", (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  requireAdmin(boxId, userId);
  run("DELETE FROM items WHERE id = ? AND box_id = ?", c.req.param("itemId"), boxId);
  return c.json({ ok: true });
});

// Outside systems (a form tool, a script) add data with a bearer token. They
// only know the box's public age1... recipient, so they can add but never read.
app.post("/api/boxes/:id/ingest-tokens", async (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  requireAdmin(boxId, userId);
  const { label } = await c.req.json();
  if (typeof label !== "string" || !label.trim()) bad("label is required");
  const token = `sbx_${newId(24)}`;
  run(
    "INSERT INTO ingest_tokens (token_hash, box_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    sha256(token), boxId, label.trim(), userId, now(),
  );
  return c.json({ token });
});

app.post("/api/ingest/:boxId", bodyLimit({ maxSize: MAX_ITEM_BYTES }), async (c) => {
  const boxId = c.req.param("boxId");
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const t = one("SELECT label FROM ingest_tokens WHERE token_hash = ? AND box_id = ?", sha256(token), boxId);
  if (!t) bad("Invalid ingest token", 401);
  const body = new Uint8Array(await c.req.arrayBuffer());
  const name = c.req.query("name") ?? `submission-${new Date().toISOString()}`;
  const id = storeItem(boxId, name, body, null, `ingest:${t!.label}`);
  return c.json({ id });
});

// --- Invites -------------------------------------------------------------------

app.post("/api/boxes/:id/invites", async (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  requireAdmin(boxId, userId);
  const { label, role, inviteFile, ttlHours, keyVersion } = await c.req.json();
  if (typeof label !== "string" || !label.trim() || label.length > 100) bad("label is required");
  if (role !== "reader" && role !== "admin") bad("role must be reader or admin");
  const file = fromB64(inviteFile, "inviteFile");
  const hours = Math.min(Math.max(Number(ttlHours) || 24, 1), MAX_INVITE_TTL_HOURS);
  const box = one("SELECT key_version FROM boxes WHERE id = ?", boxId)!;
  // The invite file holds the box key. If the key changed meanwhile, it's stale.
  if (keyVersion !== box.key_version) bad("The box key changed. Reload and try again.", 409);
  const id = newId();
  run(
    `INSERT INTO invites (id, box_id, label, role, invite_file, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, boxId, label.trim(), role, file, userId, now(), now() + hours * 3600 * 1000,
  );
  return c.json({ id });
});

app.delete("/api/boxes/:id/invites/:inviteId", (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  requireAdmin(boxId, userId);
  run(
    "UPDATE invites SET canceled_at = ?, invite_file = NULL WHERE id = ? AND box_id = ? AND completed_at IS NULL",
    now(), c.req.param("inviteId"), boxId,
  );
  return c.json({ ok: true });
});

// Public: lets the join page show what the link is for. It never changes
// state, so link previews (LINE, Slack, iMessage) can't burn the invite.
app.get("/api/invites/:id", (c) => {
  const inv = one(
    `SELECT i.*, b.name AS box_name, u.nickname AS invited_by FROM invites i
     JOIN boxes b ON b.id = i.box_id JOIN users u ON u.id = i.created_by WHERE i.id = ?`,
    c.req.param("id"),
  );
  if (!inv) bad("Invite not found", 404);
  return c.json({
    boxId: inv!.box_id, boxName: inv!.box_name, label: inv!.label, role: inv!.role,
    invitedBy: inv!.invited_by, status: inviteStatus(inv!), expiresAt: inv!.expires_at,
  });
});

// Step 1 of joining: atomically mark the invite as used by this user and hand
// over the invite file. Only the URL fragment's one-time key can open it.
app.post("/api/invites/:id/claim", (c) => {
  const { userId } = auth(c);
  const id = c.req.param("id");
  const inv = one("SELECT * FROM invites WHERE id = ?", id);
  if (!inv) bad("Invite not found", 404);
  const u = one("SELECT member_recipient FROM users WHERE id = ?", userId)!;
  if (!u.member_recipient) bad("Set up your member key first", 409);
  if (one("SELECT 1 FROM memberships WHERE box_id = ? AND user_id = ?", inv!.box_id, userId)) {
    bad("You are already a member of this box. The invite is still unused.", 409);
  }
  const res = run(
    `UPDATE invites SET used_by = ?, used_at = ?
     WHERE id = ? AND used_by IS NULL AND canceled_at IS NULL AND invite_file IS NOT NULL AND expires_at > ?`,
    userId, now(), id, now(),
  );
  const fresh = one("SELECT * FROM invites WHERE id = ?", id)!;
  const isRetry = res.changes === 0 && fresh.used_by === userId && !fresh.completed_at && !fresh.canceled_at;
  if (res.changes === 0 && !isRetry) {
    const status = inviteStatus(fresh);
    bad(status === "expired" ? "This invite has expired." : status === "canceled"
      ? "This invite was canceled." : "This invite was already used.", 410);
  }
  return c.json({ boxId: fresh.box_id, role: fresh.role, inviteFile: toB64(fresh.invite_file) });
});

// Step 2 of joining: the browser re-locked the box key to the new member key.
app.post("/api/invites/:id/complete", async (c) => {
  const { userId } = auth(c);
  const id = c.req.param("id");
  const { keyCopy } = await c.req.json();
  const copy = fromB64(keyCopy, "keyCopy");
  const inv = one("SELECT * FROM invites WHERE id = ?", id);
  if (!inv || inv.used_by !== userId) bad("Claim the invite first", 409);
  if (inv!.canceled_at) bad("This invite was canceled.", 410);
  if (inv!.completed_at) bad("This invite was already used.", 410);
  tx(db, () => {
    run(
      "INSERT INTO memberships (box_id, user_id, role, key_copy, invited_by, joined_at) VALUES (?, ?, ?, ?, ?, ?)",
      inv!.box_id, userId, inv!.role, copy, inv!.created_by, now(),
    );
    run("UPDATE invites SET completed_at = ?, invite_file = NULL WHERE id = ?", now(), id);
  });
  return c.json({ boxId: inv!.box_id });
});

// --- Remove members + change the box key -------------------------------------------

app.post("/api/boxes/:id/rotate", async (c) => {
  const { userId } = auth(c);
  const boxId = c.req.param("id");
  requireAdmin(boxId, userId);
  const { removeUserIds = [], recipient, keyHistory, keyCopies, expectedKeyVersion } = await c.req.json();
  if (!Array.isArray(removeUserIds)) bad("removeUserIds must be an array");
  if (removeUserIds.includes(userId)) bad("You can't remove yourself");
  if (!isRecipient(recipient)) bad("recipient must be an age1... recipient");
  const history = fromB64(keyHistory, "keyHistory");
  if (typeof keyCopies !== "object" || !keyCopies) bad("keyCopies is required");

  const box = one("SELECT key_version FROM boxes WHERE id = ?", boxId)!;
  if (expectedKeyVersion !== box.key_version) bad("The box key changed. Reload and try again.", 409);

  const members = all("SELECT user_id FROM memberships WHERE box_id = ?", boxId).map((m) => m.user_id as string);
  for (const r of removeUserIds) if (!members.includes(r)) bad("Unknown member to remove");
  const staying = members.filter((m) => !removeUserIds.includes(m)).sort();
  const given = Object.keys(keyCopies).sort();
  // Every member who stays must get a copy of the new key, or they'd be locked out.
  if (JSON.stringify(staying) !== JSON.stringify(given)) {
    bad("Members changed. Reload and try again.", 409);
  }
  const copies = Object.fromEntries(given.map((id) => [id, fromB64(keyCopies[id], "keyCopies")]));

  tx(db, () => {
    for (const r of removeUserIds) run("DELETE FROM memberships WHERE box_id = ? AND user_id = ?", boxId, r);
    for (const [uid, copy] of Object.entries(copies)) {
      run("UPDATE memberships SET key_copy = ? WHERE box_id = ? AND user_id = ?", copy, boxId, uid);
    }
    run(
      "UPDATE boxes SET recipient = ?, key_history = ?, key_version = key_version + 1 WHERE id = ?",
      recipient, history, boxId,
    );
    // Open invites hold the old box key: cancel them all.
    run(
      "UPDATE invites SET canceled_at = ?, invite_file = NULL WHERE box_id = ? AND completed_at IS NULL AND canceled_at IS NULL",
      now(), boxId,
    );
  });
  return c.json({ ok: true, keyVersion: box.key_version + 1 });
});

// ---------------------------------------------------------------------------
// Static web app (built by Vite into dist/). Any non-API path serves the SPA.

// The page decrypts data, so a strict CSP matters: no inline or third-party scripts.
const HTML_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

if (existsSync(`${STATIC_DIR}/index.html`)) {
  app.use("/assets/*", serveStatic({ root: STATIC_DIR }));
  const indexHtml = readFileSync(`${STATIC_DIR}/index.html`, "utf8");
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml, 200, HTML_HEADERS)));
} else {
  console.warn(`No ${STATIC_DIR}/index.html. Run "npm run build", or use "npm run dev" for the Vite dev server.`);
}

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Secretbox on http://localhost:${PORT}  (RP ID ${RP_ID}, DB ${DB_PATH})`);
});
