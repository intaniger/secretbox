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
  userPlus: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|M12.5 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z|M20 8v6|M23 11h-6",
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
  if (err instanceof DOMException && err.name === "NotAllowedError") return "The passkey prompt was canceled or timed out. Try again.";
  const msg = err instanceof Error ? err.message : String(err);
  if (/no identity matched|failed to decrypt/i.test(msg)) return "Your passkey can't open this.";
  return msg;
}

/**
 * Runs an action with a busy button and a status line; shows errors. `fn` can
 * return a message to show when it is done. If the box locks while it runs,
 * nothing is shown: the message can name an item, and the screen is locked.
 */
async function act(btn: HTMLButtonElement | null, status: string, fn: () => Promise<string | void>) {
  const gen = generation;
  if (btn) btn.disabled = true;
  say(status);
  try {
    const done = await fn();
    if (gen !== generation) return;
    if (done) say(done, "ok");
    else if (notice.classList.contains("info")) say(null);
  } catch (err) {
    console.error(err);
    if (gen === generation) say(explain(err), "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** A form whose submit (button click or Enter) runs `fn`. */
function form(props: Props, onSubmit: () => void, ...children: Child[]) {
  return h("form", { ...props, onsubmit: (e: Event) => { e.preventDefault(); onSubmit(); } }, ...children);
}

/**
 * A secret this page put on the clipboard is removed after a minute, if the
 * page still has focus (browsers allow no clipboard writes otherwise), and at
 * Lock. Clipboard history apps may keep their own copy: the web can't stop that.
 */
const CLIPBOARD_MS = 60_000;
let copiedSecret = false;
let clipboardTimer = 0;

function forgetClipboard() {
  if (!copiedSecret) return;
  copiedSecret = false;
  clearTimeout(clipboardTimer);
  navigator.clipboard.writeText("").catch(() => {});
}

/** `secret: false` for text that is safe to keep, such as the public key. */
function copyButton(text: string, label = "Copy", props: Props = {}, secret = true) {
  const b = h("button", props, icon("copy"), label);
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (secret) {
        copiedSecret = true;
        clearTimeout(clipboardTimer);
        clipboardTimer = window.setTimeout(() => document.hasFocus() && forgetClipboard(), CLIPBOARD_MS);
      }
      b.replaceChildren(icon("check"), "Copied");
      setTimeout(() => b.replaceChildren(icon("copy"), label), 2000);
    } catch {
      say("Copy didn't work. Select the text and copy it.", "error");
    }
  };
  return b;
}

/**
 * A field where people type secrets or private names. The text stays on this
 * device: no cloud spellcheck (Chrome's Enhanced Spell Check, Edge's Microsoft
 * Editor), no grammar add-ons (Grammarly) and no saved form history. `exact`
 * also turns off autocorrect and capitals, for a password that must stay as typed.
 * h() can't set these: it skips `false`, and `spellcheck` is a boolean property.
 */
function keepLocal<T extends HTMLElement>(el: T, exact = false): T {
  el.setAttribute("spellcheck", "false");
  el.setAttribute("autocomplete", "off");
  el.setAttribute("writingsuggestions", "false");
  el.setAttribute("data-gramm", "false");
  el.setAttribute("data-gramm_editor", "false");
  el.setAttribute("data-enable-grammarly", "false");
  if (exact) {
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
  }
  return el;
}

/**
 * Saves decrypted bytes as a file. The object URL exists only for this
 * download, not for as long as the item is open, and Lock revokes it.
 * Always application/octet-stream: the type in a label is what a member typed.
 */
function saveFile(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  blobUrls.add(url);
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a); // some browsers ignore a click on a detached link
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    blobUrls.delete(url);
  }, 30_000);
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
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A name as the person looking at it reads it, for use inside a sentence.
 * Nobody names the person who makes a box, so an empty name is the box creator.
 */
function who(name: string, me: vault.Person): string {
  if (name === me.name) return "you";
  return name || "the box creator";
}

