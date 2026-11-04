import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { editorFixture } from "../helpers/editor-fixture";
import { declareTermsComplete } from "../helpers/owner-signing.js";

// Creating signing links can also email the first signer. Signers are made up
// and the server is mocked, so nothing is sent.
const unexpectedWrites = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(unexpectedWrites.get(page) ?? []).toEqual([]);
});

const sendNowLabel =
  "Email Avery Lindqvist the signing link now. PaperSign emails each later signer when their turn opens.";

async function draft(
  page: Page,
  options: { emailEnabled?: boolean; invitationEmail?: "sent" | "failed" },
  signers = [
    ["Avery Lindqvist", "avery@example.invalid"],
    ["Noor Haddad", "noor@example.invalid"],
  ],
) {
  const fixture = await editorFixture(page, {
    placements: [],
    invitationEmail: "sent",
    ...options,
  });
  unexpectedWrites.set(page, fixture.unexpectedWrites);
  await fixture.open();
  await page
    .getByRole("button", { name: "Invite to sign", exact: true })
    .click();
  for (const [name, email] of signers) {
    await page.getByLabel("Recipient name", { exact: true }).fill(name);
    await page.getByLabel("Recipient email", { exact: true }).fill(email);
    await page
      .getByRole("button", { name: "Add signing field", exact: true })
      .click();
  }
  return fixture;
}

test("emails the first signer with the links by default", async ({ page }) => {
  const fixture = await draft(page, { emailEnabled: true });
  await page
    .getByLabel(
      "The agreement terms are complete. Recipient text fields are only for signing details, such as names, titles, places and dates.",
      { exact: true },
    )
    .check();
  await expect(page.getByLabel(sendNowLabel, { exact: true })).toBeChecked();
  const evidence = process.env.SEND_ON_CREATE_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page
      .locator(".signer-list-confirmation")
      .screenshot({ path: `${evidence}/send-on-create.png` });
  }
  await page
    .getByRole("button", { name: "Create links and send", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Signing links created and Avery Lindqvist has been emailed. PaperSign emails each later signer when their turn opens.",
  );
  expect(fixture.invites.map((invite) => invite.sendEmail)).toEqual([true]);
  await expect(
    page.getByRole("list", { name: "Signing requests", exact: true }),
  ).toContainText("Ready to sign");
});

test("leaves email out when the box is cleared", async ({ page }) => {
  const fixture = await draft(page, { emailEnabled: true });
  await declareTermsComplete(page, { email: false });
  await page
    .getByRole("button", { name: "Create signing links", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Signing links created. Share each private link with its signer; people sign in the listed order.",
  );
  expect(fixture.invites.map((invite) => invite.sendEmail)).toEqual([false]);
});

test("keeps the links and says so when the email fails", async ({ page }) => {
  await draft(page, { emailEnabled: true, invitationEmail: "failed" });
  await declareTermsComplete(page, { email: true });
  await page
    .getByRole("button", { name: "Create links and send", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "The links were created, but the email to Avery Lindqvist could not be sent. Use Email in the signing order to try again.",
  );
  await expect(
    page.getByRole("list", { name: "Signing requests", exact: true }),
  ).toBeVisible();
});

test("offers no email without SMTP", async ({ page }) => {
  await draft(page, { emailEnabled: false });
  await expect(page.getByLabel(/^Email .+ the signing link now\./)).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Create signing links", exact: true }),
  ).toBeVisible();
});

test("offers no email when the sender signs first", async ({ page }) => {
  await draft(page, { emailEnabled: true }, [
    ["Editor QA", "editor@example.invalid"],
    ["Noor Haddad", "noor@example.invalid"],
  ]);
  await expect(page.getByLabel(/^Email .+ the signing link now\./)).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Create signing links", exact: true }),
  ).toBeVisible();
});
