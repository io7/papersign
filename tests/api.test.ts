import {
  assertTestMail,
  latestTestMail,
  waitForTestMail,
} from "./helpers/test-mail.js";
import { verifyFixtureEmail } from "./helpers/account-security.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localFetch, setLocalClientAddress } from "./helpers/local-http.js";
let clientIndex = 1;
setLocalClientAddress("127.0.11.1");
beforeEach(() => setLocalClientAddress(`127.0.11.${++clientIndex}`));
import {
  ownerInvitationBody,
  finalizeOwnerIfNeeded,
} from "./helpers/owner-signing.js";
import {
  recipientBody,
  recipientCookies,
  verifyApiRecipient,
} from "./helpers/signer-verification.js";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { Client } from "pg";
import sharp from "sharp";
import { config } from "../server/config";
import {
  coloredPdf,
  samplePdf,
  signaturePng,
  whiteSignaturePng,
} from "./fixtures";
const base = "http://127.0.0.1:3176";
const unique = randomUUID();
let cookieA = "",
  cookieB = "",
  png = "",
  original: Buffer,
  signatureId = "",
  docId = "",
  revision = 1,
  normalExport = "";
const password = `Test-${randomUUID()}!`;
async function request(
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
) {
  cookie = recipientCookies(path, cookie);
  if (method === "POST") {
    body = recipientBody(path, body);
    body = await ownerInvitationBody(path, cookie, body);
  }
  const multipart = body instanceof FormData;
  return localFetch(base + "/api" + path, {
    method,
    headers: {
      Origin: base,
      "X-PaperSign": "1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(!multipart && body ? { "Content-Type": "application/json" } : {}),
    },
    body: multipart ? body : body ? JSON.stringify(body) : undefined,
  });
}
async function register(label: string) {
  const email = `${label}-${unique}@example.invalid`;
  const secret = password;
  const response = await request("/auth/sign-up/email", "", "POST", {
    name: label,
    email,
    password: secret,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const created = await response.json();
  await verifyFixtureEmail(created.user.id, email);
  const signedIn = await request("/auth/sign-in/email", "", "POST", {
    email,
    password: secret,
  });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  return signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function guestPost(
  token: string,
  body: unknown,
  localAddress = "127.0.0.3",
) {
  // Keep the serial-signing checks in a separate loopback rate-limit bucket.
  // This is a real source address, not an untrusted forwarded-IP header.
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/sign/${token}`,
      {
        method: "POST",
        localAddress,
        timeout: 10000,
        headers: {
          Origin: base,
          "X-PaperSign": "1",
          "Content-Type": "application/json",
          Cookie: recipientCookies(`/sign/${token}`),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode!,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Guest signing stalled")));
    req.end(JSON.stringify(recipientBody(`/sign/${token}`, body)));
  });
}
async function imageCount(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes);
  const objects = pdf
    .getPage(0)
    .node.Resources()
    ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  return (objects?.entries() ?? []).filter(([, reference]) => {
    const object = pdf.context.lookup(reference);
    return (
      object instanceof PDFRawStream &&
      object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")
    );
  }).length;
}
async function readyExport(
  rasterize: boolean,
  documentId = docId,
  reviewedRevision = revision,
) {
  const finalized = await finalizeOwnerIfNeeded(documentId, cookieA);
  reviewedRevision = finalized.revision;
  if (documentId === docId) revision = finalized.revision;
  const queued = await request(
    `/documents/${documentId}/exports`,
    cookieA,
    "POST",
    {
      rasterize,
      revision: reviewedRevision,
    },
  );
  expect(queued.status, await queued.clone().text()).toBe(202);
  const job = await queued.json();
  for (let i = 0; i < 150; i++) {
    const response = await request(`/exports/${job.id}`, cookieA),
      status = await response.json();
    if (status.state === "failed") throw new Error(status.error);
    if (status.state === "ready") return job.id as string;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Export did not finish in time");
}
describe("Private accounts, persistent signatures, PDF exports and signing links", () => {
  beforeAll(async () => {
    await assertTestMail(base);
    cookieA = await register("owner");
    cookieB = await register("outsider");
    png = "data:image/png;base64," + (await signaturePng()).toString("base64");
    original = await samplePdf();
    await mkdir(".local/qa", { recursive: true });
  });
  it("registers accounts, persists a signature across login, and denies cross-account reads and writes", async () => {
    const response = await request("/signatures", cookieA, "POST", {
      name: "Reusable signature",
      source: "drawn",
      png,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const signature = await response.json();
    signatureId = signature.id;
    expect(signature.isDefault).toBe(true);
    expect(signature.fileKey).toBeUndefined();
    expect(
      (await request(`/signatures/${signatureId}/image`, cookieB)).status,
    ).toBe(404);
    expect(
      (
        await request(`/signatures/${signatureId}`, cookieB, "PATCH", {
          name: "Taken",
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(`/signatures/${signatureId}`, cookieB, "DELETE")).status,
    ).toBe(404);
    expect((await request(`/signatures/${signatureId}/image`)).status).toBe(
      401,
    );
    await request("/auth/sign-out", cookieA, "POST", {});
    expect((await request("/signatures", cookieA)).status).toBe(401);
    const login = await request("/auth/sign-in/email", "", "POST", {
      email: `owner-${unique}@example.invalid`,
      password,
    });
    expect(login.status).toBe(200);
    cookieA = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const library = await (await request("/signatures", cookieA)).json();
    expect(library[0].id).toBe(signatureId);
    expect(
      (await request(`/signatures/${signatureId}/image`, cookieA)).status,
    ).toBe(200);
    const badOrigin = await fetch(base + "/api/signatures", {
      method: "POST",
      headers: {
        Origin: "https://other.invalid",
        Cookie: cookieA,
        "X-PaperSign": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Bad", source: "drawn", png }),
    });
    expect(badOrigin.status).toBe(403);
  });
  it("validates PNGs, keeps exactly one default under concurrent changes, and supports rename/remove", async () => {
    expect(
      (
        await request("/signatures", cookieA, "POST", {
          name: "bad",
          source: "uploaded",
          png: "data:image/png;base64,bm90IHBuZw==",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const second = await (
      await request("/signatures", cookieA, "POST", {
        name: "Second",
        source: "uploaded",
        png,
      })
    ).json();
    await Promise.all([
      request(`/signatures/${signatureId}`, cookieA, "PATCH", {
        isDefault: true,
      }),
      request(`/signatures/${second.id}`, cookieA, "PATCH", {
        isDefault: true,
      }),
    ]);
    let library = await (await request("/signatures", cookieA)).json();
    expect(library.filter((s: any) => s.isDefault)).toHaveLength(1);
    expect(
      (
        await request(`/signatures/${signatureId}`, cookieA, "PATCH", {
          name: "Saved for later",
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(`/signatures/${second.id}`, cookieA, "DELETE")).status,
    ).toBe(204);
    library = await (await request("/signatures", cookieA)).json();
    expect(library).toHaveLength(1);
    expect(library[0].name).toBe("Saved for later");
    expect(library[0].isDefault).toBe(true);
  });
  it("uploads and signs rotated/cropped PDFs, prevents stale and unauthorized edits, and makes real raster exports", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(original)], { type: "application/pdf" }),
      "rotation-test.pdf",
    );
    const uploaded = await request("/documents", cookieA, "POST", form);
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const document = await uploaded.json();
    docId = document.id;
    revision = document.revision;
    expect(document.pages).toHaveLength(4);
    expect((await request(`/documents/${docId}`, cookieB)).status).toBe(404);
    expect((await request(`/documents/${docId}/pdf`, cookieB)).status).toBe(
      404,
    );
    const placements = document.pages.map((_: unknown, pageIndex: number) => ({
      id: randomUUID(),
      signatureId,
      pageIndex,
      x: 0.2,
      y: 0.63,
      width: 0.18,
      height: 0.06,
    }));
    const saved = await request(
      `/documents/${docId}/placements`,
      cookieA,
      "PUT",
      { revision, placements },
    );
    expect(saved.status).toBe(200);
    revision = (await saved.json()).revision;
    expect(
      (
        await request(`/documents/${docId}/placements`, cookieA, "PUT", {
          revision: revision - 1,
          placements: [],
        })
      ).status,
    ).toBe(409);
    normalExport = await readyExport(false);
    expect(
      (await request(`/exports/${normalExport}/download`, cookieB)).status,
    ).toBe(404);
    const normal = Buffer.from(
      await (
        await request(`/exports/${normalExport}/download`, cookieA)
      ).arrayBuffer(),
    );
    expect((await PDFDocument.load(normal)).getPageCount()).toBe(4);
    await writeFile(".local/qa/signed-rotated.pdf", normal);
    const raster = await readyExport(true),
      rasterBytes = Buffer.from(
        await (
          await request(`/exports/${raster}/download`, cookieA)
        ).arrayBuffer(),
      );
    await writeFile(".local/qa/signed-rasterized.pdf", rasterBytes);
    const proof = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "tests/check_pdf.mjs",
          ".local/qa/signed-rotated.pdf",
          ".local/qa/signed-rasterized.pdf",
        ],
        { encoding: "utf8" },
      ),
    );
    expect(proof.normalText).toBeGreaterThan(0);
    expect(proof.rasterText).toBe(0);
    expect(proof.pages).toBe(4);
    for (const mark of proof.centers) {
      expect(mark.x).toBeCloseTo(0.29, 1);
      expect(mark.y).toBeCloseTo(0.66, 1);
    }
    expect(
      Buffer.from(
        await (await request(`/documents/${docId}/pdf`, cookieA)).arrayBuffer(),
      ).equals(original),
    ).toBe(true);
  });
  it("coalesces eight simultaneous exports without exhausting the database pool", async () => {
    // A separate loopback client has its own rate-limit bucket; no IP headers
    // are spoofed. Eight callers saturate the server's eight-connection pool.
    const calls = Array.from(
      { length: 8 },
      () =>
        new Promise<{ status: number; body: any }>((resolve, reject) => {
          const req = httpRequest(
            `${base}/api/documents/${docId}/exports`,
            {
              method: "POST",
              localAddress: "127.0.0.2",
              timeout: 10000,
              headers: {
                Origin: base,
                "X-PaperSign": "1",
                Cookie: cookieA,
                "Content-Type": "application/json",
              },
            },
            (response) => {
              let body = "";
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => {
                try {
                  resolve({
                    status: response.statusCode!,
                    body: JSON.parse(body),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.on("error", reject);
          req.on("timeout", () =>
            req.destroy(new Error("Concurrent export stalled")),
          );
          req.end(JSON.stringify({ rasterize: false, revision }));
        }),
    );
    const responses = await Promise.all(calls);
    expect(responses.map((response) => response.status)).toEqual(
      Array(8).fill(202),
    );
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    expect(responses[0].body.id).toBe(normalExport);
  });
  it("freezes invitation content, accepts consent once, revokes links, and preserves exports after removing a saved signature", async () => {
    // A completed owner signature is immutable. New recipients get a fresh
    // draft and a new owner acceptance rather than reopening that record.
    const previous = await (
      await request(`/documents/${docId}`, cookieA)
    ).json();
    expect(previous.status).toBe("completed");
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(original)], { type: "application/pdf" }),
      "Recipient agreement.pdf",
    );
    const fresh = await (
      await request("/documents", cookieA, "POST", form)
    ).json();
    docId = fresh.id;
    const saved = await request(
      `/documents/${docId}/placements`,
      cookieA,
      "PUT",
      { revision: fresh.revision, placements: previous.placements },
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    revision = (await saved.json()).revision;
    const body = {
      revision,
      recipients: ["Signer one", "Signer two"].map((name) => ({
        name,
        email: `${name.replace(" ", "")}@example.invalid`,
        field: {
          id: randomUUID(),
          pageIndex: 0,
          x: 0.5,
          y: 0.8,
          width: 0.3,
          height: 0.08,
        },
      })),
    };
    const response = await request(
      `/documents/${docId}/invitations`,
      cookieA,
      "POST",
      body,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const invites = await response.json(),
      token = invites[0].url.split("/").pop();
    const guestRevision = (await (await request(`/sign/${token}`)).json())
      .revision;
    await verifyApiRecipient(token, body.recipients[0].email);
    expect(
      (
        await request(`/documents/${docId}/placements`, cookieA, "PUT", {
          revision: revision + 1,
          placements: [],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/sign/${token}`, cookieB, "POST", {
          name: "Wrong owner",
          consent: true,
          revision: guestRevision,
          signatureId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/sign/${token}`, "", "POST", {
          name: "Signer one",
          consent: false,
          revision: guestRevision,
          png,
        })
      ).status,
    ).toBe(400);
    const results = await Promise.all([
      request(`/sign/${token}`, "", "POST", {
        name: "Signer one",
        consent: true,
        revision: guestRevision,
        png,
      }),
      request(`/sign/${token}`, "", "POST", {
        name: "Signer one",
        consent: true,
        revision: guestRevision,
        png,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await (await request(`/documents/${docId}`, cookieA)).json()).status,
    ).toBe("awaiting");
    const preview = await (
      await request(
        `/documents/${docId}/invitations/${invites[1].id}/email`,
        cookieA,
      )
    ).json();
    expect(preview.enabled).toBe(true);
    expect(
      (
        await request(
          `/documents/${docId}/invitations/${invites[1].id}/email`,
          cookieA,
          "POST",
          { previewHash: preview.previewHash },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/documents/${docId}/invitations/${invites[1].id}/revoke`,
          cookieA,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    const revokedToken = invites[1].url.split("/").pop();
    expect((await request(`/sign/${revokedToken}`)).status).toBe(404);
    expect(
      (await (await request(`/documents/${docId}`, cookieA)).json()).status,
    ).toBe("completed");
    expect(
      (await request(`/signatures/${signatureId}`, cookieA, "DELETE")).status,
    ).toBe(204);
    expect(
      (await request(`/exports/${normalExport}/download`, cookieA)).status,
    ).toBe(200);
    const events = await (
      await request(`/documents/${docId}/history`, cookieA)
    ).json();
    expect(
      events.filter((e: any) => e.event === "signature_accepted"),
    ).toHaveLength(1);
  });
  it("enforces a serial signer list, binds consent to the reviewed PDF, and carries earlier signatures into later reviews", async () => {
    const saved = await request("/signatures", cookieA, "POST", {
      name: "Serial agreement owner",
      source: "uploaded",
      png,
    });
    expect(saved.status).toBe(201);
    const ownerSignature = await saved.json();
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await samplePdf(false))], {
        type: "application/pdf",
      }),
      "serial-signing.pdf",
    );
    const uploaded = await request("/documents", cookieA, "POST", form);
    expect(uploaded.status).toBe(201);
    const document = await uploaded.json();
    const placed = await request(
      `/documents/${document.id}/placements`,
      cookieA,
      "PUT",
      {
        revision: document.revision,
        placements: [
          {
            id: randomUUID(),
            signatureId: ownerSignature.id,
            pageIndex: 0,
            x: 0.1,
            y: 0.1,
            width: 0.25,
            height: 0.08,
          },
        ],
      },
    );
    expect(placed.status).toBe(200);
    const draftRevision = (await placed.json()).revision;
    const recipients = [
      { name: "First signer", email: "first@example.invalid", x: 0.1, y: 0.54 },
      {
        name: "Second signer",
        email: "second@example.invalid",
        x: 0.5,
        y: 0.54,
      },
      { name: "Third signer", email: "third@example.invalid", x: 0.1, y: 0.78 },
    ].map(({ name, email, x, y }) => ({
      name,
      email,
      // The server owns ordering; client-provided ordinals must not bypass it.
      signingOrder: 1,
      field: {
        id: randomUUID(),
        pageIndex: 0,
        x,
        y,
        width: 0.25,
        height: 0.08,
      },
    }));
    const duplicateEmails = structuredClone(recipients);
    duplicateEmails[1].email = "FIRST@example.invalid";
    expect(
      (
        await request(
          `/documents/${document.id}/invitations`,
          cookieA,
          "POST",
          {
            revision: draftRevision,
            recipients: duplicateEmails,
          },
        )
      ).status,
    ).toBe(400);
    const duplicateFields = structuredClone(recipients);
    duplicateFields[1].field.id = duplicateFields[0].field.id;
    expect(
      (
        await request(
          `/documents/${document.id}/invitations`,
          cookieA,
          "POST",
          {
            revision: draftRevision,
            recipients: duplicateFields,
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (await (await request(`/documents/${document.id}`, cookieA)).json())
        .invitations,
    ).toEqual([]);
    const created = await request(
      `/documents/${document.id}/invitations`,
      cookieA,
      "POST",
      {
        revision: draftRevision,
        recipients,
      },
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const invitations = await created.json();
    const tokens = invitations.map((invite: any) =>
      invite.url.split("/").pop(),
    );
    const mailStart = Date.now();
    const invitationPreview = async (index: number) =>
      (
        await request(
          `/documents/${document.id}/invitations/${invitations[index].id}/email`,
          cookieA,
        )
      ).json();
    const firstPreview = await invitationPreview(0);
    expect(firstPreview.body).toContain("You can sign it now.");
    expect(firstPreview.body).not.toContain("earlier signers");
    expect((await invitationPreview(1)).body).toContain(
      "You are signer 2 in the signing order. Your turn opens once the earlier signers have finished, and PaperSign will email you when it does.",
    );
    const list = (
      await (await request(`/documents/${document.id}`, cookieA)).json()
    ).invitations;
    expect(
      list.map((invite: any) => [
        invite.name,
        invite.signingOrder,
        invite.signingStatus,
        invite.canSign,
      ]),
    ).toEqual([
      ["First signer", 1, "ready", true],
      ["Second signer", 2, "waiting", false],
      ["Third signer", 3, "waiting", false],
    ]);
    const initial = await Promise.all(
      tokens.map(async (token: string) =>
        (await request(`/sign/${token}`)).json(),
      ),
    );
    expect(
      initial.map((guest) => [
        guest.signingOrder,
        guest.totalSigners,
        guest.waitingForSigners,
        guest.canSign,
      ]),
    ).toEqual([
      [1, 3, 0, true],
      [2, 3, 1, false],
      [3, 3, 2, false],
    ]);
    for (const privateField of [
      "recipients",
      "invitations",
      "email",
      "imageKey",
      "tokenHash",
      "tokenSealed",
    ])
      expect(initial[1]).not.toHaveProperty(privateField);
    expect(JSON.stringify(initial[1])).not.toContain("First signer");
    expect(JSON.stringify(initial[1])).not.toContain("first@example.invalid");
    expect(JSON.stringify(initial[1])).not.toContain("Third signer");
    const firstRevision = initial[0].revision;
    const consent = (name: string, reviewedRevision: number) => ({
      name,
      consent: true,
      revision: reviewedRevision,
      png,
    });
    expect((await request(`/sign/${tokens[0]}/pdf`)).status).toBe(400);
    expect(
      (await request(`/sign/${tokens[0]}/pdf?revision=${firstRevision - 1}`))
        .status,
    ).toBe(409);
    expect(
      (await request(`/sign/${tokens[1]}/pdf?revision=${firstRevision}`))
        .status,
    ).toBe(409);
    expect(
      (await guestPost(tokens[1], consent("Second signer", firstRevision)))
        .status,
    ).toBe(409);
    expect(
      (await guestPost(tokens[2], consent("Third signer", firstRevision)))
        .status,
    ).toBe(409);
    expect(
      (await guestPost(tokens[0], { name: "First signer", consent: true, png }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(`/documents/${document.id}/exports`, cookieA, "POST", {
          revision: firstRevision,
          rasterize: false,
        })
      ).status,
    ).toBe(409);
    await verifyApiRecipient(tokens[0], "first@example.invalid");
    const firstPdf = await request(
      `/sign/${tokens[0]}/pdf?revision=${firstRevision}`,
    );
    expect(firstPdf.status).toBe(200);
    const firstBytes = Buffer.from(await firstPdf.arrayBuffer());
    expect(await imageCount(firstBytes)).toBe(1);
    await writeFile(".local/qa/serial-first-review.pdf", firstBytes);
    // The immutable owner preview must survive deletion from the owner's library.
    expect(
      (await request(`/signatures/${ownerSignature.id}`, cookieA, "DELETE"))
        .status,
    ).toBe(204);
    const raced = await Promise.all([
      guestPost(tokens[0], consent("First signer", firstRevision)),
      guestPost(tokens[0], consent("First signer", firstRevision)),
      guestPost(tokens[1], consent("Second signer", firstRevision)),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([
      200, 409, 409,
    ]);
    // Only the signer whose turn just opened is told; later signers keep waiting.
    const secondTurn = await waitForTestMail(
      "second@example.invalid",
      "Your turn to sign",
      mailStart,
    );
    expect(secondTurn.text).toContain("The earlier signers have finished");
    expect(secondTurn.text).toContain(`/sign/${tokens[1]}`);
    expect(
      await latestTestMail(
        "third@example.invalid",
        "Your turn to sign",
        mailStart,
      ),
    ).toBeUndefined();
    const second = await (await request(`/sign/${tokens[1]}`)).json();
    expect([
      second.signingStatus,
      second.canSign,
      second.waitingForSigners,
    ]).toEqual(["ready", true, 0]);
    expect(second.revision).toBe(firstRevision + 1);
    expect(
      (await request(`/sign/${tokens[1]}/pdf?revision=${firstRevision}`))
        .status,
    ).toBe(409);
    expect(
      (await guestPost(tokens[1], consent("Second signer", firstRevision)))
        .status,
    ).toBe(409);
    await verifyApiRecipient(tokens[1], "second@example.invalid");
    const secondPdf = await request(
      `/sign/${tokens[1]}/pdf?revision=${second.revision}`,
    );
    expect(secondPdf.status).toBe(200);
    const secondBytes = Buffer.from(await secondPdf.arrayBuffer());
    expect(await imageCount(secondBytes)).toBe(2);
    await writeFile(".local/qa/serial-second-review.pdf", secondBytes);
    const thirdWaiting = await (await request(`/sign/${tokens[2]}`)).json();
    expect([
      thirdWaiting.signingStatus,
      thirdWaiting.canSign,
      thirdWaiting.waitingForSigners,
    ]).toEqual(["waiting", false, 1]);
    expect(
      (
        await request(
          `/documents/${document.id}/invitations/${invitations[1].id}/revoke`,
          cookieA,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    expect((await request(`/sign/${tokens[1]}`)).status).toBe(404);
    // Revoking the waiting queue's head opens the next turn too.
    const thirdTurn = await waitForTestMail(
      "third@example.invalid",
      "Your turn to sign",
      mailStart,
    );
    expect(thirdTurn.text).toContain(`/sign/${tokens[2]}`);
    const third = await (await request(`/sign/${tokens[2]}`)).json();
    expect([
      third.signingStatus,
      third.canSign,
      third.waitingForSigners,
    ]).toEqual(["ready", true, 0]);
    expect(third.revision).toBe(second.revision + 1);
    expect(
      (await guestPost(tokens[2], consent("Third signer", second.revision)))
        .status,
    ).toBe(409);
    await verifyApiRecipient(tokens[2], "third@example.invalid");
    const thirdPdf = await request(
      `/sign/${tokens[2]}/pdf?revision=${third.revision}`,
    );
    expect(thirdPdf.status).toBe(200);
    const thirdBytes = Buffer.from(await thirdPdf.arrayBuffer());
    expect(await imageCount(thirdBytes)).toBe(2);
    await writeFile(".local/qa/serial-third-review.pdf", thirdBytes);
    const signed = await guestPost(
      tokens[2],
      consent("Third signer", third.revision),
    );
    expect(signed.status, await signed.clone().text()).toBe(200);
    const completed = await (
      await request(`/documents/${document.id}`, cookieA)
    ).json();
    expect(completed.status).toBe("completed");
    const finalList = (
      await (await request(`/documents/${document.id}`, cookieA)).json()
    ).invitations;
    expect(finalList.map((invite: any) => invite.signingStatus)).toEqual([
      "signed",
      "revoked",
      "signed",
    ]);
    await verifyApiRecipient(tokens[2], "third@example.invalid", "record");
    for (let index = 0; index < 100; index++) {
      if (
        (await (await request(`/sign/${tokens[2]}/record`)).json()).state ===
        "ready"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const finalPdf = await request(`/sign/${tokens[2]}/record/pdf`);
    expect(finalPdf.status).toBe(200);
    const finalBytes = Buffer.from(await finalPdf.arrayBuffer());
    expect(await imageCount(finalBytes)).toBe(3);
    await writeFile(".local/qa/serial-completed-review.pdf", finalBytes);
    const proof = JSON.parse(
      execFileSync(process.execPath, ["tests/check_serial_pdf.mjs"], {
        encoding: "utf8",
      }),
    );
    expect(proof.map((page: any) => page.signatures)).toEqual([
      [true, false, false, false],
      [true, true, false, false],
      [true, true, false, false],
      [true, true, false, true],
    ]);
    expect(proof.every((page: any) => page.originalTextPresent)).toBe(true);
    const events = await (
      await request(`/documents/${document.id}/history`, cookieA)
    ).json();
    expect(
      events.filter((event: any) => event.event === "signature_accepted"),
    ).toHaveLength(2);
    expect(
      events
        .filter((event: any) => event.event === "turn_email_sent")
        .map((event: any) => event.details.signingOrder),
    ).toEqual([2, 3]);
  });
  it("keeps a later signer blocked by an expired earlier request until the owner revokes it", async () => {
    const database = new URL(config.DATABASE_URL);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(database.hostname);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await samplePdf(false))], {
        type: "application/pdf",
      }),
      `serial-expiry-${unique}.pdf`,
    );
    const uploaded = await request("/documents", cookieA, "POST", form);
    expect(uploaded.status).toBe(201);
    const document = await uploaded.json();
    const created = await request(
      `/documents/${document.id}/invitations`,
      cookieA,
      "POST",
      {
        revision: document.revision,
        recipients: ["Expired signer", "Waiting signer"].map((name, index) => ({
          name,
          email: `expiry-${index}-${unique}@example.invalid`,
          field: {
            id: randomUUID(),
            pageIndex: 0,
            x: 0.1,
            y: 0.5 + index * 0.2,
            width: 0.25,
            height: 0.08,
          },
        })),
      },
    );
    expect(created.status).toBe(201);
    const invitations = await created.json();
    // Time travel only this newly created fixture; never change the application
    // clock, existing users, or a non-loopback database.
    const client = new Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    try {
      const expired = await client.query(
        "update invitation set expires_at = now() - interval '1 minute' where id = $1 and document_id = $2 and email = $3 and state = 'pending' returning id",
        [invitations[0].id, document.id, `expiry-0-${unique}@example.invalid`],
      );
      expect(expired.rowCount).toBe(1);
    } finally {
      await client.end();
    }
    const tokens = invitations.map((invitation: any) =>
      invitation.url.split("/").pop(),
    );
    const ownerView = await (
      await request(`/documents/${document.id}`, cookieA)
    ).json();
    expect(
      ownerView.invitations.map((invitation: any) => [
        invitation.signingStatus,
        invitation.canSign,
      ]),
    ).toEqual([
      ["expired", false],
      ["waiting", false],
    ]);
    expect((await request(`/sign/${tokens[0]}`)).status).toBe(404);
    const waiting = await (await request(`/sign/${tokens[1]}`)).json();
    expect([waiting.waitingForSigners, waiting.canSign]).toEqual([1, false]);
    expect(
      (await request(`/sign/${tokens[1]}/pdf?revision=${waiting.revision}`))
        .status,
    ).toBe(409);
    expect(
      (
        await request(`/sign/${tokens[1]}`, "", "POST", {
          name: "Waiting signer",
          consent: true,
          revision: waiting.revision,
          png,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/documents/${document.id}/invitations/${invitations[0].id}/revoke`,
          cookieA,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    const ready = await (await request(`/sign/${tokens[1]}`)).json();
    expect([
      ready.signingStatus,
      ready.waitingForSigners,
      ready.canSign,
    ]).toEqual(["ready", 0, true]);
    expect(ready.revision).toBe(waiting.revision + 1);
    await verifyApiRecipient(tokens[1], `expiry-1-${unique}@example.invalid`);
    expect(
      (
        await request(`/sign/${tokens[1]}`, "", "POST", {
          name: "Waiting signer",
          consent: true,
          revision: ready.revision,
          png,
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await request(`/documents/${document.id}`, cookieA)).json())
        .status,
    ).toBe("completed");
  });
  it("serializes an owner revocation racing a signature without advancing the document twice", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await samplePdf(false))], {
        type: "application/pdf",
      }),
      "revoke-sign-race.pdf",
    );
    const uploaded = await request("/documents", cookieA, "POST", form);
    expect(uploaded.status).toBe(201);
    const document = await uploaded.json();
    const created = await request(
      `/documents/${document.id}/invitations`,
      cookieA,
      "POST",
      {
        revision: document.revision,
        recipients: ["Racing signer", "Next signer"].map((name, index) => ({
          name,
          email: `race-${index}-${unique}@example.invalid`,
          field: {
            id: randomUUID(),
            pageIndex: 0,
            x: 0.1,
            y: 0.5 + index * 0.2,
            width: 0.25,
            height: 0.08,
          },
        })),
      },
    );
    expect(created.status).toBe(201);
    const invitations = await created.json();
    const tokens = invitations.map((invitation: any) =>
      invitation.url.split("/").pop(),
    );
    const review = await (await request(`/sign/${tokens[0]}`)).json();
    await verifyApiRecipient(tokens[0], `race-0-${unique}@example.invalid`);
    const [signature, revocation] = await Promise.all([
      guestPost(
        tokens[0],
        {
          name: "Racing signer",
          consent: true,
          revision: review.revision,
          png,
        },
        "127.0.0.4",
      ),
      request(
        `/documents/${document.id}/invitations/${invitations[0].id}/revoke`,
        cookieA,
        "POST",
        {},
      ),
    ]);
    expect(
      [signature.status, revocation.status].filter((status) => status === 200),
    ).toHaveLength(1);
    expect([200, 404, 409]).toContain(signature.status);
    expect([200, 409]).toContain(revocation.status);
    const ownerView = await (
      await request(`/documents/${document.id}`, cookieA)
    ).json();
    expect(ownerView.revision).toBe(review.revision + 1);
    expect(ownerView.status).toBe("awaiting");
    expect(ownerView.invitations[0].state).toBe(
      signature.status === 200 ? "signed" : "revoked",
    );
    expect(ownerView.invitations[1].signingStatus).toBe("ready");
    const next = await (await request(`/sign/${tokens[1]}`)).json();
    expect([next.canSign, next.waitingForSigners, next.revision]).toEqual([
      true,
      0,
      ownerView.revision,
    ]);
    await verifyApiRecipient(tokens[1], `race-1-${unique}@example.invalid`);
    const pdf = await request(
      `/sign/${tokens[1]}/pdf?revision=${next.revision}`,
    );
    expect(pdf.status).toBe(200);
    expect(await imageCount(Buffer.from(await pdf.arrayBuffer()))).toBe(
      signature.status === 200 ? 1 : 0,
    );
    const events = await (
      await request(`/documents/${document.id}/history`, cookieA)
    ).json();
    expect(
      events.filter((event: any) =>
        ["signature_accepted", "invitation_revoked"].includes(event.event),
      ),
    ).toHaveLength(1);
  });
  it("removes white PNG backgrounds for saved and guest signatures without halos, while preserving ink and existing transparency", async () => {
    const opaque = await whiteSignaturePng();
    const createSignature = (name: string, bytes: Buffer) =>
      request("/signatures", cookieA, "POST", {
        name,
        source: "uploaded",
        png: `data:image/png;base64,${bytes.toString("base64")}`,
      });
    const created = await createSignature("White background upload", opaque);
    expect(created.status, await created.clone().text()).toBe(201);
    const signature = await created.json();
    const saved = Buffer.from(
      await (
        await request(`/signatures/${signature.id}/image`, cookieA)
      ).arrayBuffer(),
    );
    await writeFile(".local/qa/white-background-cleaned.png", saved);
    const rgba = await sharp(saved)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = Array.from(
      { length: rgba.info.width * rgba.info.height },
      (_, index) => [...rgba.data.subarray(index * 4, index * 4 + 4)],
    );
    expect(
      pixels.filter(
        ([r, g, b, a]) => r >= 245 && g >= 245 && b >= 245 && a > 0,
      ),
    ).toHaveLength(0);
    expect(
      pixels.filter(
        ([r, g, b, a]) => r === 0 && g === 0 && b === 0 && a === 255,
      ).length,
    ).toBeGreaterThan(200);
    expect(
      pixels.filter(
        ([r, g, b, a]) => r === 0 && g === 64 && b === 192 && a === 255,
      ).length,
    ).toBeGreaterThan(200);
    const blackEdge = pixels.find(
      ([r, g, b, a]) => r === 0 && g === 0 && b === 0 && a > 100 && a < 150,
    );
    expect(blackEdge).toEqual([0, 0, 0, 127]);
    const blueEdge = pixels.find(
      ([r, g, b, a]) =>
        r === 0 && g >= 63 && g <= 65 && b >= 191 && b <= 194 && a === 127,
    )!;
    expect(blueEdge).toBeDefined();
    // Unmatting preserves how the original antialiased edge looked on white.
    for (const [channel, originalValue] of [128, 160, 224].entries())
      expect(
        Math.abs(
          (blueEdge[channel] * blueEdge[3]) / 255 +
            255 -
            blueEdge[3] -
            originalValue,
        ),
      ).toBeLessThanOrEqual(1);
    const centerOffset =
      (Math.floor(rgba.info.height / 2) * rgba.info.width +
        Math.floor(rgba.info.width / 2)) *
      4;
    expect(
      rgba.data[centerOffset + 3],
      "White gap between strokes must be transparent, not merely trimmed",
    ).toBe(0);
    const repeated = await createSignature("Already cleaned upload", saved);
    expect(repeated.status).toBe(201);
    const repeatedSignature = await repeated.json();
    const secondPass = await sharp(
      Buffer.from(
        await (
          await request(`/signatures/${repeatedSignature.id}/image`, cookieA)
        ).arrayBuffer(),
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([secondPass.info.width, secondPass.info.height]).toEqual([
      rgba.info.width,
      rgba.info.height,
    ]);
    expect(secondPass.data.equals(rgba.data)).toBe(true);
    const transparent = await whiteSignaturePng(true);
    const preserved = await createSignature(
      "Already transparent upload",
      transparent,
    );
    expect(preserved.status).toBe(201);
    const preservedSignature = await preserved.json();
    const preservedBytes = Buffer.from(
      await (
        await request(`/signatures/${preservedSignature.id}/image`, cookieA)
      ).arrayBuffer(),
    );
    const histogram = async (bytes: Buffer) => {
      const data = await sharp(bytes).ensureAlpha().raw().toBuffer();
      const counts: Record<string, number> = {};
      for (let offset = 0; offset < data.length; offset += 4) {
        if (!data[offset + 3]) continue;
        const value = [...data.subarray(offset, offset + 4)].join(",");
        counts[value] = (counts[value] ?? 0) + 1;
      }
      return counts;
    };
    expect(await histogram(preservedBytes)).toEqual(
      await histogram(transparent),
    );
    const blank = await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    expect((await createSignature("Blank white upload", blank)).status).toBe(
      400,
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await coloredPdf())], {
        type: "application/pdf",
      }),
      "colored-background.pdf",
    );
    const uploaded = await request("/documents", cookieA, "POST", form);
    expect(uploaded.status).toBe(201);
    const document = await uploaded.json();
    const placed = await request(
      `/documents/${document.id}/placements`,
      cookieA,
      "PUT",
      {
        revision: document.revision,
        placements: [
          {
            id: randomUUID(),
            signatureId: signature.id,
            pageIndex: 0,
            x: 0.1,
            y: 0.2,
            width: 0.4,
            height: 0.15,
          },
        ],
      },
    );
    expect(placed.status).toBe(200);
    const invitations = await request(
      `/documents/${document.id}/invitations`,
      cookieA,
      "POST",
      {
        revision: (await placed.json()).revision,
        recipients: [
          {
            name: "White PNG guest",
            email: `white-${unique}@example.invalid`,
            field: {
              id: randomUUID(),
              pageIndex: 0,
              x: 0.1,
              y: 0.55,
              width: 0.4,
              height: 0.15,
            },
          },
        ],
      },
    );
    expect(invitations.status).toBe(201);
    const token = (await invitations.json())[0].url.split("/").pop();
    const review = await (await request(`/sign/${token}`)).json();
    await verifyApiRecipient(token, `white-${unique}@example.invalid`);
    const signed = await guestPost(
      token,
      {
        name: "White PNG guest",
        consent: true,
        revision: review.revision,
        png: `data:image/png;base64,${opaque.toString("base64")}`,
      },
      "127.0.0.5",
    );
    expect(signed.status, await signed.clone().text()).toBe(200);
    const completed = await (
      await request(`/documents/${document.id}`, cookieA)
    ).json();
    for (const rasterize of [false, true]) {
      const jobId = await readyExport(
        rasterize,
        document.id,
        completed.revision,
      );
      const bytes = Buffer.from(
        await (
          await request(`/exports/${jobId}/download`, cookieA)
        ).arrayBuffer(),
      );
      await writeFile(
        `.local/qa/white-background-${rasterize ? "raster" : "normal"}.pdf`,
        bytes,
      );
    }
    const proof = JSON.parse(
      execFileSync(process.execPath, ["tests/check_white_pdf.mjs"], {
        encoding: "utf8",
      }),
    );
    for (const documentProof of proof) {
      expect(documentProof.regions).toHaveLength(2);
      for (const region of documentProof.regions) {
        expect(region.whiteHaloPixels).toBe(0);
        expect(region.backgroundPixels).toBeGreaterThan(1000);
        expect(region.blackInkPixels).toBeGreaterThan(500);
        expect(region.blueInkPixels).toBeGreaterThan(500);
      }
    }
    expect(
      proof.map((documentProof: any) => documentProof.textLength > 0),
    ).toEqual([true, false]);
  });
});
