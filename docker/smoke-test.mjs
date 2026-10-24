#!/usr/bin/env node
// End-to-end check of a running PaperSign stack started with the try-out
// mailbox (`docker compose --profile try-out up -d`). It creates a throwaway
// owner, makes it the first Admin, signs a document with two signers through an
// API key and the command-line client, renders an image-only copy, and checks
// Admin operations. Run from a checkout with `npm ci` done:
//
//   PAPERSIGN_URL=http://HOST:3176 MAILPIT_URL=http://HOST:8025 \
//   BOOTSTRAP_COMMAND='docker compose exec -T web papersign bootstrap-admin --email {email}' \
//   node docker/smoke-test.mjs [--after-restart]
//
// BOOTSTRAP_COMMAND is split on spaces and run without a shell; {email} is
// replaced by the generated owner address. Use only on a fresh test instance:
// it needs zero Admins and open registration. --after-restart checks the same
// data again after `docker compose down` and `up`, using SMOKE_STATE
// (default .local/docker-smoke-state.json). Behind the bundled Caddy with a
// local certificate, point PAPERSIGN_URL at the https address and set
// NODE_EXTRA_CA_CERTS to Caddy's root certificate.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";

const base = (process.env.PAPERSIGN_URL ?? "http://127.0.0.1:3176").replace(
  /\/+$/,
  "",
);
const mailpit = (process.env.MAILPIT_URL ?? "http://127.0.0.1:8025").replace(
  /\/+$/,
  "",
);
const statePath = resolve(
  process.env.SMOKE_STATE ?? ".local/docker-smoke-state.json",
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
const results = [];
const pass = (name, detail = "") => {
  results.push({ name, ok: true, detail });
  console.log(`ok  ${name}${detail ? `: ${detail}` : ""}`);
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Browser-style request with the same-origin headers PaperSign requires.
async function request(
  path,
  { method = "GET", body, cookie = "", headers = {} } = {},
) {
  const form = body instanceof FormData;
  return fetch(base + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Origin: base,
      "X-PaperSign": "1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined && !form
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    body: body === undefined || form ? body : JSON.stringify(body),
  });
}
async function json(response, expected = 200) {
  const text = await response.text();
  assert.equal(
    response.status,
    expected,
    `${response.url} → ${response.status}: ${text.slice(0, 300)}`,
  );
  return text ? JSON.parse(text) : undefined;
}
const cookiesOf = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

async function mailTo(address, subject, after) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = await (
      await fetch(`${mailpit}/api/v1/messages?limit=200`)
    ).json();
    const found = list.messages.find(
      (message) =>
        message.To.some(
          (to) => to.Address.toLowerCase() === address.toLowerCase(),
        ) &&
        message.Subject.includes(subject) &&
        Date.parse(message.Created) >= after - 2000,
    );
    if (found)
      return (await fetch(`${mailpit}/api/v1/message/${found.ID}`)).json();
    await pause(500);
  }
  throw new Error(`No “${subject}” email reached ${address}`);
}
function totp(uri) {
  const encoded = new URL(uri).searchParams.get("secret");
  let bits = "";
  for (const char of encoded.replace(/=+$/, ""))
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(char.toUpperCase())
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
async function minutesPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Docker smoke test minutes", { x: 60, y: 760, size: 16, font });
  page.drawText("Synthetic document for an automated check.", {
    x: 60,
    y: 730,
    size: 11,
    font,
  });
  page.drawText("Ada Smoke, Chair", { x: 60, y: 300, size: 11, font });
  page.drawText("Place and date:", { x: 60, y: 282, size: 11, font });
  page.drawText("Bo Smoke, Member", { x: 320, y: 300, size: 11, font });
  page.drawText("Place and date:", { x: 320, y: 282, size: 11, font });
  return Buffer.from(await doc.save());
}
async function signaturePng() {
  const svg =
    '<svg width="240" height="80"><path d="M12 58 C28 45 30 6 40 17 S34 78 60 48 S80 20 88 40 S106 57 127 28 S142 76 166 44 L225 43" stroke="#1d4ed8" fill="none" stroke-width="5"/></svg>';
  const png = await sharp({
    create: {
      width: 240,
      height: 80,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
async function signAs(url, email, name, text, png) {
  const token = new URL(url).pathname.split("/").pop();
  const details = await json(await request(`/api/sign/${token}`));
  const asked = Date.now();
  const sent = await request(`/api/sign/${token}/verification/send`, {
    method: "POST",
    body: { revision: details.revision },
  });
  await json(sent);
  const cookie = cookiesOf(sent);
  const mail = await mailTo(email, "Your PaperSign verification code", asked);
  const code = mail.Text.match(/code is: (\d{6})/)?.[1];
  assert(code, "verification code missing");
  await json(
    await request(`/api/sign/${token}/verification/confirm`, {
      method: "POST",
      cookie,
      body: { revision: details.revision, code },
    }),
  );
  const review = await request(
    `/api/sign/${token}/pdf?revision=${details.revision}`,
    { cookie },
  );
  assert.equal(review.status, 200);
  await review.arrayBuffer();
  const reviewId = review.headers.get("x-papersign-review");
  assert(reviewId, "review id missing");
  await json(
    await request(`/api/sign/${token}`, {
      method: "POST",
      cookie,
      body: {
        name,
        consent: true,
        consentVersion: details.consent.version,
        reviewId,
        revision: details.revision,
        png,
        textValues: details.textFields.map((field) => ({ id: field.id, text })),
      },
    }),
  );
}
function cli(key, ...args) {
  return runFile(
    process.execPath,
    [join(repo, "client/papersign.mjs"), ...args],
    {
      env: {
        PATH: process.env.PATH,
        PAPERSIGN_URL: base,
        PAPERSIGN_API_KEY: key,
        // A test certificate authority, such as Caddy's local one.
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
      },
      timeout: 120_000,
    },
  );
}
async function bootstrapAdmin(email) {
  const template = process.env.BOOTSTRAP_COMMAND;
  assert(
    template,
    "Set BOOTSTRAP_COMMAND, for example: docker compose exec -T web papersign bootstrap-admin --email {email}",
  );
  const [command, ...args] = template
    .trim()
    .split(/\s+/)
    .map((part) => part.replaceAll("{email}", email));
  const { stdout } = await runFile(command, args, { timeout: 120_000 });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

async function firstRun() {
  const run = randomUUID().slice(0, 8);
  const owner = {
    email: `owner-${run}@example.test`,
    password: `Smoke-${randomUUID()}!`,
    name: "Smoke Owner",
  };
  await json(await request("/api/health"));
  const config = await json(await request("/api/config"));
  assert.equal(
    config.emailEnabled,
    true,
    "SMTP must be configured (try-out mailbox)",
  );
  pass("health and configuration", base);

  const registered = Date.now();
  await json(
    await request("/api/auth/sign-up/email", { method: "POST", body: owner }),
  );
  const verification = await mailTo(
    owner.email,
    "Verify your PaperSign email address",
    registered,
  );
  const link = verification.Text.match(/https?:\/\/\S+verify-email\S+/)?.[0];
  assert(link, "verification link missing");
  const verified = await fetch(link, { redirect: "manual" });
  assert(
    verified.status < 400,
    `verification link answered ${verified.status}`,
  );
  const signedIn = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: owner.email, password: owner.password },
  });
  await json(signedIn);
  let cookie = cookiesOf(signedIn);
  pass("registration, email verification and sign-in", owner.email);

  const promoted = await bootstrapAdmin(owner.email);
  assert.equal(promoted.role, "admin");
  pass("first Admin from the container command", promoted.id);

  const setup = await json(
    await request("/api/auth/two-factor/enable", {
      method: "POST",
      cookie,
      body: { password: owner.password },
    }),
  );
  const confirmed = await request("/api/auth/two-factor/verify-totp", {
    method: "POST",
    cookie,
    body: { code: totp(setup.totpURI) },
  });
  await json(confirmed);
  cookie = cookiesOf(confirmed) || cookie;
  const created = await json(
    await request("/api/admin/api-keys", {
      method: "POST",
      cookie,
      body: { name: "Docker smoke test", lifetimeDays: 30 },
    }),
    201,
  );
  pass("authenticator enrollment and API key", created.key.prefix);

  const folder = await mkdtemp(join(tmpdir(), "papersign-smoke-"));
  try {
    await writeFile(join(folder, "minutes.pdf"), await minutesPdf());
    const signers = [
      { name: "Ada Smoke", anchor: "Ada Smoke, Chair" },
      { name: "Bo Smoke", anchor: "Bo Smoke, Member" },
    ].map((signer, index) => ({
      name: signer.name,
      email: `signer${index + 1}-${run}@example.test`,
      signature: { anchor: signer.anchor },
      text: [
        {
          label: "Place and date",
          anchor: "Place and date:",
          near: signer.anchor,
        },
      ],
    }));
    await writeFile(
      join(folder, "spec.json"),
      JSON.stringify({ pdf: "minutes.pdf", signers }),
    );
    const made = await cli(created.secret, "create", join(folder, "spec.json"));
    const documentId = made.stdout.match(/Document: ([0-9a-f-]{36})/)?.[1];
    assert(documentId, made.stdout);
    pass("command-line client created the request", documentId);

    const emailed = Date.now();
    const sent = await cli(created.secret, "email", documentId);
    assert.equal(sent.stdout.match(/^Sent to /gm)?.length, 2, sent.stdout);
    await mailTo(signers[0].email, "invited you to sign", emailed);
    await mailTo(signers[1].email, "invited you to sign", emailed);
    pass("invitation emails delivered", "2 signers");

    const png = await signaturePng();
    const key = { Authorization: `Bearer ${created.secret}` };
    let document = await json(
      await request(`/api/documents/${documentId}`, { headers: key }),
    );
    for (const [index, invitation] of document.invitations.entries())
      await signAs(
        invitation.url,
        invitation.email,
        signers[index].name,
        `London, 2${index}.10.2026`,
        png,
      );
    pass("both signers verified by email code and signed");

    let record = { state: "queued" };
    for (
      let attempt = 0;
      attempt < 120 && record.state !== "ready";
      attempt++
    ) {
      record = await json(
        await request(`/api/documents/${documentId}/record`, { headers: key }),
      );
      if (record.state !== "ready") await pause(500);
    }
    assert.equal(record.state, "ready", JSON.stringify(record));
    await cli(
      created.secret,
      "download",
      documentId,
      join(folder, "signed.pdf"),
      "--evidence",
      join(folder, "evidence.tar"),
    );
    const signed = await readFile(join(folder, "signed.pdf"));
    assert.equal(signed.subarray(0, 5).toString(), "%PDF-");
    assert((await readFile(join(folder, "evidence.tar"))).length > 1024);
    pass(
      "worker produced the completed record; PDF and evidence downloaded",
      `${signed.length} bytes`,
    );

    document = await json(
      await request(`/api/documents/${documentId}`, { cookie }),
    );
    const requested = await request(`/api/documents/${documentId}/exports`, {
      method: "POST",
      cookie,
      body: { rasterize: true, revision: document.revision },
    });
    const queued = await json(requested, requested.status === 200 ? 200 : 202);
    const exportId = queued.id ?? queued.exportId;
    let exported = { state: "queued" };
    for (
      let attempt = 0;
      attempt < 240 && !["ready", "failed"].includes(exported.state);
      attempt++
    ) {
      exported = await json(
        await request(`/api/exports/${exportId}`, { cookie }),
      );
      if (!["ready", "failed"].includes(exported.state)) await pause(500);
    }
    assert.equal(exported.state, "ready", JSON.stringify(exported));
    const image = await request(`/api/exports/${exportId}/download`, {
      cookie,
    });
    const imageBytes = Buffer.from(await image.arrayBuffer());
    assert.equal(imageBytes.subarray(0, 5).toString(), "%PDF-");
    pass(
      "image-only export rendered in the worker",
      `${imageBytes.length} bytes`,
    );

    const operations = await json(
      await request("/api/admin/operations", { cookie }),
    );
    const failing = operations.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`);
    assert.deepEqual(failing, [], "Admin operations checks");
    pass(
      "Admin operations checks",
      operations.checks.map((check) => check.name).join(", "),
    );

    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          base,
          owner,
          key: created.secret,
          documentId,
          signedBytes: signed.length,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function afterRestart() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.base, base);
  await json(await request("/api/health"));
  const signedIn = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: state.owner.email, password: state.owner.password },
  });
  const body = await json(signedIn);
  assert(
    body.twoFactorRedirect,
    "the owner still has two-step verification after restart",
  );
  pass("account and authenticator survived the restart", state.owner.email);
  const key = { Authorization: `Bearer ${state.key}` };
  const document = await json(
    await request(`/api/documents/${state.documentId}`, { headers: key }),
  );
  assert.equal(document.status, "completed");
  const signed = await request(
    `/api/documents/${state.documentId}/record/pdf`,
    { headers: key },
  );
  const bytes = Buffer.from(await signed.arrayBuffer());
  assert.equal(signed.status, 200);
  assert.equal(bytes.length, state.signedBytes);
  pass("document, key and stored PDF survived the restart", state.documentId);
}

try {
  if (process.argv.includes("--after-restart")) await afterRestart();
  else await firstRun();
  console.log(JSON.stringify({ passed: true, checks: results.length }));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
