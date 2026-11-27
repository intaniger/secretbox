// The HTTP API. It runs the same way on Vercel (server/vercel.ts) and locally
// (server/node.ts); only the database differs.
//
// There are no accounts, sessions or cookies. A box has one key pair. Whoever
// holds the box private key is a member, and proves it on each request with
// the box's ACCESS KEY: the browser derives it from the private key, and the
// server only stores its SHA-256 hash. Passkeys never talk to the server: the
// browser uses them only to unlock an envelope that holds the box private key.

import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import * as age from "age-encryption";
import type { Db } from "./db.ts";

const MAX_INVITE_TTL_HOURS = 24 * 7;
// Vercel Functions accept request bodies up to 4.5 MB.
export const MAX_ITEM_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers

const now = () => Date.now();
const newId = (bytes = 16) => randomBytes(bytes).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const toB64 = (u: Uint8Array | null | undefined) => (u ? Buffer.from(u).toString("base64") : null);
const isAgeFile = (u: Uint8Array) =>
  Buffer.from(u.subarray(0, 21)).toString("latin1") === "age-encryption.org/v1";
const isRecipient = (s: unknown): s is string => typeof s === "string" && /^age1[0-9a-z]{20,}$/.test(s);
/** Box IDs and passkey credential IDs are base64url. */
const isId = (s: unknown, max = 64): s is string =>
  typeof s === "string" && s.length >= 16 && s.length <= max && /^[\w-]+$/.test(s);

function bad(message: string, status: 400 | 401 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message });
}

/** A base64 age file from a JSON body. The server never accepts plaintext. */
function ageFile(s: unknown, field: string): Uint8Array {
  if (typeof s !== "string" || s.length === 0) bad(`${field} is required`);
  const buf = new Uint8Array(Buffer.from(s as string, "base64"));
  if (!isAgeFile(buf)) bad(`${field} is not an age file`);
  return buf;
}

/** Accepts binary age files and ASCII-armored ones (`age -a`), and stores binary. */
function ageBody(bytes: Uint8Array, field: string): Uint8Array {
  if (Buffer.from(bytes.subarray(0, 34)).toString("latin1") === "-----BEGIN AGE ENCRYPTED FILE-----") {
    try {
      bytes = age.armor.decode(Buffer.from(bytes).toString("utf8"));
    } catch {
      bad(`${field}: invalid armored age file`);
    }
  }
  if (!isAgeFile(bytes)) bad(`${field} must be an age file. The server never accepts plaintext.`);
  return bytes;
}

const bearer = (c: Context) => c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";

// ---------------------------------------------------------------------------

