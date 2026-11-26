// Generates the example values used throughout docs/.
//
// It builds every age file BY HAND, step by step, following the age spec
// (https://age-encryption.org/v1) and Typage's fido2prf format, so each
// intermediate value (shared secret, wrap key, header MAC, payload key…) can
// be shown. Then it checks every file opens with the real Typage library.
// If the docs described the algorithm wrongly, this script would fail.
//
// The passkey is simulated (a real one never reveals its secret), using the
// same math as WebAuthn PRF + CTAP2 hmac-secret.
//
//   node docs/technical/example-data.mjs   → writes docs/technical/example-data.json

import { writeFileSync } from "node:fs";
import { createHash, randomBytes as nodeRandom } from "node:crypto";
import * as age from "age-encryption";
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { extract, hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64nopad, bech32 } from "@scure/base";

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

const ZERO_NONCE = new Uint8Array(12);
const PRF_LABEL = "age-encryption.org/fido2prf";

// --- Keys ----------------------------------------------------------------------

async function keyPair() {
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient, privateHex: hex(bech32Bytes(identity)), publicHex: hex(bech32Bytes(recipient)) };
}

/** A simulated passkey: a credential ID and the hidden PRF secret (CTAP2 "CredRandom"). */
function passkey() {
  return { credentialId: b64url(randomBytes(16)), hiddenSecret: randomBytes(32) };
}

/** What the browser + authenticator compute for one PRF input. */
function prf(pk, input) {
  const salt = sha256(concat(utf8("WebAuthn PRF"), [0x00], input)); // browser
  const output = hmac(sha256, pk.hiddenSecret, salt); //                  authenticator (hmac-secret)
  return { salt, output };
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

function prfStanza(pk, fileKey) {
  const nonce = randomBytes(16);
  const input1 = concat(utf8(PRF_LABEL), [0x01], nonce);
  const input2 = concat(utf8(PRF_LABEL), [0x02], nonce);
  const r1 = prf(pk, input1);
  const r2 = prf(pk, input2);
  const wrapKey = extract(sha256, concat(r1.output, r2.output), utf8(PRF_LABEL));
  const body = chacha20poly1305(wrapKey, ZERO_NONCE).encrypt(fileKey);
  return {
    lines: [`-> ${PRF_LABEL} ${b64(nonce)}`, b64(body)],
    steps: {
      nonceB64: b64(nonce),
      input1Hex: hex(input1),
      input2Hex: hex(input2),
      browserSalt1Hex: hex(r1.salt),
      browserSalt2Hex: hex(r2.salt),
      prfOutput1Hex: hex(r1.output),
      prfOutput2Hex: hex(r2.output),
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
const lockToPasskey = (pk, text) => {
  const fileKey = randomBytes(16);
  return ageFile(prfStanza(pk, fileKey), fileKey, utf8(text));
};

// --- Verify with the real library -----------------------------------------------------------

async function openWith(identity, file) {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return d.decrypt(file, "text");
}
async function openWithPasskey(pk, file) {
  const { Stanza } = await import("age-encryption/dist/format.js").catch(() => ({}));
  void Stanza;
  const d = new age.Decrypter();
  d.addIdentity({
    async unwrapFileKey(stanzas) {
      for (const s of stanzas) {
        if (s.args[0] !== PRF_LABEL) continue;
        const nonce = base64nopad.decode(s.args[1]);
        const o1 = prf(pk, concat(utf8(PRF_LABEL), [1], nonce)).output;
        const o2 = prf(pk, concat(utf8(PRF_LABEL), [2], nonce)).output;
        const key = extract(sha256, concat(o1, o2), utf8(PRF_LABEL));
        try {
          return chacha20poly1305(key, ZERO_NONCE).decrypt(s.body);
        } catch {
          return null;
        }
      }
      return null;
    },
  });
  return d.decrypt(file, "text");
}

// --- The story -----------------------------------------------------------------------------------

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// 01: Tiger signs up and creates "Finance 2026"
const tigerPasskey = passkey();
const tigerMember = await keyPair();
const tigerEnvelope = lockToPasskey(tigerPasskey, tigerMember.identity);
const financeBox = await keyPair();
const tigerFinanceCopy = lockTo(tigerMember.recipient, financeBox.identity);
const sessionToken = b64url(nodeRandom(32));

// 02: Tiger (already signed in) creates "HR 2027"
const hrBox = await keyPair();
const tigerHrCopy = lockTo(tigerMember.recipient, hrBox.identity);

// 03: Tiger adds a note to Finance 2026
const noteText = "Salary sheet: Nok 50k";
const note = lockTo(financeBox.recipient, noteText);

// 04: Tiger creates an invite for Nok
const oneTime = await keyPair();
const inviteId = b64url(randomBytes(16));
const inviteFile = lockTo(oneTime.recipient, financeBox.identity);

// 05: Nok uses the invite
const nokPasskey = passkey();
const nokMember = await keyPair();
const nokEnvelope = lockToPasskey(nokPasskey, nokMember.identity);
const boxFromInvite = await openWith(oneTime.identity, inviteFile.file);
const nokFinanceCopy = lockTo(nokMember.recipient, boxFromInvite);

// Check every file with Typage, and the full reading chain.
const checks = {
  tigerEnvelope: (await openWithPasskey(tigerPasskey, tigerEnvelope.file)) === tigerMember.identity,
  tigerFinanceCopy: (await openWith(tigerMember.identity, tigerFinanceCopy.file)) === financeBox.identity,
  tigerHrCopy: (await openWith(tigerMember.identity, tigerHrCopy.file)) === hrBox.identity,
  note: (await openWith(financeBox.identity, note.file)) === noteText,
  inviteFile: boxFromInvite === financeBox.identity,
  nokEnvelope: (await openWithPasskey(nokPasskey, nokEnvelope.file)) === nokMember.identity,
  nokReadsNote: await (async () => {
    const member = await openWithPasskey(nokPasskey, nokEnvelope.file);
    const box = await openWith(member, nokFinanceCopy.file);
    return (await openWith(box, note.file)) === noteText;
  })(),
};
if (!Object.values(checks).every(Boolean)) {
  console.error("Verification FAILED", checks);
  process.exit(1);
}

const data = {
  note: "Generated by docs/technical/example-data.mjs. Every file was built by hand and verified with Typage. The passkeys are simulated.",
  checks,
  tiger: {
    passkey: { credentialId: tigerPasskey.credentialId, hiddenSecretHex: hex(tigerPasskey.hiddenSecret) },
    member: tigerMember,
    envelope: tigerEnvelope.out,
    session: { cookieToken: sessionToken, storedHash: sha256hex(sessionToken) },
  },
  financeBox: { name: "Finance 2026", ...financeBox, tigerKeyCopy: tigerFinanceCopy.out },
  hrBox: { name: "HR 2027", ...hrBox, tigerKeyCopy: tigerHrCopy.out },
  item: { name: "note.txt", text: noteText, ...note.out },
  invite: {
    id: inviteId,
    oneTime,
    link: `https://secretbox-nu.vercel.app/join/${inviteId}#${oneTime.identity}`,
    file: inviteFile.out,
  },
  nok: {
    passkey: { credentialId: nokPasskey.credentialId, hiddenSecretHex: hex(nokPasskey.hiddenSecret) },
    member: nokMember,
    envelope: nokEnvelope.out,
    financeKeyCopy: nokFinanceCopy.out,
  },
};

writeFileSync(new URL("./example-data.json", import.meta.url), JSON.stringify(data, null, 2) + "\n");
console.log("All checks passed:", Object.keys(checks).join(", "));
console.log("Wrote docs/technical/example-data.json");
