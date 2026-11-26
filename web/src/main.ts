import { api, ApiError, registerPasskey, signInWithPasskey, type BoxDetail, type InviteInfo, type Me } from "./api.ts";
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
  if (/PRF/.test(msg)) return "This passkey can't unlock data (no PRF support). Use Apple Passwords, Google Password Manager, or a recent security key.";
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
    if (err instanceof ApiError && err.status === 401) {
      state.me = null;
      await render();
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// ---------------------------------------------------------------------------
// State + router

const state: { me: Me | null } = { me: null };

async function loadMe(): Promise<Me | null> {
  try {
    state.me = await api.get<Me>("/api/me");
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) throw err;
    state.me = null;
  }
  return state.me;
}

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
    return await homeView();
  } catch (err) {
    console.error(err);
    show(topbar(), h("section", { class: "card" }, h("p", { class: "error" }, explain(err)), h("a", { href: "/", onclick: link("/") }, "Go home")));
  }
}

const link = (path: string) => (e: Event) => {
  e.preventDefault();
  go(path);
};

function topbar() {
  const me = state.me;
  return h(
    "header",
    { class: "topbar" },
    h("a", { class: "brand", href: "/", onclick: link("/") }, "Secretbox"),
    me &&
      h(
        "div",
        { class: "who" },
        h("span", { class: `pill ${vault.isUnlocked() ? "ok" : ""}`, "data-test": "lock-state" }, vault.isUnlocked() ? "Unlocked" : "Locked"),
        h("span", { class: "muted" }, me.nickname),
        vault.isUnlocked() &&
          h("button", { class: "link", onclick: () => { vault.lock(); void render(); } }, "Lock"),
        h("button", {
          class: "link",
          onclick: async () => {
            await api.post("/api/logout");
            vault.lock();
            state.me = null;
            go("/");
          },
        }, "Sign out"),
      ),
  );
}

// ---------------------------------------------------------------------------
// Home

async function homeView() {
  const me = await loadMe();
  if (!me) {
    const nick = h("input", { placeholder: "Your name, e.g. Tiger", autocomplete: "nickname", "data-test": "nickname" });
    const boxName = h("input", { placeholder: "Box name, e.g. Finance 2026", "data-test": "box-name" });
    const createBtn = h("button", { class: "primary", "data-test": "create-box" }, "Create box");
    createBtn.onclick = () =>
      act(createBtn, "Step 1 of 2: make your passkey…", async () => {
        if (!nick.value.trim() || !boxName.value.trim()) throw Error("Type your name and a box name.");
        await registerPasskey(nick.value.trim());
        const me = (await loadMe())!;
        say("Step 2 of 2: confirm your passkey again to lock your key…");
        await vault.setupMemberKey(me);
        const id = await vault.createBox((await loadMe())!, boxName.value.trim());
        go(`/box/${id}`);
      });
    const signInBtn = h("button", { "data-test": "sign-in" }, "Sign in with passkey");
    signInBtn.onclick = () =>
      act(signInBtn, "Waiting for your passkey…", async () => {
        await signInWithPasskey();
        await render();
      });
    return show(
      topbar(),
      h("section", { class: "hero" },
        h("h1", {}, "Share confidential data, without collecting emails."),
        h("p", { class: "muted" }, "Send a one-time invite link. Readers unlock the data with their passkey. The server only stores locked files."),
      ),
      h("section", { class: "card" }, h("h2", {}, "Sign in"), h("p", { class: "muted" }, "Use the passkey you made before."), signInBtn),
      h("section", { class: "card" },
        h("h2", {}, "Start a new box"),
        h("label", {}, "Your name", nick),
        h("label", {}, "Box name", boxName),
        h("p", { class: "muted small" }, "Your device asks for your passkey two times: once to make it, once to lock your key with it."),
        createBtn,
      ),
    );
  }

  const { boxes } = await api.get<{ boxes: import("./api.ts").BoxSummary[] }>("/api/boxes");
  const name = h("input", { placeholder: "Box name", "data-test": "new-box-name" });
  const newBtn = h("button", { class: "primary" }, "Create box");
  newBtn.onclick = () =>
    act(newBtn, "Creating box…", async () => {
      if (!name.value.trim()) throw Error("Type a box name.");
      go(`/box/${await vault.createBox(me, name.value.trim())}`);
    });
  const setupBtn = h("button", { class: "primary" }, "Set up my key");
  setupBtn.onclick = () =>
    act(setupBtn, "Confirm your passkey to lock your key…", async () => {
      await vault.setupMemberKey(me);
      await render();
    });

  show(
    topbar(),
    !me.memberRecipient &&
      h("section", { class: "card warn" }, h("h2", {}, "Finish setting up"), h("p", {}, "Your passkey exists, but your key isn't locked to it yet."), setupBtn),
    h("section", { class: "card" },
      h("h2", {}, "Your boxes"),
      boxes.length === 0
        ? h("p", { class: "muted" }, "No boxes yet. Create one, or open an invite link.")
        : h("ul", { class: "list" },
            ...boxes.map((b) =>
              h("li", {},
                h("a", { href: `/box/${b.id}`, onclick: link(`/box/${b.id}`), class: "row-main" }, b.name),
                h("span", { class: "muted small" }, `${b.item_count} items · ${b.member_count} members`),
              ),
            ),
          ),
    ),
    me.memberRecipient && h("section", { class: "card" }, h("h2", {}, "New box"), name, newBtn),
  );
}

