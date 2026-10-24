import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "pg";
import { config } from "../server/config";
import { SIGNING_CONSENT } from "../shared/signing-consent";
import { samplePdf, signaturePng } from "./fixtures";
import { verifyFixtureEmail, fixtureTotp } from "./helpers/account-security.js";
import { verifyApiRecipient } from "./helpers/signer-verification.js";
import { assertTestMail, waitForTestMail } from "./helpers/test-mail.js";
// @ts-expect-error The command-line client is plain JavaScript.
import { closePdf, findAll, loadLayout, openPdf } from "../client/anchors.mjs";
// @ts-expect-error The MCP server is plain JavaScript.
import { createPaperSignServer } from "../client/mcp-server.mjs";

const runFile = promisify(execFile);

// Fixed to the disposable local instance. Only the synthetic accounts created
// below are promoted, and they are demoted again afterwards.
const base = "http://127.0.0.1:3176";
const run = randomUUID();
const prefix = `apikey-qa-${run}-`;
const password = `ApiKey-QA-${randomUUID()}!`;
const database = new Client({ connectionString: config.DATABASE_URL });
const fixtureIds = new Set<string>();
const sourceSubnet = `127.${parseInt(run.slice(0, 2), 16)}.${parseInt(run.slice(2, 4), 16)}`;
const localSources = new Map<string, string>();
type Account = { id: string; email: string; cookie: string };
let admin: Account, ordinary: Account;
let emailEnabled = false;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// Browser-style request: same-origin headers and a session cookie.
function request(path: string, cookie = "", method = "GET", body?: unknown) {
  if (body instanceof FormData)
    return fetch(`${base}/api${path}`, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { Origin: base, "X-PaperSign": "1", Cookie: cookie },
      body,
    });
  const sourceKey = path.startsWith("/auth/")
    ? String((body as { email?: string })?.email ?? cookie)
    : cookie || path;
  if (!localSources.has(sourceKey))
    localSources.set(sourceKey, `${sourceSubnet}.${20 + localSources.size}`);
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api${path}`,
      {
        method,
        localAddress: localSources.get(sourceKey),
        timeout: 15000,
        headers: {
          Origin: base,
          "X-PaperSign": "1",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            for (const item of value) headers.append(key, item);
          else if (value !== undefined) headers.set(key, value);
        }
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve(
            new Response(
              response.statusCode === 204 ? null : Buffer.concat(chunks),
              { status: response.statusCode!, headers },
            ),
          ),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request stalled")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
// Program-style request: only the bearer key, no Origin or X-PaperSign.
function keyRequest(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const multipart = body instanceof FormData;
  return fetch(`${base}/api${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${key}`,
      ...(!multipart && body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    body: multipart
      ? body
      : body === undefined
        ? undefined
        : JSON.stringify(body),
  });
}
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
async function register(label: string): Promise<Account> {
  const email = `${prefix}${label}@example.invalid`;
  const response = await request("/auth/sign-up/email", "", "POST", {
    name: `API key QA ${label}`,
    email,
    password,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const { user } = await response.json();
  fixtureIds.add(user.id);
  await verifyFixtureEmail(user.id, email);
  const signedIn = await request("/auth/sign-in/email", "", "POST", {
    email,
    password,
  });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  let cookie = cookies(signedIn);
  const setup = await request("/auth/two-factor/enable", cookie, "POST", {
    password,
    method: "totp",
  });
  expect(setup.status, await setup.clone().text()).toBe(200);
  const confirmed = await request(
    "/auth/two-factor/verify-totp",
    cookie,
    "POST",
    { code: fixtureTotp((await setup.json()).totpURI) },
  );
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  cookie = cookies(confirmed) || cookie;
  return { id: user.id, email, cookie };
}
async function createKey(name: string, lifetimeDays?: number) {
  const response = await request("/admin/api-keys", admin.cookie, "POST", {
    name,
    ...(lifetimeDays ? { lifetimeDays } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as {
    key: { id: string; prefix: string; expiresAt: string; state: string };
    secret: string;
  };
}
async function upload(key: string, name = "API key QA agreement.pdf") {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(await samplePdf(false))], {
      type: "application/pdf",
    }),
    name,
  );
  const response = await keyRequest("/documents", key, "POST", form);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}
// A one-page document with two signature blocks that share a repeated label.
async function minutesPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("QA board minutes", { x: 60, y: 760, size: 16, font });
  page.drawText("Ada QA, Chair", { x: 60, y: 300, size: 11, font });
  page.drawText("Place and date:", { x: 60, y: 282, size: 11, font });
  page.drawText("Bo QA, Member", { x: 320, y: 300, size: 11, font });
  page.drawText("Place and date:", { x: 320, y: 282, size: 11, font });
  return doc.save();
}
function minutesSigners(label: string) {
  return [
    { name: "Ada QA", anchor: "Ada QA, Chair" },
    { name: "Bo QA", anchor: "Bo QA, Member" },
  ].map((signer, index) => ({
    name: signer.name,
    email: `${prefix}${label}-${index + 1}@example.invalid`,
    signature: { anchor: signer.anchor },
    text: [
      {
        label: "Place and date",
        anchor: "Place and date:",
        near: signer.anchor,
      },
    ],
  }));
}
const field = (pageIndex = 0, y = 0.7) => ({
  id: randomUUID(),
  pageIndex,
  x: 0.12,
  y,
  width: 0.3,
  height: 0.06,
});

describe("Admin API keys", () => {
  beforeAll(async () => {
    expect(["127.0.0.1", "localhost"]).toContain(
      new URL(config.DATABASE_URL).hostname,
    );
    await assertTestMail(base);
    emailEnabled = (await (await request("/config")).json()).emailEnabled;
    await database.connect();
    admin = await register("admin");
    ordinary = await register("ordinary");
    const promoted = await database.query(
      'update "user" set role = $1 where id = $2 and email like $3 returning id',
      ["admin", admin.id, `${prefix}%@example.invalid`],
    );
    expect(promoted.rowCount).toBe(1);
  });

  afterAll(async () => {
    try {
      if (fixtureIds.size)
        await database.query(
          'update "user" set role = $1 where id = any($2::text[]) and email like $3',
          ["user", [...fixtureIds], `${prefix}%@example.invalid`],
        );
    } finally {
      await database.end();
    }
  });

  it("lets only an Admin create, list and revoke keys, and stores only a hash", async () => {
    const body = { name: "Denied" };
    expect((await request("/admin/api-keys", "", "POST", body)).status).toBe(
      401,
    );
    expect(
      (await request("/admin/api-keys", ordinary.cookie, "POST", body)).status,
    ).toBe(403);
    expect((await request("/admin/api-keys", ordinary.cookie)).status).toBe(
      403,
    );
    expect(
      (
        await request("/admin/api-keys", admin.cookie, "POST", {
          name: "Odd lifetime",
          lifetimeDays: 45,
        })
      ).status,
    ).toBe(400);

    const created = await createKey("QA listing key", 30);
    expect(created.secret).toMatch(/^psk_[A-Za-z0-9_-]{43}$/);
    expect(created.key.prefix).toBe(created.secret.slice(0, 12));
    expect(created.key.state).toBe("active");
    const days = (Date.parse(created.key.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const listed = await request(
      `/admin/api-keys?search=${encodeURIComponent("QA listing key")}`,
      admin.cookie,
    );
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(created.secret);
    expect(text).not.toContain(sha256(created.secret));
    const page = JSON.parse(text);
    expect(page.items[0]).toMatchObject({
      id: created.key.id,
      owner: { id: admin.id, email: admin.email },
      state: "active",
      lastUsedAt: null,
    });

    const row = await database.query("select * from api_key where id = $1", [
      created.key.id,
    ]);
    expect(row.rows[0].key_hash).toBe(sha256(created.secret));
    expect(JSON.stringify(row.rows[0])).not.toContain(created.secret);
    expect(
      (
        await database.query(
          "select count(*)::int count from admin_event where event = $1 and target_id = $2",
          ["api_key_created", created.key.id],
        )
      ).rows[0].count,
    ).toBe(1);

    const revoked = await request(
      `/admin/api-keys/${created.key.id}/revoke`,
      admin.cookie,
      "POST",
      {},
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(
      (
        await request(
          `/admin/api-keys/${created.key.id}/revoke`,
          admin.cookie,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
    expect((await keyRequest("/documents", created.secret)).status).toBe(401);
  });

  it("prepares a signing request with a key and no browser headers", async () => {
    const { secret, key } = await createKey("QA workflow key");
    const document = await upload(secret);

    const signatureOnPage = await keyRequest(
      `/documents/${document.id}/placements`,
      secret,
      "PUT",
      {
        revision: document.revision,
        placements: [{ ...field(), signatureId: randomUUID() }],
      },
    );
    expect(signatureOnPage.status).toBe(403);

    const placed = await keyRequest(
      `/documents/${document.id}/placements`,
      secret,
      "PUT",
      {
        revision: document.revision,
        placements: [
          { ...field(0, 0.2), kind: "text", text: "London", fontSize: 11 },
        ],
      },
    );
    expect(placed.status, await placed.clone().text()).toBe(200);
    const { revision } = await placed.json();

    const signers = ["first", "second"].map((label, index) => ({
      name: `QA signer ${label}`,
      email: `${prefix}${label}-signer@example.invalid`,
      field: field(0, 0.5 + index * 0.15),
      textFields: [
        {
          ...field(0, 0.58 + index * 0.15),
          height: 0.03,
          label: "Place and date",
          fontSize: 10,
        },
      ],
    }));
    const invited = await keyRequest(
      `/documents/${document.id}/invitations`,
      secret,
      "POST",
      { revision, termsLocked: true, recipients: signers },
    );
    expect(invited.status, await invited.clone().text()).toBe(201);
    const links = await invited.json();
    expect(links.map((link: { email: string }) => link.email)).toEqual(
      signers.map((signer) => signer.email),
    );
    expect(links[0].url).toMatch(/\/sign\/[A-Za-z0-9_-]{43}$/);
    expect(links[0].canSign).toBe(true);
    expect(links[1].signingStatus).toBe("waiting");

    const current = await (
      await keyRequest(`/documents/${document.id}`, secret)
    ).json();
    expect(current.status).toBe("awaiting");
    expect(current.invitations).toHaveLength(2);

    const preview = await keyRequest(
      `/documents/${document.id}/invitations/${links[0].id}/email`,
      secret,
    );
    expect(preview.status).toBe(200);
    const email = await preview.json();
    expect(email.to).toBe(signers[0].email);
    if (emailEnabled) {
      const before = Date.now();
      const sent = await keyRequest(
        `/documents/${document.id}/invitations/${links[0].id}/email`,
        secret,
        "POST",
        { previewHash: email.previewHash },
      );
      expect(sent.status, await sent.clone().text()).toBe(200);
      const mail = await waitForTestMail(signers[0].email, "", before);
      expect(mail.text).toContain(links[0].url);
    }

    expect(
      (
        await (
          await keyRequest(`/documents/${document.id}/record`, secret)
        ).json()
      ).state,
    ).toBe("unavailable");
    const history = await (
      await keyRequest(`/documents/${document.id}/history`, secret)
    ).json();
    expect(history.map((event: { event: string }) => event.event)).toContain(
      "invitations_created",
    );

    const used = await database.query(
      "select last_used_at from api_key where id = $1",
      [key.id],
    );
    expect(used.rows[0].last_used_at).not.toBeNull();
    const requests = await database.query(
      "select details from admin_event where event = $1 and target_id = $2",
      ["api_key_request", key.id],
    );
    const logged = requests.rows.map(
      (row) =>
        `${row.details.method} ${row.details.route} ${row.details.status}`,
    );
    expect(logged).toContain("POST /api/documents 201");
    expect(logged).toContain("PUT /api/documents/:id/placements 403");
    expect(logged).toContain("POST /api/documents/:id/invitations 201");
    expect(logged.some((entry) => entry.startsWith("GET"))).toBe(false);
  });

  it("refuses every route outside the key's scope and ignores session cookies", async () => {
    const { secret } = await createKey("QA scope key");
    const own = await upload(secret);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await samplePdf(false))], {
        type: "application/pdf",
      }),
      "Ordinary QA private.pdf",
    );
    const others = await request("/documents", ordinary.cookie, "POST", form);
    expect(others.status).toBe(201);
    const foreign = await others.json();

    const refused: Array<[string, string, unknown?]> = [
      ["/admin/summary", "GET"],
      ["/admin/api-keys", "GET"],
      ["/admin/api-keys", "POST", { name: "Key-made key" }],
      ["/admin/documents", "GET"],
      ["/signatures", "GET"],
      ["/account/security", "GET"],
      ["/account/storage", "GET"],
      ["/auth/get-session", "GET"],
      ["/me", "GET"],
      [`/documents/${own.id}/review`, "POST", { revision: own.revision }],
      [`/documents/${own.id}/finalize`, "POST", {}],
      [
        `/documents/${own.id}/exports`,
        "POST",
        { rasterize: false, revision: 1 },
      ],
      ["/no-such-route", "GET"],
    ];
    for (const [path, method, body] of refused)
      expect(
        (await keyRequest(path, secret, method, body)).status,
        `${method} ${path}`,
      ).toBe(403);

    expect((await keyRequest(`/documents/${foreign.id}`, secret)).status).toBe(
      404,
    );
    expect(
      (await keyRequest(`/documents/${foreign.id}/pdf`, secret)).status,
    ).toBe(404);

    // The key decides who is acting; another account's cookie changes nothing.
    const mixed = await keyRequest("/documents", secret, "GET", undefined, {
      Cookie: ordinary.cookie,
    });
    expect(mixed.status).toBe(200);
    const ids = (await mixed.json()).map((doc: { id: string }) => doc.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
  });

  it("never completes the owner's own signature", async () => {
    const { secret } = await createKey("QA owner signature key");
    const document = await upload(secret);
    const png = `data:image/png;base64,${(await signaturePng()).toString("base64")}`;
    const saved = await request("/signatures", admin.cookie, "POST", {
      name: "QA owner signature",
      source: "drawn",
      png,
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const signature = await saved.json();
    const placed = await request(
      `/documents/${document.id}/placements`,
      admin.cookie,
      "PUT",
      {
        revision: document.revision,
        placements: [{ ...field(0, 0.3), signatureId: signature.id }],
      },
    );
    expect(placed.status, await placed.clone().text()).toBe(200);
    const { revision } = await placed.json();
    const invited = await keyRequest(
      `/documents/${document.id}/invitations`,
      secret,
      "POST",
      {
        revision,
        termsLocked: true,
        ownerReviewId: randomUUID(),
        ownerConsentVersion: "any",
        recipients: [
          {
            name: "QA signer",
            email: `${prefix}owner-check@example.invalid`,
            field: field(0, 0.6),
          },
        ],
      },
    );
    expect(invited.status).toBe(403);
    expect((await invited.json()).message).toMatch(/your signature/i);
  });

  it("stops malformed, revoked, expired and orphaned keys", async () => {
    for (const header of [
      "Bearer nope",
      "Basic dXNlcjpwYXNz",
      `Bearer psk_${"x".repeat(43)}`,
    ]) {
      const response = await fetch(`${base}/api/documents`, {
        headers: { Authorization: header },
      });
      expect(response.status, header).toBe(401);
    }

    const expiring = await createKey("QA expired key");
    expect((await keyRequest("/documents", expiring.secret)).status).toBe(200);
    await database.query(
      "update api_key set expires_at = now() - interval '1 second' where id = $1",
      [expiring.key.id],
    );
    expect((await keyRequest("/documents", expiring.secret)).status).toBe(401);

    const demoted = await createKey("QA demoted owner key");
    await database.query(
      'update "user" set role = $1 where id = $2 and email like $3',
      ["user", admin.id, `${prefix}%@example.invalid`],
    );
    try {
      expect((await keyRequest("/documents", demoted.secret)).status).toBe(401);
    } finally {
      await database.query(
        'update "user" set role = $1 where id = $2 and email like $3',
        ["admin", admin.id, `${prefix}%@example.invalid`],
      );
    }
    expect((await keyRequest("/documents", demoted.secret)).status).toBe(200);
  });

  it("runs the command-line client end to end: create, email, sign and download", async () => {
    const { secret } = await createKey("QA command-line key");
    const folder = await mkdtemp(join(tmpdir(), "papersign-cli-"));
    try {
      await writeFile(join(folder, "minutes.pdf"), await minutesPdf());
      const signers = minutesSigners("cli");
      await writeFile(
        join(folder, "spec.json"),
        JSON.stringify({ pdf: "minutes.pdf", signers }),
      );
      const cli = (...args: string[]) =>
        runFile(process.execPath, ["client/papersign.mjs", ...args], {
          env: {
            PATH: process.env.PATH,
            PAPERSIGN_URL: base,
            PAPERSIGN_API_KEY: secret,
          },
          timeout: 60_000,
        });

      const created = await cli(
        "create",
        join(folder, "spec.json"),
        "--out",
        join(folder, "plan"),
      );
      const documentId = created.stdout.match(/Document: ([0-9a-f-]{36})/)?.[1];
      expect(documentId, created.stdout).toBeTruthy();
      expect(created.stdout).toContain("No email was sent");
      expect(created.stdout).toMatch(/1\. Ada QA .*: ready/);
      expect(created.stdout).toMatch(/2\. Bo QA .*: waiting/);
      const preview = await readFile(join(folder, "plan", "page-1.png"));
      expect(preview.subarray(1, 4).toString()).toBe("PNG");

      const dry = await cli("email", documentId!, "--dry-run");
      expect(dry.stdout.match(/Would send to/g)).toHaveLength(2);
      if (emailEnabled) {
        const before = Date.now();
        const sent = await cli(
          "email",
          documentId!,
          "--signer",
          signers[0].email,
        );
        expect(sent.stdout).toContain(`Sent to ${signers[0].email}`);
        expect(sent.stdout).not.toContain(signers[1].email);
        await waitForTestMail(signers[0].email, "invited you to sign", before);
      }

      const png = `data:image/png;base64,${(await signaturePng()).toString("base64")}`;
      const document = await (
        await keyRequest(`/documents/${documentId}`, secret)
      ).json();
      for (const [index, invitation] of document.invitations.entries()) {
        const token = new URL(invitation.url).pathname.split("/").pop()!;
        const { cookie, reviewId } = await verifyApiRecipient(
          token,
          invitation.email,
        );
        const details = await (
          await fetch(`${base}/api/sign/${token}`, {
            headers: { Cookie: cookie },
          })
        ).json();
        const signed = await fetch(`${base}/api/sign/${token}`, {
          method: "POST",
          headers: {
            Origin: base,
            "X-PaperSign": "1",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({
            name: signers[index].name,
            consent: true,
            consentVersion: SIGNING_CONSENT.version,
            reviewId,
            revision: details.revision,
            png,
            textValues: [
              {
                id: invitation.textFields[0].id,
                text: `London, 2${index}.10.2026`,
              },
            ],
          }),
        });
        expect(signed.status, await signed.clone().text()).toBe(200);
      }

      const deadline = Date.now() + 30_000;
      let record = { state: "queued" };
      while (record.state !== "ready" && Date.now() < deadline) {
        record = await (
          await keyRequest(`/documents/${documentId}/record`, secret)
        ).json();
        if (record.state !== "ready")
          await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(record.state).toBe("ready");
      const status = await cli("status", documentId!);
      expect(status.stdout).toMatch(/: completed/);
      expect(status.stdout.match(/: signed, signed /g)).toHaveLength(2);

      const out = join(folder, "signed.pdf"),
        evidence = join(folder, "evidence.tar");
      await cli("download", documentId!, out, "--evidence", evidence);
      const signedPdf = await readFile(out);
      expect(signedPdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect((await readFile(evidence)).length).toBeGreaterThan(1024);
      // Each signer's place and date sits to the right of their own label.
      const pdf = await openPdf(signedPdf);
      try {
        const layout = await loadLayout(pdf);
        const labels = findAll(layout, "Place and date:");
        for (const [index, text] of [
          "London, 20.10.2026",
          "London, 21.10.2026",
        ].entries()) {
          const [value] = findAll(layout, text);
          expect(value, text).toBeTruthy();
          expect(value.box.left).toBeGreaterThan(labels[index].box.right);
          expect(Math.abs(value.box.top - labels[index].box.top)).toBeLessThan(
            8,
          );
        }
      } finally {
        await closePdf(pdf);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("serves the workflow over MCP: plan with previews, create, preview, send and cancel", async () => {
    const { secret } = await createKey("QA MCP key");
    const folder = await mkdtemp(join(tmpdir(), "papersign-mcp-"));
    const mcp = new McpClient({ name: "papersign-qa", version: "1.0.0" });
    try {
      const pdf = join(folder, "minutes.pdf");
      await writeFile(pdf, await minutesPdf());
      const signers = minutesSigners("mcp");
      const server = createPaperSignServer({ baseUrl: base, key: secret });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await mcp.connect(clientSide);
      const textOf = (result: { content: unknown }) =>
        (result.content as Array<{ type: string; text?: string }>)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

      const tools = Object.fromEntries(
        (await mcp.listTools()).tools.map((tool) => [tool.name, tool]),
      );
      expect(Object.keys(tools).sort()).toEqual([
        "papersign_cancel",
        "papersign_create",
        "papersign_download",
        "papersign_list_documents",
        "papersign_plan",
        "papersign_preview_emails",
        "papersign_reissue",
        "papersign_send_emails",
        "papersign_status",
      ]);
      expect(tools.papersign_plan.annotations?.readOnlyHint).toBe(true);
      expect(tools.papersign_send_emails.annotations).toMatchObject({
        readOnlyHint: false,
        openWorldHint: true,
      });
      expect(tools.papersign_cancel.annotations?.destructiveHint).toBe(true);

      const relative = await mcp.callTool({
        name: "papersign_plan",
        arguments: { pdf: "minutes.pdf", signers },
      });
      expect(relative.isError).toBe(true);
      const unplanned = await mcp.callTool({
        name: "papersign_create",
        arguments: { plan_id: randomUUID() },
      });
      expect(unplanned.isError).toBe(true);

      const planned = await mcp.callTool({
        name: "papersign_plan",
        arguments: { pdf, signers },
      });
      expect(planned.isError, textOf(planned)).toBeFalsy();
      const planId = textOf(planned).match(/plan_id: ([0-9a-f-]{36})/)?.[1];
      expect(planId).toBeTruthy();
      expect(textOf(planned)).toContain("2. Bo QA: Place and date");
      const images = (
        planned.content as Array<{
          type: string;
          mimeType?: string;
          data?: string;
        }>
      ).filter((part) => part.type === "image");
      expect(images).toHaveLength(1);
      expect(images[0].mimeType).toBe("image/png");
      expect(
        Buffer.from(images[0].data!, "base64").subarray(1, 4).toString(),
      ).toBe("PNG");

      const created = await mcp.callTool({
        name: "papersign_create",
        arguments: { plan_id: planId },
      });
      expect(created.isError, textOf(created)).toBeFalsy();
      const documentId = textOf(created).match(
        /document_id: ([0-9a-f-]{36})/,
      )?.[1];
      expect(textOf(created)).toContain("No email was sent.");
      // A plan is used once, so a retry cannot create a duplicate request.
      expect(
        (
          await mcp.callTool({
            name: "papersign_create",
            arguments: { plan_id: planId },
          })
        ).isError,
      ).toBe(true);

      const status = textOf(
        await mcp.callTool({
          name: "papersign_status",
          arguments: { document_id: documentId },
        }),
      );
      expect(status).toMatch(/: awaiting/);
      expect(status).toMatch(/1\. Ada QA .*: ready/);
      expect(status).not.toContain("/sign/");

      const previews = textOf(
        await mcp.callTool({
          name: "papersign_preview_emails",
          arguments: { document_id: documentId },
        }),
      );
      expect(previews.match(/^To: /gm)).toHaveLength(2);
      if (emailEnabled) {
        const before = Date.now();
        const sent = await mcp.callTool({
          name: "papersign_send_emails",
          arguments: { document_id: documentId, signers: [signers[1].email] },
        });
        expect(textOf(sent)).toBe(
          `Sent to ${signers[1].email}: API key QA admin invited you to sign minutes.pdf`,
        );
        await waitForTestMail(signers[1].email, "invited you to sign", before);
      }

      const listed = textOf(
        await mcp.callTool({ name: "papersign_list_documents", arguments: {} }),
      );
      expect(listed).toContain(documentId);
      const cancelled = await mcp.callTool({
        name: "papersign_cancel",
        arguments: { document_id: documentId, reason: "QA cancellation" },
      });
      expect(textOf(cancelled)).toContain("Cancelled");
      expect(
        textOf(
          await mcp.callTool({
            name: "papersign_status",
            arguments: { document_id: documentId },
          }),
        ),
      ).toMatch(/: cancelled/);
    } finally {
      await mcp.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("limits each Admin to ten active keys", async () => {
    const active = await database.query(
      "select count(*)::int count from api_key where user_id = $1 and revoked_at is null and expires_at > now()",
      [admin.id],
    );
    for (let index = active.rows[0].count; index < 10; index++)
      await database.query(
        "insert into api_key (id, name, user_id, prefix, key_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '1 day')",
        [
          randomUUID(),
          `QA filler ${index}`,
          admin.id,
          "psk_filler00",
          sha256(randomUUID()),
        ],
      );
    const response = await request("/admin/api-keys", admin.cookie, "POST", {
      name: "One too many",
    });
    expect(response.status).toBe(409);
  });
});
