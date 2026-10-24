import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import Fastify from "fastify";

const mailbox = vi.hoisted(() => ({
  enabled: true,
  messages: [] as { to: string; subject: string; text: string }[],
}));
vi.mock("../server/mail.js", () => ({
  mailConfigured: () => mailbox.enabled,
  sendSecurityMail: async (message: {
    to: string;
    subject: string;
    text: string;
  }) => {
    mailbox.messages.push(message);
  },
}));
import { auth } from "../server/auth.js";
import { config } from "../server/config.js";
import { db, pool } from "../server/db.js";
import { twoFactor } from "../server/account-security-schema.js";
import { user, verification } from "../server/schema.js";
import {
  registerAccountSecurityRoutes,
  requireAccountVerification,
  requireAdminMfa,
} from "../server/account-security.js";

const fixtures: string[] = [];
const password = `Account-security-${randomUUID()}!`;
let clientIndex = 0;
class Browser {
  cookies = new Map<string, string>();
  ip = `127.42.10.${++clientIndex}`;
  get cookie() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  async request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await auth.handler(
      new Request(
        new URL(
          path.startsWith("http") ? path : `/api/auth${path}`,
          config.APP_URL,
        ),
        {
          method,
          headers: {
            Origin: config.APP_URL,
            Cookie: this.cookie,
            "Content-Type": "application/json",
            "x-papersign-client-ip": this.ip,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }
  async session() {
    return (await this.request("/get-session")).body;
  }
}
async function createAccount() {
  const email = `account-security-${randomUUID()}@example.test`;
  const browser = new Browser();
  const created = await browser.request("/sign-up/email", {
    name: "Security test",
    email,
    password,
    callbackURL: `${config.APP_URL}/account`,
  });
  expect(created.status).toBe(200);
  const record = await db.query.user.findFirst({
    where: eq(user.email, email),
  });
  expect(record).toBeTruthy();
  fixtures.push(record!.id);
  const signedIn = await browser.request("/sign-in/email", { email, password });
  expect(signedIn.status).toBe(200);
  return { browser, email, id: record!.id };
}
function emailUrl(email: string, subject: string) {
  const message = mailbox.messages.findLast(
    (item) => item.to === email && item.subject.includes(subject),
  );
  expect(message).toBeTruthy();
  return message!.text.match(/https?:\/\/\S+/)![0];
}
function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get("secret")!;
  let bits = "";
  for (const char of encoded.replace(/=+$/, ""))
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(char.toUpperCase())
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash.at(-1)! & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
async function enroll(browser: Browser) {
  const setup = await browser.request("/two-factor/enable", {
    password,
    method: "totp",
  });
  expect(setup.status).toBe(200);
  expect(setup.body.backupCodes).toHaveLength(10);
  const verified = await browser.request("/two-factor/verify-totp", {
    code: totp(setup.body.totpURI),
  });
  expect(verified.status).toBe(200);
  return setup.body as { totpURI: string; backupCodes: string[] };
}

beforeAll(async () => {
  const url = new URL(config.DATABASE_URL);
  if (url.hostname !== "127.0.0.1" || url.port !== "54376")
    throw new Error(
      "Account security tests require isolated PostgreSQL on 127.0.0.1:54376.",
    );
});
afterAll(async () => {
  if (fixtures.length) {
    await db.delete(verification).where(inArray(verification.value, fixtures));
    await db.delete(user).where(inArray(user.id, fixtures));
  }
  await pool.end();
});

describe("Account verification and recovery", () => {
  it("keeps registration responses generic and binds verification to the mailed account", async () => {
    const account = await createAccount();
    expect((await account.browser.session()).user.emailVerified).toBe(false);
    expect(() => requireAccountVerification({ emailVerified: false })).toThrow(
      "Verify your email",
    );
    const existing = await new Browser().request("/sign-up/email", {
      name: "Security test",
      email: account.email,
      password,
    });
    expect(existing.status).toBe(200);
    expect(existing.body.token).toBeNull();
    const link = emailUrl(account.email, "Verify");
    const verifier = new Browser();
    expect((await verifier.request(link)).status).toBe(302);
    expect((await account.browser.session()).user.emailVerified).toBe(true);
    expect(await verifier.session()).toBeNull();
    expect(() =>
      requireAccountVerification({ emailVerified: true }),
    ).not.toThrow();
  });
  it("rejects recovery and verification uniformly when delivery is unavailable", async () => {
    mailbox.enabled = false;
    try {
      const unknown = await new Browser().request("/request-password-reset", {
        email: "unknown@example.test",
      });
      const verify = await new Browser().request("/send-verification-email", {
        email: "unknown@example.test",
      });
      expect(unknown.status).toBe(503);
      expect(verify.status).toBe(503);
      expect(unknown.body.message).toContain("not configured");
    } finally {
      mailbox.enabled = true;
    }
  });
  it("resets through a single-use token, revokes all sessions, and does not disclose unknown accounts", async () => {
    const account = await createAccount();
    const second = new Browser();
    await second.request("/sign-in/email", { email: account.email, password });
    const resetter = new Browser();
    const known = await resetter.request("/request-password-reset", {
      email: account.email,
      redirectTo: `${config.APP_URL}/reset-password`,
    });
    const unknown = await new Browser().request("/request-password-reset", {
      email: `${randomUUID()}@example.test`,
      redirectTo: `${config.APP_URL}/reset-password`,
    });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    const link = emailUrl(account.email, "Reset");
    const callback = await resetter.request(link);
    expect(callback.status).toBe(302);
    const token = new URL(callback.headers.get("location")!).searchParams.get(
      "token",
    );
    const nextPassword = `New-security-${randomUUID()}!`;
    expect(
      (
        await resetter.request("/reset-password", {
          token,
          newPassword: nextPassword,
        })
      ).status,
    ).toBe(200);
    expect(await account.browser.session()).toBeNull();
    expect(await second.session()).toBeNull();
    expect(
      (
        await resetter.request("/reset-password", {
          token,
          newPassword: password,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await new Browser().request("/sign-in/email", {
          email: account.email,
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await new Browser().request("/sign-in/email", {
          email: account.email,
          password: nextPassword,
        })
      ).status,
    ).toBe(200);
  });
  it("enforces recovery rate limits before any message is sent", async () => {
    const browser = new Browser();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await browser.request("/request-password-reset", {
            email: "unknown@example.test",
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await browser.request("/request-password-reset", {
          email: "unknown@example.test",
        })
      ).status,
    ).toBe(429);
  });
});

describe("Authenticator protection", () => {
  it("requires verified enrollment, marks only the proved session, and revokes older password-only sessions", async () => {
    const account = await createAccount();
    const oldBrowser = new Browser();
    await oldBrowser.request("/sign-in/email", {
      email: account.email,
      password,
    });
    expect(() =>
      requireAdminMfa({
        user: { twoFactorEnabled: false },
        session: { mfaVerified: false },
      }),
    ).toThrow();
    const setup = await account.browser.request("/two-factor/enable", {
      password,
      method: "totp",
    });
    expect(setup.status).toBe(200);
    expect((await account.browser.session()).user.twoFactorEnabled).toBe(false);
    const code = totp(setup.body.totpURI);
    const bad = `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;
    expect(
      (await account.browser.request("/two-factor/verify-totp", { code: bad }))
        .status,
    ).toBe(401);
    expect(
      (await account.browser.request("/two-factor/verify-totp", { code }))
        .status,
    ).toBe(200);
    const active = await account.browser.session();
    expect(active.user.twoFactorEnabled).toBe(true);
    expect(active.session.mfaVerified).toBe(true);
    expect(() => requireAdminMfa(active)).not.toThrow();
    expect(await oldBrowser.session()).toBeNull();
    const [record] = await db
      .select()
      .from(twoFactor)
      .where(eq(twoFactor.userId, account.id));
    expect(record.secret).not.toContain(
      new URL(setup.body.totpURI).searchParams.get("secret"),
    );
    expect(record.backupCodes).not.toContain(setup.body.backupCodes[0]);
  });
  it("requires MFA on fresh login and consumes recovery codes once", async () => {
    const account = await createAccount();
    const setup = await enroll(account.browser);
    const login = new Browser();
    expect(
      (
        await login.request("/sign-in/email", {
          email: account.email,
          password,
        })
      ).body.twoFactorRedirect,
    ).toBe(true);
    expect(await login.session()).toBeNull();
    expect(
      (
        await login.request("/two-factor/verify-totp", {
          code: totp(setup.totpURI),
          trustDevice: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await login.request("/two-factor/verify-backup-code", {
          code: setup.backupCodes[0],
        })
      ).status,
    ).toBe(200);
    expect((await login.session()).session.mfaVerified).toBe(true);
    const replay = new Browser();
    await replay.request("/sign-in/email", { email: account.email, password });
    expect(
      (
        await replay.request("/two-factor/verify-backup-code", {
          code: setup.backupCodes[0],
        })
      ).status,
    ).not.toBe(200);
  });
  it("keeps MFA enabled and invalidates pending login challenges after password recovery", async () => {
    const account = await createAccount();
    const setup = await enroll(account.browser);
    const pending = new Browser();
    expect(
      (
        await pending.request("/sign-in/email", {
          email: account.email,
          password,
        })
      ).body.twoFactorRedirect,
    ).toBe(true);
    const resetter = new Browser();
    await resetter.request("/request-password-reset", {
      email: account.email,
      redirectTo: `${config.APP_URL}/reset-password`,
    });
    const callback = await resetter.request(emailUrl(account.email, "Reset"));
    const token = new URL(callback.headers.get("location")!).searchParams.get(
      "token",
    );
    const nextPassword = `Recovered-${randomUUID()}!`;
    expect(
      (
        await resetter.request("/reset-password", {
          token,
          newPassword: nextPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await pending.request("/two-factor/verify-totp", {
          code: totp(setup.totpURI),
        })
      ).status,
    ).toBe(401);
    const fresh = new Browser();
    expect(
      (
        await fresh.request("/sign-in/email", {
          email: account.email,
          password: nextPassword,
        })
      ).body.twoFactorRedirect,
    ).toBe(true);
    expect(
      (
        await fresh.request("/two-factor/verify-totp", {
          code: totp(setup.totpURI),
        })
      ).status,
    ).toBe(200);
    expect((await fresh.session()).user.twoFactorEnabled).toBe(true);
  });
  it("does not allow an Admin to disable MFA", async () => {
    const account = await createAccount();
    await enroll(account.browser);
    await db.update(user).set({ role: "admin" }).where(eq(user.id, account.id));
    expect(
      (await account.browser.request("/two-factor/disable", { password }))
        .status,
    ).toBe(403);
    expect((await account.browser.session()).user.twoFactorEnabled).toBe(true);
  });
});

describe("Private security settings", () => {
  it("lists no bearer tokens and revokes only the signed-in user's sessions", async () => {
    const a = await createAccount(),
      b = await createAccount();
    const other = new Browser();
    await other.request("/sign-in/email", { email: a.email, password });
    const app = Fastify();
    await registerAccountSecurityRoutes(app);
    try {
      expect(
        (await app.inject({ url: "/api/account/security" })).statusCode,
      ).toBe(401);
      const settings = await app.inject({
        url: "/api/account/security",
        headers: { cookie: a.browser.cookie },
      });
      const parsed = settings.json();
      expect(parsed.sessions).toHaveLength(2);
      expect(
        parsed.sessions.filter((item: { current: boolean }) => item.current),
      ).toHaveLength(1);
      expect(settings.body).not.toContain('"token"');
      const victim = await b.browser.session();
      await app.inject({
        url: `/api/account/sessions/${victim.session.id}/revoke`,
        method: "POST",
        headers: { cookie: a.browser.cookie },
      });
      expect(await b.browser.session()).toBeTruthy();
      await app.inject({
        url: "/api/account/sessions/revoke-others",
        method: "POST",
        headers: { cookie: a.browser.cookie },
      });
      expect(await other.session()).toBeNull();
      expect(await a.browser.session()).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