// ---------------------------------------------------------------------------
// Router

function go(path: string) {
  history.pushState(null, "", path);
  void render();
}

window.addEventListener("popstate", () => void render());
// The invite link opened again in this tab: only its "#" part is new.
window.addEventListener("hashchange", () => void render());

// ---------------------------------------------------------------------------
// Lock and auto-lock

/** Goes up at each lock. Work that started before a lock sees it, and draws nothing. */
let generation = 0;
/** Object URLs of decrypted files (saveFile). */
const blobUrls = new Set<string>();

/**
 * Forgets everything secret that this tab holds: the box key, an opened
 * invite and its one-time key, decrypted files, names on screen, and a
 * secret this page copied. Runs at Lock, at auto-lock, and when the page goes away.
 */
function teardown() {
  generation++;
  vault.lock();
  openedInvite = null;
  pendingInvite = null;
  for (const url of blobUrls) URL.revokeObjectURL(url);
  blobUrls.clear();
  forgetClipboard();
  say(null);
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  app.replaceChildren();
}

/** An open box locks after this long with no input, or this long in another tab or app. */
const IDLE_LOCK_MS = 5 * 60_000;
const AWAY_LOCK_MS = 2 * 60_000;
/**
 * An opened invite can't be opened again (the server deleted it), so it gets
 * more time before it is closed. After that, the person needs a new link.
 */
const INVITE_LOCK_MS = 10 * 60_000;

let lastInput = Date.now();
let hiddenSince: number | null = null;

function checkLock() {
  const now = Date.now();
  const idle = now - lastInput;
  const away = hiddenSince === null ? 0 : now - hiddenSince;
  if (vault.openBoxId() !== null && (idle >= IDLE_LOCK_MS || away >= AWAY_LOCK_MS)) {
    autoLock(idle >= IDLE_LOCK_MS ? "Locked after 5 minutes without use." : "Locked because you left this tab.");
  } else if (openedInvite && Math.max(idle, away) >= INVITE_LOCK_MS) {
    autoLock("This invite was closed after 10 minutes, to keep the box safe. Ask for a new link.");
  }
}

function autoLock(message: string) {
  teardown();
  void render().then(() => say(message));
}

for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) {
  window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenSince = Date.now();
  } else {
    checkLock(); // before the person sees the page again
    hiddenSince = null;
  }
});
setInterval(checkLock, 15_000);

// Leaving the page (another site, a reload, a closed tab): forget everything.
// A browser that keeps the page for Back (the back/forward cache) shows it locked.
window.addEventListener("pagehide", () => teardown());
window.addEventListener("pageshow", (e) => {
  if (e.persisted) void render();
});
// An opened invite is lost on a reload or a closed tab: ask first.
window.addEventListener("beforeunload", (e) => {
  if (!openedInvite) return;
  e.preventDefault();
  e.returnValue = ""; // older browsers ask only with this
});

const pathBoxId = () => location.pathname.match(/^\/box\/([\w-]+)/)?.[1] ?? null;

