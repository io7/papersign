import { expect, type Page } from "@playwright/test";

/**
 * Copies a signer's link the way a sender does, with Copy link in the signing
 * order, and returns what landed on the clipboard.
 */
export async function copySigningLink(page: Page, name: string) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  // Match the name itself: other steps mention it in "Waiting for …".
  const step = page
    .getByRole("list", { name: "Signing requests", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
  await step
    .getByRole("button", { name: `Copy link for ${name}`, exact: true })
    .click();
  await expect(step.getByRole("status")).toHaveText("Link copied.");
  return page.evaluate(() => navigator.clipboard.readText());
}
