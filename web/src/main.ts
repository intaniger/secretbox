import { ApiError } from "./api.ts";
import * as vault from "./vault.ts";

// ---------------------------------------------------------------------------
// Tiny DOM helper

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  // A button inside a form must not submit it by accident.
  if (tag === "button" && !("type" in props)) (el as HTMLButtonElement).type = "button";
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

// Line icons (24×24, stroked). Several sub-paths are separated by "|".
const ICONS = {
  box: "M21 8l-9-5-9 5v8l9 5 9-5z|M3 8l9 5 9-5|M12 13v8",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z|M7 11V7a5 5 0 0 1 10 0v4",
  unlock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z|M7 11V7a5 5 0 0 1 9.9-1",
  key: "M21 2l-2 2|M15.5 7.5l3 3L22 7l-3-3|M11.4 12.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78z|M11.4 12.6L19 5",
  note: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6",
  chevron: "M9 18l6-6-6-6",
  plus: "M12 5v14|M5 12h14",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M17 8l-5-5-5 5|M12 3v12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3",
  copy: "M9 9h11v11H9z|M5 15H4V4h11v1",
  check: "M20 6L9 17l-5-5",
  share: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8|M16 6l-4-4-4 4|M12 2v13",
  plug: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71|M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
} as const;

function icon(name: keyof typeof ICONS, cls = "icon") {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name].split("|")) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
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

/** A form whose submit (button click or Enter) runs `fn`. */
function form(props: Props, onSubmit: () => void, ...children: Child[]) {
  return h("form", { ...props, onsubmit: (e: Event) => { e.preventDefault(); onSubmit(); } }, ...children);
}

function copyButton(text: string, label = "Copy") {
  const b = h("button", {}, icon("copy"), label);
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.replaceChildren(icon("check"), "Copied");
      setTimeout(() => b.replaceChildren(icon("copy"), label), 2000);
    } catch {
      say("Copy didn't work. Select the text and copy it.", "error");
    }
  };
  return b;
}

const MAX_UPLOAD = 4 * 1024 * 1024; // the server's limit (MAX_ITEM_BYTES)

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
const fmtIn = (t: number) => {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const min = Math.round((t - Date.now()) / 60000);
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  if (Math.abs(min) < 48 * 60) return rtf.format(Math.round(min / 60), "hour");
  return rtf.format(Math.round(min / 1440), "day");
};
const hasExt = (name: string) => /\.\w{1,8}$/.test(name);

// ---------------------------------------------------------------------------
// Router

/**
 * The invite link that was just made. It holds a one-time private key, so it
 * lives only in memory and is dropped on the next navigation.
 */
let freshInvite: { boxId: string; name: string; url: string } | null = null;

function go(path: string) {
  history.pushState(null, "", path);
  void render();
}

window.addEventListener("popstate", () => void render());

const pathBoxId = () => location.pathname.match(/^\/box\/([\w-]+)/)?.[1] ?? null;

