// End-to-end test of the whole user journey in headless Chrome.
// Each person gets their own browser profile and a virtual passkey
// authenticator with PRF support (Chrome DevTools Protocol), so real
// WebAuthn + PRF code paths run — nothing is mocked.
//
//   npm test            (builds, then runs this)
//   CHROME_PATH=/path/to/chrome npm test

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import * as age from "age-encryption";

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const DB = join(tmpdir(), `secretbox-e2e-${process.pid}.db`);

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
const shot = async (p, file) => {
  if (!process.env.SCREENSHOTS) return;
  mkdirSync("test-results", { recursive: true });
  await p.page.screenshot({ path: `test-results/${file}`, fullPage: true });
};

let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

// --- Server ------------------------------------------------------------------

const server = spawn(process.execPath, ["--no-warnings", "server/index.ts"], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ORIGINS: BASE },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("Secretbox on") && resolve());
  server.on("exit", (code) => reject(Error(`server exited (${code})`)));
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

// --- Helpers -------------------------------------------------------------------

/** A person = a separate browser profile + their own passkey authenticator. */
async function person(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
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
    prompts,
    total: () => prompts.created + prompts.asserted,
    goto: (url) => page.goto(url, { waitUntil: "networkidle0" }),
    type: async (sel, text) => {
      await page.$eval(sel, (el) => (el.value = ""));
      await page.type(sel, text);
    },
    click: (sel) => page.click(sel),
    text: (sel) => page.$eval(sel, (el) => el.textContent),
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
  };
  return p;
}

async function createInvite(admin, label, role = "reader") {
  await admin.type("[data-test=invite-label]", label);
  await admin.page.select("[data-test=invite-role]", role);
  await admin.page.$eval("[data-test=invite-link]", (el) => el.remove()).catch(() => {});
  await admin.click("[data-test=create-invite]");
  await admin.page.waitForSelector("[data-test=invite-link]");
  return admin.page.$eval("[data-test=invite-link]", (el) => el.value);
}

async function joinWith(p, link, nickname) {
  await p.goto(link);
  await p.waitText("invited you");
  await shot(p, `3-join-${nickname}.png`);
  await p.type("[data-test=nickname]", nickname);
  await p.click("[data-test=accept]");
  await p.page.waitForSelector("[data-test=box-title]", { timeout: 20000 });
}

// --- The journey -----------------------------------------------------------------

