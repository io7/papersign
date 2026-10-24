import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
const mailbox = vi.hoisted(() => ({
  enabled: true,
  fail: false,
  messages: [] as { to: string; subject: string; text: string }[],
}));
vi.mock("../server/mail.js", () => ({
  mailConfigured: () => mailbox.enabled,
  sendSecurityMail: async (message: {
    to: string;
    subject: string;
    text: string;
  }) => {
    if (mailbox.fail) throw new Error("Synthetic SMTP failure");
    mailbox.messages.push(message);
  },
}));
import { buildApp } from "../server/app.js";
import { config } from "../server/config.js";
import { db, pool } from "../server/db.js";
import {
  audit,
  documents,
  evidenceRecords,
  exportsTable,
  invitations,
  signerVerifications,
  user,
} from "../server/schema.js";
import { removeFile, seal, sha256, storeFile } from "../server/storage.js";
import { renderPdf } from "../server/pdf.js";
import { recordFinalization } from "../server/evidence.js";
import { SIGNING_CONSENT } from "../shared/signing-consent.js";
import { samplePdf, signaturePng } from "./fixtures.js";
let app: FastifyInstance, png: string;
const ownedUsers: string[] = [],
  ownedDocuments: string[] = [],
  files = new Set<string>();
let browserIndex = 0;
class Browser {
  cookies = new Map<string, string>();
  ip = `127.51.0.${++browserIndex}`;
  get cookie() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  async request(path: string, body?: unknown) {
    const response = await app.inject({
      method: body === undefined ? "GET" : "POST",
      url: `/api${path}`,
      remoteAddress: this.ip,
      headers: {
        Origin: config.APP_URL,
        "X-PaperSign": "1",
        Cookie: this.cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    for (const cookie of response.cookies)
      this.cookies.set(cookie.name, cookie.value);
    return response;
  }
}
async function fixture() {
  const userId = randomUUID(),
    documentId = randomUUID(),
    invitationId = randomUUID(),
    token = randomBytes(32).toString("base64url"),
    email = `${invitationId}@example.test`;
  const bytes = await samplePdf(),
    source = await storeFile(bytes, "pdf");
  files.add(source);
  ownedUsers.push(userId);
  ownedDocuments.push(documentId);
  await db.insert(user).values({
    id: userId,
    name: "OTP fixture owner",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(documents).values({
    id: documentId,
    userId,
    name: "Synthetic verification agreement.pdf",
    byteSize: bytes.length,
    fileKey: source,
    previewKey: source,
    sourceHash: sha256(bytes),
    pages: [{ width: 612, height: 792, rotation: 0 }],
    status: "awaiting",
    revision: 2,
  });
  await db.insert(invitations).values({
    id: invitationId,
    documentId,
    name: "Invited signer",
    email,
    signingOrder: 1,
    tokenHash: sha256(token),
    sealedToken: seal(token),
    field: {
      id: randomUUID(),
      pageIndex: 0,
      x: 0.1,
      y: 0.7,
      width: 0.3,
      height: 0.1,
    },
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { userId, documentId, invitationId, token, email, revision: 2 };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function latestCode(f: Fixture) {
  return mailbox.messages
    .findLast((mail) => mail.to === f.email)!
    .text.match(/code is: (\d{6})/)![1];
}
async function verify(browser: Browser, f: Fixture, purpose = "") {
  const base = `/sign/${f.token}${purpose}/verification`;
  const sent = await browser.request(`${base}/send`, { revision: f.revision });
  expect(sent.statusCode, sent.body).toBe(200);
  const confirmed = await browser.request(`${base}/confirm`, {
    revision: f.revision,
    code: latestCode(f),
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
}
async function reviewed(browser: Browser, f: Fixture) {
  const pdf = await browser.request(
    `/sign/${f.token}/pdf?revision=${f.revision}`,
  );
  expect(pdf.statusCode, pdf.body).toBe(200);
  expect(pdf.headers["x-papersign-review-sha256"]).toBe(sha256(pdf.rawPayload));
  return String(pdf.headers["x-papersign-review"]);
}
function acceptance(f: Fixture, reviewId = randomUUID()) {
  return {
    name: "Invited signer",
    consent: true,
    consentVersion: SIGNING_CONSENT.version,
    reviewId,
    revision: f.revision,
    png,
  };
}
beforeAll(async () => {
  const url = new URL(config.DATABASE_URL);
  if (url.hostname !== "127.0.0.1" || url.port !== "54376")
    throw new Error(
      "Signer verification tests require isolated PostgreSQL on 127.0.0.1:54376.",
    );
  app = await buildApp();
  png = `data:image/png;base64,${(await signaturePng()).toString("base64")}`;
});
afterAll(async () => {
  if (ownedDocuments.length) {
    const evidence = await db
      .select()
      .from(evidenceRecords)
      .where(inArray(evidenceRecords.documentId, ownedDocuments));
    for (const row of evidence)
      for (const file of row.files) files.add(file.fileKey);
    const requests = await db
      .select()
      .from(invitations)
      .where(inArray(invitations.documentId, ownedDocuments));
    for (const row of requests) if (row.imageKey) files.add(row.imageKey);
    const exports = await db
      .select()
      .from(exportsTable)
      .where(inArray(exportsTable.documentId, ownedDocuments));
    for (const row of exports) if (row.fileKey) files.add(row.fileKey);
    await db.delete(audit).where(inArray(audit.documentId, ownedDocuments));
    await db
      .delete(evidenceRecords)
      .where(inArray(evidenceRecords.documentId, ownedDocuments));
    await db
      .delete(exportsTable)
      .where(inArray(exportsTable.documentId, ownedDocuments));
    await db
      .delete(signerVerifications)
      .where(inArray(signerVerifications.documentId, ownedDocuments));
    await db
      .delete(invitations)
      .where(inArray(invitations.documentId, ownedDocuments));
    await db.delete(documents).where(inArray(documents.id, ownedDocuments));
    await db.delete(user).where(inArray(user.id, ownedUsers));
  }
  for (const file of files) await removeFile(file);
  await app?.close();
  await pool.end();
});
describe("Recipient mailbox proof and immutable acceptance", () => {
  it("reports legacy completed documents without preserved records honestly after mailbox verification", async () => {
    const f = await fixture(),
      browser = new Browser();
    await db
      .update(invitations)
      .set({
        state: "signed",
        signedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      })
      .where(eq(invitations.id, f.invitationId));
    await db
      .update(documents)
      .set({ status: "completed" })
      .where(eq(documents.id, f.documentId));
    await verify(browser, f, "/record");
    const record = await browser.request(`/sign/${f.token}/record`);
    expect(record.statusCode).toBe(200);
    expect(record.json().state).toBe("unavailable");
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, f.documentId));
    await db.insert(exportsTable).values({
      id: randomUUID(),
      documentId: f.documentId,
      revision: f.revision,
      rasterize: false,
      canonical: true,
      evidenceComplete: false,
      originalKey: document.fileKey,
      fileKey: document.fileKey,
      sha256: document.sourceHash,
      layers: [],
      state: "ready",
    });
    const limited = await browser.request(`/sign/${f.token}/record`);
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json()).toMatchObject({
      state: "ready",
      evidenceComplete: false,
      outcome: "all-signed",
    });
    expect(limited.json()).not.toHaveProperty("receipt");
    expect(limited.json()).not.toHaveProperty("timestamp");
    expect(
      (await browser.request(`/sign/${f.token}/record/pdf`)).statusCode,
    ).toBe(200);
    expect(
      (await browser.request(`/sign/${f.token}/record/receipt`)).statusCode,
    ).toBe(409);
    expect(
      (await browser.request(`/sign/${f.token}/record/evidence`)).statusCode,
    ).toBe(409);
  });
  it("rejects bearer-only PDFs and signatures, and never returns the emailed code", async () => {
    const f = await fixture(),
      browser = new Browser();
    expect(
      (await browser.request(`/sign/${f.token}/pdf?revision=2`)).statusCode,
    ).toBe(403);
    expect(
      (await browser.request(`/sign/${f.token}`, acceptance(f))).statusCode,
    ).toBe(403);
    const sent = await browser.request(`/sign/${f.token}/verification/send`, {
      revision: 2,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.body).not.toContain(latestCode(f));
    expect(sent.headers["set-cookie"]).toContain("HttpOnly");
    expect(sent.headers["set-cookie"]).toContain("SameSite=Strict");
    const [challenge] = await db
      .select()
      .from(signerVerifications)
      .where(eq(signerVerifications.invitationId, f.invitationId));
    expect(challenge.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge.codeHash).not.toBe(sha256(latestCode(f)));
    expect(mailbox.messages.at(-1)!.to).toBe(f.email);
    const forwarded = new Browser();
    expect(
      (
        await forwarded.request(`/sign/${f.token}/verification/confirm`, {
          revision: 2,
          code: latestCode(f),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await forwarded.request(`/sign/${f.token}`, acceptance(f))).statusCode,
    ).toBe(403);
  });
  it("consumes codes, expires them, limits guesses, and preserves failed-attempt counters", async () => {
    const f = await fixture(),
      browser = new Browser();
    await browser.request(`/sign/${f.token}/verification/send`, {
      revision: 2,
    });
    const actual = latestCode(f),
      wrong = actual === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++)
      expect(
        (
          await browser.request(`/sign/${f.token}/verification/confirm`, {
            revision: 2,
            code: wrong,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await browser.request(`/sign/${f.token}/verification/confirm`, {
          revision: 2,
          code: actual,
        })
      ).statusCode,
    ).toBe(400);
    const [locked] = await db
      .select()
      .from(signerVerifications)
      .where(eq(signerVerifications.invitationId, f.invitationId));
    expect(locked.attempts).toBe(5);
    expect(locked.consumedAt).not.toBeNull();
    expect(locked.codeHash).toBeNull();
    const expiring = await fixture(),
      other = new Browser();
    await other.request(`/sign/${expiring.token}/verification/send`, {
      revision: 2,
    });
    await db
      .update(signerVerifications)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(signerVerifications.invitationId, expiring.invitationId));
    expect(
      (
        await other.request(`/sign/${expiring.token}/verification/confirm`, {
          revision: 2,
          code: latestCode(expiring),
        })
      ).statusCode,
    ).toBe(400);
  });
  it("fails closed without configured or successful mail and rate-limits resends across browsers", async () => {
    const f = await fixture(),
      browser = new Browser();
    mailbox.enabled = false;
    expect(
      (
        await browser.request(`/sign/${f.token}/verification/send`, {
          revision: 2,
        })
      ).statusCode,
    ).toBe(503);
    mailbox.enabled = true;
    mailbox.fail = true;
    const failure = await browser.request(
      `/sign/${f.token}/verification/send`,
      { revision: 2 },
    );
    mailbox.fail = false;
    expect(failure.statusCode).toBe(503);
    expect(failure.cookies).toHaveLength(0);
    expect(
      (
        await new Browser().request(`/sign/${f.token}/verification/send`, {
          revision: 2,
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (await browser.request(`/sign/${f.token}`, acceptance(f))).statusCode,
    ).toBe(403);
  });
  it("binds verified grants and reviews to the document revision and invitation", async () => {
    const f = await fixture(),
      browser = new Browser();
    await verify(browser, f);
    expect(
      (
        await browser.request(`/sign/${f.token}/verification/confirm`, {
          revision: 2,
          code: latestCode(f),
        })
      ).statusCode,
    ).toBe(400);
    const reviewId = await reviewed(browser, f);
    const foreign = await fixture();
    expect(
      (await browser.request(`/sign/${foreign.token}`, acceptance(f, reviewId)))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await browser.request(`/sign/${f.token}`, {
          ...acceptance(f, reviewId),
          consentVersion: "old-consent",
        })
      ).statusCode,
    ).toBe(400);
    await db
      .update(documents)
      .set({ revision: 3 })
      .where(eq(documents.id, f.documentId));
    expect(
      (await browser.request(`/sign/${f.token}/pdf?revision=2`)).statusCode,
    ).toBe(409);
    expect(
      (await browser.request(`/sign/${f.token}/pdf?revision=3`)).statusCode,
    ).toBe(403);
    expect(
      (
        await browser.request(`/sign/${f.token}`, {
          ...acceptance(f, reviewId),
          revision: 3,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("accepts only once, retains exact consent, and requires separate mailbox proof for records after expiry", async () => {
    const f = await fixture(),
      browser = new Browser();
    await verify(browser, f);
    const reviewId = await reviewed(browser, f);
    const attempts = await Promise.all([
      browser.request(`/sign/${f.token}`, acceptance(f, reviewId)),
      browser.request(`/sign/${f.token}`, acceptance(f, reviewId)),
    ]);
    expect(attempts.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const accepted = attempts
      .find((result) => result.statusCode === 200)!
      .json();
    expect(accepted.acceptanceReceiptHash).toMatch(/^[a-f0-9]{64}$/);
    const records = await db
      .select()
      .from(evidenceRecords)
      .where(eq(evidenceRecords.documentId, f.documentId));
    expect(
      records.filter((record) => record.kind === "acceptance"),
    ).toHaveLength(1);
    expect(
      records.find((record) => record.kind === "acceptance")!.body.consent,
    ).toEqual(SIGNING_CONSENT);
    const [proof] = await db
      .select()
      .from(signerVerifications)
      .where(eq(signerVerifications.invitationId, f.invitationId));
    expect(proof.consumedAt).not.toBeNull();
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(invitations.id, f.invitationId));
    expect((await browser.request(`/sign/${f.token}`)).statusCode).toBe(200);
    expect((await browser.request(`/sign/${f.token}/record`)).statusCode).toBe(
      403,
    );
    f.revision = 3;
    await verify(browser, f, "/record");
    expect(
      (await browser.request(`/sign/${f.token}/record`)).json().state,
    ).toBe("preparing");
    const [canonical] = await db
      .select()
      .from(exportsTable)
      .where(
        and(
          eq(exportsTable.documentId, f.documentId),
          eq(exportsTable.canonical, true),
        ),
      );
    const final = await renderPdf(
        canonical.originalKey,
        canonical.layers,
        false,
      ),
      fileKey = await storeFile(final, "pdf");
    files.add(fileKey);
    await db.transaction(async (tx) => {
      await recordFinalization(tx, canonical, { fileKey, bytes: final });
      await tx
        .update(exportsTable)
        .set({ state: "ready", fileKey, sha256: sha256(final) })
        .where(eq(exportsTable.id, canonical.id));
    });
    const completion = await browser.request(`/sign/${f.token}/record`);
    expect(completion.json().state).toBe("ready");
    expect(completion.json().outcome).toBe("all-signed");
    expect(
      (await browser.request(`/sign/${f.token}/record/pdf`)).rawPayload,
    ).toEqual(final);
    expect(
      (await browser.request(`/sign/${f.token}/record/receipt`)).json()
        .finalPdfSha256,
    ).toBe(sha256(final));
    const bundle = await browser.request(`/sign/${f.token}/record/evidence`);
    expect(bundle.statusCode, bundle.body.slice(0, 100)).toBe(200);
    expect(bundle.rawPayload.includes(Buffer.from("verify.mjs"))).toBe(true);
    expect(
      (await new Browser().request(`/sign/${f.token}/record/pdf`)).statusCode,
    ).toBe(403);
    expect(
      (await browser.request(`/sign/${f.token}`, acceptance(f, reviewId)))
        .statusCode,
    ).toBe(404);
  });
});