async function render() {
  freshInvite = null;
  const path = location.pathname;
  let m: RegExpMatchArray | null;
  try {
    if ((m = path.match(/^\/join\/([\w-]+)$/))) return await joinView(m[1]);
    if ((m = path.match(/^\/box\/([\w-]+)(\/people)?$/))) return await boxView(m[1], m[2] ? "people" : "items");
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

function topbar(open?: vault.Box) {
  return h(
    "header",
    { class: "topbar" },
    h("a", { class: "brand", href: "/", onclick: link("/") }, icon("box"), "Secretbox"),
    location.pathname.startsWith("/box/") &&
      h(
        "div",
        { class: "who" },
        h("span", {
          class: `lockstate ${open ? "ok" : ""}`,
          title: open
            ? "This box is open in this tab until you select Lock or close the tab."
            : "Open this box with its passkey.",
        }, icon(open ? "unlock" : "lock"), h("span", { "data-test": "lock-state" }, open ? "Unlocked" : "Locked")),
        open && h("span", { class: "muted name" }, open.me.name),
        open && h("button", { class: "link", "data-test": "lock", onclick: () => { vault.lock(); go("/"); } }, "Lock"),
      ),
  );
}

/** Opens a box with a passkey the person picks, and goes to that box. */
function openButton(label: string, test: string) {
  const btn = h("button", { class: "primary block", "data-test": test }, icon("key"), label);
  btn.onclick = () =>
    act(btn, "Choose the passkey for the box…", async () => {
      const boxId = await vault.openWithPasskey();
      say(null);
      if (pathBoxId() === boxId) await render(); // stay on this tab of the box
      else go(`/box/${boxId}`);
    });
  return btn;
}

// ---------------------------------------------------------------------------
// Home

async function homeView() {
  // A box that is open in this tab: offer the way back to it.
  const openId = vault.openBoxId();
  const openName = openId ? await vault.load().then((b) => b.name, () => null) : null;

  const nick = h("input", { placeholder: "e.g. Tiger", autocomplete: "nickname", "data-test": "nickname" });
  const boxName = h("input", { placeholder: "e.g. Finance 2026", "data-test": "box-name" });
  const createBtn = h("button", { type: "submit", class: "block", "data-test": "create-box" }, "Create box");
  const create = form({ class: "card" }, () =>
    act(createBtn, "Make the passkey for this box…", async () => {
      if (!nick.value.trim() || !boxName.value.trim()) throw Error("Type your name and a box name.");
      go(`/box/${await vault.createBox(boxName.value.trim(), nick.value.trim())}`);
    }),
    h("h2", {}, "Make a new box"),
    h("label", {}, "Your name", nick),
    h("label", {}, "Box name", boxName),
    createBtn,
    h("p", { class: "hint" }, "Your device makes a passkey for this box. There is no account and no email."),
  );

  show(
    topbar(),
    h("section", { class: "hero" },
      h("h1", {}, "Share secrets with a one-time link."),
      h("p", { class: "lead" }, "No accounts and no emails. Each box has its own passkey. The server keeps only locked data, so it can't read it."),
    ),
    openId && openName &&
      h("a", { href: `/box/${openId}`, onclick: link(`/box/${openId}`), class: "boxrow continue" },
        icon("unlock"),
        h("span", { class: "grow" }, h("span", { class: "row-main" }, openName), h("span", { class: "meta" }, "Open in this tab")),
        icon("chevron", "icon chev"),
      ),
    openButton("Open a box with passkey", "open-box"),
    h("p", { class: "hint center" }, "Your device shows one passkey for each of your boxes. Choose one to open that box."),
    h("div", { class: "divider" }, h("span", {}, "or")),
    create,
  );
}

// ---------------------------------------------------------------------------
// Box

type Tab = "items" | "people";
type BoxCtx = { d: vault.Box; refresh: () => Promise<void> };

async function boxView(boxId: string, tab: Tab) {
  if (vault.openBoxId() !== boxId) {
    return show(
      topbar(),
      h("section", { class: "card gate" },
        icon("lock", "icon gate-icon"),
        h("h1", {}, "This box is locked"),
        h("p", { class: "muted" }, "Open it with the passkey you made for this box. It stays open in this tab until you select Lock or close the tab."),
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
      return boxView(boxId, tab);
    }
    throw err;
  }
  const ctx: BoxCtx = { d, refresh: () => boxView(boxId, tab) };

  const base = `/box/${boxId}`;
  const tabLink = (t: Tab, label: string, n: number) => {
    const href = t === "items" ? base : `${base}/people`;
    return h("a", { class: "tab", href, onclick: link(href), "aria-current": t === tab ? "page" : undefined, "data-test": `tab-${t}` },
      label, h("span", { class: "count" }, String(n)));
  };

  show(
    topbar(d),
    h("section", { class: "boxhead" },
      h("h1", { "data-test": "box-title" }, d.name),
      h("nav", { class: "tabs", "aria-label": "Box sections" },
        tabLink("items", "Items", d.items.length),
        tabLink("people", "People", d.members.length),
      ),
    ),
    ...(tab === "items" ? itemsTab(ctx) : peopleTab(ctx)),
  );
}

// --- Items tab

function itemsTab(ctx: BoxCtx): Child[] {
  const { d } = ctx;
  return [
    ...addTools(ctx),
    d.items.length
      ? h("ul", { class: "items", "data-test": "items" }, ...d.items.map((it) => itemRow(ctx, it)))
      : h("p", { class: "empty" }, "Nothing here yet. Add a note or upload a file."),
    connectSection(ctx),
  ];
}

function addTools({ d, refresh }: BoxCtx): Child[] {
  // New note: a small composer that opens in place.
  const title = h("input", { placeholder: "e.g. Wi-Fi password", "data-test": "note-name" });
  const text = h("textarea", { rows: 5, placeholder: "Write the secret here.", "data-test": "note-text" });
  const save = h("button", { type: "submit", class: "primary", "data-test": "add-note" }, "Save note");
  const cancel = h("button", {}, "Cancel");
  const composer = form({ class: "card composer", hidden: true }, () =>
    act(save, "Locking…", async () => {
      if (!text.value) throw Error("Write the note first.");
      await vault.addData(d, title.value.trim() || "Untitled note", "text/plain", text.value);
      await refresh();
      say("Saved. It was locked on this device before upload.", "ok");
    }),
    h("label", {}, "Title", title),
    h("label", {}, "Note", text),
    h("div", { class: "buttons" }, save, cancel),
  );
  const newNote = h("button", { "data-test": "new-note", "aria-expanded": "false" }, icon("plus"), "New note");
  const toggle = (open: boolean) => {
    composer.hidden = !open;
    newNote.setAttribute("aria-expanded", String(open));
    if (open) title.focus();
  };
  newNote.onclick = () => toggle(newNote.getAttribute("aria-expanded") !== "true");
  cancel.onclick = () => toggle(false);

  // Upload: one click opens the file picker; choosing a file uploads it.
  const fileInput = h("input", { type: "file", class: "visually-hidden", tabindex: "-1", "data-test": "file-input" });
  const upload = h("button", { "data-test": "upload-file" }, icon("upload"), "Upload file");
  upload.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    void act(upload, `Locking and uploading “${f.name}”…`, async () => {
      try {
        if (f.size > MAX_UPLOAD) throw Error(`“${f.name}” is ${fmtSize(f.size)}. The limit is ${fmtSize(MAX_UPLOAD)}.`);
        await vault.addData(d, f.name, f.type, new Uint8Array(await f.arrayBuffer()));
      } finally {
        fileInput.value = ""; // so the same file can be chosen again
      }
      await refresh();
      say(`Uploaded “${f.name}”. It was locked on this device before upload.`, "ok");
    });
  };

  return [
    h("div", { class: "toolbar" }, newNote, upload, fileInput),
    h("p", { class: "hint" }, "Notes, files and their names are locked on this device before upload."),
    composer,
  ];
}

function itemRow({ refresh }: BoxCtx, it: vault.Box["items"][number]) {
  const name = it.label?.name ?? "From an outside system";
  const by = it.label ? it.label.addedBy : "outside system";
  const isText = it.label ? it.label.type.startsWith("text/") || !hasExt(it.label.name) : false;
  const viewer = h("div", { class: "viewer", hidden: true });
  const row = h("button", { class: "item", "data-test": "open-item", "aria-expanded": "false" },
    icon(it.label ? (isText ? "note" : "file") : "plug"),
    h("span", { class: "grow" },
      h("span", { class: "row-main" }, name),
      h("span", { class: "meta", title: fmtDate(it.createdAt) }, `${fmtSize(it.label?.size ?? it.size)} · ${by} · ${fmtDay(it.createdAt)}`),
    ),
    icon("chevron", "icon chev"),
  );
  const expand = (open: boolean) => {
    viewer.hidden = !open;
    row.setAttribute("aria-expanded", String(open));
  };

  row.onclick = () => {
    if (!viewer.hidden) return expand(false);
    if (viewer.childElementCount) return expand(true); // already unlocked once
    void act(row, "Opening…", async () => {
      const bytes = await vault.openItem(it.id);
      let text: string | null = null;
      try {
        if (bytes.length < 200_000) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch { /* binary */ }
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: it.label?.type || "" }));
      let file = it.label?.name ?? `outside-${new Date(it.createdAt).toISOString().slice(0, 19)}${text !== null ? ".txt" : ".bin"}`;
      if (text !== null && !hasExt(file)) file += ".txt";

      const del = h("button", { class: "link danger push", "data-test": "delete-item" }, "Delete");
      del.onclick = () => act(del, "Deleting…", async () => {
        if (!confirm(`Delete “${name}” for everyone in this box?`)) return;
        await vault.deleteItem(it.id);
        await refresh();
        say(`Deleted “${name}”.`, "ok");
      });

      viewer.replaceChildren(
        text !== null
          ? h("pre", { "data-test": "item-text" }, text)
          : h("p", { class: "muted" }, "This file can't be shown here. Download it to open it."),
        h("div", { class: "buttons" },
          text !== null && copyButton(text, "Copy text"),
          h("a", { class: "button", href: url, download: file }, icon("download"), "Download"),
          del,
        ),
      );
      expand(true);
    });
  };

  return h("li", {}, row, viewer);
}

