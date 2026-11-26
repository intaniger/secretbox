// Generates the example values used throughout docs/.
//
// It builds every age file BY HAND, step by step, following the age spec
// (https://age-encryption.org/v1), so each intermediate value (shared secret,
// wrap key, header MAC, payload key…) can be shown. Then it checks every file
// opens with the real Typage library, and that the app's own key code
// (web/src/keys.ts) gives the same passkey key and access key.
// If the docs described the algorithm wrongly, this script would fail.
//
// The passkey is simulated (a real one never reveals its secret), using the
// same math as WebAuthn PRF + CTAP2 hmac-secret.
//
//   node docs/technical/example-data.mjs   → writes docs/technical/example-data.json

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as age from "age-encryption";
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64nopad, bech32 } from "@scure/base";
import * as appKeys from "../../web/src/keys.ts";

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (u) => Buffer.from(u).toString("hex");
const b64 = (u) => base64nopad.encode(u);
const b64url = (u) => Buffer.from(u).toString("base64url");
const concat = (...parts) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) (out.set(a, o), (o += a.length));
  return out;
};
const bech32Bytes = (s) => bech32.fromWords(bech32.decode(s.toLowerCase(), false).words);
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

const ZERO_NONCE = new Uint8Array(12);
const PRF_INPUT = "secretbox passkey key v1";
const ACCESS_LABEL = "secretbox access key v1";

// --- Keys ----------------------------------------------------------------------

async function keyPair() {
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient, privateHex: hex(bech32Bytes(identity)), publicHex: hex(bech32Bytes(recipient)) };
}

/** A simulated passkey for one box: its user ID is the box ID. */
function passkey(boxId, label) {
  return { credentialId: b64url(randomBytes(16)), userId: boxId, label, hiddenSecret: randomBytes(32) };
}

/** The passkey key: the PRF output for the fixed input, used as an X25519 private key. */
function passkeyKey(pk) {
  const browserSalt = sha256(concat(utf8("WebAuthn PRF"), [0x00], utf8(PRF_INPUT))); // browser
  const prfOutput = hmac(sha256, pk.hiddenSecret, browserSalt); //                       authenticator (hmac-secret)
  const identity = bech32.encode("AGE-SECRET-KEY-", bech32.toWords(prfOutput), false).toUpperCase();
  const recipient = bech32.encode("age", bech32.toWords(x25519.getPublicKey(prfOutput)), false);
  return { prfInput: PRF_INPUT, browserSaltHex: hex(browserSalt), prfOutputHex: hex(prfOutput), identity, recipient };
}

/** The access key: HMAC-SHA-256(box private key bytes, label). The server keeps SHA-256 of its text. */
function accessKey(box) {
  const key = b64url(hmac(sha256, bech32Bytes(box.identity), utf8(ACCESS_LABEL)));
  return { label: ACCESS_LABEL, key, storedHash: sha256hex(key) };
}

// --- Stanzas (how the file key is locked) -----------------------------------------------

function x25519Stanza(recipient, fileKey) {
  const recipientPublic = bech32Bytes(recipient);
  const ephemeralSecret = randomBytes(32);
  const ephemeralShare = x25519.getPublicKey(ephemeralSecret);
  const sharedSecret = x25519.getSharedSecret(ephemeralSecret, recipientPublic);
  const salt = concat(ephemeralShare, recipientPublic);
  const wrapKey = hkdf(sha256, sharedSecret, salt, utf8("age-encryption.org/v1/X25519"), 32);
  const body = chacha20poly1305(wrapKey, ZERO_NONCE).encrypt(fileKey);
  return {
    lines: [`-> X25519 ${b64(ephemeralShare)}`, b64(body)],
    steps: {
      recipientPublicHex: hex(recipientPublic),
      ephemeralSecretHex: hex(ephemeralSecret),
      ephemeralShareB64: b64(ephemeralShare),
      sharedSecretHex: hex(sharedSecret),
      hkdfSaltHex: hex(salt),
      wrapKeyHex: hex(wrapKey),
      bodyB64: b64(body),
    },
  };
}

// --- A whole age file ---------------------------------------------------------------------

