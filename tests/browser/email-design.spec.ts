import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { emailHtml, type EmailDesign } from "../../server/email-design.js";

const directory = ".local/qa/account-security-email-design/emails";
const url =
  "https://papersign.example.invalid/account/verify?token=SYNTHETIC-NOT-VALID&callbackURL=%2Faccount";
const fixtures: { name: string; text: string; design: EmailDesign }[] = [
  {
    name: "verify-email",
    text: `Confirm that this email address belongs to you by opening this link within one hour:\n${url}\n\nIf you did not request this, ignore this email.\n\nPaperSign`,
    design: {
      heading: "Verify your email address",
      preview:
        "Confirm your email address to use PaperSign. This link expires in one hour.",
      action: { label: "Verify email address", url },
    },
  },
  {
    name: "reset-password",
    text: `A password reset was requested for your PaperSign account.\n\nChoose a new password using this link within 30 minutes:\n${url}\n\nAll existing sessions will be signed out when you reset your password. Your authenticator remains enabled.\n\nIf you did not request this, ignore this email.\n\nPaperSign`,
    design: {
      heading: "Reset your password",
      preview:
        "Choose a new PaperSign password. This link expires in 30 minutes.",
      action: { label: "Reset password", url },
    },
  },
  {
    name: "verification-code",
    text: "Your PaperSign verification code is: 123456\n\nIt expires in 10 minutes and only works in the browser that requested it. Use it to verify your email before reviewing and signing the document.\n\nDo not share this code, including with the document sender. If you did not request it, ignore this email.\n\nPaperSign",
    design: {
      heading: "Your verification code",
      preview: "Your PaperSign verification code expires in 10 minutes.",
      code: "123456",
    },
  },
  {
    name: "signing-invitation",
    text: `Hello Taylor,\n\nAlex Morgan has invited you to sign “Consulting agreement.pdf”. You are signer 2 in the signing order. Your turn opens once the earlier signers have finished.\n\nOpen your private signing link:\n${url}\n\nThis link expires on 2026-10-29. You can upload or draw your signature.\n\nPaperSign`,
    design: {
      heading: "You’re invited to sign",
      preview: "Alex Morgan invited you to sign Consulting agreement.pdf.",
      action: { label: "Review document", url },
    },
  },
  {
    name: "account-invitation",
    text: `Hello Taylor,\n\nAlex Morgan has invited you to join PaperSign as a User.\n\nCreate your account using your private invitation link:\n${url}\n\nThis link expires on 2026-10-29. If you already have an account with this email address, sign in before accepting.\n\nPaperSign`,
    design: {
      heading: "You’re invited to PaperSign",
      preview: "Alex Morgan invited you to join PaperSign.",
      action: { label: "Accept invitation", url },
    },
  },
];

for (const width of [640, 390]) {
  for (const fixture of fixtures) {
    test(`${fixture.name} email at ${width}`, async ({ page }) => {
      const outgoing: string[] = [];
      await page.route("**/*", async (route) => {
        outgoing.push(route.request().url());
        await route.abort();
      });
      await page.setViewportSize({ width, height: 1000 });
      const html = emailHtml(fixture.text, fixture.design);
      await page.setContent(html);
      await expect(
        page.getByRole("heading", {
          name: fixture.design.heading,
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (fixture.design.action) {
        await expect(
          page.getByRole("link", {
            name: fixture.design.action.label,
            exact: true,
          }),
        ).toHaveAttribute("href", url);
        await expect(page.getByRole("link")).toHaveCount(2);
      } else {
        await expect(page.getByText("123456", { exact: true })).toBeVisible();
        await expect(page.getByRole("link")).toHaveCount(0);
      }
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/${fixture.name}.html`, html);
      await page.screenshot({
        path: `${directory}/${fixture.name}-${width}.png`,
        fullPage: true,
      });
      expect(outgoing).toEqual([]);
    });
  }
}

test("email content wraps long document titles and private URLs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  const longUrl = `https://papersign.example.invalid/sign/${"synthetic-token-".repeat(35)}`;
  await page.setContent(
    emailHtml(
      `Hello Taylor,\n\nYou are invited to sign ${"LongDocumentName".repeat(30)}.pdf.\n\nOpen your link:\n${longUrl}\n\nPaperSign`,
      {
        heading: "You’re invited to sign",
        preview: "Review your document",
        action: { label: "Review document", url: longUrl },
      },
    ),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("link", { name: "Review document", exact: true }),
  ).toBeVisible();
});