function connectSection({ d, refresh }: BoxCtx) {
  const out = h("div", {});
  const makeBtn = h("button", { "data-test": "create-token" }, d.hasAddKey ? "Replace add key" : "Make add key");
  makeBtn.onclick = () => act(makeBtn, "Making add key…", async () => {
    if (d.hasAddKey && !confirm("Replace the add key? The old one stops working.")) return;
    const addKey = await vault.makeAddKey();
    const cmd = `age -r ${d.publicKey} answer.txt \\\n  | curl --data-binary @- \\\n    -H "Authorization: Bearer ${addKey}" \\\n    "${location.origin}/api/ingest/${d.id}"`;
    out.replaceChildren(
      h("p", { class: "small" }, h("strong", {}, "Copy the add key now. "), "It is shown only once."),
      h("pre", { "data-test": "token" }, addKey),
      h("p", { class: "small muted" }, "Example with the age command-line tool:"),
      h("pre", {}, cmd),
    );
  });
  const offBtn = d.hasAddKey && h("button", { class: "link danger" }, "Turn off");
  if (offBtn) offBtn.onclick = () => act(offBtn, "Turning off…", async () => {
    await vault.deleteAddKey();
    await refresh();
  });

  return h("details", { class: "card disclosure", "data-test": "connect" },
    h("summary", {}, icon("plug"), h("span", { class: "grow" }, "Let a form or script add items"), icon("chevron", "icon chev")),
    h("p", { class: "muted small" }, "An outside system can add items with the box public key and an add key. It can't read anything."),
    h("div", { class: "label" }, "Box public key"),
    h("pre", { "data-test": "box-recipient" }, d.publicKey),
    h("p", { class: "small muted" }, d.hasAddKey ? "An add key is turned on." : "There is no add key yet."),
    h("div", { class: "buttons" }, makeBtn, offBtn),
    out,
  );
}

