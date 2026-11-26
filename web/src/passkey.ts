// Passkeys, used only to unlock: they never talk to the server.
//
// Each box membership gets its own passkey. Its user ID is the box ID, so the
// device's passkey list doubles as the list of your boxes, and the passkey
// tells the app which box to open.
//
// The PRF extension gives 32 secret bytes that only this passkey can make, for
// a fixed input. Those bytes are used directly as an age X25519 private key:
// the PASSKEY KEY. The browser hashes the input first:
//   SHA-256("WebAuthn PRF" || 0x00 || "secretbox passkey key v1")
// and the authenticator computes HMAC-SHA-256(credential secret, that hash).

import * as keys from "./keys.ts";

// Frozen: this text keeps the app's old name (Secretbox). Every existing
// passkey key comes from it, so a change would lock everyone out of their boxes.
const PRF_INPUT = new TextEncoder().encode("secretbox passkey key v1");
const prfRequest = { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs;
const challenge = () => crypto.getRandomValues(new Uint8Array(32)); // nobody checks it: no server login

export type Passkey = { credentialId: string; boxId: string; key: keys.KeyPair };

const NO_PRF =
  "This passkey can't unlock data (no PRF support). Use Apple Passwords, Google Password Manager, or a recent security key.";

function prfOutput(cred: PublicKeyCredential): Uint8Array | undefined {
  const first = (cred.getClientExtensionResults() as any).prf?.results?.first as ArrayBuffer | ArrayBufferView | undefined;
  if (!first) return undefined;
  return ArrayBuffer.isView(first) ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength) : new Uint8Array(first);
}

/**
 * Make a new passkey for a box. 1 prompt if the authenticator gives the PRF
 * output while it makes the passkey, otherwise 2 (make it, then use it once).
 * `label` is what the device's passkey list shows, e.g. "Finance 2026" for the
 * person who made the box, or "Finance 2026 – Nok" for a person invited as Nok.
 */
export async function createPasskey(boxId: string, label: string): Promise<Passkey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Vault Box" },
      user: { id: new TextEncoder().encode(boxId), name: label, displayName: label },
      challenge: challenge(),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -8 }, // Ed25519
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      extensions: prfRequest,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw Error("No passkey was made.");
  if ((cred.getClientExtensionResults() as any).prf?.enabled !== true) throw Error(NO_PRF);
  const credentialId = keys.toB64url(new Uint8Array(cred.rawId));
  const secret = prfOutput(cred) ?? (await usePasskey([credentialId])).secret;
  return { credentialId, boxId, key: await keys.keyPairFromSecret(secret) };
}

/**
 * Use a passkey: 1 prompt. With no `allow` list the device shows all your
 * passkeys for this site, one per box, and the chosen one names the box.
 */
export async function getPasskey(allow?: string[]): Promise<Passkey> {
  const { credentialId, boxId, secret } = await usePasskey(allow);
  if (!boxId) throw Error("This passkey was not made by Vault Box.");
  return { credentialId, boxId, key: await keys.keyPairFromSecret(secret) };
}

async function usePasskey(allow: string[] = []) {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: challenge(),
      userVerification: "required",
      allowCredentials: allow.map((id) => ({ type: "public-key", id: keys.fromB64url(id) as Uint8Array<ArrayBuffer> })),
      extensions: prfRequest,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw Error("No passkey was used.");
  const secret = prfOutput(cred);
  if (!secret) throw Error(NO_PRF);
  const handle = (cred.response as AuthenticatorAssertionResponse).userHandle;
  return {
    credentialId: keys.toB64url(new Uint8Array(cred.rawId)),
    boxId: handle ? new TextDecoder().decode(handle) : null,
    secret,
  };
}
