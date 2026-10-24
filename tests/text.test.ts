import { verifyFixtureEmail } from "./helpers/account-security.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localFetch, setLocalClientAddress } from "./helpers/local-http.js";
let clientIndex = 1;
setLocalClientAddress("127.0.12.1");
beforeEach(() => setLocalClientAddress(`127.0.12.${++clientIndex}`));
import { ownerInvitationBody } from "./helpers/owner-signing.js";
import { assertTestMail } from "./helpers/test-mail.js";
import {
  recipientBody,
  recipientCookies,
  verifyApiRecipient,
} from "./helpers/signer-verification.js";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { samplePdf, signaturePng } from "./fixtures";

// These integration tests deliberately use the disposable local instance only.
const base = "http://127.0.0.1:3176";
const run = randomUUID();
let owner = "",
  outsider = "",
  document: any,
  placements: any[],
  png = "";

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
  return localFetch(`${base}/api${path}`, {
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
  const email = `text-${label}-${run}@example.invalid`;
  const secret = `Text-test-${randomUUID()}!`;
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
async function sign(token: string, body: unknown, localAddress = "127.0.0.7") {
  // A real loopback source address isolates this suite's guest rate-limit bucket.
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
async function exportPdf(rasterize: boolean, name: string) {
  const queued = await request(
    `/documents/${document.id}/exports`,
    owner,
    "POST",
    {
      rasterize,
      revision: document.revision,
    },
  );
  expect(queued.status, await queued.clone().text()).toBe(202);
  const job = await queued.json();
  for (let attempt = 0; attempt < 150; attempt++) {
    const status = await (await request(`/exports/${job.id}`, owner)).json();
    if (status.state === "failed") throw new Error(status.error);
    if (status.state === "ready") {
      const response = await request(`/exports/${job.id}/download`, owner);
      expect(response.status).toBe(200);
      const path = `.local/qa/text-${name}.pdf`;
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      return path;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Export did not finish in time");
}
async function readDocument() {
  const response = await request(`/documents/${document.id}`, owner);
  expect(response.status).toBe(200);
  document = await response.json();
  return document;
}
function inspectPdf(...paths: string[]) {
  return JSON.parse(
    execFileSync(process.execPath, ["tests/check_text_pdf.mjs", ...paths], {
      encoding: "utf8",
    }),
  );
}

describe("Text on documents and required recipient fields", () => {
  beforeAll(async () => {
    await assertTestMail(base);
    owner = await register("owner");
    outsider = await register("outsider");
    await mkdir(".local/qa", { recursive: true });
    const original = await samplePdf();
    await writeFile(".local/qa/text-original.pdf", original);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(original)], { type: "application/pdf" }),
      "Text signing agreement.pdf",
    );
    const uploaded = await request("/documents", owner, "POST", form);
    expect(uploaded.status).toBe(201);
    document = await uploaded.json();
    png = `data:image/png;base64,${(await signaturePng()).toString("base64")}`;
    placements = document.pages.map((_: any, pageIndex: number) => ({
      kind: "text",
      id: randomUUID(),
      pageIndex,
      x: 0.1,
      y: 0.12,
      width: 0.72,
      height: 0.055,
      text: `Tromsø / 21.10.2026 — æøå ${pageIndex + 1}`,
      fontSize: 14,
    }));
    // Tight fit exposes differences between PDF glyph advances and browser
    // kerning, and includes uppercase æ, ø and å near the box edge.
    placements.push({
      kind: "text",
      id: randomUUID(),
      pageIndex: 3,
      x: 0.1,
      y: 0.3,
      width: 0.28,
      height: 0.035,
      text: "AVAVAV To To WA WA ÅÆØ",
      fontSize: 36,
    });
  });

  it("saves and reloads owner text while enforcing ownership, revision and text limits", async () => {
    const path = `/documents/${document.id}/placements`;
    expect(
      (
        await request(path, outsider, "PUT", {
          revision: document.revision,
          placements,
        })
      ).status,
    ).toBe(404);
    const saved = await request(path, owner, "PUT", {
      revision: document.revision,
      placements,
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const initialRevision = document.revision;
    await readDocument();
    expect(document.revision).toBe(initialRevision + 1);
    expect(document.placements).toEqual(placements);
    expect(
      (
        await request(path, owner, "PUT", {
          revision: initialRevision,
          placements: [],
        })
      ).status,
    ).toBe(409);
    for (const invalid of [
      { text: "" },
      { text: "Two\nlines" },
      { text: "Unsupported 🖋" },
      { text: "Hidden\u00ad hyphen" },
      { text: "a".repeat(201) },
      { fontSize: 5 },
      { fontSize: 37 },
      { width: 0.01, height: 0.002, text: "Text does not fit" },
    ]) {
      const response = await request(path, owner, "PUT", {
        revision: document.revision,
        placements: [{ ...placements[0], ...invalid }],
      });
      expect(
        response.status,
        JSON.stringify(invalid) + (await response.clone().text()),
      ).toBe(400);
    }
    await readDocument();
    expect(document.placements).toEqual(placements);
    expect(document.revision).toBe(initialRevision + 1);
  });

  it("prints text with æ, ø and å at the selected position on rotated/cropped pages and raster downloads", async () => {
    const normal = await exportPdf(false, "owner-normal"),
      raster = await exportPdf(true, "owner-raster");
    await writeFile(
      ".local/qa/text-owner-manifest.json",
      JSON.stringify(placements),
    );
    const proof = inspectPdf(
      normal,
      raster,
      ".local/qa/text-original.pdf",
      ".local/qa/text-owner-manifest.json",
    );
    expect(proof.pages).toBe(4);
    expect(proof.rasterTextLength).toBe(0);
    expect(proof.changedPixelsOutsideFields).toBeLessThanOrEqual(12);
    for (const field of proof.fields) {
      expect(field.extracted).toBe(true);
      expect(field.changedPixels).toBeGreaterThan(30);
      expect(field.rasterInkPixels).toBeGreaterThan(30);
      expect(field.meanRasterDifference).toBeLessThan(30);
    }
    await writeFile(
      ".local/qa/text-owner-pdf-proof.json",
      JSON.stringify(proof, null, 2),
    );
  });

  it("requires only the assigned text fields, freezes accepted text and carries it through serial signing", async () => {
    const fieldId = randomUUID();
    const recipients = [
      {
        name: "Maya Text",
        email: `maya-${run}@example.invalid`,
        field: {
          id: randomUUID(),
          pageIndex: 0,
          x: 0.1,
          y: 0.68,
          width: 0.3,
          height: 0.08,
        },
        textFields: [
          {
            id: fieldId,
            label: "Place / date",
            pageIndex: 0,
            x: 0.1,
            y: 0.79,
            width: 0.7,
            height: 0.05,
            fontSize: 12,
          },
        ],
      },
      // Deliberately omit textFields to preserve the pre-text invitation contract.
      {
        name: "Jordan Legacy",
        email: `jordan-${run}@example.invalid`,
        field: {
          id: randomUUID(),
          pageIndex: 0,
          x: 0.5,
          y: 0.68,
          width: 0.3,
          height: 0.08,
        },
      },
    ];
    const invited = await request(
      `/documents/${document.id}/invitations`,
      owner,
      "POST",
      {
        revision: document.revision,
        recipients,
      },
    );
    expect(invited.status, await invited.clone().text()).toBe(201);
    const invitations = await invited.json();
    const tokens = invitations.map((invite: any) =>
      invite.url.split("/").pop(),
    );
    const first = await (await request(`/sign/${tokens[0]}`)).json();
    const waiting = await (await request(`/sign/${tokens[1]}`)).json();
    expect(first.textFields).toEqual(recipients[0].textFields);
    expect(waiting.canSign).toBe(false);
    expect(waiting.textFields ?? []).toEqual([]);
    expect(JSON.stringify(waiting)).not.toContain(fieldId);
    const validText = [{ id: fieldId, text: "London / 21.10.2026" }];
    await verifyApiRecipient(tokens[0], recipients[0].email);
    const consent = {
      name: "Maya Text",
      consent: true,
      revision: first.revision,
      png,
    };
    for (const values of [
      undefined,
      [],
      [{ id: fieldId, text: " " }],
      [{ id: randomUUID(), text: "Wrong field" }],
      [...validText, ...validText],
      [{ id: fieldId, text: "Unsupported 🖋" }],
    ]) {
      const response = await sign(tokens[0], {
        ...consent,
        ...(values ? { textValues: values } : {}),
      });
      expect(response.status, await response.clone().text()).toBe(400);
    }
    expect(
      (
        await sign(tokens[1], {
          ...consent,
          name: "Jordan Legacy",
          textValues: validText,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await sign(tokens[0], {
          ...consent,
          revision: first.revision - 1,
          textValues: validText,
        })
      ).status,
    ).toBe(409);
    const signed = await sign(tokens[0], { ...consent, textValues: validText });
    expect(signed.status, await signed.clone().text()).toBe(200);
    expect(
      (
        await sign(tokens[0], {
          ...consent,
          textValues: [{ id: fieldId, text: "Overwritten" }],
        })
      ).status,
    ).toBe(409);
    const second = await (await request(`/sign/${tokens[1]}`)).json();
    expect(second.canSign).toBe(true);
    expect(second.textFields ?? []).toEqual([]);
    await verifyApiRecipient(tokens[1], recipients[1].email);
    const review = await request(
      `/sign/${tokens[1]}/pdf?revision=${second.revision}`,
    );
    expect(review.status).toBe(200);
    await writeFile(
      ".local/qa/text-second-review.pdf",
      Buffer.from(await review.arrayBuffer()),
    );
    const reviewProof = inspectPdf(".local/qa/text-second-review.pdf");
    expect(reviewProof.text).toContain(validText[0].text);
    expect(reviewProof.text).toContain(placements[0].text);
    expect(reviewProof.text).not.toContain("Overwritten");
    // The old guest POST shape must still work for a signer without text fields.
    const completed = await sign(
      tokens[1],
      { name: "Jordan Legacy", consent: true, revision: second.revision, png },
      "127.0.0.8",
    );
    expect(completed.status, await completed.clone().text()).toBe(200);
    await readDocument();
    expect(document.status).toBe("completed");
    const normal = await exportPdf(false, "completed-normal"),
      raster = await exportPdf(true, "completed-raster");
    const finalFields = [
      ...placements,
      { ...recipients[0].textFields![0], text: validText[0].text },
    ];
    await writeFile(
      ".local/qa/text-completed-manifest.json",
      JSON.stringify(finalFields),
    );
    const proof = inspectPdf(
      normal,
      raster,
      ".local/qa/text-original.pdf",
      ".local/qa/text-completed-manifest.json",
    );
    expect(
      proof.fields.every(
        (field: any) =>
          field.extracted &&
          field.changedPixels > 30 &&
          field.rasterInkPixels > 30,
      ),
    ).toBe(true);
    expect(proof.rasterTextLength).toBe(0);
    await writeFile(
      ".local/qa/text-completed-pdf-proof.json",
      JSON.stringify(proof, null, 2),
    );
  });
});