// --- People tab

function peopleTab(ctx: BoxCtx): Child[] {
  const { d, refresh } = ctx;
  const members = h("ul", { class: "list", "data-test": "members" },
    ...d.members.map((m) => {
      const rm = !m.isMe && h("button", { class: "link danger", "data-test": `remove-${m.name}` }, "Remove");
      if (rm) rm.onclick = () => act(rm, "Removing…", async () => {
        if (!confirm(`Remove ${m.name}? Their passkey stops opening this box. If they copied the box key, they keep it: to cut someone off fully, make a new box.`)) return;
        await vault.removeMember(m.credentialId);
        await refresh();
        say(`${m.name} was removed.`, "ok");
      });
      return h("li", { class: "person", "data-test": "member" },
        h("span", { class: "avatar", "aria-hidden": "true" }, m.name.trim().charAt(0).toUpperCase() || "?"),
        h("span", { class: "grow" },
          h("span", { class: "line" }, h("span", { class: "row-main" }, m.name), m.isMe && h("span", { class: "muted" }, " (you)")),
          h("span", { class: "meta", title: fmtDate(m.createdAt) },
            `${m.invitedBy ? `Invited by ${m.invitedBy}` : "Made this box"} · ${fmtDay(m.createdAt)}`),
        ),
        rm,
      );
    }),
  );

  return [
    inviteCard(ctx),
    h("section", { class: "card" }, h("h2", {}, "People with access"), members),
  ];
}