let failed = false;
try {
  console.log("\nSecretbox end-to-end test\n");

  const tiger = await person("Tiger");
  await tiger.goto(BASE);
  await shot(tiger, "1-start.png");
  await tiger.type("[data-test=nickname]", "Tiger");
  await tiger.type("[data-test=box-name]", "Finance 2026");
  await tiger.click("[data-test=create-box]");
  await tiger.page.waitForSelector("[data-test=box-title]", { timeout: 20000 });
  assert.match(await tiger.text("[data-test=box-title]"), /Finance 2026/);
  assert.equal(tiger.total(), 2, "creating a box should take exactly 2 passkey prompts");
  log("Tiger creates a box (2 passkey prompts)");
  const boxId = new URL(tiger.page.url()).pathname.split("/").pop();

  await tiger.type("[data-test=note-text]", "Salary sheet: Nok 50k");
  await tiger.click("[data-test=add-note]");
  await tiger.waitText("note.txt");
  assert.equal(tiger.total(), 2, "adding data should need no passkey prompt");
  log("Tiger adds a note (0 prompts, locked in the browser)");

  const nokLink = await createInvite(tiger, "Nok, finance");
  await shot(tiger, "2-admin-invite.png");
  const beeLink = await createInvite(tiger, "Bee, audit");
  const spareLink = await createInvite(tiger, "Spare");
  assert.match(nokLink, new RegExp(`^${BASE}/join/[\\w-]+#AGE-SECRET-KEY-1[0-9A-Z]+$`));
  log("Tiger makes 3 invite links (one-time key after #)");

  const nok = await person("Nok");
  await joinWith(nok, nokLink, "Nok");
  assert.equal(nok.total(), 2, "joining should take exactly 2 passkey prompts");
  assert.ok(!nok.page.url().includes("#"), "the one-time key should be removed from the URL");
  assert.equal(await nok.open("note.txt"), "Salary sheet: Nok 50k");
  await shot(nok, "4-reader-box.png");
  log("Nok joins with the link (2 prompts) and reads the note");

  // A link preview bot fetches the page and the public invite info: nothing changes.
  const preview = await fetch(beeLink.split("#")[0]);
  assert.equal(preview.status, 200);
  const info = await (await fetch(`${BASE}/api/invites/${beeLink.split("/join/")[1].split("#")[0]}`)).json();
  assert.equal(info.status, "open");
  log("A link preview (GET) does not use up the invite");

  const mallory = await person("Mallory");
  await mallory.goto(nokLink);
  await mallory.waitText("already used");
  await shot(mallory, "5-link-used.png");
  log("Mallory opens Nok's link again: 'already used'");

  const bee = await person("Bee");
  await joinWith(bee, beeLink, "Bee");
  log("Bee joins with her own link");

  // --- Outside system adds data with only the public key + a token
  await tiger.type("[data-test=token-label]", "Google Form");
  await tiger.click("[data-test=create-token]");
  await tiger.page.waitForSelector("[data-test=token]");
  const token = (await tiger.text("[data-test=token]")).trim();
  const recipient = (await tiger.text("[data-test=box-recipient]")).trim();
  const ingest = (name, body) =>
    fetch(`${BASE}/api/ingest/${boxId}?name=${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  assert.equal((await ingest("answer.txt", await e.encrypt("Form answer #1"))).status, 200);
  const e2 = new age.Encrypter();
  e2.addRecipient(recipient);
  assert.equal((await ingest("armored.txt", age.armor.encode(await e2.encrypt("Armored answer")))).status, 200);
  assert.equal((await ingest("plain.txt", "not encrypted")).status, 400, "plaintext must be rejected");
  assert.equal(
    (await fetch(`${BASE}/api/ingest/${boxId}?name=x`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "x" })).status,
    401,
  );
  log("An outside system adds 2 files with the age public key; plaintext and bad tokens are rejected");

  // --- Nok comes back later: a reload clears keys from memory, so she unlocks once.
  await nok.page.reload({ waitUntil: "networkidle0" });
  assert.equal(await nok.text("[data-test=lock-state]"), "Locked");
  const before = nok.total();
  assert.equal(await nok.open("answer.txt"), "Form answer #1");
  assert.equal(await nok.open("armored.txt"), "Armored answer");
  assert.equal(nok.total() - before, 1, "unlocking should take exactly 1 passkey prompt");
  log("Nok returns, unlocks once (1 prompt), reads the form answers");

  // --- Remove Nok: the box key changes, Bee keeps access without doing anything
  await tiger.page.reload({ waitUntil: "networkidle0" });
  await tiger.page.waitForSelector("[data-test=remove-Nok]");
  await tiger.click("[data-test=remove-Nok]");
  await tiger.waitText("Nok was removed");
  log("Tiger removes Nok (box key changes)");

  await nok.page.reload({ waitUntil: "networkidle0" });
  await nok.page.waitForSelector("[data-test=no-access]");
  const nokApi = await nok.page.evaluate(async (id) => (await fetch(`/api/boxes/${id}`)).status, boxId);
  assert.equal(nokApi, 403);
  log("Nok has no access any more (UI and API)");

  await mallory.goto(spareLink);
  await mallory.waitText("canceled");
  log("Open invites were canceled, because they held the old box key");

  await tiger.type("[data-test=note-text]", "Written after the key change");
  await tiger.type("[data-test=note-name]", "after.txt");
  await tiger.click("[data-test=add-note]");
  await tiger.waitText("after.txt");
  await bee.page.reload({ waitUntil: "networkidle0" });
  assert.equal(await bee.open("note.txt"), "Salary sheet: Nok 50k");
  assert.equal(await bee.open("after.txt"), "Written after the key change");
  log("Bee reads old data (key history) and new data (new key), with no new invite");

  // --- Sign out, sign in again
  await bee.page.evaluate(() => [...document.querySelectorAll(".topbar button")].find((b) => b.textContent === "Sign out").click());
  await bee.page.waitForSelector("[data-test=sign-in]");
  await bee.click("[data-test=sign-in]");
  await bee.waitText("Finance 2026");
  log("Bee signs out and signs in again with her passkey");

  // --- What the server stored
  const raw = Buffer.concat([DB, `${DB}-wal`].filter(existsSync).map((f) => readFileSync(f))).toString("latin1");
  for (const secret of ["Salary sheet", "Form answer", "Armored answer", "after the key change", "AGE-SECRET-KEY-1"]) {
    assert.ok(!raw.includes(secret), `server storage contains "${secret}"`);
  }
  assert.ok(raw.includes("age-encryption.org/v1"), "server storage should contain age files");
  log("The server's database holds no plaintext and no secret keys");

  console.log("\n  All checks passed.\n");
} catch (err) {
  failed = true;
  console.error("\n  FAILED:", err);
} finally {
  await browser.close();
  server.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  process.exit(failed ? 1 : 0);
}
