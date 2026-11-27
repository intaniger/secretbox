// End-to-end test of the whole user journey in headless Chrome.
// Each person gets their own browser profile and a virtual passkey
// authenticator with PRF support (Chrome DevTools Protocol), so real
// WebAuthn + PRF code paths run — nothing is mocked.
//
//   npm test              (builds, then runs this against server/node.ts)
//   npm run test:vercel   (same journey against the Vercel build output)
//   CHROME_PATH=/path/to/chrome npm test

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import * as age from "age-encryption";

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const DB = join(tmpdir(), `vault-box-e2e-${process.pid}`); // PGlite data directory

const CHROME =
  process.env.CHROME_PATH ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
if (!CHROME) throw Error("Chrome not found. Set CHROME_PATH.");

// SCREENSHOTS=1 saves phone-size screenshots to test-results/.
// SCREENSHOTS=all saves light and dark ones, at phone and desktop size.
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 };
const shot = async (p, file) => {
  if (!process.env.SCREENSHOTS) return;
  mkdirSync("test-results", { recursive: true });
  const all = process.env.SCREENSHOTS === "all";
  if (all) await p.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await p.page.screenshot({ path: `test-results/${file}`, fullPage: true });
  if (!all) return;
  const base = file.replace(/\.png$/, "");
  await p.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await p.page.screenshot({ path: `test-results/${base}-dark.png`, fullPage: true });
  await p.page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await p.page.screenshot({ path: `test-results/${base}-desktop-dark.png`, fullPage: true });
  await p.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await p.page.screenshot({ path: `test-results/${base}-desktop.png`, fullPage: true });
  await p.page.emulateMediaFeatures();
  await p.page.setViewport(PHONE);
};

let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

// --- Server ------------------------------------------------------------------