// ---------------------------------------------------------------------------
// Box

async function boxView(boxId: string) {
  const me = await loadMe();
  if (!me) return go("/");
  let d: BoxDetail;
  try {
    d = await api.get<BoxDetail>(`/api/boxes/${boxId}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return show(topbar(), h("section", { class: "card", "data-test": "no-access" }, h("h2", {}, "No access"), h("p", {}, "You are not a member of this box."), h("a", { href: "/", onclick: link("/") }, "Go home")));
    }
    throw err;
  }
  // There are no roles: every member can add, invite, remove and delete.
  const refresh = () => boxView(boxId);

  async function ensureUnlocked() {
    if (vault.isUnlocked()) return;
    say("Confirm your passkey to unlock…");
    await vault.unlock(me!);
  }

  // --- Unlock
  const unlockBtn = h("button", { class: "primary", "data-test": "unlock" }, "Unlock with passkey");
  unlockBtn.onclick = () => act(unlockBtn, "Confirm your passkey to unlock…", async () => { await vault.unlock(me); await refresh(); });

  // --- Items
  const items = h("ul", { class: "list", "data-test": "items" },
    ...d.items.map((it) => {
      const viewer = h("div", { class: "viewer" });
      const openBtn = h("button", { "data-test": "open-item" }, "Open");
      openBtn.onclick = () =>
        act(openBtn, "Unlocking…", async () => {
          await ensureUnlocked();
          const bytes = await vault.openItem(d, it.id);
          let text: string | null = null;
          try {
            if (bytes.length < 200_000) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch { /* binary */ }
          const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
          viewer.replaceChildren(
            text !== null ? h("pre", { "data-test": "item-text" }, text) : h("p", { class: "muted" }, "Binary file."),
            h("a", { href: url, download: it.name }, "Download"),
          );
          if (!document.querySelector(".topbar .pill.ok")) app.querySelector(".topbar")?.replaceWith(topbar());
        });
      const delBtn = h("button", { class: "link danger" }, "Delete");
      delBtn.onclick = () => act(delBtn, "Deleting…", async () => {
        if (!confirm(`Delete "${it.name}"?`)) return;
        await api.del(`/api/boxes/${boxId}/items/${it.id}`);
        await refresh();
      });
      return h("li", {},
        h("div", { class: "row" },
          h("div", {},
            h("div", { class: "row-main" }, it.name),
            h("div", { class: "muted small" }, `${fmtSize(it.size)} · ${it.addedBy ?? it.source.replace(/^ingest:/, "via ")} · ${fmtDate(it.createdAt)}`),
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
      await vault.addData(d, noteName.value.trim() || "note.txt", note.value);
      await refresh();
      say("Added. It was locked in your browser before upload.", "ok");
    });
    const file = h("input", { type: "file" });
    const fileBtn = h("button", {}, "Lock and upload file");
    fileBtn.onclick = () => act(fileBtn, "Locking…", async () => {
      const f = file.files?.[0];
      if (!f) throw Error("Choose a file first.");
      await vault.addData(d, f.name, new Uint8Array(await f.arrayBuffer()));
      await refresh();
      say("Uploaded. It was locked in your browser before upload.", "ok");
    });
    addCard = h("section", { class: "card" },
      h("h2", {}, "Add data"),
      h("p", { class: "muted small" }, "Data is locked in your browser with the box's public key. No passkey needed. File names are not encrypted."),
      h("label", {}, "Name", noteName), note, noteBtn,
      h("hr"),
      file, fileBtn,
    );
  }

  // --- Members
  const members = h("ul", { class: "list", "data-test": "members" },
    ...d.members.map((m) => {
      const rm = m.userId !== d.me.userId && h("button", { class: "link danger", "data-test": `remove-${m.name}` }, "Remove");
      if (rm) rm.onclick = () => act(rm, "Removing and changing the box key…", async () => {
        if (!confirm(`Remove ${m.name}? This changes the box key. Everyone else keeps access.`)) return;
        await ensureUnlocked();
        await vault.removeMember(d, m.userId);
        await refresh();
        say(`${m.name} was removed. The box key changed and open invites were canceled.`, "ok");
      });
      const who = m.invitedBy ? `invited by ${m.invitedBy}` : "made this box";
      return h("li", { class: "row", "data-test": "member" },
        h("div", {},
          h("div", { class: "row-main" }, m.name, m.userId === d.me.userId ? " (you)" : ""),
          h("div", { class: "muted small" }, `${who} · ${fmtDate(m.joinedAt)}`),
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
    const result = h("div", {});
    const invBtn = h("button", { class: "primary", "data-test": "create-invite" }, "Create invite link");
    invBtn.onclick = () => act(invBtn, "Creating invite…", async () => {
      if (!name.value.trim()) throw Error("Type the name of the person you invite.");
      await ensureUnlocked();
      const url = await vault.createInvite(d, name.value.trim(), Number(ttl.value));
      const out = h("input", { readOnly: true, value: url, "data-test": "invite-link" });
      const copy = h("button", {}, "Copy");
      copy.onclick = async () => { await navigator.clipboard.writeText(url); copy.textContent = "Copied"; };
      result.replaceChildren(
        h("div", { class: "invite-result" },
          h("p", { class: "small" }, h("strong", {}, "Send this link in a private chat. "), "It works one time, and this is the only time it is shown."),
          h("div", { class: "copyrow" }, out, copy),
        ),
      );
      say(null);
    });
    const list = h("ul", { class: "list" },
      ...d.invites.map((i) => {
        const cancel = i.status === "open" && h("button", { class: "link danger" }, "Cancel");
        if (cancel) cancel.onclick = () => act(cancel, "Canceling…", async () => {
          await api.del(`/api/boxes/${boxId}/invites/${i.id}`);
          await refresh();
        });
        return h("li", { class: "row" },
          h("div", {},
            h("div", {}, h("span", { class: "row-main" }, i.name), " ", h("span", { class: `pill ${i.status}` }, i.status)),
            h("div", { class: "muted small" },
              `by ${i.invitedBy ?? "?"}`, i.status === "open" ? ` · expires ${fmtDate(i.expiresAt)}` : ""),
          ),
          h("div", { class: "actions" }, cancel),
        );
      }),
    );
    inviteCard = h("section", { class: "card" },
      h("h2", {}, "Invite someone"),
      h("p", { class: "muted small" }, "Everybody in this box can invite others. The name you type is how this person appears here."),
      h("div", { class: "grid2" }, h("label", {}, "Their name", name), h("label", {}, "Expires after", ttl)),
      invBtn, result,
      d.invites.length > 0 && h("h3", {}, "Invites"), d.invites.length > 0 && list,
    );
  }

  // --- Outside systems
  let ingestCard: HTMLElement;
  {
    const tLabel = h("input", { placeholder: "e.g. Google Form", "data-test": "token-label" });
    const tOut = h("div", {});
    const tBtn = h("button", { "data-test": "create-token" }, "Create token");
    tBtn.onclick = () => act(tBtn, "Creating token…", async () => {
      if (!tLabel.value.trim()) throw Error("Type a label for the token.");
      const { token } = await api.post<{ token: string }>(`/api/boxes/${boxId}/ingest-tokens`, { label: tLabel.value.trim() });
      const cmd = `age -r ${d.box.recipient} answer.txt \\\n  | curl --data-binary @- \\\n    -H "Authorization: Bearer ${token}" \\\n    "${location.origin}/api/ingest/${boxId}?name=answer.txt"`;
      tOut.replaceChildren(
        h("p", { class: "small" }, h("strong", {}, "Copy the token now. "), "It is shown only once."),
        h("pre", { "data-test": "token" }, token),
        h("p", { class: "small muted" }, "Example with the age CLI:"),
        h("pre", {}, cmd),
      );
      say(null);
    });
    ingestCard = h("section", { class: "card" },
      h("h2", {}, "Outside systems"),
      h("p", { class: "muted small" }, "A form tool or a script can add data with this public key. It can add, but it can't read."),
      h("pre", { "data-test": "box-recipient" }, d.box.recipient),
      d.ingestTokens.length > 0 && h("p", { class: "small muted" }, `Tokens: ${d.ingestTokens.map((t) => t.label).join(", ")}`),
      h("div", { class: "copyrow" }, tLabel, tBtn),
      tOut,
    );
  }

  show(
    topbar(),
    h("section", { class: "boxhead" },
      h("a", { href: "/", onclick: link("/"), class: "small" }, "← Boxes"),
      h("h1", { "data-test": "box-title" }, d.box.name),
    ),
    !vault.isUnlocked() &&
      h("section", { class: "card locked" },
        h("p", {}, "This box is locked. Your passkey unlocks it in this tab only, until you close the tab or select Lock."),
        unlockBtn),
    h("section", { class: "card" }, h("h2", {}, "Data"), d.items.length ? items : h("p", { class: "muted" }, "No data yet.")),
    addCard,
    h("section", { class: "card" }, h("h2", {}, "Members"), members),
    inviteCard,
    ingestCard,
  );
}

// ---------------------------------------------------------------------------
// Join

async function joinView(inviteId: string) {
  const me = await loadMe();
  const oneTimeKey = decodeURIComponent(location.hash.slice(1));
  const info = await api.get<InviteInfo>(`/api/invites/${inviteId}`).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
  const head = (...rest: Child[]) => show(topbar(), h("section", { class: "card", "data-test": "join" }, ...rest));

  if (!info) return head(h("h2", {}, "Invite not found"), h("p", {}, "Check the link, or ask for a new one."));
  const intro = [
    h("h2", {}, "You're invited"),
    h("p", {}, `${info.invitedBy} invited you to “${info.boxName}”.`),
    h("p", { class: "muted small", "data-test": "invite-as" }, `You will appear as ${info.name} in this box.`),
  ];
  if (!oneTimeKey.startsWith("AGE-SECRET-KEY-1")) {
    return head(...intro, h("p", { class: "error" }, "This link is incomplete. Open the full link exactly as it was sent."));
  }
  if (info.status !== "open") {
    const why = { used: "This invite was already used.", expired: "This invite has expired.", canceled: "This invite was canceled." }[info.status];
    return head(...intro, h("p", { class: "error", "data-test": "invite-status" }, why), h("p", { class: "muted" }, "Ask the person who sent it for a new link."));
  }

  const finish = async (account: Me) => {
    say("Joining…");
    const boxId = await vault.acceptInvite(account, inviteId, oneTimeKey);
    // Drop the one-time key from the address bar and the history entry.
    history.replaceState(null, "", `/box/${boxId}`);
    say(`You joined “${info.boxName}”.`, "ok");
    await render();
  };

  if (!me) {
    // The person who invited typed the name, so there is nothing to fill in.
    const accept = h("button", { class: "primary", "data-test": "accept" }, "Accept and make passkey");
    accept.onclick = () =>
      act(accept, "Step 1 of 2: make your passkey…", async () => {
        await registerPasskey(info.name);
        const account = (await loadMe())!;
        say("Step 2 of 2: confirm your passkey again to lock your key…");
        await vault.setupMemberKey(account);
        await finish((await loadMe())!);
      });
    const signIn = h("button", { class: "link" }, "I already have a passkey");
    signIn.onclick = () => act(signIn, "Waiting for your passkey…", async () => { await signInWithPasskey(); await render(); });
    return head(...intro,
      h("p", { class: "muted small" }, "Nothing to fill in, and no email. Your device asks for your passkey two times. The link stops working after you accept."),
      accept, " ", signIn);
  }

  const accept = h("button", { class: "primary", "data-test": "accept" }, "Accept");
  accept.onclick = () =>
    act(accept, "Joining…", async () => {
      let account = me;
      if (!account.memberRecipient) {
        say("Confirm your passkey to lock your key…");
        await vault.setupMemberKey(account);
        account = (await loadMe())!;
      }
      await finish(account);
    });
  head(...intro, accept);
}

void render();
