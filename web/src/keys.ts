// All cryptography lives here. It's a thin layer over age (Typage).
//
//   Passkey (Face ID + PRF)
//     │  unlocks the ENVELOPE      (age file, fido2prf stanza)
//   Member key   — one per person (age X25519)
//     │  unlocks the KEY COPY      (age file, X25519 stanza)
//   Box key      — one per box    (age X25519)
//     │  unlocks
//   Data         — age files
//
// Secrets (age identities) exist only in this tab's memory. The server only
// ever receives age files and age1... public keys.

import * as age from "age-encryption";
import { bech32 } from "@scure/base";

export type KeyPair = { identity: string; recipient: string };

/** A new X25519 age key pair. (Use generateHybridIdentity for post-quantum.) */
export async function newKeyPair(): Promise<KeyPair> {
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await age.identityToRecipient(identity) };
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

/**
 * Lock data to a passkey (fido2prf). This asks for Face ID / fingerprint:
 * passkey recipients are symmetric, so only the passkey's owner can do it.
 */
export async function lockToPasskey(passkey: string, data: string): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.addRecipient(new age.webauthn.WebAuthnRecipient({ identity: passkey }));
  return e.encrypt(data);
}

/** Unlock an envelope with the passkey. Asks for Face ID / fingerprint. */
export async function unlockWithPasskey(passkey: string, file: Uint8Array): Promise<string> {
  const d = new age.Decrypter();
  d.addIdentity(new age.webauthn.WebAuthnIdentity({ identity: passkey }));
  return d.decrypt(file, "text");
}

/**
 * Builds Typage's passkey identity string (AGE-PLUGIN-FIDO2PRF-1...) for a
 * credential we registered ourselves. It's bech32(CBOR[1, credId, rpId,
 * transports]) — the same encoding as age.webauthn.createCredential returns.
 * Passing it to WebAuthnRecipient/WebAuthnIdentity makes the browser use
 * exactly this passkey instead of asking the user to pick one.
 */
export function passkeyIdentity(credentialId: string, transports: string[], rpId = location.hostname): string {
  const enc = new TextEncoder();
  const credId = base64urlToBytes(credentialId);
  const text = (s: string) => {
    const b = enc.encode(s);
    return [cborHead(3, b.length), b];
  };
  const parts: Uint8Array[] = [
    cborHead(0, 1),
    cborHead(2, credId.length),
    credId,
    ...text(rpId),
    cborHead(4, transports.length),
    ...transports.flatMap(text),
  ];
  return bech32.encode("AGE-PLUGIN-FIDO2PRF-", bech32.toWords(concat(parts)), false).toUpperCase();
}

function cborHead(major: number, n: number): Uint8Array {
  if (n <= 23) return new Uint8Array([(major << 5) | n]);
  if (n <= 0xff) return new Uint8Array([(major << 5) | 24, n]);
  if (n <= 0xffff) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  throw Error("cbor: value too large");
}

// --- Encoding helpers ---------------------------------------------------------

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}