function ageFile(stanza, fileKey, plaintext) {
  const headerUpToMac = `age-encryption.org/v1\n${stanza.lines.join("\n")}\n---`;
  const macKey = hkdf(sha256, fileKey, new Uint8Array(0), utf8("header"), 32);
  const mac = hmac(sha256, macKey, utf8(headerUpToMac));
  const header = `${headerUpToMac} ${b64(mac)}\n`;
  const payloadNonce = randomBytes(16);
  const payloadKey = hkdf(sha256, fileKey, payloadNonce, utf8("payload"), 32);
  const chunkNonce = new Uint8Array(12);
  chunkNonce[11] = 0x01; // counter 0, "last chunk" flag
  const sealed = chacha20poly1305(payloadKey, chunkNonce).encrypt(plaintext);
  const file = concat(utf8(header), payloadNonce, sealed);
  return {
    file,
    out: {
      fileKeyHex: hex(fileKey),
      stanza: stanza.steps,
      header: header.trimEnd(),
      headerMacKeyHex: hex(macKey),
      headerMacB64: b64(mac),
      payloadNonceHex: hex(payloadNonce),
      payloadKeyHex: hex(payloadKey),
      chunkNonceHex: hex(chunkNonce),
      payloadCiphertextHex: hex(sealed),
      plaintextBytes: plaintext.length,
      payloadBytes: payloadNonce.length + sealed.length,
      totalBytes: file.length,
    },
  };
}

const lockTo = (recipient, text) => {
  const fileKey = randomBytes(16);
  return ageFile(x25519Stanza(recipient, fileKey), fileKey, utf8(text));
};
// --- Verify with the real library -----------------------------------------------------------

async function openWith(identity, file) {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return d.decrypt(file, "text");
}
// --- The story -----------------------------------------------------------------------------------

const json = (v) => JSON.stringify(v);
const now = Date.parse("2026-11-26T09:00:00Z");

// 01: Tiger makes "Finance 2026". The box ID is the passkey's user ID.
// Nobody names the person who makes a box, so Tiger's name in the box is "".
const financeId = b64url(randomBytes(16));
const financeBox = await keyPair();
const tigerPasskey = passkey(financeId, "Finance 2026");
const tigerKey = passkeyKey(tigerPasskey);
const tigerEnvelope = lockTo(tigerKey.recipient, financeBox.identity);
const financeAccess = accessKey(financeBox);
const financeName = lockTo(financeBox.recipient, "Finance 2026");
const tigerNameText = json({ name: "", invitedBy: null });
const tigerName = lockTo(financeBox.recipient, tigerNameText);

// 02: Tiger makes "HR 2027" too: a second passkey, with a different key.
const hrId = b64url(randomBytes(16));
const hrBox = await keyPair();
const tigerHrPasskey = passkey(hrId, "HR 2027");
const tigerHrKey = passkeyKey(tigerHrPasskey);
const tigerHrEnvelope = lockTo(tigerHrKey.recipient, hrBox.identity);
const hrAccess = accessKey(hrBox);

// 03: Tiger adds a note: a locked label and the locked data.
const noteText = "Salary sheet: Nok 50k";
const labelText = json({ name: "note.txt", type: "text/plain", size: utf8(noteText).length, addedBy: "" });
const noteLabel = lockTo(financeBox.recipient, labelText);
const note = lockTo(financeBox.recipient, noteText);
const addKey = `vlt_${b64url(randomBytes(24))}`;

// 04: Tiger makes an invite for Nok. He has no name in the box, so invitedBy is "".
const oneTime = await keyPair();
const inviteId = b64url(randomBytes(16));
const inviteText = json({ boxKey: financeBox.identity, name: "Nok", invitedBy: "" });
const inviteFile = lockTo(oneTime.recipient, inviteText);
const inviteName = lockTo(financeBox.recipient, json({ name: "Nok", invitedBy: "" }));

// 05: Nok opens the invite and joins with her own passkey for this box.
const opened = JSON.parse(await openWith(oneTime.identity, inviteFile.file));
const nokAccess = accessKey({ identity: opened.boxKey });
const nokPasskey = passkey(financeId, "Finance 2026 – Nok");
const nokKey = passkeyKey(nokPasskey);
const nokEnvelope = lockTo(nokKey.recipient, opened.boxKey);
const nokName = lockTo(financeBox.recipient, json({ name: "Nok", invitedBy: "" }));

