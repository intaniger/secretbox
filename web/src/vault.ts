// The user actions, built from keys.ts, passkey.ts and the API. Each function
// notes how many passkey prompts (Face ID / fingerprint) it causes.

import { api, type BoxResponse } from "./api.ts";
import * as keys from "./keys.ts";
import { createPasskey, getPasskey } from "./passkey.ts";

/**
 * The open box. Lives only in this tab's memory, until "Lock", the auto-lock
 * in main.ts, or the tab closes. `key` is a non-extractable CryptoKey where the
 * browser allows it (keys.holdBoxKey).
 */
type Opened = { boxId: string; credentialId: string } & keys.HeldBoxKey;
let opened: Opened | null = null;

export const openBoxId = () => opened?.boxId ?? null;
export const lock = () => {
  opened = null;
};

/**
 * A name as it appears in a box. The person who invites types the name, so
 * the person who made the box has none: `name` is "" for them. `invitedBy` is
 * null for the person who made the box, and "" for people they invited.
 */
export type Person = { name: string; invitedBy: string | null };
type Label = { name: string; type: string; size: number; addedBy: string };

export type Box = {
  id: string;
  name: string;
  publicKey: string;
  hasAddKey: boolean;
  me: Person;
  members: (Person & { credentialId: string; createdAt: number; isMe: boolean })[];
  /** `label` is null for data from an outside system. */
  items: { id: string; label: Label | null; size: number; createdAt: number }[];
  invites: (Person & { id: string; expiresAt: number })[];
};

const lockJson = async (recipient: string, value: unknown) => keys.toB64(await keys.lockTo(recipient, JSON.stringify(value)));
const unlockJson = async <T>(identity: keys.Identity, b64: string): Promise<T> =>
  JSON.parse(await keys.unlockText([identity], keys.fromB64(b64)));

/**
 * The server gives the box public key, and members lock data to it. The
 * browser holds the private key, so it can check that the two belong together.
 */
function checkPublicKey(ours: string, fromServer: string) {
  if (ours !== fromServer) {
    throw Error("Vault Box sent the wrong key for this box, so it isn't safe to use. Don't add anything, and tell the other people in this box.");
  }
}

function must(): Opened {
  if (!opened) throw Error("Open the box with your passkey first.");
  return opened;
}

/** Fetches the box and unlocks every name and label. 0 prompts. */
export async function load(): Promise<Box> {
  const o = must();
  const r = await api.get<BoxResponse>(`/api/boxes/${o.boxId}`, o.access);
  checkPublicKey(o.publicKey, r.publicKey);
  const members = await Promise.all(
    r.members.map(async (m) => ({
      ...(await unlockJson<Person>(o.key, m.nameLocked)),
      credentialId: m.credentialId,
      createdAt: m.createdAt,
      isMe: m.credentialId === o.credentialId,
    })),
  );
  return {
    id: r.id,
    name: await keys.unlockText([o.key], keys.fromB64(r.nameLocked)),
    publicKey: r.publicKey,
    hasAddKey: r.hasAddKey,
    me: members.find((m) => m.isMe) ?? { name: "?", invitedBy: null },
    members,
    items: await Promise.all(
      r.items.map(async (i) => ({
        id: i.id,
        label: i.labelLocked ? await unlockJson<Label>(o.key, i.labelLocked) : null,
        size: i.size,
        createdAt: i.createdAt,
      })),
    ),
    invites: await Promise.all(
      r.invites.map(async (i) => ({ ...(await unlockJson<Person>(o.key, i.nameLocked)), id: i.id, expiresAt: i.expiresAt })),
    ),
  };
}

/**
 * Make a box: a new box key pair, a new passkey for it, and an envelope that
 * locks the box private key to the passkey key. 1 or 2 prompts.
 * The maker types no name: nobody else is there yet to see it.
 */
export async function createBox(boxName: string): Promise<string> {
  const box = await keys.newKeyPair();
  const boxId = keys.randomId();
  const passkey = await createPasskey(boxId, boxName);
  const held = await keys.holdBoxKey(box.identity);
  await api.post("/api/boxes", {
    id: boxId,
    publicKey: box.recipient,
    nameLocked: keys.toB64(await keys.lockTo(box.recipient, boxName)),
    member: {
      credentialId: passkey.credentialId,
      envelope: keys.toB64(await keys.lockTo(passkey.key.recipient, box.identity)),
      nameLocked: await lockJson(box.recipient, { name: "", invitedBy: null } satisfies Person),
    },
  }, held.access);
  opened = { boxId, credentialId: passkey.credentialId, ...held };
  return boxId;
}

/** 1 prompt. The person picks a passkey; the passkey says which box it opens. */
export async function openWithPasskey(): Promise<string> {
  const passkey = await getPasskey();
  const { envelope } = await api.get<{ envelope: string }>(`/api/boxes/${passkey.boxId}/envelopes/${passkey.credentialId}`);
  const held = await keys.holdBoxKey(await keys.unlockText([passkey.key.identity], keys.fromB64(envelope)));
  opened = { boxId: passkey.boxId, credentialId: passkey.credentialId, ...held };
  return passkey.boxId;
}

/** 0 prompts: the label and the data are locked to the box's public key. */
export async function addData(b: Box, name: string, type: string, data: Uint8Array | string): Promise<void> {
  const o = must();
  const size = typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
  const form = new FormData();
  form.append("label", new Blob([(await keys.lockTo(b.publicKey, JSON.stringify({ name, type, size, addedBy: b.me.name } satisfies Label))) as Uint8Array<ArrayBuffer>]));
  form.append("data", new Blob([(await keys.lockTo(b.publicKey, data)) as Uint8Array<ArrayBuffer>]));
  await api.post(`/api/boxes/${o.boxId}/items`, form, o.access);
}

