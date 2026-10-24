import { test as base, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import jsQR from "jsqr";

const directory = ".local/qa/account-security-email-design";
const uri =
  "otpauth://totp/PaperSign%3Ataylor%40example.invalid?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PaperSign&digits=6&period=30";
const test = base.extend<{ securityFixture: { failLoad: boolean } }>({
  securityFixture: [
    async ({ context }, use) => {
      const state = { failLoad: false };
      const unexpected: string[] = [];
      let protectedSession = false;
      await context.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const respond = (body: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        if (request.method() === "GET" && path === "/api/me")
          return respond({
            user: {
              id: "fixture",
              name: "Taylor Morgan",
              email: "taylor@example.invalid",
              role: "admin",
              emailVerified: protectedSession,
              twoFactorEnabled: protectedSession,
              mfaVerified: protectedSession,
            },
          });
        if (request.method() === "GET" && path === "/api/config")
          return respond({ emailEnabled: true, registrationEnabled: true });
        if (request.method() === "GET" && path === "/api/account/security")
          return respond(
            state.failLoad
              ? { message: "Security settings could not be loaded." }
              : {
                  email: "taylor@example.invalid",
                  emailVerified: protectedSession,
                  twoFactorEnabled: protectedSession,
                  mfaVerified: protectedSession,
                  admin: true,
                  emailEnabled: true,
                  sessions: [
                    {
                      id: "this-session",
                      current: true,
                      createdAt: "2026-10-22T09:47:00Z",
                      expiresAt: "2026-10-29T09:47:00Z",
                      ipAddress: "192.0.2.10",
                      userAgent: "Chrome/130 Windows",
                    },
                  ],
                },
            state.failLoad ? 503 : 200,
          );
        if (
          request.method() === "POST" &&
          path === "/api/auth/two-factor/enable"
        )
          return respond({
            totpURI: uri,
            backupCodes: Array.from(
              { length: 10 },
              (_, i) => `fixture${i}-code${i}`,
            ),
          });
        if (
          request.method() === "POST" &&
          path === "/api/auth/two-factor/verify-totp"
        ) {
          protectedSession = true;
          return respond({ status: true });
        }
        unexpected.push(`${request.method()} ${path}`);
        return respond({ message: "Unexpected API call intercepted." }, 409);
      });
      await use(state);
      expect(unexpected).toEqual([]);
    },
    { auto: true },
  ],
});
test.use({ serviceWorkers: "block" });

async function capture(page: Page, name: string) {
  await mkdir(directory, { recursive: true });
  // Full-page captures otherwise place sticky/fixed elements at the last scroll
  // offset after Playwright has brought the QR or a control into view.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    scrollTo(0, 0);
  });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}

for (const width of [1440, 900, 390, 320]) {
  test(`account security layout at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/account?next=/admin");
    await expect(
      page.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Set up authenticator" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const heading = await page
      .getByRole("heading", { name: "Account security", exact: true })
      .boundingBox();
    const workspace = await page.locator(".workspace").boundingBox();
    expect(heading!.x - workspace!.x).toBeGreaterThanOrEqual(
      width < 480 ? 18 : 24,
    );
    expect(heading!.y).toBeGreaterThanOrEqual(24);
    await expect(
      page.getByRole("button", { name: "Set up authenticator" }),
    ).toHaveCSS("background-color", "rgb(22, 63, 56)");
    await capture(page, `account-${width}`);
  });
}

for (const width of [1440, 390, 320]) {
  test(`QR enrollment and recovery alignment at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/account?next=/admin");
    await page
      .getByLabel("Current password", { exact: true })
      .fill("Synthetic-password-123!");
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const qr = page.getByRole("img", {
      name: "Scan this QR code with your authenticator app",
    });
    await expect(qr).toBeVisible();
    const pixels = await sharp(await qr.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const decoded = jsQR(
      new Uint8ClampedArray(pixels.data),
      pixels.info.width,
      pixels.info.height,
    );
    expect(decoded?.data).toBe(uri);
    await expect(page.getByLabel("Setup key", { exact: true })).toBeHidden();
    const confirm = page.getByRole("button", { name: "Confirm and enable" });
    await expect(confirm).toBeDisabled();
    const checkbox = page.getByRole("checkbox", {
      name: "I have saved my recovery codes.",
    });
    const inputBox = await checkbox.boundingBox();
    const textBox = await page.locator(".consent-label span").boundingBox();
    expect(
      Math.abs(inputBox!.y + inputBox!.height / 2 - (textBox!.y + 12)),
    ).toBeLessThanOrEqual(1);
    await page.locator(".consent-label span").click();
    await expect(checkbox).toBeChecked();
    await expect(confirm).toBeEnabled();
    await page
      .getByText("Can’t scan the code? Enter a setup key", { exact: true })
      .click();
    await expect(page.getByLabel("Setup key", { exact: true })).toHaveValue(
      "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    );
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(page.url()).origin,
      });
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("status").last()).toContainText(
      "Setup key copied.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(page, `setup-key-${width}`);
    await page
      .getByText("Can’t scan the code? Enter a setup key", { exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(page, `enrollment-${width}`);
    await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
    await confirm.click();
    await expect(
      page.getByText("Authenticator enabled", { exact: true }),
    ).toBeVisible();
    await expect(qr).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Open Admin", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await capture(page, `protected-${width}`);
  });
}

test("security settings can recover from a load error", async ({
  page,
  securityFixture,
}) => {
  securityFixture.failLoad = true;
  await page.goto("/account");
  await expect(page.getByRole("alert")).toHaveText(
    "Security settings could not be loaded.",
  );
  securityFixture.failLoad = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Email address", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