const env = { ...process.env, PORT: String(PORT), DB_PATH: DB };
const CREATE_PROMPTS = Number(process.env.CREATE_PROMPTS ?? 1);
delete env.DATABASE_URL; // always test against a fresh local PGlite
// E2E_SERVER=test/vercel-harness.mjs runs the same journey against the Vercel build output.
const server = spawn(process.execPath, ["--no-warnings", process.env.E2E_SERVER ?? "server/node.ts"], {
  env,
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("Vault Box on") && resolve());
  server.on("exit", (code) => reject(Error(`server exited (${code})`)));
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

// --- Helpers -------------------------------------------------------------------

/**
 * A person = a separate browser profile + their own passkey authenticator.
 * `prfAtCreate: false` acts like a device that gives the PRF output only when
 * a passkey is used, not while it is made (then making one takes 2 prompts).
 */
async function person(name, { prfAtCreate = true } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (!prfAtCreate) {
    await page.evaluateOnNewDocument(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async (options) => {
        const cred = await create(options);
        const results = cred.getClientExtensionResults.bind(cred);
        cred.getClientExtensionResults = () => {
          const r = results();
          return r.prf ? { ...r, prf: { enabled: r.prf.enabled } } : r;
        };
        return cred;
      };
    });
  }
  await page.setViewport(PHONE);
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  // Count passkey prompts (each one is a Face ID / fingerprint on a phone).
  const prompts = { created: 0, asserted: 0 };
  cdp.on("WebAuthn.credentialAdded", () => prompts.created++);
  cdp.on("WebAuthn.credentialAsserted", () => prompts.asserted++);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log(`    [${name} page error] ${e.message}`));
  const p = {
    name,
    page,
    cdp,
    authenticatorId,
    prompts,
    total: () => prompts.created + prompts.asserted,
    goto: (url) => page.goto(url, { waitUntil: "networkidle0" }),
    type: async (sel, text) => {
      await page.$eval(sel, (el) => (el.value = ""));
      await page.type(sel, text);
    },
    click: (sel) => page.click(sel),
    text: (sel) => page.$eval(sel, (el) => el.textContent),
    /** Goes to a tab of the box page ("items", "people" or "integration"). */
    tab: async (name) => {
      // Clicking the tab that is already open draws the page again: don't race it.
      if (await page.$(`[data-test=tab-${name}][aria-current=page]`)) return;
      await page.click(`[data-test=tab-${name}]`);
      await page.waitForSelector(`[data-test=tab-${name}][aria-current=page]`);
    },
    /** Waits until the item list shows an item with this name (or, with gone=true, doesn't). */
    waitItem: (itemName, gone = false) =>
      page.waitForFunction(
        (n, g) => [...document.querySelectorAll("[data-test=items] .row-main")].some((e) => e.textContent === n) !== g,
        { timeout: 15000 },
        itemName,
        gone,
      ),
    /** Opens the note composer and saves a note. */
    addNote: async (title, text) => {
      await page.click("[data-test=new-note]");
      await p.type("[data-test=note-name]", title);
      await p.type("[data-test=note-text]", text);
      await page.click("[data-test=add-note]");
      await p.waitItem(title);
    },
    waitText: (text, timeout = 15000) =>
      page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text),
    /** Clicks "Open" on the item with this name and returns its decrypted text. */
    open: async (itemName) => {
      await page.waitForSelector("[data-test=items]");
      await page.evaluate((n) => {
        const li = [...document.querySelectorAll("[data-test=items] > li")].find(
          (li) => li.querySelector(".row-main")?.textContent === n,
        );
        if (!li) throw Error(`no item ${n}`);
        li.querySelector("[data-test=open-item]").click();
      }, itemName);
      const handle = await page.waitForFunction(
        (n) => {
          const li = [...document.querySelectorAll("[data-test=items] > li")].find(
            (li) => li.querySelector(".row-main")?.textContent === n,
          );
          return li?.querySelector("[data-test=item-text]")?.textContent ?? null;
        },
        { timeout: 15000 },
        itemName,
      );
      return handle.jsonValue();
    },
    /** Opens every item with this name and returns their decrypted texts. */
    openAll: async (itemName) => {
      const count = await page.evaluate((n) => {
        const lis = [...document.querySelectorAll("[data-test=items] > li")].filter(
          (li) => li.querySelector(".row-main")?.textContent === n,
        );
        lis.forEach((li) => li.querySelector("[data-test=open-item]").click());
        return lis.length;
      }, itemName);
      const handle = await page.waitForFunction(
        (n, c) => {
          const texts = [...document.querySelectorAll("[data-test=items] > li")]
            .filter((li) => li.querySelector(".row-main")?.textContent === n)
            .map((li) => li.querySelector("[data-test=item-text]")?.textContent);
          return texts.length === c && texts.every((t) => t != null) ? texts : null;
        },
        { timeout: 15000 },
        itemName,
        count,
      );
      return handle.jsonValue();
    },
  };
  return p;
}

/**
 * Any member can invite: Share, type a name, Create link. There is no role.
 * The link is shown only in the dialog, and is gone when it closes.
 */
async function createInvite(member, name, { screenshot } = {}) {
  // Release each element handle: DevTools keeps what a handle points to in
  // memory, and here that would keep the link (and its key) alive for keysInMemory.
  await member.click("[data-test=share]");
  await (await member.page.waitForSelector("dialog[open] [data-test=invite-name]")).dispose();
  await member.type("[data-test=invite-name]", name);
  if (screenshot) await shot(member, "2-share.png");
  await member.click("[data-test=create-invite]");
  await (await member.page.waitForSelector("[data-test=invite-link]")).dispose();
  const link = await member.page.$eval("[data-test=invite-link]", (el) => el.value);
  if (screenshot) await shot(member, screenshot);
  await member.click("[data-test=share-done]");
  await member.page.waitForFunction(() => !document.querySelector("dialog"));
  return link;
}

/** Opening the invite uses up the link. The invited person types nothing. */
async function joinWith(p, link, expectedName, heading) {
  await p.goto(link);
  assert.ok(!p.page.url().includes("#"), "the one-time key should leave the address bar as soon as the page reads it");
  await p.click("[data-test=open-invite]");
  await p.waitText(heading);
  assert.equal(await p.text("[data-test=invite-as]"), `You will appear as ${expectedName} in this box.`);
  assert.equal(await p.page.$("input"), null, "the join page should have no fields to fill in");
  await shot(p, `3-join-${expectedName}.png`);
  await p.click("[data-test=accept]");
  await p.page.waitForSelector("[data-test=box-title]", { timeout: 20000 });
}

