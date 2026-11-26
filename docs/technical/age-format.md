# Technical details: the age file format

[← All documents](../README.md)

Secretbox locks everything with [age v1](https://age-encryption.org/v1), through the TypeScript library [Typage](https://github.com/FiloSottile/typage). This document shows each part of an age file, with real values. The example is the data file of the note from [scenario 3](../03-add-item.md).

The script [example-data.mjs](example-data.mjs) makes each value by hand with these formulas. Then it verifies that Typage unlocks each file. If a formula here were wrong, the script would fail.

## The methods

| Name | What it does | Used for |
|---|---|---|
| X25519 | Makes key pairs. Two parties calculate one shared secret. | Passkey keys, box keys, one-time keys, temporary keys |
| HKDF-SHA-256 | Makes a new key from a secret, a salt and a label (`info`). | Wrap keys, the header MAC key, the payload key |
| HMAC-SHA-256 | Makes a check value (MAC) from a key and a message. | The header check. Also the access key and the passkey PRF, outside age. |
| ChaCha20-Poly1305 | Locks data with a 32-byte key and a 12-byte nonce. Adds a 16-byte tag that finds each change. | The stanza body, the payload |

## Keys

An X25519 private key is 32 bytes. Its public key is 32 bytes too. age writes them in Bech32 text:

| Key | Bech32 prefix | Example (Finance 2026 box key) | Raw bytes |
|---|---|---|---|
| Private key | `AGE-SECRET-KEY-` (upper case) | `AGE-SECRET-KEY-174SLE9SKATLRGWFVVQSPPZXZ2X4M0WEQM4KAEEJ09GKQHFK5FLASM7P3R3` | `f561fc9616eafe34392c60201088c251abb7bb20dd6ddce64f2a2c0ba6d44ffb` |
| Public key | `age` | `age1aa0rtwwaz8rhsdt243382vx2x7lhf7lscfdtm6tcxhxnsqxl594sg0gwew` | `ef5e35b9dd11c778356aac627530ca37bf74fbf0c25abde97835cd3800dfa16b` |

Secretbox makes box keys and one-time keys with `age.generateX25519Identity()`. A passkey key uses the PRF output as the 32 private bytes. See [passkey-prf.md](passkey-prf.md). `age.identityToRecipient()` calculates each public key.

## The parts of a file

```mermaid
flowchart TD
  subgraph H["Header (text)"]
    V["age-encryption.org/v1"]
    S["Stanza: -> X25519 TEMPORARY-PUBLIC-PART<br/>body: the file key, locked"]
    M["--- MAC"]
  end
  subgraph P["Payload (binary)"]
    N["16-byte nonce"]
    C["Chunks of up to 64 KiB, each locked, each with a 16-byte tag"]
  end
  H --> P
```

The data file of the note:

```
age-encryption.org/v1
-> X25519 csC1SWy5hBxFb9OHqyOPz+hovpr0HCeFB62jnP/e5jw
r3k3VpSGco7wucbClUEQy8YF/ZSSOZx6vERXVCEowS0
--- PWNYy+XB25dDVeCfF+Coqfq8MQ1gjkePnmadGb77IXU
<16-byte nonce><37 bytes: 21 locked bytes + 16-byte tag>
```

Total: 168 bytes of header + 53 bytes of payload = 221 bytes.

## Step 1: the file key

```
file_key = 16 random bytes
         = e6e880992a9faf8cbbfe1da538653f9f
```

The browser uses `crypto.getRandomValues`. age makes a new file key for each file. The file key never leaves the browser in the clear.

## Step 2: the X25519 stanza (lock the file key)

Input: the file key and the recipient's public key. For an item, the recipient is the box public key.

```
recipient       = ef5e35b9dd11c778356aac627530ca37bf74fbf0c25abde97835cd3800dfa16b   (box public key)

temp_private    = 32 random bytes
                = 75318440d7531df1bc58b287f7f6c7021a89f8aef18161b1e19974aa0e5fdd00
temp_public     = X25519(temp_private, basepoint)
                = csC1SWy5hBxFb9OHqyOPz+hovpr0HCeFB62jnP/e5jw   (base64, in the stanza line)

shared_secret   = X25519(temp_private, recipient)
                = 9ed9b3e7a706e85a4bd38782bcc9e163f51f4b36b5a399f7c90c8cd69f748941

salt            = temp_public || recipient          (64 bytes)
wrap_key        = HKDF-SHA-256(ikm = shared_secret, salt = salt,
                               info = "age-encryption.org/v1/X25519", length = 32)
                = 7abc12d3c0efe15a771e3f6a35e836a64679b87f270cc242a114c8031099d173

body            = ChaCha20-Poly1305(key = wrap_key, nonce = 12 zero bytes).seal(file_key)
                = r3k3VpSGco7wucbClUEQy8YF/ZSSOZx6vERXVCEowS0   (32 bytes: 16 locked + 16 tag)
```

The stanza is two lines:

```
-> X25519 csC1SWy5hBxFb9OHqyOPz+hovpr0HCeFB62jnP/e5jw
r3k3VpSGco7wucbClUEQy8YF/ZSSOZx6vERXVCEowS0
```

age forgets `temp_private` after this step. A zero nonce is safe here, because each `wrap_key` locks one value only.

The stanza does not hold the recipient public key. So a person who has the file cannot see which public key locked it. Secretbox uses this: the server cannot know a member's passkey public key from their envelope.

### Unlock the stanza

The holder of the box **private** key calculates the same shared secret:

```
shared_secret = X25519(box_private, temp_public)        ← same value as X25519(temp_private, recipient)
wrap_key      = HKDF-SHA-256(shared_secret, temp_public || box_public, "age-encryption.org/v1/X25519")
file_key      = ChaCha20-Poly1305(wrap_key, zero nonce).open(body)
```

If the private key is wrong, the Poly1305 tag check fails, and the unlock stops with an error.

## Step 3: the header check (MAC)

```
mac_key = HKDF-SHA-256(ikm = file_key, salt = empty, info = "header", length = 32)
        = 33fce5a30f50df2bba8cba014ef5a83deb1ee4332b3ccfd2bb896d6b67b5253d

message = the header text from "age-encryption.org/v1" up to and including "---"
mac     = HMAC-SHA-256(mac_key, message)
        = PWNYy+XB25dDVeCfF+Coqfq8MQ1gjkePnmadGb77IXU   (base64)
```

The last header line is `--- ` and the MAC. When the library unlocks the file, it calculates the MAC again. If a person changed a stanza, the MAC does not agree, and the library stops.

## Step 4: the payload

```
payload_nonce = 16 random bytes
              = 70821bbbf211a4ff2bcb692ae6b5d453
payload_key   = HKDF-SHA-256(ikm = file_key, salt = payload_nonce, info = "payload", length = 32)
              = 92f2c509e44e6fb6965a543616083cf5c9f4e0797e83f452fbac9bcf0d21003a
```

The library cuts the data into chunks of 64 KiB. The last chunk can be smaller. The library locks each chunk separately:

```
chunk_nonce = 11-byte chunk counter (big endian, from 0) || 1 byte last-chunk flag (0x01 or 0x00)
            = 000000000000000000000001        (chunk 0, and it is the last chunk)
chunk       = ChaCha20-Poly1305(payload_key, chunk_nonce).seal("Salary sheet: Nok 50k")
            = f563108d5ee6a175f0ff30a8f25f9efc7252c39e83849a15f4ada632eb58c673c485115014
```

The counter stops a person who changes the order of chunks. The last-chunk flag stops a person who cuts chunks from the end.

Size: 16 (nonce) + 21 (data) + 16 (tag) = 53 bytes.

## How Secretbox uses the format

Each file has one X25519 stanza.

| File | Recipient (the public key that locks it) | Data in the payload |
|---|---|---|
| Envelope | The member's passkey public key | The box private key (74 characters) |
| Box name file | The box public key | The box name |
| Member name file | The box public key | `{"name", "invitedBy"}` as JSON |
| Item label | The box public key | `{"name", "type", "size", "addedBy"}` as JSON |
| Item data | The box public key | The item |
| Invite file | The one-time public key | `{"boxKey", "name", "invitedBy"}` as JSON |
| Invite name file | The box public key | `{"name", "invitedBy"}` as JSON |

age can put many stanzas in one file, one for each recipient. Secretbox does not do this. It locks data to the box key, and gives each member the box private key in their own envelope. So a new member needs only one new envelope, and no item changes.

## Verify the values yourself

```sh
node docs/technical/example-data.mjs
```

The script prints `All checks passed` and writes [example-data.json](example-data.json). Each run makes new random values.

[← All documents](../README.md)
