import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { config } from "../../server/config.js";
import { assertTestMail, waitForTestMail } from "../helpers/test-mail.js";
import { fixtureTotp } from "../helpers/account-security.js";

const base = "http://127.0.0.1:3176";
test("verify email, enroll an Admin authenticator, sign in with MFA and recover a password", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(testInfo.project.use.baseURL).toBe(base);
  await assertTestMail(base);
  const databaseUrl = new URL(config.DATABASE_URL);
  expect(databaseUrl.hostname).toBe("127.0.0.1");
  expect(databaseUrl.port).toBe("54376");
  const database = new Client({ connectionString: config.DATABASE_URL });
  await database.connect();
  const email = `account-security-browser-${randomUUID()}@example.invalid`;
  const password = `Security-browser-${randomUUID()}!`;
  const nextPassword = `Reset-browser-${randomUUID()}!`;
  const directory = ".impeccable/review/account-security";
  await mkdir(directory, { recursive: true });
  let fixtureId = "";
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  try {
    const created = await page.request.post("/api/auth/sign-up/email", {
      headers: { Origin: base, "X-PaperSign": "1" },
      data: {
        name: "Taylor Morgan",
        email,
        password,
        callbackURL: `${base}/account?verified=1`,
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    fixtureId = (await created.json()).user.id;
    const mail = await waitForTestMail(email, "Verify");
    await page.goto(mail.text.match(/https?:\/\/\S+/)![0]);
    await expect(page).toHaveURL(/\/login\?/);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".verified-label").first()).toContainText(
      "Verified",
    );
    await database.query(
      'update "user" set role = $1 where id = $2 and email = $3',
      ["admin", fixtureId, email],
    );
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/account\?/);
    await expect(
      page.getByText("Set up or confirm your authenticator below", {
        exact: false,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `${directory}/account-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `${directory}/account-mobile.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    await expect(
      page.getByRole("img", {
        name: "Scan this QR code with your authenticator app",
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Setup key", { exact: true })).toBeHidden();
    const uri = await page
      .getByRole("link", {
        name: "Open in an authenticator app on this device",
      })
      .getAttribute("href");
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download recovery codes", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe(
      "papersign-recovery-codes.txt",
    );
    await expect(
      page.getByRole("button", { name: "Confirm and enable", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "I have saved my recovery codes." })
      .check();
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(fixtureTotp(uri!));
    await page.screenshot({
      path: `${directory}/enrollment-mobile.png`,
      fullPage: true,
      mask: [
        page.getByLabel("Setup key", { exact: true }),
        page.getByRole("img", {
          name: "Scan this QR code with your authenticator app",
        }),
        page.getByLabel("Authenticator code", { exact: true }),
        page.getByRole("list", { name: "Recovery codes" }),
      ],
    });
    await page
      .getByRole("button", { name: "Confirm and enable", exact: true })
      .click();
    await expect(
      page.getByText("Authenticator enabled", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Admin", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: `${directory}/protected-desktop.png`,
      fullPage: true,
    });
    await page.getByRole("link", { name: "Open Admin", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Admin", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();
    await page.screenshot({
      path: `${directory}/login-factor-desktop.png`,
      fullPage: true,
    });
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(fixtureTotp(uri!));
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await expect(page).toHaveURL(/\/documents$/);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toContainText(
      "If an account uses this address",
    );
    const resetMail = await waitForTestMail(email, "Reset");
    await page.goto(resetMail.text.match(/https?:\/\/\S+/)![0]);
    await expect(page).toHaveURL(`${base}/reset-password`);
    await page.getByLabel("New password", { exact: true }).fill(nextPassword);
    await page.getByLabel("Confirm new password").fill(nextPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Your password has been reset",
    );
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(nextPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();
    expect(browserErrors).toEqual([]);
  } finally {
    if (fixtureId) {
      await database.query("delete from verification where value = $1", [
        fixtureId,
      ]);
      await database.query('delete from "user" where id = $1 and email = $2', [
        fixtureId,
        email,
      ]);
    }
    await database.end();
  }
});