/** The text of the member row for this name. */
const memberRow = (p, name) =>
  p.page.evaluate((n) => [...document.querySelectorAll("[data-test=member]")]
    .find((li) => li.querySelector(".row-main")?.textContent.startsWith(n))?.innerText ?? null, name);

/**
 * Every whole age private key (AGE-SECRET-KEY-1 + 58 bech32 characters) that is
 * a string in this page's JavaScript memory, after a full garbage collection.
 * An open box keeps its key as a non-extractable CryptoKey, and every other key
 * string must be gone once it was used. (This can't see bytes in arrays: only strings.)
 */
async function keysInMemory(p) {
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  p.cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await p.cdp.send("HeapProfiler.enable");
  await p.cdp.send("HeapProfiler.collectGarbage");
  await p.cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  p.cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await p.cdp.send("HeapProfiler.disable");
  return [...new Set(chunks.join("").match(/age-secret-key-1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}/gi) ?? [])];
}

/**
 * Acts as if the person left the tab (another app or tab) for this long, then
 * came back: the page reads document.visibilityState and Date.now().
 */
async function leaveTab(p, ms) {
  await p.page.evaluate((away) => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
    const realNow = Date.now;
    Date.now = () => realNow() + away;
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    Date.now = realNow;
    delete document.visibilityState;
  }, ms);
}

/** Opens the box with a passkey from the box page (1 prompt). */
async function unlock(p) {
  await p.page.waitForSelector("[data-test=unlock]");
  await p.click("[data-test=unlock]");
  await p.page.waitForSelector("[data-test=box-title]", { timeout: 20000 });
}

// --- The journey -----------------------------------------------------------------