function inviteCard({ d, refresh }: BoxCtx) {
  const name = h("input", { placeholder: "Their name, e.g. Nok", autocomplete: "off", "aria-label": "Their name", "data-test": "invite-name" });
  const ttl = h("select", { "aria-label": "Link works for" },
    h("option", { value: "1" }, "1 hour"), h("option", { value: "24", selected: true }, "24 hours"),
    h("option", { value: "72" }, "3 days"), h("option", { value: "168" }, "7 days"));
  const summary = h("span", {});
  const sync = () => (summary.textContent = `The link works for ${ttl.selectedOptions[0]?.textContent}`);
  ttl.addEventListener("change", sync);
  sync();

  const btn = h("button", { type: "submit", class: "primary", "data-test": "create-invite" }, "Create link");
  const create = form({ class: "inline-form" }, () =>
    act(btn, "Making the invite link…", async () => {
      if (!name.value.trim()) throw Error("Type the name of the person you invite.");
      const url = await vault.createInvite(d, name.value.trim(), Number(ttl.value));
      freshInvite = { boxId: d.id, name: name.value.trim(), url };
      await refresh();
    }), name, btn);

  // Show the new link only while it can still be used: after it is canceled
  // (or opened), its row is gone and the link is dead.
  const freshId = freshInvite && new URL(freshInvite.url).pathname.split("/").pop();
  const fresh = freshInvite?.boxId === d.id && d.invites.some((i) => i.id === freshId) ? freshInvite : null;
  if (!fresh) freshInvite = null;
  const share = fresh && "share" in navigator && h("button", {}, icon("share"), "Share");
  if (share && fresh) share.onclick = () => navigator.share({ url: fresh.url }).catch(() => {});

  const pending = d.invites.length > 0 && h("ul", { class: "list", "data-test": "invites" },
    ...d.invites.map((i) => {
      const cancel = h("button", { class: "link danger", "data-test": `cancel-${i.name}` }, "Cancel");
      cancel.onclick = () => act(cancel, "Canceling…", async () => {
        await vault.cancelInvite(i.id);
        await refresh();
      });
      return h("li", { class: "row" },
        h("span", {},
          h("span", { class: "row-main" }, i.name),
          h("span", { class: "meta", title: fmtDate(i.expiresAt) }, `invited by ${i.invitedBy} · expires ${fmtIn(i.expiresAt)}`)),
        cancel,
      );
    }),
  );

  return h("section", { class: "card" },
    h("h2", {}, "Invite someone"),
    h("p", { class: "muted small" }, "Anyone in this box can invite. The name you type is how they appear here. Each link works one time."),
    create,
    h("details", { class: "options" },
      h("summary", {}, summary, h("span", { class: "change" }, "Change")),
      h("label", {}, "Link works for", ttl),
    ),
    fresh &&
      h("div", { class: "invite-result" },
        h("p", { class: "small" }, h("strong", {}, `The link for ${fresh.name} is ready. `), "Send it in a private chat. It works one time, and it is shown only here."),
        h("input", { readOnly: true, value: fresh.url, "aria-label": "Invite link", "data-test": "invite-link", onfocus: (e: Event) => (e.target as HTMLInputElement).select() }),
        h("div", { class: "buttons" }, copyButton(fresh.url, "Copy link"), share),
      ),
    pending && h("h3", {}, "Waiting to be used"),
    pending,
  );
}

// ---------------------------------------------------------------------------
// Join

let openedInvite: vault.OpenedInvite | null = null;

async function joinView(inviteId: string) {
  const oneTimeKey = decodeURIComponent(location.hash.slice(1));
  const card = (...rest: Child[]) =>
    show(topbar(), h("section", { class: "card join", "data-test": "join" }, h("p", { class: "eyebrow" }, icon("box"), "Invitation"), ...rest));

  if (!oneTimeKey.startsWith("AGE-SECRET-KEY-1")) {
    return card(h("h1", {}, "This link is incomplete"), h("p", { class: "error" }, "Open the full link exactly as it was sent."));
  }

  // A reload after "Open invite": the locked invite file is still in this tab.
  if (openedInvite?.inviteId !== inviteId && sessionStorage.getItem(`invite:${inviteId}`)) {
    openedInvite = await vault.openInvite(inviteId, oneTimeKey);
  }

  if (openedInvite?.inviteId !== inviteId) {
    const openBtn = h("button", { class: "primary block", "data-test": "open-invite" }, "Open invite");
    openBtn.onclick = () => act(openBtn, "Opening the invite…", async () => {
      try {
        openedInvite = await vault.openInvite(inviteId, oneTimeKey);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        // Used, expired or canceled: say so in place of the button.
        return card(
          h("h1", {}, "This link no longer works"),
          h("p", { class: "error", "data-test": "invite-status" }, explain(err)),
          h("p", { class: "muted" }, "Ask the person who sent it for a new link."),
        );
      }
      await render();
    });
    return card(
      h("h1", {}, "You're invited to a box"),
      h("p", { class: "muted" }, "Somebody sent you a private link to a box in Secretbox."),
      openBtn,
      h("p", { class: "hint" }, "Opening the invite uses up this link, so nobody else can use it after you."),
    );
  }

  const inv = openedInvite;
  const accept = h("button", { class: "primary block", "data-test": "accept" }, icon("key"), "Accept and make passkey");
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
    h("h1", {}, `${inv.invitedBy} invited you to “${inv.boxName}”`),
    h("p", { class: "muted", "data-test": "invite-as" }, `You will appear as ${inv.name} in this box.`),
    accept,
    h("p", { class: "hint" }, "Nothing to fill in, and no email. Your device makes a passkey for this box."),
  );
}

void render();
