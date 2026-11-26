// All cryptography lives here: a thin layer over age (Typage) and WebCrypto.
// passkey.ts turns a passkey into the passkey key.
//
//   Passkey (Face ID + PRF)
//     │  its PRF output is the PASSKEY KEY   (age X25519 private key)
//     │  which unlocks the ENVELOPE          (age file, X25519 stanza)
//   Box key — one per box                    (age X25519)
//     │  unlocks names, labels and data      (age files)
//     │  and gives the ACCESS KEY            (HMAC-SHA-256; the server checks its hash)
//
// Private keys exist only in this tab's memory. The server only ever receives
// age files, age1... public keys and the access key.

import * as age from "age-encryption";
import { bech32 } from "@scure/base";

export type KeyPair = { identity: string; recipient: string };

/** A new X25519 age key pair. (Use generateHybridIdentity for post-quantum.) */
export async function newKeyPair(): Promise<KeyPair> {
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

/** The age key pair whose private key is exactly these 32 bytes (a PRF output). */
export async function keyPairFromSecret(secret: Uint8Array): Promise<KeyPair> {
  if (secret.length !== 32) throw Error("A private key is 32 bytes");
  const identity = bech32.encode("AGE-SECRET-KEY-", bech32.toWords(secret), false).toUpperCase();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

export const publicKeyOf = (identity: string) => age.identityToRecipient(identity);

/** The 32 bytes inside an AGE-SECRET-KEY-1... string. */
function secretOf(identity: string): Uint8Array {
  const { prefix, words } = bech32.decode(identity.toLowerCase() as `${string}1${string}`, false);
  if (prefix !== "age-secret-key-") throw Error("Not an age X25519 identity");
  return bech32.fromWords(words);
}

/**
 * The box's access key: HMAC-SHA-256(box private key, "secretbox access key v1").
 * Only someone with the box private key can make it. The server stores its
 * SHA-256 hash and asks for it on every member request.
 */
export async function accessKey(boxIdentity: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", secretOf(boxIdentity) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("secretbox access key v1"));
  return toB64url(new Uint8Array(mac));
}

/** Lock data to a public age1... key. Needs no passkey. */
export async function lockTo(recipient: string, data: string | Uint8Array): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(data);
}

/** Unlock an age file with any of the given identities. */
export async function unlockBytes(identities: string[], file: Uint8Array): Promise<Uint8Array> {
  const d = new age.Decrypter();
  for (const id of identities) d.addIdentity(id);
  return d.decrypt(file);
}

export async function unlockText(identities: string[], file: Uint8Array): Promise<string> {
  const d = new age.Decrypter();
  for (const id of identities) d.addIdentity(id);
  return d.decrypt(file, "text");
}

// --- Encoding helpers ---------------------------------------------------------

/** 16 random bytes, base64url. Used for box IDs. */
export const randomId = () => toB64url(crypto.getRandomValues(new Uint8Array(16)));

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export const toB64url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}
