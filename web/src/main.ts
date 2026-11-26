import { ApiError } from "./api.ts";
import * as vault from "./vault.ts";

// ---------------------------------------------------------------------------
// Tiny DOM helper

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k.startsWith("data-") || k.startsWith("aria-") || !(k in el)) el.setAttribute(k, String(v));
    else (el as any)[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const app = document.getElementById("app")!;
const notice = document.getElementById("notice")!;

function show(...nodes: Child[]) {
  app.replaceChildren(...(nodes.filter(Boolean) as (Node | string)[]));
}

function say(message: string | null, kind: "info" | "error" | "ok" = "info") {
  notice.replaceChildren();
  notice.className = "";
  if (!message) return;
  notice.className = `notice ${kind}`;
  notice.append(h("span", {}, message), h("button", { class: "link", onclick: () => say(null), "aria-label": "Close" }, "×"));
}

function explain(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotAllowedError") return "The passkey request was canceled or timed out.";
  const msg = err instanceof Error ? err.message : String(err);
  if (/no identity matched|failed to decrypt/i.test(msg)) return "This key doesn't open that data.";
  return msg;
}

/** Runs an action with a busy button and a status line; shows errors. */
async function act(btn: HTMLButtonElement | null, status: string, fn: () => Promise<void>) {
  if (btn) btn.disabled = true;
  say(status);
  try {
    await fn();
    if (notice.classList.contains("info")) say(null);
  } catch (err) {
    console.error(err);
    say(explain(err), "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// ---------------------------------------------------------------------------
// Router

function go(path: string) {
  history.pushState(null, "", path);
  void render();
}

window.addEventListener("popstate", () => void render());

async function render() {
  const path = location.pathname;
  let m: RegExpMatchArray | null;
  try {
    if ((m = path.match(/^\/join\/([\w-]+)$/))) return await joinView(m[1]);
    if ((m = path.match(/^\/box\/([\w-]+)$/))) return await boxView(m[1]);
    return homeView();
  } catch (err) {
    console.error(err);
    show(topbar(), h("section", { class: "card" }, h("p", { class: "error" }, explain(err)), h("a", { href: "/", onclick: link("/") }, "Go home")));
  }
}

const link = (path: string) => (e: Event) => {
  e.preventDefault();
  go(path);
};

function topbar(open?: vault.Box) {
  return h(
    "header",
    { class: "topbar" },
    h("a", { class: "brand", href: "/", onclick: link("/") }, "Secretbox"),
    location.pathname.startsWith("/box/") &&
      h(
        "div",
        { class: "who" },
        h("span", { class: `pill ${open ? "ok" : ""}`, "data-test": "lock-state" }, open ? "Unlocked" : "Locked"),
        open && h("span", { class: "muted" }, open.me.name),
        open && h("button", { class: "link", "data-test": "lock", onclick: () => { vault.lock(); go("/"); } }, "Lock"),
      ),
  );
}

/** Opens a box with a passkey the person picks, and goes to that box. */
function openButton(label: string, test: string) {
  const btn = h("button", { class: "primary", "data-test": test }, label);
  btn.onclick = () =>
    act(btn, "Choose the passkey for the box…", async () => {
      const boxId = await vault.openWithPasskey();
      say(null);
      if (location.pathname === `/box/${boxId}`) await render();
      else go(`/box/${boxId}`);
    });
  return btn;
}

// ---------------------------------------------------------------------------
// Home

function homeView() {
  const nick = h("input", { placeholder: "Your name, e.g. Tiger", autocomplete: "nickname", "data-test": "nickname" });
  const boxName = h("input", { placeholder: "Box name, e.g. Finance 2026", "data-test": "box-name" });
  const createBtn = h("button", { class: "primary", "data-test": "create-box" }, "Create box");
  createBtn.onclick = () =>
    act(createBtn, "Make the passkey for this box…", async () => {
      if (!nick.value.trim() || !boxName.value.trim()) throw Error("Type your name and a box name.");
      go(`/box/${await vault.createBox(boxName.value.trim(), nick.value.trim())}`);
    });
  const openId = vault.openBoxId();
  show(
    topbar(),
    h("section", { class: "hero" },
      h("h1", {}, "Share confidential data, without accounts or emails."),
      h("p", { class: "muted" }, "Send a one-time invite link. Each box has its own passkey. The server only stores locked files."),
    ),
    openId && h("section", { class: "card" }, h("a", { href: `/box/${openId}`, onclick: link(`/box/${openId}`) }, "Go back to the open box")),
    h("section", { class: "card" },
      h("h2", {}, "Open a box"),
      h("p", { class: "muted" }, "Your device shows one passkey for each of your boxes. Choose one to open that box."),
      openButton("Open with passkey", "open-box"),
    ),
    h("section", { class: "card" },
      h("h2", {}, "Start a new box"),
      h("label", {}, "Your name", nick),
      h("label", {}, "Box name", boxName),
      h("p", { class: "muted small" }, "Your device makes a passkey for this box. There is no account and no email."),
      createBtn,
    ),
  );
}

// ---------------------------------------------------------------------------
// Box

async function boxView(boxId: string) {
  if (vault.openBoxId() !== boxId) {
    return show(
      topbar(),
      h("section", { class: "card locked" },
        h("h2", {}, "This box is locked"),
        h("p", {}, "Your passkey for this box opens it in this tab, until you close the tab or select Lock."),
        openButton("Open with passkey", "unlock"),
      ),
    );
  }
  let d: vault.Box;
  try {
    d = await vault.load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      vault.lock();
      return boxView(boxId);
    }
    throw err;
  }
  const refresh = () => boxView(boxId);

  // --- Items
  const items = h("ul", { class: "list", "data-test": "items" },
    ...d.items.map((it) => {
      const name = it.label?.name ?? "From an outside system";
      const viewer = h("div", { class: "viewer" });
      const openBtn = h("button", { "data-test": "open-item" }, "Open");
      openBtn.onclick = () =>
        act(openBtn, "Unlocking…", async () => {
          const bytes = await vault.openItem(it.id);
          let text: string | null = null;
          try {
            if (bytes.length < 200_000) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch { /* binary */ }
          const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: it.label?.type || "" }));
          const file = it.label?.name ?? `outside-${new Date(it.createdAt).toISOString().slice(0, 19)}.bin`;
          viewer.replaceChildren(
            text !== null ? h("pre", { "data-test": "item-text" }, text) : h("p", { class: "muted" }, "Binary file."),
            h("a", { href: url, download: file }, "Download"),
          );
        });
      const delBtn = h("button", { class: "link danger" }, "Delete");
      delBtn.onclick = () => act(delBtn, "Deleting…", async () => {
        if (!confirm(`Delete "${name}"?`)) return;
        await vault.deleteItem(it.id);
        await refresh();
      });
      const by = it.label ? it.label.addedBy : "outside system";
      return h("li", {},
        h("div", { class: "row" },
          h("div", {},
            h("div", { class: "row-main" }, name),
            h("div", { class: "muted small" }, `${fmtSize(it.label?.size ?? it.size)} · ${by} · ${fmtDate(it.createdAt)}`),
          ),
          h("div", { class: "actions" }, openBtn, delBtn),
        ),
        viewer,
      );
    }),
  );

  // --- Add data
  let addCard: HTMLElement;
  {
    const noteName = h("input", { value: "note.txt", "data-test": "note-name" });
    const note = h("textarea", { rows: 4, placeholder: "Type something secret…", "data-test": "note-text" });
    const noteBtn = h("button", { class: "primary", "data-test": "add-note" }, "Lock and add note");
    noteBtn.onclick = () => act(noteBtn, "Locking…", async () => {
      if (!note.value) throw Error("Type a note first.");
      await vault.addData(d, noteName.value.trim() || "note.txt", "text/plain", note.value);
      await refresh();
      say("Added. It was locked in your browser before upload.", "ok");
    });
    const file = h("input", { type: "file" });
    const fileBtn = h("button", {}, "Lock and upload file");
    fileBtn.onclick = () => act(fileBtn, "Locking…", async () => {
      const f = file.files?.[0];
      if (!f) throw Error("Choose a file first.");
      await vault.addData(d, f.name, f.type, new Uint8Array(await f.arrayBuffer()));
      await refresh();
      say("Uploaded. It was locked in your browser before upload.", "ok");
    });
    addCard = h("section", { class: "card" },
      h("h2", {}, "Add data"),
      h("p", { class: "muted small" }, "Your browser locks the data and its name with the box's public key before upload."),
      h("label", {}, "Name", noteName), note, noteBtn,
      h("hr"),
      file, fileBtn,
    );
  }

  // --- Members
  const members = h("ul", { class: "list", "data-test": "members" },
    ...d.members.map((m) => {
      const rm = !m.isMe && h("button", { class: "link danger", "data-test": `remove-${m.name}` }, "Remove");
      if (rm) rm.onclick = () => act(rm, "Removing…", async () => {
        if (!confirm(`Remove ${m.name}? Their passkey stops opening this box. If they copied the box key, they keep it: to cut someone off fully, make a new box.`)) return;
        await vault.removeMember(m.credentialId);
        await refresh();
        say(`${m.name} was removed.`, "ok");
      });
      const who = m.invitedBy ? `invited by ${m.invitedBy}` : "made this box";
      return h("li", { class: "row", "data-test": "member" },
        h("div", {},
          h("div", { class: "row-main" }, m.name, m.isMe ? " (you)" : ""),
          h("div", { class: "muted small" }, `${who} · ${fmtDate(m.createdAt)}`),
        ),
        h("div", { class: "actions" }, rm),
      );
    }),
  );

  // --- Invites: any member can invite
  let inviteCard: HTMLElement;
  {
    const name = h("input", { placeholder: "e.g. Nok", autocomplete: "off", "data-test": "invite-name" });
    const ttl = h("select", {},
      h("option", { value: "1" }, "1 hour"), h("option", { value: "24", selected: true }, "24 hours"),
      h("option", { value: "72" }, "3 days"), h("option", { value: "168" }, "7 days"));
    const invBtn = h("button", { class: "primary", "data-test": "create-invite" }, "Create invite link");
    invBtn.onclick = () => act(invBtn, "Creating invite…", async () => {
      if (!name.value.trim()) throw Error("Type the name of the person you invite.");
      const url = await vault.createInvite(d, name.value.trim(), Number(ttl.value));
      await refresh();
      const out = h("input", { readOnly: true, value: url, "data-test": "invite-link" });
      const copy = h("button", {}, "Copy");
      copy.onclick = async () => { await navigator.clipboard.writeText(url); copy.textContent = "Copied"; };
      document.querySelector("[data-test=invite-result]")?.replaceChildren(
        h("div", { class: "invite-result" },
          h("p", { class: "small" }, h("strong", {}, "Send this link in a private chat. "), "It works one time, and this is the only time it is shown."),
          h("div", { class: "copyrow" }, out, copy),
        ),
      );
      say(null);
    });
    const list = h("ul", { class: "list", "data-test": "invites" },
      ...d.invites.map((i) => {
        const cancel = h("button", { class: "link danger", "data-test": `cancel-${i.name}` }, "Cancel");
        cancel.onclick = () => act(cancel, "Canceling…", async () => {
          await vault.cancelInvite(i.id);
          await refresh();
        });
        return h("li", { class: "row" },
          h("div", {},
            h("div", { class: "row-main" }, i.name),
            h("div", { class: "muted small" }, `by ${i.invitedBy} · expires ${fmtDate(i.expiresAt)}`),
          ),
          h("div", { class: "actions" }, cancel),
        );
      }),
    );
    inviteCard = h("section", { class: "card" },
      h("h2", {}, "Invite someone"),
      h("p", { class: "muted small" }, "Everybody in this box can invite others. The name you type is how this person appears here."),
      h("div", { class: "grid2" }, h("label", {}, "Their name", name), h("label", {}, "Expires after", ttl)),
      invBtn, h("div", { "data-test": "invite-result" }),
      d.invites.length > 0 && h("h3", {}, "Open invites"), d.invites.length > 0 && list,
    );
  }

  // --- Outside systems
  let ingestCard: HTMLElement;
  {
    const out = h("div", {});
    const makeBtn = h("button", { "data-test": "create-token" }, d.hasAddKey ? "Replace add key" : "Make add key");
    makeBtn.onclick = () => act(makeBtn, "Making add key…", async () => {
      if (d.hasAddKey && !confirm("Replace the add key? The old one stops working.")) return;
      const addKey = await vault.makeAddKey();
      const cmd = `age -r ${d.publicKey} answer.txt \\\n  | curl --data-binary @- \\\n    -H "Authorization: Bearer ${addKey}" \\\n    "${location.origin}/api/ingest/${boxId}"`;
      out.replaceChildren(
        h("p", { class: "small" }, h("strong", {}, "Copy the add key now. "), "It is shown only once."),
        h("pre", { "data-test": "token" }, addKey),
        h("p", { class: "small muted" }, "Example with the age CLI:"),
        h("pre", {}, cmd),
      );
      say(null);
    });
    const offBtn = d.hasAddKey && h("button", { class: "link danger" }, "Turn off");
    if (offBtn) offBtn.onclick = () => act(offBtn, "Turning off…", async () => {
      await vault.deleteAddKey();
      await refresh();
    });
    ingestCard = h("section", { class: "card" },
      h("h2", {}, "Outside systems"),
      h("p", { class: "muted small" }, "A form tool or a script can add data with the public key and an add key. It can add, but it can't read."),
      h("pre", { "data-test": "box-recipient" }, d.publicKey),
      h("p", { class: "small muted" }, d.hasAddKey ? "An add key exists." : "There is no add key."),
      h("div", { class: "actions" }, makeBtn, offBtn),
      out,
    );
  }

  show(
    topbar(d),
    h("section", { class: "boxhead" }, h("h1", { "data-test": "box-title" }, d.name)),
    h("section", { class: "card" }, h("h2", {}, "Data"), d.items.length ? items : h("p", { class: "muted" }, "No data yet.")),
    addCard,
    h("section", { class: "card" }, h("h2", {}, "Members"), members),
    inviteCard,
    ingestCard,
  );
}

// ---------------------------------------------------------------------------
// Join

let openedInvite: vault.OpenedInvite | null = null;

async function joinView(inviteId: string) {
  const oneTimeKey = decodeURIComponent(location.hash.slice(1));
  const card = (...rest: Child[]) => show(topbar(), h("section", { class: "card", "data-test": "join" }, h("h2", {}, "You're invited"), ...rest));

  if (!oneTimeKey.startsWith("AGE-SECRET-KEY-1")) {
    return card(h("p", { class: "error" }, "This link is incomplete. Open the full link exactly as it was sent."));
  }

  // A reload after "Open invite": the locked invite file is still in this tab.
  if (openedInvite?.inviteId !== inviteId && sessionStorage.getItem(`invite:${inviteId}`)) {
    openedInvite = await vault.openInvite(inviteId, oneTimeKey);
  }

  if (openedInvite?.inviteId !== inviteId) {
    const openBtn = h("button", { class: "primary", "data-test": "open-invite" }, "Open invite");
    openBtn.onclick = () => act(openBtn, "Opening the invite…", async () => {
      openedInvite = await vault.openInvite(inviteId, oneTimeKey);
      await render();
    });
    return card(
      h("p", {}, "Somebody invited you to a box in Secretbox."),
      h("p", { class: "muted small" }, "Opening the invite uses up this link, so nobody else can use it after you."),
      openBtn,
    );
  }

  const inv = openedInvite;
  const accept = h("button", { class: "primary", "data-test": "accept" }, "Accept and make passkey");
  accept.onclick = () =>
    act(accept, "Make your passkey for this box…", async () => {
      const boxId = await vault.join(inv);
      openedInvite = null;
      // Drop the one-time key from the address bar and the history entry.
      history.replaceState(null, "", `/box/${boxId}`);
      await render();
      say(`You joined “${inv.boxName}”.`, "ok");
    });
  card(
    h("p", {}, `${inv.invitedBy} invited you to “${inv.boxName}”.`),
    h("p", { class: "muted small", "data-test": "invite-as" }, `You will appear as ${inv.name} in this box.`),
    h("p", { class: "muted small" }, "Nothing to fill in, and no email. Your device makes a passkey for this box."),
    accept,
  );
}

void render();
