# Technical details: passkeys, access keys and add keys

[← All documents](../README.md)

Vault Box has no accounts, no sign-in, no sessions and no cookies. This document shows what replaces them.

| Question | Answer |
|---|---|
| How does the server know that a request comes from a member? | The request has the box's **access key**. Only a person with the box private key can calculate it. |
| How does a person get the box private key? | Their passkey unlocks their envelope. See [passkey-prf.md](passkey-prf.md). |
| What does the passkey send to the server? | Nothing. The browser uses it only to get the PRF output. The server never checks a passkey. |
| How does another system add data? | With the box public key and an **add key**. |

## Passkey domain

A passkey works only on the domain where the person made it (the "RP ID"). The browser uses `location.hostname`. So:

- A passkey made on `vlt.i7r.tech` does not work on a preview URL or on any other domain.
- Choose the final domain before real members join.

The server does not check the domain, because it does not check passkeys.

## The access key

```
access_key  = base64url( HMAC-SHA-256(key = box_private_key_bytes, message = "secretbox access key v1") )
access_hash = hex( SHA-256(access_key as text) )
```

The text `secretbox access key v1` keeps the app's old name, Secretbox, on purpose. Every box's access hash depends on it, so it can't change.

With the Finance 2026 values:

```
box_private_key_bytes = 11ead6a26d3f3858c7b64820cc60dad4a15e59c7ec7e1a688e6c7f5dbf404c24
access_key            = -opAqacwlYsMBtzqm8OLNy6fM6xa3MBHIPav8AuUxBI
access_hash           = 1ee2b4af37da3c39ca453399e1f43b6108dd9ff6bdfa1885e9bddda5da79c412       ← the server keeps only this
```

The code is `accessKey()` in [web/src/keys.ts](../../web/src/keys.ts). It uses WebCrypto.

| Property | Why |
|---|---|
| Only members can make it | It needs the box private key. |
| It does not show the private key | HMAC-SHA-256 is one-way. |
| It is the same for all members | They all have the same box private key. |
| It never changes | The box private key never changes. See [flaw 2](../08-security.md#2-removal-deletes-only-the-envelope). |
| The server keeps a fast hash | The key has 256 random bits, so nobody can guess it from the hash. A slow password hash is not necessary. |

### How the server checks it

Each member request sends the header:

```
Authorization: Bearer -opAqacwlYsMBtzqm8OLNy6fM6xa3MBHIPav8AuUxBI
```

The server runs:

```sql
SELECT id FROM boxes WHERE id = $1 AND access_hash = $2   -- $2 = SHA-256 of the key from the header
```

No row means HTTP 401: "This key does not open this box". The server does not say if the box exists.

### Which requests need it

| Request | Needs |
|---|---|
| `POST /api/boxes` (make a box) | The new access key. The server keeps its hash. |
| `GET /api/boxes/:id/envelopes/:credentialId` | Nothing. Only the passkey can unlock the envelope. |
| `POST /api/invites/:id/claim` | Nothing. Only the key in the link can unlock the invite file. |
| `POST /api/ingest/:id` | The add key. |
| All other `/api/boxes/:id/…` requests | The access key. |

## The add key

An outside system, for example a form tool, gets two values from a member:

- the box public key, to lock data,
- an add key, to send it.

```
add_key  = "vlt_" + base64url(24 random bytes)          (the server makes it)
         = vlt_…
add_hash = hex( SHA-256(add_key) )
         = 2e8700659d1ccec37997aca0d436d936a7274f693fe939e50fe13eeadfb78974       ← the server keeps only this
```

The server shows the add key one time. A box has zero or one add key. **Replace add key** makes a new one, and the old one stops working. **Turn off** deletes the hash.

The add key works only for `POST /api/ingest/:id`. It cannot read, list or delete. The body must be one age file. The server accepts binary and ASCII-armored files (`age -a`).

## Other websites

Other websites cannot use a member's access:

- **No cookies.** The browser sends nothing automatically. Each request needs the access key, and the access key is only in the memory of the Vault Box tab.
- **No CORS headers.** Other websites cannot read the answers of the API.
- **Strict CSP.** The page loads scripts only from its own address. It allows no inline scripts. The policy is in `HTML_HEADERS` in [server/app.ts](../../server/app.ts).

## Compared with the first version

| First version | This version |
|---|---|
| A user account for each person. | No accounts. |
| One passkey for each person. The server checked it at sign-in (SimpleWebAuthn). | One passkey for each box membership. The server never checks it. |
| A session cookie for 30 days. | The access key, in tab memory, until the box locks: **Lock**, 5 minutes without use, a hidden tab, or a closed tab. |
| A member key and a key copy for each box. | An envelope for each membership, with the box private key. |
| Roles, then no roles. | No roles. |
| Removal changed the box key. | Removal deletes the envelope. The box key stays. |

[← All documents](../README.md)
