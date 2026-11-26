# How Secretbox works

These documents explain what Secretbox does in each situation. They show each key, each file, each lock method and each result. They also show how the result of one step goes into the next step.

The text uses [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/): short sentences, active voice, one meaning for each word.

## In short

Secretbox keeps shared data in locked boxes. A person opens a box with Face ID or a fingerprint, through a passkey on their phone. The server keeps the boxes, but it cannot open them.

To give access, an admin sends a link. The link works one time. Nobody types an email address.

## Read this first: padlocks and keys

The system uses pairs of keys. Think of an **open padlock** and **the key that opens it**.

- The **public key** is the open padlock. You can give copies to anybody. Anybody can snap it shut on a box. Nobody can open the box with it.
- The **private key** is the key. Only the person who has it can open what the padlock locked.

In Secretbox, a public key starts with `age1…`. A private key starts with `AGE-SECRET-KEY-1…`.

## The words in these documents

Each word has one meaning in all documents.

| Word | Meaning | Example |
|---|---|---|
| **Lock** | Encrypt. Make data that only the correct key can read. | |
| **Unlock** | Decrypt. Get the original data back with the correct key. | |
| **Public key** | The open padlock. It can lock. It cannot unlock. | `age1gffpl2mrf5g9…` |
| **Private key** | The key that unlocks what its public key locked. | `AGE-SECRET-KEY-1XZZ8PLLY…` |
| **Key pair** | A public key and its private key. | |
| **Passkey** | A login key in a phone or password manager. You use it with Face ID or a fingerprint. It has a hidden secret that never leaves the device. | |
| **PRF output** | 32 bytes that a passkey gives for an input, after Face ID. The same input always gives the same output. | `add6282257e13a4c…` |
| **age file** | A locked file in the [age](https://age-encryption.org) format. Every locked thing in Secretbox is an age file. | |
| **File key** | A random 16-byte key. The system makes a new one for each age file. | `bd991a3d7a99a5c2…` |
| **Member key** | One key pair for each person. | |
| **Envelope** | An age file that holds a person's member private key. Only that person's passkey unlocks it. | |
| **Box key** | One key pair for each box. | |
| **Key copy** | An age file that holds a box private key. A member private key unlocks it. Each member has their own key copy. | |
| **Item** | One piece of data in a box, for example a note or a file. It is an age file. | |
| **Temporary key pair** | A key pair that age makes inside one file, to lock the file key to a public key. age forgets the private part immediately. | `qj0vsVPNwwInsjLR…` (public part) |
| **One-time key** | A key pair that the system makes for one invite link. | |
| **Invite file** | An age file that holds a box private key. The one-time private key unlocks it. | |
| **Key history** | An age file that holds old box private keys. The current box private key unlocks it. | |
| **Session token** | A random value in a browser cookie. It shows the server who you are after you sign in. | |
| **Ingest token** | A secret that lets another system add items to a box. | |

## The big picture

One Face ID unlocks a chain. Each step gives the key for the next step.

```mermaid
flowchart TD
  P["Passkey + Face ID<br/>(on the phone)"] -->|unlocks| E["Envelope<br/>(age file on server)"]
  E -->|holds| M["Member private key<br/>(in the browser tab only)"]
  M -->|unlocks| K["Key copy<br/>(age file on server)"]
  K -->|holds| B["Box private key<br/>(in the browser tab only)"]
  B -->|unlocks| I["Item<br/>(age file on server)"]
  I -->|holds| T["The data, for example a note"]
```

The server keeps the three age files. It never gets a private key, a PRF output or the data.

## How one age file is made

Every age file has the same four parts. This is the "recipe". The scenario documents show each part with real values.

```mermaid
flowchart LR
  FK["1. File key<br/>random 16 bytes"] --> ST["2. Stanza<br/>the file key, locked"]
  FK --> MAC["3. Header check<br/>finds changes"]
  FK --> PL["4. Payload<br/>the data, locked"]
  R["Public key or passkey"] --> ST
  D["Data"] --> PL
```

1. **File key.** The system makes a random 16-byte file key.
2. **Stanza.** The system locks the file key. A public key or a passkey decides how. The result is one line in the file header.
3. **Header check.** The system calculates a check value (MAC) from the header. If somebody changes the header, the check fails.
4. **Payload.** The system locks the data with a key that comes from the file key.

To unlock, the system goes back: unlock the stanza, get the file key, verify the header check, unlock the payload.

Details: [technical/age-format.md](technical/age-format.md).

## The example people

| Person | Role |
|---|---|
| **Tiger** | Makes the box "Finance 2026". He is the admin. |
| **Nok** | Gets an invite link from Tiger. She is a reader. |
| **Mallory** | Finds Nok's link after Nok used it. |

All example values are real outputs of the same code that Secretbox uses. The script simulates one part: the passkeys. A real passkey never shows its hidden secret.

The script [technical/example-data.mjs](technical/example-data.mjs) makes the values and verifies each file with the real library. The values are in [technical/example-data.json](technical/example-data.json). Each run of the script makes new random values. The documents use the values in the JSON file of this commit.

Tables show long values in a short form. They end with `…`.

## How to read a scenario

Each scenario document has the same parts. The first three parts need no technical knowledge.

| Part | For whom | What it tells |
|---|---|---|
| **In short** | Everybody | The idea, in a few sentences. |
| **What … sees** | Everybody | The steps on the screen. |
| **What happens, in plain words** | Everybody | The steps behind the screen. |
| **Who talks to whom** | Technical readers | A diagram of the messages between the phone, the browser and the server. |
| **How the keys flow** | Technical readers | A diagram of which output goes into which step. |
| **Steps: input, method, output** | Technical readers | A table with real example values. The column "Goes to" shows where each output is used next. |
| **Result** | Everybody | What is kept, where, and how many times Face ID is necessary. |

## Scenarios

1. [A new person makes an account and a box](01-new-user-new-box.md)
2. [A person with an account makes a new box](02-existing-user-new-box.md)
3. [An admin adds an item, and a member reads it](03-add-item.md)
4. [An admin makes an invite link](04-create-invite.md)
5. [A person uses an invite link](05-use-invite.md)
6. [An invite link is expired, or another person opens a used link](06-invite-expired-or-reused.md)
7. [What the database keeps](07-storage.md)
8. [Security flaws and limits](08-security.md)

## Technical details

- [age file format: file key, stanzas, header check, payload](technical/age-format.md)
- [Passkey PRF and the fido2prf stanza](technical/passkey-prf.md)
- [Passkey sign-up, sign-in and sessions](technical/webauthn-and-sessions.md)
- [API calls and database statements](technical/api-and-sql.md)