export function createApp(db: Db): Hono {
  const app = new Hono();

  /** Members only: the request must carry the box's access key. Returns the box ID. */
  async function member(c: Context): Promise<string> {
    const boxId = c.req.param("id")!;
    const key = bearer(c);
    const box = key && (await db.one("SELECT id FROM boxes WHERE id = ? AND access_hash = ?", boxId, sha256(key)));
    if (!box) bad("This key does not open this box", 401);
    return boxId;
  }

  /** Expired invites are deleted, so their invite files are gone too. */
  const deleteExpiredInvites = () => db.run("DELETE FROM invites WHERE expires_at <= ?", now());

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  const limit = bodyLimit({
    maxSize: MAX_ITEM_BYTES,
    onError: (c) => c.json({ error: `Too large. The limit is ${MAX_ITEM_BYTES / 1024 / 1024} MB.` }, 413),
  });

  // --- Boxes ----------------------------------------------------------------------------

  // Make a box and its first member in one step. The browser chose the box ID
  // (it is the passkey's user ID) and sends the new access key as the bearer.
  app.post("/api/boxes", async (c) => {
    const access = bearer(c);
    if (!access) bad("Send the box's access key", 401);
    const { id, publicKey, nameLocked, member: m } = await c.req.json();
    if (!isId(id)) bad("id must be 16 to 64 base64url characters");
    if (!isRecipient(publicKey)) bad("publicKey must be an age1... public key");
    const name = ageFile(nameLocked, "nameLocked");
    if (!isId(m?.credentialId, 1400)) bad("member.credentialId is required");
    const envelope = ageFile(m.envelope, "member.envelope");
    const memberName = ageFile(m.nameLocked, "member.nameLocked");
    await db.tx(async (q) => {
      const n = await q.run(
        `INSERT INTO boxes (id, public_key, name_locked, access_hash, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        id, publicKey, name, sha256(access), now(),
      );
      if (n !== 1) bad("A box with this ID exists", 409);
      await q.run(
        "INSERT INTO members (box_id, credential_id, envelope, name_locked, created_at) VALUES (?, ?, ?, ?, ?)",
        id, m.credentialId, envelope, memberName, now(),
      );
    });
    return c.json({ id });
  });

  // Public on purpose: the envelope opens only with the passkey itself.
  app.get("/api/boxes/:id/envelopes/:credentialId", async (c) => {
    const row = await db.one(
      "SELECT envelope FROM members WHERE box_id = ? AND credential_id = ?",
      c.req.param("id"), c.req.param("credentialId"),
    );
    if (!row) bad("This passkey can't open this box anymore. You may have been removed, or the box was deleted.", 404);
    return c.json({ envelope: toB64(row!.envelope) });
  });

  app.get("/api/boxes/:id", async (c) => {
    const boxId = await member(c);
    const [box, members, items, invites] = await Promise.all([
      db.one("SELECT public_key, name_locked, add_hash IS NOT NULL AS has_add_key FROM boxes WHERE id = ?", boxId),
      db.all("SELECT credential_id, name_locked, created_at FROM members WHERE box_id = ? ORDER BY created_at", boxId),
      db.all(
        `SELECT id, label_locked, octet_length(data_locked) AS size, created_at
         FROM items WHERE box_id = ? ORDER BY created_at DESC`,
        boxId,
      ),
      db.all("SELECT id, name_locked, expires_at FROM invites WHERE box_id = ? AND expires_at > ? ORDER BY expires_at", boxId, now()),
    ]);
    return c.json({
      id: boxId,
      publicKey: box!.public_key,
      nameLocked: toB64(box!.name_locked),
      hasAddKey: box!.has_add_key,
      members: members.map((m) => ({ credentialId: m.credential_id, nameLocked: toB64(m.name_locked), createdAt: m.created_at })),
      items: items.map((i) => ({ id: i.id, labelLocked: toB64(i.label_locked), size: i.size, createdAt: i.created_at })),
      invites: invites.map((i) => ({ id: i.id, nameLocked: toB64(i.name_locked), expiresAt: i.expires_at })),
    });
  });

  // --- Members ----------------------------------------------------------------------------

  // The last step of joining: the new member locked the box private key to their passkey.
  app.post("/api/boxes/:id/members", async (c) => {
    const boxId = await member(c);
    const { credentialId, envelope, nameLocked } = await c.req.json();
    if (!isId(credentialId, 1400)) bad("credentialId is required");
    const n = await db.run(
      `INSERT INTO members (box_id, credential_id, envelope, name_locked, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      boxId, credentialId, ageFile(envelope, "envelope"), ageFile(nameLocked, "nameLocked"), now(),
    );
    if (n !== 1) bad("This passkey is already a member", 409);
    return c.json({ ok: true });
  });

  // Deletes the envelope, so this passkey can no longer open the box. It can't
  // take back a box key that the member already copied: see docs/08-security.md.
  app.delete("/api/boxes/:id/members/:credentialId", async (c) => {
    const boxId = await member(c);
    await db.tx(async (q) => {
      const n = await q.run("DELETE FROM members WHERE box_id = ? AND credential_id = ?", boxId, c.req.param("credentialId"));
      if (n !== 1) bad("Not a member", 404);
      const left = await q.one("SELECT COUNT(*) AS n FROM members WHERE box_id = ?", boxId);
      if (Number(left!.n) === 0) bad("A box needs at least one member", 409);
    });
    return c.json({ ok: true });
  });

  // --- Items ------------------------------------------------------------------------------

  // Multipart: "label" and "data", both age files locked to the box's public key.
  app.post("/api/boxes/:id/items", limit, async (c) => {
    const boxId = await member(c);
    const body = await c.req.parseBody();
    const bytes = async (v: unknown, field: string) =>
      v instanceof File ? ageBody(new Uint8Array(await v.arrayBuffer()), field) : bad(`${field} is required`);
    const label = await bytes(body.label, "label");
    const data = await bytes(body.data, "data");
    const id = newId();
    await db.run(
      "INSERT INTO items (id, box_id, label_locked, data_locked, created_at) VALUES (?, ?, ?, ?, ?)",
      id, boxId, label, data, now(),
    );
    return c.json({ id });
  });

  app.get("/api/boxes/:id/items/:itemId", async (c) => {
    const boxId = await member(c);
    const item = await db.one("SELECT data_locked FROM items WHERE id = ? AND box_id = ?", c.req.param("itemId"), boxId);
    if (!item) bad("Not found", 404);
    return c.body(Buffer.from(item!.data_locked), 200, {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
    });
  });

  app.delete("/api/boxes/:id/items/:itemId", async (c) => {
    const boxId = await member(c);
    await db.run("DELETE FROM items WHERE id = ? AND box_id = ?", c.req.param("itemId"), boxId);
    return c.json({ ok: true });
  });

  // --- Outside systems --------------------------------------------------------------------

  // An outside system (a form tool, a script) gets the box's public key and an
  // ADD KEY. It can add data, but not read, list or delete anything.
  // Making a new add key replaces the old one.
  app.post("/api/boxes/:id/add-key", async (c) => {
    const boxId = await member(c);
    const addKey = `vlt_${newId(24)}`;
    await db.run("UPDATE boxes SET add_hash = ? WHERE id = ?", sha256(addKey), boxId);
    return c.json({ addKey });
  });

  app.delete("/api/boxes/:id/add-key", async (c) => {
    const boxId = await member(c);
    await db.run("UPDATE boxes SET add_hash = NULL WHERE id = ?", boxId);
    return c.json({ ok: true });
  });

  // The body is one age file. It has no locked label, so members see it as
  // "from an outside system".
  app.post("/api/ingest/:id", limit, async (c) => {
    const boxId = c.req.param("id");
    const key = bearer(c);
    const box = key && (await db.one("SELECT id FROM boxes WHERE id = ? AND add_hash = ?", boxId, sha256(key)));
    if (!box) bad("Invalid add key", 401);
    const data = ageBody(new Uint8Array(await c.req.arrayBuffer()), "body");
    const id = newId();
    await db.run("INSERT INTO items (id, box_id, data_locked, created_at) VALUES (?, ?, ?, ?)", id, boxId, data, now());
    return c.json({ id });
  });

  // --- Invites ----------------------------------------------------------------------------

  app.post("/api/boxes/:id/invites", async (c) => {
    const boxId = await member(c);
    const { inviteFile, nameLocked, ttlHours } = await c.req.json();
    const hours = Math.min(Math.max(Number(ttlHours) || 24, 1), MAX_INVITE_TTL_HOURS);
    const id = newId();
    await deleteExpiredInvites();
    await db.run(
      "INSERT INTO invites (id, box_id, invite_file, name_locked, expires_at) VALUES (?, ?, ?, ?, ?)",
      id, boxId, ageFile(inviteFile, "inviteFile"), ageFile(nameLocked, "nameLocked"), now() + hours * 3600 * 1000,
    );
    return c.json({ id });
  });

  app.delete("/api/boxes/:id/invites/:inviteId", async (c) => {
    const boxId = await member(c);
    await db.run("DELETE FROM invites WHERE id = ? AND box_id = ?", c.req.param("inviteId"), boxId);
    return c.json({ ok: true });
  });

  // Public: opening the link deletes the invite and hands over its file, once.
  // Only the one-time key after the link's "#" can open the file, and browsers
  // never send that part to the server. A POST, so link previews can't use it up.
  app.post("/api/invites/:id/claim", async (c) => {
    await deleteExpiredInvites();
    const inv = await db.one(
      "DELETE FROM invites WHERE id = ? AND expires_at > ? RETURNING box_id, invite_file",
      c.req.param("id"), now(),
    );
    if (!inv) bad("This link was already used, has expired, or was canceled.", 404);
    return c.json({ boxId: inv!.box_id, inviteFile: toB64(inv!.invite_file) });
  });

  return app;
}

// The page decrypts data, so a strict CSP matters: no inline or third-party scripts.
// no-store: the browser keeps no copy of the page, so Back after leaving the
// site loads it fresh (and locked) where browsers respect it for the back/forward cache.
export const HTML_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};