async function render() {
  // A dialog (it may hold a fresh invite link) never outlives its page.
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  const path = location.pathname;
  let m: RegExpMatchArray | null;
  try {
    if ((m = path.match(/^\/join\/([\w-]+)$/))) return await joinView(m[1]);
    if ((m = path.match(/^\/box\/([\w-]+)(?:\/(people|integration))?$/))) return await boxView(m[1], (m[2] as Tab | undefined) ?? "items");
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

/**
 * The brand, and one Lock button while a box is open. Seeing the box's
 * contents already says it is unlocked, so there is no separate status.
 */
function topbar(open?: vault.Box) {
  return h(
    "header",
    { class: "topbar" },
    h("a", { class: "brand", href: "/", onclick: link("/") }, icon("box"), "Vault Box"),
    open &&
      h("button", {
        class: "lock-button",
        "data-test": "lock",
        title: "Lock this box. You'll need your passkey to open it again.",
        onclick: () => { teardown(); go("/"); },
      }, icon("lock"), "Lock"),
  );
}

/** Opens a box with a passkey the person picks, and goes to that box. */
function openButton(label: string, test: string) {
  const btn = h("button", { class: "primary block", "data-test": test }, icon("key"), label);
  btn.onclick = () =>
    act(btn, "Waiting for your passkey…", async () => {
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
  const gen = generation;
  const openId = vault.openBoxId();
  const openName = openId ? await vault.load().then((b) => b.name, () => null) : null;
  if (gen !== generation) return; // locked while loading

  const boxName = keepLocal(h("input", { placeholder: "Box name, e.g. Finance 2026", "aria-label": "Box name", "data-test": "box-name" }));
  const createBtn = h("button", { type: "submit", "data-test": "create-box" }, "Create box");
  const create = form({ class: "card" }, () =>
    act(createBtn, "Save the passkey when your device asks…", async () => {
      if (!boxName.value.trim()) throw Error("Type a name for the box.");
      go(`/box/${await vault.createBox(boxName.value.trim())}`);
    }),
    h("h2", {}, "Make a new box"),
    h("div", { class: "inline-form" }, boxName, createBtn),
    h("p", { class: "hint" }, "Your device will save a passkey for this box. You'll use it to open the box later."),
  );

  show(
    topbar(),
    h("section", { class: "hero" },
      h("h1", {}, "Share secrets with a one-time link."),
      h("p", { class: "lead" }, "No account and no password. Everything is encrypted on your device, so not even Vault Box can read it."),
    ),
    openId && openName &&
      h("a", { href: `/box/${openId}`, onclick: link(`/box/${openId}`), class: "boxrow continue" },
        icon("unlock"),
        h("span", { class: "grow" }, h("span", { class: "row-main" }, openName), h("span", { class: "meta" }, "Open in this tab")),
        icon("chevron", "icon chev"),
      ),
    openButton("Open a box with passkey", "open-box"),
    h("p", { class: "hint center" }, "Your device shows a passkey for each of your boxes. Pick one, then use your fingerprint or face."),
    h("div", { class: "divider" }, h("span", {}, "or")),
    create,
  );
}

// ---------------------------------------------------------------------------
// Box

type Tab = "items" | "people" | "integration";
type BoxCtx = { d: vault.Box; refresh: () => Promise<void> };

const tabPath = (boxId: string, tab: Tab) => `/box/${boxId}${tab === "items" ? "" : `/${tab}`}`;

async function boxView(boxId: string, tab: Tab) {
  // A refresh that finishes after the person went to another page must not draw over it.
  if (location.pathname !== tabPath(boxId, tab)) return;
  if (vault.openBoxId() !== boxId) {
    return show(
      topbar(),
      h("section", { class: "card gate" },
        icon("lock", "icon gate-icon"),
        h("h1", {}, "This box is locked"),
        h("p", { class: "muted" }, "Open it with this box's passkey. It locks again when you lock it, close this tab, or leave it for a few minutes."),
        openButton("Open with passkey", "unlock"),
      ),
    );
  }
  const gen = generation;
  let d: vault.Box;
  try {
    d = await vault.load();
  } catch (err) {
    if (gen !== generation) return;
    if (err instanceof ApiError && err.status === 401) {
      teardown();
      return boxView(boxId, tab);
    }
    throw err;
  }
  // Locked, or the person went to another page, while it loaded: draw nothing.
  if (gen !== generation || location.pathname !== tabPath(boxId, tab)) return;
  const ctx: BoxCtx = { d, refresh: () => boxView(boxId, tab) };

  const tabLink = (t: Tab, label: string, badge: string | number | null) => {
    const href = tabPath(boxId, t);
    return h("a", { class: "tab", href, onclick: link(href), "aria-current": t === tab ? "page" : undefined, "data-test": `tab-${t}` },
      label, badge !== null && h("span", { class: "count" }, String(badge)));
  };

  show(
    topbar(d),
    h("section", { class: "boxhead" },
      h("div", { class: "boxhead-row" },
        h("h1", { "data-test": "box-title" }, d.name),
        shareButton(ctx, "Share", { class: "primary", "data-test": "share" }),
      ),
      h("nav", { class: "tabs", "aria-label": "Box sections" },
        tabLink("items", "Items", d.items.length),
        tabLink("people", "People", d.members.length),
        tabLink("integration", "Integration", d.hasAddKey ? "On" : null),
      ),
    ),
    ...(tab === "items" ? itemsTab(ctx) : tab === "people" ? peopleTab(ctx) : integrationTab(ctx)),
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
  ];
}

function addTools({ d, refresh }: BoxCtx): Child[] {
  // New note: a small composer that opens in place.
  const title = keepLocal(h("input", { placeholder: "e.g. Wi-Fi password", "data-test": "note-name" }));
  const text = keepLocal(h("textarea", { rows: 5, placeholder: "Write the secret here.", "data-test": "note-text" }), true);
  const save = h("button", { type: "submit", class: "primary", "data-test": "add-note" }, "Save note");
  const cancel = h("button", {}, "Cancel");
  const composer = form({ class: "card composer", hidden: true }, () =>
    act(save, "Encrypting…", async () => {
      if (!text.value) throw Error("Write the note first.");
      const name = title.value.trim() || "Untitled note";
      await vault.addData(d, name, "text/plain", text.value);
      await refresh();
      return `Saved “${name}”. Only people in this box can read it.`;
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
  cancel.onclick = () => {
    text.value = ""; // the secret must not wait in a hidden field
    toggle(false);
  };

  // Upload: one click opens the file picker; choosing a file uploads it.
  const fileInput = h("input", { type: "file", class: "visually-hidden", tabindex: "-1", "data-test": "file-input" });
  const upload = h("button", { "data-test": "upload-file" }, icon("upload"), "Upload file");
  upload.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    void act(upload, `Encrypting and uploading “${f.name}”…`, async () => {
      try {
        if (f.size > MAX_UPLOAD) throw Error(`“${f.name}” is ${fmtSize(f.size)}. The limit is ${fmtSize(MAX_UPLOAD)}.`);
        await vault.addData(d, f.name, f.type, new Uint8Array(await f.arrayBuffer()));
      } finally {
        fileInput.value = ""; // so the same file can be chosen again
      }
      await refresh();
      return `Uploaded “${f.name}”. Only people in this box can read it.`;
    });
  };

  return [
    h("div", { class: "toolbar" }, newNote, upload, fileInput),
    h("p", { class: "hint" }, "Notes, files and their names are encrypted on this device before they're uploaded."),
    composer,
  ];
}

function itemRow({ d, refresh }: BoxCtx, it: vault.Box["items"][number]) {
  const name = it.label?.name ?? "From another app";
  const by = it.label ? who(it.label.addedBy, d.me) : "another app";
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
    const gen = generation;
    void act(row, "Opening…", async () => {
      const bytes = await vault.openItem(it.id);
      if (gen !== generation) return; // locked while it loaded
      let text: string | null = null;
      try {
        if (bytes.length < 200_000) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch { /* binary */ }
      let file = it.label?.name ?? `outside-${new Date(it.createdAt).toISOString().slice(0, 19)}${text !== null ? ".txt" : ".bin"}`;
      if (text !== null && !hasExt(file)) file += ".txt";

      const download = h("button", { "data-test": "download" }, icon("download"), "Download");
      download.onclick = () => saveFile(bytes, file);
      const del = h("button", { class: "link danger push", "data-test": "delete-item" }, "Delete");
      del.onclick = () => act(del, "Deleting…", async () => {
        if (!confirm(`Delete “${name}” for everyone in this box?`)) return;
        await vault.deleteItem(it.id);
        await refresh();
        return `Deleted “${name}”.`;
      });

      viewer.replaceChildren(
        text !== null
          ? h("pre", { "data-test": "item-text" }, text)
          : h("p", { class: "muted" }, "This file can't be shown here. Download it to open it."),
        h("div", { class: "buttons" },
          text !== null && copyButton(text, "Copy text"),
          download,
          del,
        ),
      );
      expand(true);
    });
  };

  return h("li", {}, row, viewer);
}

// --- Integration tab

function integrationTab({ d, refresh }: BoxCtx): Child[] {
  const out = h("div", {});
  const makeBtn = h("button", { "data-test": "create-token" }, d.hasAddKey ? "Replace add key" : "Create add key");
  makeBtn.onclick = () => act(makeBtn, "Creating add key…", async () => {
    if (d.hasAddKey && !confirm("Replace the add key? The old one stops working.")) return;
    const addKey = await vault.makeAddKey();
    const cmd = `age -r ${d.publicKey} answer.txt \\\n  | curl --data-binary @- \\\n    -H "Authorization: Bearer ${addKey}" \\\n    "${location.origin}/api/ingest/${d.id}"`;
    out.replaceChildren(
      h("p", { class: "small" }, h("strong", {}, "Copy the add key now. "), "It won't be shown again."),
      h("pre", { "data-test": "token" }, addKey),
      h("p", { class: "small muted" }, "For developers, an example with the age command-line tool:"),
      h("pre", {}, cmd),
    );
  });
  const offBtn = d.hasAddKey && h("button", { class: "link danger" }, "Turn off");
  if (offBtn) offBtn.onclick = () => act(offBtn, "Turning off…", async () => {
    await vault.deleteAddKey();
    await refresh();
  });

  return [
    h("section", { class: "card", "data-test": "connect" },
      h("h2", {}, "Let another app add items"),
      h("p", { class: "muted small" }, "A form or another app can put items in this box. It needs the public key and an add key below. It can add items, but it can't read anything."),
      h("div", { class: "label" }, "Public key (safe to share)"),
      h("pre", { "data-test": "box-recipient" }, d.publicKey),
      h("div", { class: "buttons" }, copyButton(d.publicKey, "Copy public key", {}, false)),
      h("div", { class: "label spaced" }, "Add key (keep it secret)"),
      h("p", { class: "small" }, d.hasAddKey ? "On. An app with the add key can add items." : "Off. No app can add items yet."),
      h("div", { class: "buttons" }, makeBtn, offBtn),
      out,
    ),
  ];
}

// --- People tab

function peopleTab(ctx: BoxCtx): Child[] {
  const { d, refresh } = ctx;
  const members = h("ul", { class: "list", "data-test": "members" },
    ...d.members.map((m) => {
      // The box creator has no name: they are "You" to themselves.
      const title = m.name || (m.isMe ? "You" : "Box creator");
      const them = m.name || "the box creator";
      const rm = !m.isMe && h("button", { class: "link danger", "data-test": `remove-${m.name}` }, "Remove");
      if (rm) rm.onclick = () => act(rm, "Removing…", async () => {
        if (!confirm(`Remove ${them}? They won't be able to open this box anymore. Anything they already saw or saved, they keep. To be fully safe, make a new box.`)) return;
        await vault.removeMember(m.credentialId);
        await refresh();
        return `${cap(them)} was removed.`;
      });
      return h("li", { class: "person", "data-test": "member" },
        h("span", { class: "avatar", "aria-hidden": "true" }, title.trim().charAt(0).toUpperCase() || "?"),
        h("span", { class: "grow" },
          h("span", { class: "line" }, h("span", { class: "row-main" }, title), m.isMe && m.name && h("span", { class: "muted" }, " (you)")),
          h("span", { class: "meta", title: fmtDate(m.createdAt) },
            `${m.invitedBy === null ? "Made this box" : `Invited by ${who(m.invitedBy, d.me)}`} · ${fmtDay(m.createdAt)}`),
        ),
        rm,
      );
    }),
  );

  const pending = d.invites.length > 0 && h("section", { class: "card" },
    h("h2", {}, "Invites not used yet"),
    h("ul", { class: "list", "data-test": "invites" },
      ...d.invites.map((i) => {
        const cancel = h("button", { class: "link danger", "data-test": `cancel-${i.name}` }, "Cancel");
        cancel.onclick = () => act(cancel, "Canceling…", async () => {
          await vault.cancelInvite(i.id);
          await refresh();
        });
        return h("li", { class: "row" },
          h("span", {},
            h("span", { class: "row-main" }, i.name),
            h("span", { class: "meta", title: fmtDate(i.expiresAt) }, `Invited by ${who(i.invitedBy ?? "", d.me)} · expires ${fmtIn(i.expiresAt)}`)),
          cancel,
        );
      }),
    ),
  );

  return [
    h("section", { class: "card" },
      h("h2", {}, "People with access"),
      members,
      h("div", { class: "card-foot" }, shareButton(ctx, "Invite someone", { class: "link", "data-test": "invite" })),
    ),
    pending,
  ];
}

// --- Share: invite one person

function shareButton(ctx: BoxCtx, label: string, props: Props) {
  const b = h("button", props, icon("userPlus"), label);
  b.onclick = () => shareDialog(ctx);
  return b;
}

/**
 * Sharing a box = inviting one person: type their name, get a one-time link.
 * The link holds a one-time private key, so it is shown only in this dialog,
 * and it is gone when the dialog closes.
 */
function shareDialog({ d, refresh }: BoxCtx) {
  const dialog = h("dialog", { class: "sheet", "aria-labelledby": "share-title", "data-test": "share-dialog" });
  dialog.addEventListener("close", () => dialog.remove());
  // The content fills the dialog, so a click on the dialog itself is on the
  // backdrop. That closes it only before the link exists: a stray tap must not
  // throw away a link that is shown just this once (Done or Esc still close).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && ask.isConnected) dialog.close();
  });

  const name = keepLocal(h("input", { placeholder: "e.g. Nok", "data-test": "invite-name" }));
  const ttl = h("select", {},
    h("option", { value: "1" }, "1 hour"), h("option", { value: "24", selected: true }, "24 hours"),
    h("option", { value: "72" }, "3 days"), h("option", { value: "168" }, "7 days"));
  const error = h("p", { class: "error small", role: "alert", hidden: true });
  const create = h("button", { type: "submit", class: "primary", "data-test": "create-invite" }, "Create link");
  const fail = (message: string) => {
    error.textContent = message;
    error.hidden = false;
  };

  const ask = form({ class: "sheet-body" }, async () => {
    const them = name.value.trim();
    error.hidden = true;
    if (!them) {
      fail("Type the name of the person you share with.");
      return name.focus();
    }
    create.disabled = true;
    try {
      const url = await vault.createInvite(d, them, Number(ttl.value));
      // Update the page behind the dialog now (the new invite shows under
      // "Invites not used yet"), so closing the dialog changes nothing under the
      // pointer. If that fails, still show the link: the invite exists.
      await refresh().catch(console.error);
      dialog.replaceChildren(linkReady(them, url));
    } catch (err) {
      console.error(err);
      fail(explain(err));
    } finally {
      create.disabled = false;
    }
  },
    h("h2", { id: "share-title" }, `Share “${d.name}”`),
    h("p", { class: "muted small" }, "Make a one-time link for one person. The name is how they appear in this box. Your device asks for your passkey first, because the link opens this box."),
    h("label", {}, "Their name", name),
    h("label", {}, "Link works for", ttl),
    error,
    h("div", { class: "buttons end" }, h("button", { onclick: () => dialog.close() }, "Cancel"), create),
  );

  const linkReady = (them: string, url: string) => {
    const share = "share" in navigator && h("button", {}, icon("share"), "Share…");
    if (share) share.onclick = () => navigator.share({ url }).catch(() => {});
    return h("div", { class: "sheet-body" },
      h("h2", { id: "share-title" }, `The link for ${them} is ready`),
      h("p", { class: "callout", "data-test": "link-once" },
        h("strong", {}, "Copy it now. It won't be shown again."),
        "This link was made on your device, and Vault Box never stores it. Once you close this, it's gone.",
      ),
      h("p", { class: "muted small" }, `Send it to ${them} in a private chat. It works one time.`),
      h("input", { readOnly: true, value: url, "aria-label": "Invite link", "data-test": "invite-link", onfocus: (e: Event) => (e.target as HTMLInputElement).select() }),
      h("div", { class: "buttons" },
        copyButton(url, "Copy link", { class: "primary" }),
        share,
        h("button", { class: "push", "data-test": "share-done", onclick: () => dialog.close() }, "Done"),
      ),
    );
  };

  dialog.append(ask);
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}

// ---------------------------------------------------------------------------
// Join

/** An invite after "Open invite". It holds the box private key until Accept, so it lives only in memory. */
let openedInvite: vault.OpenedInvite | null = null;
/**
 * The one-time key from the link. It leaves the address bar as soon as the page
 * reads it, so it isn't on screen, in Back/Forward, or in a reopened tab.
 */
let pendingInvite: { id: string; key: string } | null = null;

async function joinView(inviteId: string) {
  if (location.hash.length > 1) {
    pendingInvite = { id: inviteId, key: decodeURIComponent(location.hash.slice(1)) };
    history.replaceState(null, "", location.pathname);
  }
  const card = (...rest: Child[]) =>
    show(topbar(), h("section", { class: "card join", "data-test": "join" }, h("p", { class: "eyebrow" }, icon("box"), "Invitation"), ...rest));

  if (openedInvite?.inviteId !== inviteId) {
    const oneTimeKey = pendingInvite?.id === inviteId ? pendingInvite.key : "";
    if (!oneTimeKey.startsWith("AGE-SECRET-KEY-1")) {
      return card(
        h("h1", {}, "Open the link from your message"),
        h("p", { class: "muted", "data-test": "invite-needs-link" },
          "This page needs the full link. Open it again from the message you got. If you already opened this invite, ask for a new link."),
      );
    }
    const openBtn = h("button", { class: "primary block", "data-test": "open-invite" }, "Open invite");
    openBtn.onclick = () => act(openBtn, "Opening the invite…", async () => {
      try {
        openedInvite = await vault.openInvite(inviteId, oneTimeKey);
        pendingInvite = null; // used up: the opened invite has what it gave
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        pendingInvite = null;
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
      h("p", { class: "muted" }, "Somebody sent you a private link to a box on Vault Box."),
      openBtn,
      h("p", { class: "hint" }, "Opening the invite uses up this link, so nobody else can use it after you. Then accept it here: a reload loses it."),
    );
  }

  const inv = openedInvite;
  const accept = h("button", { class: "primary block", "data-test": "accept" }, icon("key"), "Accept and save passkey");
  accept.onclick = () =>
    act(accept, "Save the passkey when your device asks…", async () => {
      const boxId = await vault.join(inv);
      openedInvite = null;
      history.replaceState(null, "", `/box/${boxId}`);
      await render();
      return `You joined “${inv.boxName}”.`;
    });
  card(
    // The box creator has no name; the person knows who sent them the link.
    h("h1", {}, inv.invitedBy ? `${inv.invitedBy} invited you to “${inv.boxName}”` : `You're invited to “${inv.boxName}”`),
    h("p", { class: "muted", "data-test": "invite-as" }, `You will appear as ${inv.name} in this box.`),
    accept,
    h("p", { class: "hint" }, "Nothing to fill in. Your device will save a passkey for this box. You'll use it to open the box later."),
  );
}

void render();