/** 0 prompts. */
export async function openItem(itemId: string): Promise<Uint8Array> {
  const o = must();
  const file = await api.get<Uint8Array>(`/api/boxes/${o.boxId}/items/${itemId}`, o.access);
  return keys.unlockBytes([o.key], file);
}

export const deleteItem = (itemId: string) => api.del(`/api/boxes/${must().boxId}/items/${itemId}`, must().access);
export const cancelInvite = (inviteId: string) => api.del(`/api/boxes/${must().boxId}/invites/${inviteId}`, must().access);
/** Deletes their envelope. It can't take back a box key they already copied. */
export const removeMember = (credentialId: string) =>
  api.del(`/api/boxes/${must().boxId}/members/${credentialId}`, must().access);

/** A new add key for outside systems. It replaces the old one. */
export async function makeAddKey(): Promise<string> {
  const o = must();
  return (await api.post<{ addKey: string }>(`/api/boxes/${o.boxId}/add-key`, {}, o.access)).addKey;
}
export const deleteAddKey = () => api.del(`/api/boxes/${must().boxId}/add-key`, must().access);

// --- Invites -----------------------------------------------------------------

/** What the invite file holds. Only the one-time key in the link opens it. */
type InviteContents = Person & { boxKey: string };

/**
 * 1 prompt. An invite file holds the box private key, and the open box keeps
 * that key in a form it can't copy out. So this person's passkey unlocks their
 * envelope again, just for this invite. That also means a person who finds the
 * box open on someone else's device can't make a link for themselves.
 */
async function boxKeyForInvite(o: Opened): Promise<string> {
  const passkey = await getPasskey([o.credentialId]);
  if (passkey.credentialId !== o.credentialId) throw Error("Use the passkey of this box.");
  const { envelope } = await api.get<{ envelope: string }>(`/api/boxes/${o.boxId}/envelopes/${o.credentialId}`);
  const boxKey = await keys.unlockText([passkey.key.identity], keys.fromB64(envelope));
  checkPublicKey(await keys.publicKeyOf(boxKey), o.publicKey);
  return boxKey;
}

/**
 * 1 prompt (see boxKeyForInvite). Locks the box private key and the names to a
 * new one-time key, and puts that one-time key after the "#" of the link.
 * Browsers never send the "#" part to the server, so the server can't open the
 * invite file.
 */
export async function createInvite(b: Box, name: string, ttlHours: number): Promise<string> {
  const o = must();
  const boxKey = await boxKeyForInvite(o);
  if (opened !== o) throw Error("The box was locked. Open it and try again.");
  const oneTime = await keys.newKeyPair();
  const invitedBy = b.me.name;
  const inviteFile = await keys.lockTo(oneTime.recipient, JSON.stringify({ boxKey, name, invitedBy } satisfies InviteContents));
  const { id } = await api.post<{ id: string }>(`/api/boxes/${o.boxId}/invites`, {
    inviteFile: keys.toB64(inviteFile),
    nameLocked: await lockJson(b.publicKey, { name, invitedBy } satisfies Person),
    ttlHours,
  }, o.access);
  return `${location.origin}/join/${id}#${oneTime.identity}`;
}

/** `boxKey` is the box private key as a string: join() locks it to the new passkey. */
export type OpenedInvite = Person & { inviteId: string; boxId: string; boxName: string; boxKey: string; held: keys.HeldBoxKey };

/**
 * 0 prompts. Opening uses up the link: the server deletes the invite and
 * returns its file once. The result lives only in this tab's memory: a reload
 * or a closed tab loses it, and the person needs a new link. A canceled
 * passkey prompt can try again.
 */
export async function openInvite(inviteId: string, oneTimeIdentity: string): Promise<OpenedInvite> {
  const claim = await api.post<{ boxId: string; inviteFile: string }>(`/api/invites/${inviteId}/claim`, {});
  let contents: InviteContents;
  try {
    contents = JSON.parse(await keys.unlockText([oneTimeIdentity], keys.fromB64(claim.inviteFile)));
  } catch {
    throw Error("This link can't be opened. Check that you have the full link, or ask for a new one.");
  }
  const held = await keys.holdBoxKey(contents.boxKey);
  const r = await api.get<BoxResponse>(`/api/boxes/${claim.boxId}`, held.access);
  checkPublicKey(held.publicKey, r.publicKey);
  return {
    inviteId,
    boxId: claim.boxId,
    boxName: await keys.unlockText([held.key], keys.fromB64(r.nameLocked)),
    boxKey: contents.boxKey,
    held,
    name: contents.name,
    invitedBy: contents.invitedBy,
  };
}

/** 1 or 2 prompts: make this person's passkey for the box and lock the box key to it. */
export async function join(inv: OpenedInvite): Promise<string> {
  const passkey = await createPasskey(inv.boxId, `${inv.boxName} – ${inv.name}`);
  await api.post(`/api/boxes/${inv.boxId}/members`, {
    credentialId: passkey.credentialId,
    envelope: keys.toB64(await keys.lockTo(passkey.key.recipient, inv.boxKey)),
    nameLocked: await lockJson(inv.held.publicKey, { name: inv.name, invitedBy: inv.invitedBy } satisfies Person),
  }, inv.held.access);
  opened = { boxId: inv.boxId, credentialId: passkey.credentialId, ...inv.held };
  return inv.boxId;
}