// Check every file with Typage, the app's own key code, and the full reading chain.
const appKeyOf = async (k) => (await appKeys.keyPairFromSecret(Buffer.from(k.prfOutputHex, "hex"))).recipient;
const checks = {
  tigerKeyMatchesApp: (await appKeyOf(tigerKey)) === tigerKey.recipient,
  nokKeyMatchesApp: (await appKeyOf(nokKey)) === nokKey.recipient,
  tigerKeyMatchesTypage: (await age.identityToRecipient(tigerKey.identity)) === tigerKey.recipient,
  accessKeyMatchesApp: (await appKeys.accessKey(financeBox.identity)) === financeAccess.key,
  tigerEnvelope: (await openWith(tigerKey.identity, tigerEnvelope.file)) === financeBox.identity,
  tigerHrEnvelope: (await openWith(tigerHrKey.identity, tigerHrEnvelope.file)) === hrBox.identity,
  financeName: (await openWith(financeBox.identity, financeName.file)) === "Finance 2026",
  tigerName: (await openWith(financeBox.identity, tigerName.file)) === tigerNameText,
  noteLabel: (await openWith(financeBox.identity, noteLabel.file)) === labelText,
  note: (await openWith(financeBox.identity, note.file)) === noteText,
  inviteFile: opened.boxKey === financeBox.identity && opened.name === "Nok",
  inviteName: JSON.parse(await openWith(financeBox.identity, inviteName.file)).invitedBy === "",
  nokAccessSameAsTiger: nokAccess.key === financeAccess.key,
  nokEnvelope: (await openWith(nokKey.identity, nokEnvelope.file)) === financeBox.identity,
  nokReadsNote: await (async () => {
    const box = await openWith(nokKey.identity, nokEnvelope.file);
    return (await openWith(box, note.file)) === noteText;
  })(),
  tigerKeyCantOpenNokEnvelope: await openWith(tigerKey.identity, nokEnvelope.file).then(() => false, () => true),
};
if (!Object.values(checks).every(Boolean)) {
  console.error("Verification FAILED", checks);
  process.exit(1);
}

const data = {
  note: "Generated by docs/technical/example-data.mjs. Every file was built by hand and verified with Typage. The passkeys are simulated.",
  checks,
  financeBox: {
    id: financeId, name: "Finance 2026", ...financeBox,
    access: financeAccess, nameLocked: financeName.out,
  },
  tiger: {
    passkey: { credentialId: tigerPasskey.credentialId, userId: tigerPasskey.userId, label: tigerPasskey.label, hiddenSecretHex: hex(tigerPasskey.hiddenSecret) },
    passkeyKey: tigerKey,
    envelope: tigerEnvelope.out,
    nameText: tigerNameText,
    nameLocked: tigerName.out,
  },
  hrBox: {
    id: hrId, name: "HR 2027", ...hrBox, access: hrAccess,
    tigerPasskey: { credentialId: tigerHrPasskey.credentialId, userId: tigerHrPasskey.userId, label: tigerHrPasskey.label, hiddenSecretHex: hex(tigerHrPasskey.hiddenSecret) },
    tigerPasskeyKey: tigerHrKey,
    tigerEnvelope: tigerHrEnvelope.out,
  },
  item: { text: noteText, labelText, label: noteLabel.out, data: note.out },
  addKey: { key: addKey, storedHash: sha256hex(addKey) },
  invite: {
    id: inviteId,
    oneTime,
    link: `https://vlt.i7r.tech/join/${inviteId}#${oneTime.identity}`,
    contents: inviteText,
    file: inviteFile.out,
    nameLocked: inviteName.out,
    expiresAt: now + 24 * 3600 * 1000,
  },
  nok: {
    passkey: { credentialId: nokPasskey.credentialId, userId: nokPasskey.userId, label: nokPasskey.label, hiddenSecretHex: hex(nokPasskey.hiddenSecret) },
    passkeyKey: nokKey,
    envelope: nokEnvelope.out,
    nameLocked: nokName.out,
  },
};

writeFileSync(new URL("./example-data.json", import.meta.url), JSON.stringify(data, null, 2) + "\n");
console.log("All checks passed:", Object.keys(checks).join(", "));
console.log("Wrote docs/technical/example-data.json");
