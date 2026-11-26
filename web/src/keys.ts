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
// age files, age1... public keys and the access key. An open box keeps its
// private key as a non-extractable CryptoKey (see holdBoxKey): scripts can use
// it while the box is open, but can't read it out and keep it.

import * as age from "age-encryption";
import { bech32 } from "@scure/base";

export type KeyPair = { identity: string; recipient: string };

/** A private key that unlocks age files: an AGE-SECRET-KEY-1... string or an X25519 CryptoKey. */
export type Identity = string | CryptoKey;

/** An open box, as the tab keeps it. `key` is a CryptoKey where the browser allows it. */
export type HeldBoxKey = { key: Identity; publicKey: string; access: string };

/**
 * JavaScript keeps the last string that any regex matched (the old RegExp.$_)
 * until another match replaces it. The bech32 decoder tests each AGE-SECRET-KEY
 * string with a regex, so every function here that reads a key string ends with
 * this match on a harmless string. Otherwise a used key would stay in memory.
 */
const forgetLastMatch = () => void /-/.test("-");

async function scrubbed<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } finally {
    forgetLastMatch();
  }
}

/** A new X25519 age key pair. (Use generateHybridIdentity for post-quantum.) */
export async function newKeyPair(): Promise<KeyPair> {
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await scrubbed(age.identityToRecipient(identity)) };
}

/** The age key pair whose private key is exactly these 32 bytes (a PRF output). */
export async function keyPairFromSecret(secret: Uint8Array): Promise<KeyPair> {
  if (secret.length !== 32) throw Error("A private key is 32 bytes");
  const identity = bech32.encode("AGE-SECRET-KEY-", bech32.toWords(secret), false).toUpperCase();
  return { identity, recipient: await scrubbed(age.identityToRecipient(identity)) };
}

export const publicKeyOf = (identity: Identity) => scrubbed(age.identityToRecipient(identity));

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
 * The text is frozen: it keeps the app's old name (Secretbox), and every
 * existing box's access hash depends on it.
 * importKey copies `secret` before it returns, so the caller can zero it at once.
 */
async function accessKeyOf(secret: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", secret as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("secretbox access key v1"));
  return toB64url(new Uint8Array(mac));
}

/** The PKCS #8 header of a raw X25519 private key: WebCrypto imports private keys only in this form. */
const PKCS8_X25519 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/**
 * Turns a box private key into what an open box keeps: the key, the public key
 * and the access key. Where the browser has X25519 in WebCrypto, the key is a
 * non-extractable CryptoKey. It unlocks files, but no script (an extension, a
 * pasted console command, a later attack on the page) can read it out to keep
 * the box after it locks. Other browsers keep the string.
 * The caller must drop its copy of `identity`.
 */
export const holdBoxKey = (identity: string) => scrubbed(hold(identity));

async function hold(identity: string): Promise<HeldBoxKey> {
  const secret = secretOf(identity);
  const pkcs8 = new Uint8Array(PKCS8_X25519.length + secret.length);
  pkcs8.set(PKCS8_X25519);
  pkcs8.set(secret, PKCS8_X25519.length);
  // Both imports copy the bytes before they return, so zero them right after.
  const access = accessKeyOf(secret);
  const cryptoKey = crypto.subtle
    .importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, ["deriveBits"])
    .catch(() => null);
  secret.fill(0);
  pkcs8.fill(0);
  const publicKey = await age.identityToRecipient(identity);
  let key: Identity = identity;
  try {
    // Also checks that deriveBits works: some engines import X25519 keys but can't use them.
    const k = await cryptoKey;
    if (k && (await age.identityToRecipient(k)) === publicKey) key = k;
  } catch {
    // No X25519 in this browser's WebCrypto: keep the string.
  }
  return { key, publicKey, access: await access };
}

/** Lock data to a public age1... key. Needs no passkey. */
export async function lockTo(recipient: string, data: string | Uint8Array): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(data);
}

/** Unlock an age file with any of the given identities. */
export function unlockBytes(identities: Identity[], file: Uint8Array): Promise<Uint8Array> {
  return scrubbed((async () => {
    const d = new age.Decrypter();
    for (const id of identities) d.addIdentity(id);
    return d.decrypt(file);
  })());
}

export function unlockText(identities: Identity[], file: Uint8Array): Promise<string> {
  return scrubbed((async () => {
    const d = new age.Decrypter();
    for (const id of identities) d.addIdentity(id);
    return d.decrypt(file, "text");
  })());
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
