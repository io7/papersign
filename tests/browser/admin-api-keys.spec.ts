import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { config } from "../../server/config.js";
import {
  fixtureTotp,
  verifyFixtureEmail,
} from "../helpers/account-security.js";
import { localFetch, setLocalClientAddress } from "../helpers/local-http.js";

// Runs against the disposable local instance only. The synthetic Admin is
// demoted afterwards; keys it creates stay in the local database.
const base = "http://127.0.0.1:3176";
const run = randomUUID();
const tag = run.slice(0, 8);
const email = `apikey-ui-${run}@example.invalid`;
const password = `ApiKey-UI-${randomUUID()}!`;
const evidence = ".local/qa/api-keys";
let cookie = "";
let userId = "";

const joinCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
// Account setup uses its own loopback source so earlier specs cannot exhaust
// its authentication rate-limit bucket. No forwarded-IP header is used.
setLocalClientAddress(
  `127.${parseInt(run.slice(0, 2), 16)}.${parseInt(run.slice(2, 4), 16)}.31`,
);
async function post(path: string, body: unknown, session = "") {
  return localFetch(`${base}/api${path}`, {
    method: "POST",
    headers: {
      Origin: base,
      "X-PaperSign": "1",
      "Content-Type": "application/json",
      ...(session ? { Cookie: session } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function withSession(context: BrowserContext) {
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        url: base,
      };
    }),
  );
}

test.beforeAll(async () => {
  expect(new URL(config.DATABASE_URL).port).toBe("54376");
  const signedUp = await post("/auth/sign-up/email", {
    name: "Ada Admin",
    email,
    password,
  });
  expect(signedUp.status).toBe(200);
  userId = (await signedUp.json()).user.id;
  await verifyFixtureEmail(userId, email);
  const signedIn = await post("/auth/sign-in/email", { email, password });
  cookie = joinCookies(signedIn);
  const setup = await post(
    "/auth/two-factor/enable",
    { password, method: "totp" },
    cookie,
  );
  const confirmed = await post(
    "/auth/two-factor/verify-totp",
    { code: fixtureTotp((await setup.json()).totpURI) },
    cookie,
  );
  expect(confirmed.status).toBe(200);
  cookie = joinCookies(confirmed) || cookie;
  const database = new Client({ connectionString: config.DATABASE_URL });
  await database.connect();
  try {
    await database.query(
      'update "user" set role = $1 where id = $2 and email = $3',
      ["admin", userId, email],
    );
  } finally {
    await database.end();
  }
  await mkdir(evidence, { recursive: true });
});

test.afterAll(async () => {
  const database = new Client({ connectionString: config.DATABASE_URL });
  await database.connect();
  try {
    await database.query(
      'update "user" set role = $1 where id = $2 and email = $3',
      ["user", userId, email],
    );
  } finally {
    await database.end();
  }
});

test("an Admin creates a key, sees it once, copies it and revokes it", async ({
  page,
  context,
}) => {
  await withSession(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: base,
  });
  await page.goto("/admin?section=api-keys");
  await expect(
    page.getByRole("heading", { name: "Create an API key" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "API keys" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Name").fill(`Claude signing assistant ${tag}`);
  await page.getByLabel("Expires after").selectOption("30");
  await page.getByRole("button", { name: "Create key" }).click();

  const secretRegion = page.getByRole("region", {
    name: "Copy your new key now",
  });
  await expect(secretRegion).toBeVisible();
  const secret = await secretRegion.getByLabel("API key").inputValue();
  expect(secret).toMatch(/^psk_[A-Za-z0-9_-]{43}$/);
  await secretRegion.getByRole("button", { name: "Copy key" }).click();
  await expect(secretRegion.getByText("API key copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    secret,
  );

  const record = page.getByRole("article", {
    name: `Claude signing assistant ${tag}`,
  });
  await expect(record).toContainText(secret.slice(0, 12));
  await expect(record).toContainText("Active");
  await expect(record).toContainText("Never used");
  await expect(record).not.toContainText(secret.slice(12));
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `no horizontal scroll at ${width}px`,
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/created-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The key works for the API until it is revoked.
  const listed = await fetch(`${base}/api/documents`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(listed.status).toBe(200);

  await secretRegion.getByRole("button", { name: "I have stored it" }).click();
  await expect(secretRegion).toBeHidden();
  await page.getByLabel("Name").fill(`Spare key ${tag}`);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(secretRegion).toBeVisible();
  await secretRegion.getByRole("button", { name: "I have stored it" }).click();
  await page.goto(`/admin?section=api-keys&search=${tag}`);
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.locator(".admin-records article")).toHaveCount(2);
  await expect(record).toContainText("Last used");

  page.once("dialog", (dialog) => dialog.accept());
  await record.getByRole("button", { name: /Revoke API key/ }).click();
  await expect(page.getByText("API key revoked.")).toBeVisible();
  await expect(record).toContainText("Revoked");
  await expect(record.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  // Revoked rows keep the same columns, so status badges stay aligned.
  const spare = page.getByRole("article", { name: `Spare key ${tag}` }).first();
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    const revokedBadge = await record.locator(".status").boundingBox();
    const activeBadge = await spare.locator(".status").boundingBox();
    expect(
      Math.abs(revokedBadge!.x - activeBadge!.x),
      `badge alignment at ${width}px`,
    ).toBeLessThan(1);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Usable keys are listed before revoked ones.
  const names = await page
    .locator(".admin-records article h3")
    .allTextContents();
  expect(names.indexOf(`Spare key ${tag}`)).toBeLessThan(
    names.indexOf(`Claude signing assistant ${tag}`),
  );
  await page.screenshot({
    path: `${evidence}/revoked-1440.png`,
    fullPage: true,
  });
  const refused = await fetch(`${base}/api/documents`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(refused.status).toBe(401);
});
