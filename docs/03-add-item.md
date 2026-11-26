# 3. A member adds an item, and a member reads it

[← All documents](README.md) · [Word list](README.md#the-words-in-these-documents)

## In short

Tiger adds a note to "Finance 2026": `Salary sheet: Nok 50k`.

**Adding** needs only the box **public** key. The browser locks the note and its name before it sends them. The server keeps two age files: the **label** and the **data**.

**Reading** needs the box **private** key. When the box is open, the browser has it in memory. So reading needs no Face ID.

## What Tiger sees

To add:

1. Open the box "Finance 2026". The **Items** tab shows.
2. Select **New note**. Type a title and the note. Select **Save note**.
3. The note shows in the list, with its title, size, "Tiger" and the date.

To add a file, select **Upload file** and choose the file. The upload starts immediately.

To read:

1. Select the note in the list.
2. The note shows below its title.

## Part A: add the item

### What happens, in plain words

1. The browser makes the label: the name `note.txt`, the type, the size and "Tiger".
2. The browser locks the label with the box public key.
3. The browser locks the note with the box public key. Each lock makes a new random file key.
4. The browser sends the two age files with the access key. The server keeps them, but cannot open them.

### Who talks to whom

```mermaid
sequenceDiagram
  actor T as Tiger
  participant B as Browser
  participant S as Server
  Note over B: The box is open. The browser has the box public key and the access key
  T->>B: Title, note text, Save note
  Note over B: A1–A6. Lock the label. Lock the note
  B->>S: A7. POST /api/boxes/BOX_ID/items with the access key. Two age files
  Note over S: Check the access key. Check that both parts are age files. Keep them
  S-->>B: Item ID
```

### How the keys flow

The browser does the same recipe two times: for the label and for the note. This diagram shows the note.

```mermaid
flowchart TD
  BP["Box public key<br/>checked in scenario 2"] --> SS["A3. Shared secret"]
  EK["A2. Temporary key pair"] --> SS
  SS --> WK["A4. Wrap key"]
  FK["A1. File key<br/>random 16 bytes"] --> ST["A4. Stanza<br/>file key, locked"]
  WK --> ST
  FK --> MAC["A5. Header check"]
  FK --> PK["A6. Payload key"]
  N["The note"] --> PL["A6. Payload<br/>note, locked"]
  PK --> PL
  ST --> F["The data file"]
  MAC --> F
  PL --> F
```

### Steps: input, method, output

| Step | Input | Method | Output | Goes to |
|---|---|---|---|---|
| A0. Label | The name, the type, the size and Tiger's name. | JSON text. | `{"name":"note.txt","type":"text/plain","size":21,"addedBy":"Tiger"}` | The same recipe as A1–A6. The result is the label file, 267 bytes. Then A7. |
| A1. File key | Random bytes. | Random 16 bytes. | `e6e880992a9faf8cbbfe1da538653f9f` | A4, A5, A6 |
| A2. Temporary key pair | Random bytes. | X25519 key generation. | Temporary public part `csC1SWy5hBxFb9OH…` | A3, and the stanza line |
| A3. Shared secret | The temporary private part (A2). The box public key `age1aa0rtwwaz8rhsdt2…`. | X25519 | `9ed9b3e7a706e85a…` | A4 |
| A4. Lock the file key | The shared secret (A3). The file key (A1). | HKDF-SHA-256 makes the wrap key `7abc12d3c0efe15a…`. ChaCha20-Poly1305 locks the file key. | Stanza body `r3k3VpSGco7wucbC…` | The header |
| A5. Header check | The file key (A1). The header. | HKDF-SHA-256 makes the MAC key `33fce5a30f50df2b…`. HMAC-SHA-256 makes the MAC. | MAC `PWNYy+XB25dDVeCf…` | The header |
| A6. Payload | The file key (A1). The note (21 bytes). | HKDF-SHA-256 with a random nonce `70821bbbf211a4ff…` makes the payload key `92f2c509e44e6fb6…`. ChaCha20-Poly1305 locks the note. | 53 bytes: a 16-byte nonce, 21 locked bytes, a 16-byte tag. | The data file |
| A7. Send | The label file (A0) and the data file (221 bytes). The access key. | `POST /api/boxes/:id/items`, as two parts of a form: `label` and `data`. | The server checks the access key. It checks that each part starts with `age-encryption.org/v1`. Then it keeps them. | Part B |

The data file, as the server keeps it:

```
age-encryption.org/v1
-> X25519 csC1SWy5hBxFb9OHqyOPz+hovpr0HCeFB62jnP/e5jw
r3k3VpSGco7wucbClUEQy8YF/ZSSOZx6vERXVCEowS0
--- PWNYy+XB25dDVeCfF+Coqfq8MQ1gjkePnmadGb77IXU
[53 bytes: the note, locked]
```

The label file looks the same, with different values. The server cannot see the name `note.txt`.

### The keys in this part

| Key | Secret? | Where it comes from | What it does here |
|---|---|---|---|
| Box public key | No | The server. The browser checked it against the box private key. | Locks the two file keys (A3, A4). |
| Temporary key pair | Yes, but only for a moment | Made in A2 | Makes the shared secret. The browser then forgets the private part. |
| File key | Yes | Made in A1 | Locks the note, through the payload key. |
| Access key | Yes | Calculated when the box opened | Shows the server that a member sends the item. |
| Passkey | Not used | | Adding needs no Face ID. |

### Another system adds an item

A form tool or a script can add items too. A member makes an **add key** for it under **Let a form or script add items**, at the bottom of the **Items** tab. The server keeps only the SHA-256 hash of the add key, for example `f380ac83935d686b…`.

The other system needs the box public key and the add key. It cannot read, list or delete items, because it has no private key and no access key.

```
age -r age1aa0rtwwaz8rhsdt243382vx2x7lhf7lscfdtm6tcxhxnsqxl594sg0gwew answer.txt \
  | curl --data-binary @- -H "Authorization: Bearer sbx_…" \
    "https://secretbox-nu.vercel.app/api/ingest/Ze3WdI5DdSbboy05-E6vhQ"
```

The age command does steps A1 to A6. It sends only the data file, with no label. So the members see the item as "From an outside system". A member can make a new add key. Then the old add key stops working.

## Part B: read the item

### What happens, in plain words

1. The browser gets the data file from the server. It sends the access key.
2. The box private key unlocks the data file. The browser shows the note.

The browser unlocked the label before, when it showed the list.

### Who talks to whom

```mermaid
sequenceDiagram
  actor T as Tiger
  participant B as Browser
  participant S as Server
  T->>B: Select the item
  B->>S: B1. GET /api/boxes/BOX_ID/items/ITEM_ID with the access key
  S-->>B: The data file, 221 bytes
  Note over B: B2. Unlock it with the box private key
  B->>T: The note
```

### Steps: input, method, output

| Step | Input | Method | Output | Goes to |
|---|---|---|---|---|
| B1. Get the data file | The item ID. The access key. | `GET /api/boxes/:id/items/:itemId` | The data file, 221 bytes. | B2 |
| B2. Unlock | The data file (B1). The box private key, from tab memory. | X25519 with the temporary public part `csC1SWy5hBxFb9OH…` gives the same shared secret `9ed9b3e7a706e85a…`. HKDF-SHA-256 gives the wrap key `7abc12d3…`. ChaCha20-Poly1305 unlocks the file key `e6e88099…`. The payload key `92f2c509…` unlocks the payload. | `Salary sheet: Nok 50k` | The screen |

**Why the shared secret is the same in A3 and B2.** X25519 gives one value from two different pairs:

- the temporary private part and the box public key (when Tiger locks),
- the box private key and the temporary public part (when a member unlocks).

Only a person who has one of the two private parts can calculate the value.

## Result

| Where | What |
|---|---|
| Server | The label file and the data file. The date. The size of each file. |
| Browser tab memory | While reading: the box private key and the note. |

| Action | Face ID |
|---|---|
| Add an item (box open) | 0 |
| Read an item (box open) | 0 |
| A locked box | 1 to open it first ([scenario 2](02-open-box.md)) |

## Technical details

- [The X25519 stanza, header check and payload, step by step](technical/age-format.md)
- [The add key](technical/passkeys-and-access-keys.md#the-add-key)
- [API calls and database statements](technical/api-and-sql.md)

[← Previous](02-open-box.md) · [Next: a member makes an invite link →](04-create-invite.md)
