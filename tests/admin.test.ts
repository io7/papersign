import { assertTestMail } from "./helpers/test-mail.js";
import { verifyFixtureEmail, fixtureTotp } from "./helpers/account-security.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { config } from "../server/config";
import { samplePdf, signaturePng } from "./fixtures";

// Deliberately fixed to the disposable local instance. These tests never target
// production and only change the roles of the exact accounts created below.
const base = "http://127.0.0.1:3176";
const run = randomUUID();
const prefix = `admin-qa-${run}-`;
const password = `Admin-QA-${randomUUID()}!`;
const database = new Client({ connectionString: config.DATABASE_URL });
const fixtureIds = new Set<string>();
type Account = { id: string; email: string; cookie: string };
let first: Account, second: Account, ordinary: Account, outsider: Account;
let testEmailEnabled = false;
let document: { id: string; name: string; byteSize: number };
let original: Buffer;
const localSources = new Map<string, string>();
const sourceSubnet = `127.${parseInt(run.slice(0, 2), 16)}.${parseInt(run.slice(2, 4), 16)}`;

async function request(
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
) {
  if (!(body instanceof FormData)) {
    // Independent invitation/account fixtures get real loopback addresses so
    // this aggregate suite does not share one guest/auth rate-limit bucket.
    // No untrusted forwarded-IP header is used.
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
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
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
                {
                  status: response.statusCode!,
                  headers,
                },
              ),
            ),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () =>
        req.destroy(new Error("Invitation acceptance stalled")),
      );
      req.end(JSON.stringify(body));
    });
  }
  const multipart = body instanceof FormData;
  return fetch(`${base}/api${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: base,
      "X-PaperSign": "1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(!multipart && body ? { "Content-Type": "application/json" } : {}),
    },
    body: multipart ? body : body ? JSON.stringify(body) : undefined,
  });
}
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
async function register(label: string) {
  const email = `${prefix}${label}@example.invalid`;
  const response = await request("/auth/sign-up/email", "", "POST", {
    name: `Admin QA ${label}`,
    email,
    password,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  fixtureIds.add(body.user.id);
  await verifyFixtureEmail(body.user.id, email);
  const signedIn = await request("/auth/sign-in/email", "", "POST", {
    email,
    password,
  });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  return {
    id: body.user.id,
    email,
    cookie: await enrollFixtureMfa(cookies(signedIn)),
  };
}
async function enrollFixtureMfa(cookie: string) {
  const setup = await request("/auth/two-factor/enable", cookie, "POST", {
    password,
    method: "totp",
  });
  expect(setup.status, await setup.clone().text()).toBe(200);
  const { totpURI } = await setup.json();
  const confirmed = await request(
    "/auth/two-factor/verify-totp",
    cookie,
    "POST",
    { code: fixtureTotp(totpURI) },
  );
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  return cookies(confirmed) || cookie;
}
async function invitation(label: string, role: "user" | "admin" = "user") {
  const response = await request(
    "/admin/account-invitations",
    first.cookie,
    "POST",
    {
      name: `Invited QA ${label}`,
      email: `${prefix}${label}@example.invalid`,
      role,
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  const created = await response.json();
  expect(created.url).toEqual(expect.any(String));
  return { ...created, token: new URL(created.url).pathname.split("/").pop() };
}
async function rememberInvited(email: string) {
  const rows = await database.query(
    'select id, role from "user" where email = $1',
    [email],
  );
  for (const row of rows.rows) fixtureIds.add(row.id);
  return rows.rows;
}
async function changeRole(
  actor: Account,
  target: Account,
  expectedRole: string,
  role: string,
) {
  return request(`/admin/users/${target.id}/role`, actor.cookie, "PATCH", {
    expectedRole,
    role,
  });
}

describe("Admin authorization, private records, account invitations and role races", () => {
  beforeAll(async () => {
    expect(["127.0.0.1", "localhost"]).toContain(
      new URL(config.DATABASE_URL).hostname,
    );
    const configuration = await (await request("/config")).json();
    await assertTestMail(base);
    testEmailEnabled = configuration.emailEnabled;
    await database.connect();
    expect(
      (
        await database.query(
          'select count(*)::int count from "user" where role = $1',
          ["admin"],
        )
      ).rows[0].count,
      "The last-Admin race requires no unrelated Admin fixture; never demote another account",
    ).toBe(0);
    first = await register("first");
    second = await register("second");
    ordinary = await register("ordinary");
    outsider = await register("outsider");
    const promoted = await database.query(
      'update "user" set role = $1 where id = any($2::text[]) and email like $3 returning id',
      ["admin", [first.id, second.id], `${prefix}%@example.invalid`],
    );
    expect(promoted.rowCount).toBe(2);
    original = await samplePdf(false);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(original)], { type: "application/pdf" }),
      "Admin QA private agreement.pdf",
    );
    const uploaded = await request("/documents", ordinary.cookie, "POST", form);
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    document = await uploaded.json();
    const png = `data:image/png;base64,${(await signaturePng()).toString("base64")}`;
    for (const [name, deleted] of [
      ["Active QA signature", false],
      ["Deleted QA signature", true],
    ] as const) {
      const saved = await request("/signatures", ordinary.cookie, "POST", {
        name,
        source: "drawn",
        png,
      });
      expect(saved.status, await saved.clone().text()).toBe(201);
      if (deleted) {
        const signature = await saved.json();
        expect(
          (
            await request(
              `/signatures/${signature.id}`,
              ordinary.cookie,
              "DELETE",
            )
          ).status,
        ).toBe(204);
      }
    }
  });

  afterAll(async () => {
    try {
      // Also capture this run's accepted account if an assertion interrupted
      // the test immediately after creation, so a failed run leaves no Admin.
      const created = await database.query(
        'select id from "user" where email like $1',
        [`${prefix}%@example.invalid`],
      );
      for (const row of created.rows) fixtureIds.add(row.id);
      if (fixtureIds.size)
        await database.query(
          'update "user" set role = $1 where id = any($2::text[]) and email like $3',
          ["user", [...fixtureIds], `${prefix}%@example.invalid`],
        );
    } finally {
      await database.end();
    }
  });

  it("denies every Admin entry point to anonymous and ordinary accounts and prevents role injection", async () => {
    const id = randomUUID();
    const endpoints: Array<[string, string, unknown?]> = [
      ["/admin/summary", "GET"],
      ["/admin/users", "GET"],
      [
        `/admin/users/${ordinary.id}/role`,
        "PATCH",
        { expectedRole: "user", role: "admin" },
      ],
      ["/admin/documents", "GET"],
      [`/admin/documents/${document.id}/pdf`, "GET"],
      ["/admin/account-invitations", "GET"],
      [
        "/admin/account-invitations",
        "POST",
        {
          name: "Unauthorized",
          email: `${prefix}denied@example.invalid`,
          role: "admin",
        },
      ],
      [`/admin/account-invitations/${id}/revoke`, "POST", {}],
      [`/admin/account-invitations/${id}/email`, "GET"],
      [
        `/admin/account-invitations/${id}/email`,
        "POST",
        { previewHash: "0".repeat(64) },
      ],
    ];
    for (const [path, method, body] of endpoints) {
      expect(
        (await request(path, "", method, body)).status,
        `Anonymous ${method} ${path}`,
      ).toBe(401);
      expect(
        (await request(path, ordinary.cookie, method, body)).status,
        `User ${method} ${path}`,
      ).toBe(403);
    }
    const forged = await request("/auth/sign-up/email", "", "POST", {
      name: "Forged administrator",
      email: `${prefix}forged@example.invalid`,
      password,
      role: "admin",
    });
    expect([200, 400]).toContain(forged.status);
    if (forged.status === 200) {
      const result = await forged.json();
      fixtureIds.add(result.user.id);
      expect((await rememberInvited(result.user.email))[0].role).toBe("user");
      const forgedLogin = await request("/auth/sign-in/email", "", "POST", {
        email: result.user.email,
        password,
      });
      expect(
        (await request("/admin/summary", cookies(forgedLogin))).status,
      ).toBe(403);
    }
    const updated = await request(
      "/auth/update-user",
      ordinary.cookie,
      "POST",
      { name: "Ordinary QA", role: "admin" },
    );
    expect([200, 400]).toContain(updated.status);
    expect((await rememberInvited(ordinary.email))[0].role).toBe("user");
    expect((await request("/admin/summary", ordinary.cookie)).status).toBe(403);
    expect(
      (await (await request("/me", ordinary.cookie)).json()).user.role,
    ).toBe("user");
    expect((await (await request("/me")).json()).user).toBeNull();
  });

  it("paginates Admin records, reports real totals and permits only explicit audited original-PDF access", async () => {
    const summaryResponse = await request("/admin/summary", first.cookie);
    expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json();
    const counts = await database.query(`select
      (select count(*)::int from "user") users,
      (select count(*)::int from "user" where role = 'admin') admins,
      (select count(*)::int from document) documents,
      (select count(*)::int from signature where deleted_at is null) signatures,
      (select coalesce(sum(byte_size), 0)::float from document) bytes`);
    expect(summary).toMatchObject({
      users: counts.rows[0].users,
      admins: counts.rows[0].admins,
      documents: counts.rows[0].documents,
      storedSignatures: counts.rows[0].signatures,
      uploadedBytes: counts.rows[0].bytes,
    });
    expect(JSON.stringify(summary)).not.toContain("file_key");
    expect(JSON.stringify(summary)).not.toContain("token");
    const usersResponse = await request(
      `/admin/users?search=${encodeURIComponent(prefix)}&page=1&pageSize=2`,
      first.cookie,
    );
    expect(usersResponse.status).toBe(200);
    const users = await usersResponse.json();
    expect(users.items).toHaveLength(2);
    expect(users.total).toBeGreaterThanOrEqual(4);
    expect(users.page).toBe(1);
    expect(users.pageSize).toBe(2);
    const next = await (
      await request(
        `/admin/users?search=${encodeURIComponent(prefix)}&page=2&pageSize=2`,
        first.cookie,
      )
    ).json();
    expect(next.items).toHaveLength(2);
    const ownerList = await (
      await request(
        `/admin/users?search=${encodeURIComponent(ordinary.email)}`,
        first.cookie,
      )
    ).json();
    expect(ownerList.items).toHaveLength(1);
    expect(ownerList.items[0]).toMatchObject({
      id: ordinary.id,
      documentCount: 1,
      signatureCount: 1,
    });
    const otherList = await (
      await request(
        `/admin/users?search=${encodeURIComponent(outsider.email)}`,
        first.cookie,
      )
    ).json();
    expect(otherList.items).toHaveLength(1);
    expect(otherList.items[0]).toMatchObject({
      id: outsider.id,
      documentCount: 0,
      signatureCount: 0,
    });
    expect(
      users.items
        .map((u: any) => u.id)
        .some((id: string) => next.items.some((u: any) => u.id === id)),
    ).toBe(false);
    for (const entry of [...users.items, ...next.items]) {
      expect(entry).not.toHaveProperty("password");
      expect(entry).not.toHaveProperty("session");
      expect(entry).not.toHaveProperty("token");
    }
    expect(
      (await request("/admin/users?pageSize=101", first.cookie)).status,
    ).toBe(400);
    expect(
      (await request("/admin/documents?page=0", first.cookie)).status,
    ).toBe(400);
    const listed = await (
      await request(
        `/admin/documents?search=${encodeURIComponent(ordinary.email)}`,
        first.cookie,
      )
    ).json();
    expect(listed.items.some((item: any) => item.id === document.id)).toBe(
      true,
    );
    const adminDocument = listed.items.find(
      (item: any) => item.id === document.id,
    );
    expect(adminDocument).not.toHaveProperty("fileKey");
    expect(adminDocument).not.toHaveProperty("sourceHash");
    expect(adminDocument).not.toHaveProperty("placements");
    for (const cookie of [first.cookie, outsider.cookie]) {
      expect((await request(`/documents/${document.id}`, cookie)).status).toBe(
        404,
      );
      expect(
        (await request(`/documents/${document.id}/pdf`, cookie)).status,
      ).toBe(404);
      expect(
        (
          await request(`/documents/${document.id}/placements`, cookie, "PUT", {
            revision: 1,
            placements: [],
          })
        ).status,
      ).toBe(404);
    }
    const pdf = await request(
      `/admin/documents/${document.id}/pdf`,
      first.cookie,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(pdf.headers.get("cache-control")).toContain("no-store");
    const actual = Buffer.from(await pdf.arrayBuffer());
    expect(createHash("sha256").update(actual).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    // This is an audited original, not a broad permission bypass on owner routes.
    const audited = await database.query(
      "select * from admin_event where actor_id = $1",
      [first.id],
    );
    expect(
      audited.rows.some((row) => JSON.stringify(row).includes(document.id)),
    ).toBe(true);
  });

  it("applies promotions and demotions immediately and rejects stale or invalid role edits", async () => {
    const queued = await Promise.all(
      Array.from({ length: 12 }, () =>
        changeRole(first, first, "admin", "admin"),
      ),
    );
    expect(queued.map((response) => response.status)).toEqual(
      Array(12).fill(200),
    );
    const promoted = await changeRole(first, ordinary, "user", "admin");
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    expect((await request("/admin/summary", ordinary.cookie)).status).toBe(200);
    expect(
      (await (await request("/me", ordinary.cookie)).json()).user.role,
    ).toBe("admin");
    expect((await changeRole(second, ordinary, "user", "user")).status).toBe(
      409,
    );
    const edits = await Promise.all([
      changeRole(first, ordinary, "admin", "user"),
      changeRole(second, ordinary, "admin", "user"),
    ]);
    expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await request("/admin/summary", ordinary.cookie)).status).toBe(403);
    expect(
      (await (await request("/me", ordinary.cookie)).json()).user.role,
    ).toBe("user");
    expect(
      (await changeRole(first, ordinary, "user", "superadmin")).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/admin/users/${ordinary.id}/role`,
          first.cookie,
          "PATCH",
          { role: "admin" },
        )
      ).status,
    ).toBe(400);
  });

  it("binds invitation email and role, hashes tokens and consumes a link once before normal login", async () => {
    const invited = await invitation("new-administrator", "admin");
    expect(
      (
        await request("/admin/account-invitations", first.cookie, "POST", {
          name: "Duplicate",
          email: invited.email,
          role: "user",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/admin/account-invitations", first.cookie, "POST", {
          name: "Existing",
          email: ordinary.email,
          role: "admin",
        })
      ).status,
    ).toBe(409);
    const emailPreview = await (
      await request(
        `/admin/account-invitations/${invited.id}/email`,
        first.cookie,
      )
    ).json();
    expect(emailPreview).toMatchObject({
      to: invited.email,
      enabled: testEmailEnabled,
      attachments: [],
    });
    expect(emailPreview.body).toContain(invited.url);
    expect(emailPreview.body).toContain("Admin");
    expect(emailPreview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    const preview = await request(`/account-invitations/${invited.token}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      email: invited.email,
      role: "admin",
    });
    const stored = await database.query(
      "select * from account_invitation where id = $1",
      [invited.id],
    );
    expect(stored.rows[0].token_hash).toBe(
      createHash("sha256").update(invited.token).digest("hex"),
    );
    expect(JSON.stringify(stored.rows[0])).not.toContain(invited.token);
    for (const overrides of [{ email: outsider.email }, { role: "user" }]) {
      expect(
        (
          await request(
            `/account-invitations/${invited.token}/accept`,
            "",
            "POST",
            { name: "Invited admin", password, ...overrides },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(
          `/account-invitations/${invited.token}/accept`,
          outsider.cookie,
          "POST",
          {
            name: "Wrong signed-in account",
            password,
          },
        )
      ).status,
    ).toBe(409);
    expect(await rememberInvited(invited.email)).toHaveLength(0);
    expect(
      (await request(`/account-invitations/${invited.token}`)).status,
    ).toBe(200);
    expect(
      (
        await database.query(
          "select state from account_invitation where id = $1",
          [invited.id],
        )
      ).rows[0].state,
    ).toBe("pending");
    const accepted = await request(
      `/account-invitations/${invited.token}/accept`,
      "",
      "POST",
      { name: "Invited admin", password },
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      email: invited.email,
    });
    expect(accepted.headers.getSetCookie()).toHaveLength(0);
    expect(await rememberInvited(invited.email)).toHaveLength(1);
    expect((await rememberInvited(invited.email))[0].role).toBe("admin");
    expect(
      (await request(`/account-invitations/${invited.token}`)).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/account-invitations/${invited.token}/accept`,
          "",
          "POST",
          { name: "Replay", password },
        )
      ).status,
    ).toBe(404);
    const signedIn = await request("/auth/sign-in/email", "", "POST", {
      email: invited.email,
      password,
    });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const invitedAccount = (await rememberInvited(invited.email))[0];
    await verifyFixtureEmail(invitedAccount.id, invited.email);
    const invitedCookie = await enrollFixtureMfa(cookies(signedIn));
    expect((await request("/admin/summary", invitedCookie)).status).toBe(200);
    // Keep exactly two Admins for the later last-Admin race.
    await database.query(
      'update "user" set role = $1 where id = $2 and email = $3',
      ["user", (await rememberInvited(invited.email))[0].id, invited.email],
    );
  });

  it("rejects expired, revoked and conflicting invitations and accepts only the authenticated matching account", async () => {
    const revoked = await invitation("revoked");
    expect(
      (
        await request(
          `/admin/account-invitations/${revoked.id}/revoke`,
          first.cookie,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    const expired = await invitation("expired");
    const changed = await database.query(
      "update account_invitation set expires_at = now() - interval '1 minute' where id = $1 and email = $2 returning id",
      [expired.id, expired.email],
    );
    expect(changed.rowCount).toBe(1);
    for (const token of [revoked.token, expired.token, "a".repeat(64)]) {
      const preview = await request(`/account-invitations/${token}`);
      expect(preview.status).toBe(404);
      expect((await preview.json()).message).toBe(
        "This account invitation is no longer available.",
      );
      expect(
        (
          await request(`/account-invitations/${token}/accept`, "", "POST", {
            name: "Cannot accept",
            password,
          })
        ).status,
      ).toBe(404);
    }
    const existing = await invitation("signup-race", "admin");
    const account = await register("signup-race");
    expect(
      (
        await request(
          `/account-invitations/${existing.token}/accept`,
          "",
          "POST",
          { name: "Overwrite", password: `${password}-changed` },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/account-invitations/${existing.token}/accept`,
          outsider.cookie,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
    const originalName = (
      await database.query('select name from "user" where id = $1', [
        account.id,
      ])
    ).rows[0].name;
    const accepted = await request(
      `/account-invitations/${existing.token}/accept`,
      account.cookie,
      "POST",
      {},
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const record = (
      await database.query('select name, role from "user" where id = $1', [
        account.id,
      ])
    ).rows[0];
    expect(record).toMatchObject({ name: originalName, role: "admin" });
    const signIn = await request("/auth/sign-in/email", "", "POST", {
      email: account.email,
      password,
    });
    expect(signIn.status).toBe(200);
    expect((await request("/admin/summary", account.cookie)).status).toBe(200);
    await database.query(
      'update "user" set role = $1 where id = $2 and email = $3',
      ["user", account.id, account.email],
    );
    const lowerRoleInvitation = await invitation(
      "preserve-administrator",
      "user",
    );
    const currentAdmin = await register("preserve-administrator");
    expect(
      (await changeRole(first, currentAdmin, "user", "admin")).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/account-invitations/${lowerRoleInvitation.token}/accept`,
          currentAdmin.cookie,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    expect((await rememberInvited(currentAdmin.email))[0].role).toBe("admin");
    expect(
      (await changeRole(first, currentAdmin, "admin", "user")).status,
    ).toBe(200);
  });

  it("serializes concurrent acceptance and creates exactly one credential account", async () => {
    const invited = await invitation("concurrent");
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(`/account-invitations/${invited.token}/accept`, "", "POST", {
          name: "Concurrent invite",
          password,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 404,
    ]);
    const users = await rememberInvited(invited.email);
    expect(users).toHaveLength(1);
    expect(
      (
        await database.query(
          "select count(*)::int count from account where user_id = $1 and provider_id = 'credential'",
          [users[0].id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("accepts an Admin-created invitation with public registration disabled", async () => {
    const invited = await invitation("closed-registration");
    const script = `
      import { buildApp } from './server/app.ts';
      import { pool } from './server/db.ts';
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const data = JSON.parse(input), app = await buildApp();
      const headers = { origin: ${JSON.stringify(base)}, 'x-papersign': '1', 'content-type': 'application/json' };
      try {
        const signup = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers, payload: { name: 'Closed signup', email: data.blockedEmail, password: data.password } });
        const accepted = await app.inject({ method: 'POST', url: '/api/account-invitations/' + data.token + '/accept', headers, payload: { name: 'Closed registration invite', password: data.password } });
        console.log('ADMIN_CLOSED_RESULT=' + JSON.stringify({ signup: signup.statusCode, signupBody: signup.json(), accepted: accepted.statusCode, body: accepted.json() }));
      } finally { await app.close(); await pool.end(); }
    `;
    const result = await new Promise<{
      signup: number;
      signupBody: { code: string };
      accepted: number;
      body: unknown;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            REGISTRATION_ENABLED: "false",
            APP_URL: base,
            LOG_LEVEL: "silent",
          },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 25000,
        },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (value) => (output += value));
      child.stderr.on("data", (value) => (errors += value));
      child.on("error", reject);
      child.on("exit", (code) => {
        const line = output
          .split("\n")
          .find((line) => line.startsWith("ADMIN_CLOSED_RESULT="));
        if (code !== 0 || !line)
          reject(
            new Error(
              `Isolated closed-registration process failed (${code}): ${errors}`,
            ),
          );
        else resolve(JSON.parse(line.slice("ADMIN_CLOSED_RESULT=".length)));
      });
      child.stdin.end(
        JSON.stringify({
          token: invited.token,
          password,
          blockedEmail: `${prefix}closed-denied@example.invalid`,
        }),
      );
    });
    expect(result.signup).toBe(400);
    expect(result.signupBody.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect(result.accepted).toBe(200);
    expect(result.body).toMatchObject({ ok: true, email: invited.email });
    expect(await rememberInvited(invited.email)).toHaveLength(1);
    expect(
      await rememberInvited(`${prefix}closed-denied@example.invalid`),
    ).toHaveLength(0);
  });

  it("never removes the final Admin when two administrators demote themselves concurrently", async () => {
    const admins = await database.query(
      'select id from "user" where role = $1 order by id',
      ["admin"],
    );
    expect(admins.rows.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    const responses = await Promise.all([
      changeRole(first, first, "admin", "user"),
      changeRole(second, second, "admin", "user"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const remaining = (
      await database.query('select id from "user" where role = $1', ["admin"])
    ).rows;
    expect(remaining).toHaveLength(1);
    const winner = remaining[0].id === first.id ? first : second;
    const demoted = winner.id === first.id ? second : first;
    expect((await request("/admin/summary", demoted.cookie)).status).toBe(403);
    expect((await changeRole(winner, winner, "admin", "user")).status).toBe(
      409,
    );
    expect((await request("/admin/summary", winner.cookie)).status).toBe(200);
  });
});
