// The user actions, built from keys.ts + the API. Each function notes how many
// passkey prompts (Face ID / fingerprint) it causes.

import { api, type BoxDetail, type Me } from "./api.ts";
import * as keys from "./keys.ts";

// The member key, unlocked. Lives only in this tab's memory.
let memberIdentity: string | null = null;

export const isUnlocked = () => memberIdentity !== null;
export const lock = () => {
  memberIdentity = null;
};

const passkeyOf = (me: Me) => keys.passkeyIdentity(me.passkey.id, me.passkey.transports);

/** New account only: make the member key and lock it to the passkey. 1 prompt. */
export async function setupMemberKey(me: Me): Promise<void> {
  const member = await keys.newKeyPair();
  const envelope = await keys.lockToPasskey(passkeyOf(me), member.identity);
  await api.put("/api/me/keys", { memberRecipient: member.recipient, envelope: keys.toB64(envelope) });
  memberIdentity = member.identity;
}

/** Open the envelope with the passkey. 1 prompt, then none until the tab closes or "Lock". */
export async function unlock(me: Me): Promise<void> {
  if (memberIdentity) return;
  const { envelope } = await api.get<{ envelope: string }>("/api/me/envelope");
  memberIdentity = await keys.unlockWithPasskey(passkeyOf(me), keys.fromB64(envelope));
}

/** Current box identity first, then older ones (to read data from before a key change). */
async function boxIdentities(d: BoxDetail): Promise<string[]> {
  if (!memberIdentity) throw Error("Unlock with your passkey first.");
  const current = await keys.unlockText([memberIdentity], keys.fromB64(d.me.keyCopy));
  const older: string[] = d.box.keyHistory
    ? JSON.parse(await keys.unlockText([current], keys.fromB64(d.box.keyHistory)))
    : [];
  return [current, ...older];
}

/** 0 prompts: the key copy is locked to the member's public key. */
export async function createBox(me: Me, name: string): Promise<string> {
  if (!me.memberRecipient) throw Error("Set up your key first.");
  const box = await keys.newKeyPair();
  const keyCopy = await keys.lockTo(me.memberRecipient, box.identity);
  const { id } = await api.post<{ id: string }>("/api/boxes", {
    name,
    recipient: box.recipient,
    keyCopy: keys.toB64(keyCopy),
  });
  return id;
}

/** 0 prompts: data is locked to the box's public key. */
export async function addData(d: BoxDetail, name: string, data: Uint8Array | string): Promise<void> {
  const file = await keys.lockTo(d.box.recipient, data);
  await api.post(`/api/boxes/${d.box.id}/items?name=${encodeURIComponent(name)}`, file);
}

/** Needs the box unlocked. */
export async function openItem(d: BoxDetail, itemId: string): Promise<Uint8Array> {
  const file = await api.get<Uint8Array>(`/api/boxes/${d.box.id}/items/${itemId}`);
  return keys.unlockBytes(await boxIdentities(d), file);
}

/**
 * Any member can do this. Needs the box unlocked. Locks a copy of the box key
 * to a new one-time key, and puts that one-time key after the "#" of the link.
 * Browsers never send the "#" part to the server, so the server can't open the
 * invite file. `name` is how the invited person will appear in this box.
 */
export async function createInvite(d: BoxDetail, name: string, ttlHours: number): Promise<string> {
  const [boxIdentity] = await boxIdentities(d);
  const oneTime = await keys.newKeyPair();
  const inviteFile = await keys.lockTo(oneTime.recipient, boxIdentity);
  const { id } = await api.post<{ id: string }>(`/api/boxes/${d.box.id}/invites`, {
    name,
    ttlHours,
    keyVersion: d.box.keyVersion,
    inviteFile: keys.toB64(inviteFile),
  });
  return `${location.origin}/join/${id}#${oneTime.identity}`;
}

/**
 * 0 prompts (the account already exists). Claims the invite (the server marks
 * it used, atomically), opens the invite file with the one-time key from the
 * link, and locks the box key again to this member's public key.
 */
export async function acceptInvite(me: Me, inviteId: string, oneTimeIdentity: string): Promise<string> {
  if (!me.memberRecipient) throw Error("Set up your key first.");
  const { boxId, inviteFile } = await api.post<{ boxId: string; inviteFile: string }>(
    `/api/invites/${inviteId}/claim`,
  );
  const boxIdentity = await keys.unlockText([oneTimeIdentity], keys.fromB64(inviteFile));
  const keyCopy = await keys.lockTo(me.memberRecipient, boxIdentity);
  await api.post(`/api/invites/${inviteId}/complete`, { keyCopy: keys.toB64(keyCopy) });
  return boxId;
}

/**
 * Needs the box unlocked. Makes a new box key and gives a copy to every member
 * who stays (to their public member key — no prompts for them). Old box keys
 * go into the key history, locked to the new key, so old data stays readable
 * without locking it again.
 */
export async function removeMember(d: BoxDetail, userId: string): Promise<void> {
  const identities = await boxIdentities(d);
  const next = await keys.newKeyPair();
  const keyHistory = await keys.lockTo(next.recipient, JSON.stringify(identities));
  const keyCopies: Record<string, string> = {};
  for (const m of d.members) {
    if (m.userId === userId) continue;
    keyCopies[m.userId] = keys.toB64(await keys.lockTo(m.recipient, next.identity));
  }
  await api.post(`/api/boxes/${d.box.id}/rotate`, {
    removeUserIds: [userId],
    recipient: next.recipient,
    keyHistory: keys.toB64(keyHistory),
    keyCopies,
    expectedKeyVersion: d.box.keyVersion,
  });
}