let failed = false;
try {
  console.log("\nVault Box end-to-end test\n");

  const tiger = await person("Tiger");
  await tiger.goto(BASE);
  await shot(tiger, "1-start.png");
  assert.equal(await tiger.page.$("[data-test=nickname]"), null, "making a box asks for no name");
  await tiger.type("[data-test=box-name]", "Finance 2026");
  await tiger.click("[data-test=create-box]");
  await tiger.page.waitForSelector("[data-test=box-title]", { timeout: 20000 });
  assert.match(await tiger.text("[data-test=box-title]"), /Finance 2026/);
  // Chrome's virtual authenticator gives the PRF output while it makes the
  // passkey, so making one is a single prompt. Other devices may need 2.
  const MAKE = tiger.total();
  assert.equal(MAKE, CREATE_PROMPTS, `creating a box should take ${CREATE_PROMPTS} passkey prompt(s)`);
  log(`Tiger creates a box: no account, no name, one new passkey (${MAKE} prompt)`);
  const boxId = new URL(tiger.page.url()).pathname.split("/").pop();

  await tiger.addNote("note.txt", "Salary sheet: Nok 50k");
  assert.equal(tiger.total(), MAKE, "adding data should need no passkey prompt");
  log("Tiger adds a note (0 prompts, locked in the browser)");

  // Upload: choosing a file uploads it at once. Then open it and delete it.
  const uploadDir = join(tmpdir(), `vault-box-e2e-upload-${process.pid}`);
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(join(uploadDir, "contract.txt"), "Uploaded file body");
  await (await tiger.page.$("[data-test=file-input]")).uploadFile(join(uploadDir, "contract.txt"));
  await tiger.waitItem("contract.txt");
  assert.equal(await tiger.open("contract.txt"), "Uploaded file body");
  // Download makes a short-lived link to the unlocked bytes and saves the file.
  const downloadDir = join(tmpdir(), `vault-box-e2e-download-${process.pid}`);
  mkdirSync(downloadDir, { recursive: true });
  await tiger.cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await tiger.page.evaluate(() =>
    [...document.querySelectorAll("[data-test=items] > li")]
      .find((li) => li.querySelector(".row-main")?.textContent === "contract.txt")
      .querySelector("[data-test=download]")
      .click(),
  );
  const saved = join(downloadDir, "contract.txt");
  for (let i = 0; i < 50 && !existsSync(saved); i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(readFileSync(saved, "utf8"), "Uploaded file body", "Download should save the unlocked file");
  rmSync(downloadDir, { recursive: true, force: true });
  await shot(tiger, "2-items.png");
  await tiger.page.evaluate(() =>
    [...document.querySelectorAll("[data-test=items] > li")]
      .find((li) => li.querySelector(".row-main")?.textContent === "contract.txt")
      .querySelector("[data-test=delete-item]")
      .click(),
  );
  await tiger.waitItem("contract.txt", true);
  rmSync(uploadDir, { recursive: true, force: true });
  assert.equal(tiger.total(), MAKE, "an open box opens and deletes items with no passkey prompt");
  log("Tiger uploads a file, opens it, downloads it and deletes it (0 prompts)");

  const nokLink = await createInvite(tiger, "Nok", { screenshot: "2-invite.png" });
  const spareLink = await createInvite(tiger, "Spare");
  assert.match(nokLink, new RegExp(`^${BASE}/join/[\\w-]+#AGE-SECRET-KEY-1[0-9A-Z]+$`));
  assert.equal(tiger.total(), MAKE + 2, "each invite should ask for the passkey once: the link holds the box key");
  log("Tiger makes 2 invite links with Share, typing only a name (1 prompt each; one-time key after #)");

  await createInvite(tiger, "Temp");
  assert.equal(await tiger.page.$("[data-test=invite-link]"), null, "a link must not stay on screen after the dialog closes");
  assert.deepEqual(await keysInMemory(tiger), [], "no private key string may stay in memory after making invites");
  await tiger.tab("people");
  await tiger.click("[data-test=cancel-Temp]");
  await tiger.page.waitForFunction(() => !document.querySelector("[data-test=cancel-Temp]"));
  log("Tiger closes the dialog (the link and every key string leave memory) and cancels that invite on People");

  // A link preview bot fetches the page: that is a GET, and only a POST uses the invite.
  const preview = await fetch(nokLink.split("#")[0]);
  assert.equal(preview.status, 200);
  log("A link preview (GET) does not use up the invite");

  const nok = await person("Nok");
  // Tiger typed no name, so the page doesn't name him. Nok knows who sent the link.
  await joinWith(nok, nokLink, "Nok", "You're invited to “Finance 2026”");
  assert.equal(nok.total(), MAKE, "joining should take the same prompts as making a box");
  assert.ok(!nok.page.url().includes("#"), "the one-time key should be removed from the URL");
  assert.equal(await nok.open("note.txt"), "Salary sheet: Nok 50k");
  assert.deepEqual(await keysInMemory(nok), [], "after joining, neither the box key nor the one-time key may stay as a string");
  await nok.tab("people");
  assert.match(await memberRow(nok, "Nok"), /Invited by the box creator/);
  assert.match(await memberRow(nok, "Box creator"), /Made this box/);
  await shot(nok, "4-member-box.png");
  log("Nok opens the invite and joins without typing anything; she sees Tiger as the box creator");

  // An opened invite holds the box key, so the tab keeps it only in memory.
  const pimLink = await createInvite(tiger, "Pim");
  const pim = await person("Pim");
  await pim.goto(pimLink);
  await pim.click("[data-test=open-invite]");
  await pim.waitText("You're invited to “Finance 2026”");
  await pim.page.reload({ waitUntil: "networkidle0" }); // the page asks first; the test says yes
  await pim.page.waitForSelector("[data-test=invite-needs-link]");
  assert.equal(await pim.page.evaluate(() => sessionStorage.length), 0, "the tab must store nothing from the invite");
  log("Pim opens an invite and reloads: the tab stored nothing, so nobody can open it there again");

  const mallory = await person("Mallory");
  await mallory.goto(nokLink);
  await mallory.click("[data-test=open-invite]");
  await mallory.waitText("already used");
  await shot(mallory, "5-link-used.png");
  log("Mallory opens Nok's link again: 'already used' (the server deleted it)");

  // No roles: Nok can add data and invite people herself.
  await nok.tab("items");
  await nok.addNote("nok.txt", "Added by Nok");
  const promptsBeforeInvite = nok.total();
  const beeLink = await createInvite(nok, "Bee");
  assert.equal(nok.total() - promptsBeforeInvite, 1, "inviting asks for the passkey once, also when the box is open");
  log("Nok adds a note and invites Bee herself (no roles)");

  const bee = await person("Bee", { prfAtCreate: false });
  await joinWith(bee, beeLink, "Bee", "Nok invited you to “Finance 2026”");
  assert.equal(bee.total(), 2, "without PRF at creation, joining takes 2 prompts");
  await bee.tab("people");
  assert.match(await memberRow(bee, "Bee"), /Invited by Nok/);
  await bee.tab("items");
  assert.equal(await bee.open("nok.txt"), "Added by Nok");
  log("Bee joins with Nok's link (2 prompts on her device) and shows as 'invited by Nok'");

  // --- Outside system adds data with only the public key + an add key
  await tiger.page.reload({ waitUntil: "networkidle0" });
  await unlock(tiger);
  await tiger.tab("integration");
  await tiger.click("[data-test=create-token]");
  await tiger.page.waitForSelector("[data-test=token]");
  await shot(tiger, "2-connect.png");
  const addKey = (await tiger.text("[data-test=token]")).trim();
  const recipient = (await tiger.text("[data-test=box-recipient]")).trim();
  const ingest = (body, key = addKey) =>
    fetch(`${BASE}/api/ingest/${boxId}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body });
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  assert.equal((await ingest(await e.encrypt("Form answer #1"))).status, 200);
  const e2 = new age.Encrypter();
  e2.addRecipient(recipient);
  assert.equal((await ingest(age.armor.encode(await e2.encrypt("Armored answer")))).status, 200);
  assert.equal((await ingest("not encrypted")).status, 400, "plaintext must be rejected");
  assert.equal((await ingest("x", "vlt_nope")).status, 401, "a wrong add key must be rejected");
  const read = await fetch(`${BASE}/api/boxes/${boxId}`, { headers: { authorization: `Bearer ${addKey}` } });
  assert.equal(read.status, 401, "the add key must not open the box");
  log("An outside system adds 2 files with the public key + add key; it can't read the box");

  // --- Nok comes back later: a reload clears keys from memory, so she opens the box once.
  await nok.page.reload({ waitUntil: "networkidle0" });
  await nok.page.waitForSelector("[data-test=unlock]");
  assert.equal(await nok.page.$("[data-test=items]"), null, "a locked box shows nothing");
  assert.equal(await nok.page.$("[data-test=lock]"), null, "a locked box has no Lock button");
  await shot(nok, "4-locked.png");
  const before = nok.total();
  await unlock(nok);
  await nok.tab("items");
  assert.deepEqual((await nok.openAll("From another app")).sort(), ["Armored answer", "Form answer #1"]);
  assert.equal(nok.total() - before, 1, "opening a box should take exactly 1 passkey prompt");
  log("Nok returns, opens the box once (1 prompt), reads the form answers");

  // --- Cancel an invite: its row and invite file are deleted.
  await tiger.page.reload({ waitUntil: "networkidle0" });
  await unlock(tiger);
  await tiger.tab("people");
  assert.match(await memberRow(tiger, "You"), /Made this box/);
  assert.match(await memberRow(tiger, "Nok"), /Invited by you/);
  await shot(tiger, "6-people.png");
  await tiger.click("[data-test=cancel-Spare]");
  await tiger.page.waitForFunction(() => !document.querySelector("[data-test=cancel-Spare]"));
  await mallory.goto(spareLink);
  await mallory.click("[data-test=open-invite]");
  await mallory.waitText("was canceled");
  log("Tiger cancels the spare invite; its link stops working");

  // --- Remove Nok: her envelope is deleted, so her passkey stops opening the box.
  await tiger.click("[data-test=remove-Nok]");
  await tiger.waitText("Nok was removed");
  await nok.page.reload({ waitUntil: "networkidle0" });
  await nok.click("[data-test=unlock]");
  await nok.waitText("can't open this box anymore");
  log("Tiger removes Nok; Nok's passkey no longer opens the box");

  await tiger.tab("items");
  await tiger.addNote("after.txt", "Written after Nok left");
  await bee.page.reload({ waitUntil: "networkidle0" });
  await unlock(bee);
  assert.equal(await bee.open("note.txt"), "Salary sheet: Nok 50k");
  assert.equal(await bee.open("after.txt"), "Written after Nok left");
  log("Bee still reads old and new data, with nothing to do");

  // --- Bee leaves the tab for 3 minutes: the box locks itself and forgets its key.
  await leaveTab(bee, 3 * 60_000);
  await bee.page.waitForSelector("[data-test=unlock]");
  await bee.waitText("Locked because you left this tab");
  assert.equal(await bee.page.$("[data-test=items]"), null, "a locked box shows nothing");
  const beforeAway = bee.total();
  await unlock(bee);
  assert.equal(bee.total() - beforeAway, 1, "after the auto-lock, opening the box takes 1 prompt: the key was gone");
  log("Bee leaves the tab for 3 minutes: the box locks itself, and opens again with 1 prompt");

  // --- The start page leads back to the box that is open in this tab
  await bee.click(".brand");
  await bee.page.waitForSelector("a.continue");
  await shot(bee, "1-home-open.png");
  assert.match(await bee.text("a.continue"), /Finance 2026/);
  await bee.click("a.continue");
  await bee.page.waitForSelector("[data-test=box-title]");
  log("From the start page, Bee goes back to the box that is open in this tab");

  // --- Lock, then open again from the start page
  await bee.click("[data-test=lock]");
  await bee.page.waitForSelector("[data-test=open-box]");
  await shot(bee, "1-home.png");
  const beforeOpen = bee.total();
  await bee.click("[data-test=open-box]");
  await bee.waitText("Finance 2026");
  assert.equal(bee.total() - beforeOpen, 1);
  log("Bee locks the box and opens it again from the start page (1 prompt)");

  // --- A second box gets a second passkey. The passkey picked names the box.
  assert.match(await tiger.text("#notice"), /after\.txt/);
  await tiger.click("[data-test=lock]");
  await tiger.page.waitForSelector("[data-test=box-name]");
  assert.equal(await tiger.text("#notice"), "", "Lock must clear the notice: it can name an item");
  await tiger.type("[data-test=box-name]", "HR 2027");
  await tiger.click("[data-test=create-box]");
  await tiger.waitText("HR 2027");
  const boxId2 = new URL(tiger.page.url()).pathname.split("/").pop();
  const creds = (await tiger.cdp.send("WebAuthn.getCredentials", { authenticatorId: tiger.authenticatorId })).credentials;
  const handles = creds.map((c) => Buffer.from(c.userHandle, "base64").toString());
  assert.deepEqual(handles.sort(), [boxId, boxId2].sort(), "one passkey per box; its user ID is the box ID");
  log("Tiger makes a second box: a second passkey, whose user ID is the new box ID");

  // On a phone Tiger picks from a list ("Finance 2026", "HR 2027").
  // The virtual authenticator picks one by itself; the app opens that passkey's box.
  await tiger.click("[data-test=lock]");
  await tiger.page.waitForSelector("[data-test=open-box]");
  await tiger.click("[data-test=open-box]");
  await tiger.page.waitForSelector("[data-test=box-title]", { timeout: 20000 });
  const opened = new URL(tiger.page.url()).pathname.split("/").pop();
  const title = await tiger.text("[data-test=box-title]");
  assert.equal(title, opened === boxId ? "Finance 2026" : "HR 2027");
  assert.ok([boxId, boxId2].includes(opened));
  log(`Tiger opens "with passkey" from the start page: the passkey picked opens its box (${title})`);

  // --- What the server stored
  // Make PGlite flush to disk, then scan every data file.
  await fetch(`${BASE}/api/boxes/${boxId}/envelopes/x`);
  const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const raw = Buffer.concat(files(DB).map((f) => readFileSync(f))).toString("latin1");
  for (const secret of [
    "Salary sheet", "Form answer", "Armored answer", "after Nok left", "AGE-SECRET-KEY-1", // data and private keys
    "Finance 2026", "HR 2027", "note.txt", "Spare", addKey, // names, labels and the add key
  ]) {
    assert.ok(!raw.includes(secret), `server storage contains "${secret}"`);
  }
  assert.ok(raw.includes("age-encryption.org/v1"), "server storage should contain age files");
  log("The database holds no plaintext, no names and no private keys");

  console.log("\n  All checks passed.\n");
} catch (err) {
  failed = true;
  console.error("\n  FAILED:", err);
} finally {
  await browser.close();
  server.kill();
  rmSync(DB, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
