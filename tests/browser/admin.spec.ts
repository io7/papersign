import { assertTestMail } from "../helpers/test-mail.js";
import {
  verifyFixtureEmail,
  fixtureTotp,
} from "../helpers/account-security.js";
import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Route,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { config } from "../../server/config";
import { samplePdf } from "../fixtures";

test.use({ actionTimeout: 10000, video: "on" });

const artifacts = ".local/qa";
const screenshots = ".impeccable/review";
const geometry: unknown[] = [];
const base = "http://127.0.0.1:3176";
const run = randomUUID();
const password = `Admin-browser-${randomUUID()}!`;
const adminEmail = `admin-browser-${run}@example.invalid`;
const ownerEmail = `admin-document-owner-${run}@example.invalid`;
const invitedEmail = `admin-invited-${run}@example.invalid`;

async function register(page: Page, name: string, email: string) {
  const response = await page.request.post("/api/auth/sign-up/email", {
    headers: { Origin: base, "X-PaperSign": "1" },
    data: { name, email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  const created = (await response.json()).user;
  await verifyFixtureEmail(created.id, email);
  const signedIn = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: base, "X-PaperSign": "1" },
    data: { email, password },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  if (email === adminEmail) {
    const setup = await page.request.post("/api/auth/two-factor/enable", {
      headers: { Origin: base, "X-PaperSign": "1" },
      data: { password, method: "totp" },
    });
    expect(setup.status(), await setup.text()).toBe(200);
    const confirmed = await page.request.post(
      "/api/auth/two-factor/verify-totp",
      {
        headers: { Origin: base, "X-PaperSign": "1" },
        data: { code: fixtureTotp((await setup.json()).totpURI) },
      },
    );
    expect(confirmed.status(), await confirmed.text()).toBe(200);
  }
  return created;
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `${screenshots}/admin-${name}.png`,
    fullPage: true,
    // A reusable bearer link is never needed to judge layout or interaction.
    mask: [page.locator("input[readonly]"), page.locator(".invitation-url")],
  });
  geometry.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      navigation: [
        ...document.querySelectorAll('nav[aria-label="Main navigation"] a'),
      ].map((link) => {
        const box = link.getBoundingClientRect();
        return {
          name: link.textContent?.trim(),
          x: box.x,
          right: box.right,
          y: box.y,
          width: box.width,
        };
      }),
    }))),
  });
  await writeFile(
    `${artifacts}/admin-browser-geometry.json`,
    JSON.stringify(geometry, null, 2),
  );
}
async function noOverflow(page: Page) {
  expect
    .soft(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    .toBe(true);
}

test("administer users, invite a colleague and inspect a private upload without changing owner access", async ({
  page,
  browser,
}, testInfo) => {
  expect(
    testInfo.project.use.baseURL,
    "Admin browser fixtures are local only",
  ).toBe(base);
  expect(["127.0.0.1", "localhost"]).toContain(
    new URL(config.DATABASE_URL).hostname,
  );
  await mkdir(artifacts, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  const configuration = await (await page.request.get("/api/config")).json();
  await assertTestMail(base);
  const database = new Client({ connectionString: config.DATABASE_URL });
  await database.connect();
  const seeded: string[] = [];
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const ownerContext = await browser.newContext({ baseURL: base });
    contexts.push(ownerContext);
    const ownerPage = await ownerContext.newPage();
    ownerPage.on("pageerror", (error) => errors.push(error.message));
    const owner = await register(ownerPage, "Morgan Avery", ownerEmail);
    seeded.push(owner.id);
    const original = await samplePdf(false);
    const uploaded = await ownerPage.request.post("/api/documents", {
      headers: { Origin: base, "X-PaperSign": "1" },
      multipart: {
        file: {
          name: "Synthetic consulting agreement.pdf",
          mimeType: "application/pdf",
          buffer: original,
        },
      },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const document = await uploaded.json();
    const admin = await register(page, "Jordan Ellis", adminEmail);
    seeded.push(admin.id);
    expect(
      (
        await database.query(
          'update "user" set role = $1 where id = $2 and email = $3 returning id',
          ["admin", admin.id, adminEmail],
        )
      ).rowCount,
    ).toBe(1);
    await page.goto("/documents");
    await expect(
      page.getByRole("link", { name: "Admin", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { name: "Admin", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Usage statistics")).toBeVisible();
    await page.getByLabel("Search users", { exact: true }).fill(run);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const ownerRow = page.getByRole("article", {
      name: ownerEmail,
      exact: true,
    });
    await expect(ownerRow).toBeVisible();
    await capture(page, "overview-desktop");
    await noOverflow(page);
    for (const width of [360, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      await capture(
        page,
        width === 360 ? "users-compact-mobile" : "users-tablet",
      );
      await noOverflow(page);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // A promoted account sees the Admin entry but must enroll MFA before access.
    await ownerPage.goto("/documents");
    await expect(
      ownerPage.getByRole("link", { name: "Admin", exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel(`Role for ${ownerEmail}`, { exact: true })
      .selectOption("admin");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", {
        name: `Apply role for ${ownerEmail}`,
        exact: true,
      })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Morgan Avery is now an Admin.",
    );
    await ownerPage.goto("/admin");
    await expect(
      ownerPage.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    expect((await ownerPage.request.get("/api/admin/users")).status()).toBe(
      403,
    );
    await page
      .getByLabel(`Role for ${ownerEmail}`, { exact: true })
      .selectOption("user");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", {
        name: `Apply role for ${ownerEmail}`,
        exact: true,
      })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Morgan Avery is now a User.",
    );
    await ownerPage.goto("/admin");
    await expect(ownerPage).toHaveURL(/\/documents$/);
    await expect(
      ownerPage.getByRole("link", { name: "Admin", exact: true }),
    ).toHaveCount(0);
    expect((await ownerPage.request.get("/api/admin/summary")).status()).toBe(
      403,
    );
    expect(
      (await ownerPage.request.get(`/api/documents/${document.id}`)).status(),
    ).toBe(200);

    await ownerRow
      .getByRole("button", { name: "1 document", exact: true })
      .click();
    await expect(
      page.getByText("Documents uploaded by", { exact: false }),
    ).toContainText("Morgan Avery");
    const docRow = page.getByRole("article", {
      name: document.name,
      exact: true,
    });
    await expect(docRow).toBeVisible();
    const pdfLink = docRow.getByRole("link", {
      name: "Open uploaded PDF",
      exact: true,
    });
    await expect(pdfLink).toHaveAttribute(
      "href",
      `/api/admin/documents/${document.id}/pdf`,
    );
    const fetched = await page.request.get(
      (await pdfLink.getAttribute("href"))!,
    );
    expect(fetched.status()).toBe(200);
    expect(Buffer.compare(await fetched.body(), original)).toBe(0);
    // Admin inspection never unlocks another person's owner/editor endpoint.
    expect(
      (await page.request.get(`/api/documents/${document.id}`)).status(),
    ).toBe(404);
    await capture(page, "documents-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "documents-mobile");
    await noOverflow(page);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page
      .getByRole("group", { name: "Admin sections" })
      .getByRole("button", { name: "Invitations", exact: true })
      .click();
    await page.getByLabel("Name", { exact: true }).fill("Sam Rivera");
    await page.getByLabel("Email", { exact: true }).fill(invitedEmail);
    await page
      .getByRole("combobox", { name: "Role", exact: true })
      .selectOption("user");
    await page
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Invitation created.");
    await page
      .getByLabel("Search invitations", { exact: true })
      .fill(invitedEmail);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const inviteRow = page.getByRole("article", {
      name: invitedEmail,
      exact: true,
    });
    await expect(inviteRow).toBeVisible();
    const invitationUrl = await page
      .getByLabel(`Invitation link for ${invitedEmail}`, { exact: true })
      .inputValue();
    expect(new URL(invitationUrl).origin).toBe(base);
    await capture(page, "invitation-desktop");
    await inviteRow
      .getByRole("button", { name: "Preview email", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review invitation email",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(invitedEmail);
    await expect(dialog).toContainText("CC / BCC");
    await expect(dialog).toContainText("Attachments");
    const sendInvitation = dialog.getByRole("button", {
      name: "Send invitation email",
      exact: true,
    });
    if (configuration.emailEnabled) await expect(sendInvitation).toBeEnabled();
    else await expect(sendInvitation).toBeDisabled();
    await capture(page, "email-preview-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "email-preview-mobile");
    await noOverflow(page);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await capture(page, "invitation-mobile");
    await noOverflow(page);

    const guestContext = await browser.newContext({
      baseURL: base,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(guestContext);
    const guest = await guestContext.newPage();
    guest.on("pageerror", (error) => errors.push(error.message));
    await guest.goto(invitationUrl);
    await expect(guest.getByLabel("Your name", { exact: true })).toHaveValue(
      "Sam Rivera",
    );
    await capture(guest, "join-desktop");
    await guest.setViewportSize({ width: 390, height: 844 });
    await capture(guest, "join-mobile");
    await noOverflow(guest);
    // A second tab changes the shared session after this invitation was loaded.
    // The stale form must explain which account is signed in and allow sign-out.
    const otherTab = await guestContext.newPage();
    await otherTab.goto("/login");
    await otherTab
      .getByLabel("Email address", { exact: true })
      .fill(ownerEmail);
    await otherTab.getByLabel("Password", { exact: true }).fill(password);
    await otherTab
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(otherTab).toHaveURL(/\/documents$/);
    await otherTab.close();
    await guest.getByLabel("Password", { exact: true }).fill(password);
    await guest
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await expect(guest.locator(".auth-form")).toContainText(ownerEmail);
    await expect(guest.locator(".auth-form")).toContainText(invitedEmail);
    await expect(guest.getByLabel("Password", { exact: true })).toHaveCount(0);
    await capture(guest, "join-wrong-account-mobile");
    await guest.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(guest.getByLabel("Your name", { exact: true })).toHaveValue(
      "Sam Rivera",
    );
    await guest.getByLabel("Password", { exact: true }).fill(password);
    await guest
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(
      guest.getByRole("heading", { name: "Account created", exact: true }),
    ).toBeVisible();
    await guest.getByRole("link", { name: "Sign in", exact: true }).click();
    await guest.getByLabel("Email address", { exact: true }).fill(invitedEmail);
    await guest.getByLabel("Password", { exact: true }).fill(password);
    const signIn = () =>
      Promise.all([
        guest.waitForResponse(
          (response) =>
            response.url().endsWith("/api/auth/sign-in/email") &&
            response.request().method() === "POST",
        ),
        guest.getByRole("button", { name: "Sign in", exact: true }).click(),
      ]);
    let [signedIn] = await signIn();
    if (signedIn.status() === 429) {
      // This fixture logs several distinct users in from one IP. Respect the
      // unchanged three-logins-per-ten-seconds protection before the fourth.
      const seconds = Number(
        signedIn.headers()["x-retry-after"] ??
          signedIn.headers()["retry-after"] ??
          "10",
      );
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(10);
      await expect(guest.getByRole("alert")).toContainText("Too many requests");
      await guest.waitForTimeout(seconds * 1000 + 200);
      [signedIn] = await signIn();
    }
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    await expect(guest).toHaveURL(/\/documents$/);
    const invitedUser = (await (await guest.request.get("/api/me")).json())
      .user;
    seeded.push(invitedUser.id);
    expect(invitedUser).toMatchObject({
      email: invitedEmail,
      name: "Sam Rivera",
      role: "user",
    });
    await expect(
      guest.getByRole("link", { name: "Admin", exact: true }),
    ).toHaveCount(0);
    await guest.goto("/admin");
    await expect(guest).toHaveURL(/\/documents$/);
    expect((await guest.request.get("/api/admin/users")).status()).toBe(403);
    expect(
      (await guest.request.get(`/api/documents/${document.id}`)).status(),
    ).toBe(404);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(inviteRow).toContainText("Accepted");
    await expect(
      page.getByLabel(`Invitation link for ${invitedEmail}`, { exact: true }),
    ).toHaveCount(0);
    await capture(page, "invitation-accepted-mobile");
    await page
      .getByRole("group", { name: "Admin sections" })
      .getByRole("button", { name: "Users", exact: true })
      .click();
    await page.getByLabel("Search users", { exact: true }).fill(run);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("article", { name: invitedEmail, exact: true }),
    ).toBeVisible();
    await capture(page, "users-mobile");
    await noOverflow(page);
    await guest.goto(invitationUrl);
    await expect(
      guest.getByRole("heading", {
        name: "Invitation unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await writeFile(
      `${artifacts}/admin-browser-fixtures.json`,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          baseURL: base,
          admin: { id: admin.id, email: adminEmail },
          owner: { id: owner.id, email: ownerEmail },
          documentId: document.id,
          documentName: document.name,
          invitedEmail,
          invitedUserId: invitedUser.id,
          screenshots: [
            "overview-desktop",
            "documents-desktop",
            "documents-mobile",
            "invitation-desktop",
            "email-preview-desktop",
            "email-preview-mobile",
            "invitation-mobile",
            "join-desktop",
            "join-mobile",
            "invitation-accepted-mobile",
            "users-mobile",
          ].map((name) => `${screenshots}/admin-${name}.png`),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    if (seeded.length)
      await database.query(
        'update "user" set role = $1 where id = any($2::text[]) and email like $3',
        ["user", seeded, "%@example.invalid"],
      );
    await database.end();
  }
});

test("ignore a delayed acceptance after navigating to a different invitation", async ({
  page,
}) => {
  const pending = new Map<string, Route>();
  let signIns = 0;
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { user: null } }),
  );
  await page.route("**/api/auth/sign-in/email", (route) => {
    signIns++;
    return route.fulfill({
      status: 400,
      json: { message: "No sign-in should be attempted by this fixture." },
    });
  });
  await page.route("**/api/account-invitations/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const token = path.split("/")[3];
    if (route.request().method() === "POST") {
      pending.set(token, route);
      return;
    }
    return route.fulfill({
      json: {
        name: token === "first" ? "First invite" : "Second invite",
        email: `${token}@example.invalid`,
        role: "user",
        expiresAt: "2030-12-31T12:00:00Z",
      },
    });
  });
  await page.goto("/join/first");
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue(
    "First invite",
  );
  await page
    .getByLabel("Password", { exact: true })
    .fill("First-invitation-password!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect.poll(() => pending.has("first")).toBe(true);
  // Router navigation deliberately reuses JoinView, as browser history can.
  await page.evaluate(async () => {
    const app = (document.getElementById("app") as any).__vue_app__;
    await app.config.globalProperties.$router.push("/join/second");
  });
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue(
    "Second invite",
  );
  await page
    .getByLabel("Password", { exact: true })
    .fill("Second-invitation-password!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect.poll(() => pending.has("second")).toBe(true);
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith("/account-invitations/first/accept"),
  );
  await pending
    .get("first")!
    .fulfill({ json: { ok: true, email: "first@example.invalid" } });
  await oldResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(signIns).toBe(0);
  await expect(page).toHaveURL(/\/join\/second$/);
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue(
    "Second invite",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    "Second-invitation-password!",
  );
  await expect(page.getByLabel("Password", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Creating account…", exact: true }),
  ).toBeDisabled();
  await pending.get("second")!.fulfill({
    status: 400,
    json: { message: "Second invitation validation fixture." },
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Second invitation validation fixture.",
  );
  await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
  expect(signIns).toBe(0);
});
