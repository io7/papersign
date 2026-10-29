import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Invitation, SigningStatus } from "../../shared/types";
import { editorFixture } from "../helpers/editor-fixture";

// The sender's signing-order panel while a request is out. Signers are made up.
const day = 24 * 60 * 60 * 1000;
const unexpectedWrites = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(unexpectedWrites.get(page) ?? []).toEqual([]);
});

function signer(
  order: number,
  name: string,
  signingStatus: SigningStatus,
): Invitation {
  const states: Partial<Record<SigningStatus, string>> = {
    signed: "signed",
    revoked: "revoked",
  };
  const suffix = String(order).padStart(12, "0");
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    name,
    email: `${name.split(" ")[0].toLowerCase()}@example.invalid`,
    state: states[signingStatus] ?? "pending",
    signingOrder: order,
    signingStatus,
    canSign: signingStatus === "ready",
    expiresAt: new Date(Date.now() + 6 * day).toISOString(),
    signedAt: signingStatus === "signed" ? "2026-10-28T09:12:00Z" : null,
    field: {
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
      pageIndex: 0,
      x: 0.1,
      y: 0.4 + order * 0.1,
      width: 0.25,
      height: 0.06,
    },
    url: `http://127.0.0.1:5176/sign/fixture-link-${order}`,
  };
}

async function openPanel(page: Page, invitations: Invitation[]) {
  const fixture = await editorFixture(page, {
    status: "awaiting",
    invitations,
  });
  unexpectedWrites.set(page, fixture.unexpectedWrites);
  await fixture.open();
  const list = page.getByRole("list", { name: "Signing requests" });
  await expect(list.getByRole("listitem")).toHaveCount(invitations.length);
  return list.getByRole("listitem");
}

async function capture(page: Page, name: string) {
  const dir = process.env.SIGNING_ORDER_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page
    .locator(".editor-tools")
    .screenshot({ path: `${dir}/${name}.png`, animations: "disabled" });
}

test("each signer is a step with its status in words and only the actions it needs", async ({
  page,
}) => {
  const steps = await openPanel(page, [
    signer(1, "Avery Lindqvist", "signed"),
    signer(2, "Jonas Ekberg", "ready"),
    signer(3, "Mira Solberg", "waiting"),
  ]);
  await expect(steps.nth(0)).toContainText("Signed Oct 28, 2026");
  await expect(steps.nth(0).getByRole("button")).toHaveCount(0);
  await expect(steps.nth(1)).toContainText("Ready to sign · expires");
  await expect(steps.nth(2)).toContainText(
    "Waiting for Jonas Ekberg · expires",
  );
  for (const [index, name] of [
    [1, "Jonas Ekberg"],
    [2, "Mira Solberg"],
  ] as const) {
    const buttons = steps.nth(index).getByRole("button");
    await expect(buttons).toHaveCount(3);
    for (const label of [
      `Revoke signing link for ${name}`,
      `Copy link for ${name}`,
      `Email ${name}`,
    ])
      await expect(
        steps.nth(index).getByRole("button", { name: label, exact: true }),
      ).toBeVisible();
  }
  const copy = await steps
    .nth(1)
    .getByRole("button", { name: "Copy link for Jonas Ekberg" })
    .boundingBox();
  const email = await steps
    .nth(1)
    .getByRole("button", { name: "Email Jonas Ekberg" })
    .boundingBox();
  expect(Math.abs(copy!.width - email!.width)).toBeLessThan(1);
  // The link box only appears if copying fails.
  await expect(
    page.getByRole("textbox", { name: /^Signing link/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel signing request", exact: true }),
  ).toBeVisible();

  // Nothing can be downloaded or deleted yet, so the section only says when.
  await expect(
    page.getByText(
      "The completed PDF will be available when all active requests are signed.",
    ),
  ).toBeVisible();
  for (const label of [
    "Prepare download",
    "Advanced download",
    "Request document deletion",
  ])
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveCount(0);
  await capture(page, "awaiting-1440");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await capture(page, "awaiting-390");
});

test("an expired link offers Renew, and a revoked signer keeps their place without actions", async ({
  page,
}) => {
  const steps = await openPanel(page, [
    signer(1, "Avery Lindqvist", "signed"),
    signer(2, "Jonas Ekberg", "expired"),
    signer(3, "Mira Solberg", "revoked"),
    signer(4, "Noor Haddad", "waiting"),
  ]);
  await expect(page.locator(".signing-progress")).toContainText(
    "An expired link is holding up signing.",
  );
  await expect(steps.nth(1)).toContainText("Link expired");
  await expect(
    steps
      .nth(1)
      .getByRole("button", {
        name: "Renew link for Jonas Ekberg",
        exact: true,
      }),
  ).toBeVisible();
  await expect(
    steps.nth(1).getByRole("button", { name: /^Copy link|^Email/ }),
  ).toHaveCount(0);
  await expect(steps.nth(2)).toContainText("Revoked");
  await expect(steps.nth(2).getByRole("button")).toHaveCount(0);
  await expect(steps.nth(3)).toContainText("Waiting for Jonas Ekberg");
  await capture(page, "expired-revoked-1440");
});

test("the sender's own turn offers Sign now instead of a link to copy or email", async ({
  page,
}) => {
  // The editor fixture is signed in as editor@example.invalid.
  const steps = await openPanel(page, [
    signer(1, "Editor QA", "ready"),
    signer(2, "Jonas Ekberg", "waiting"),
  ]);
  await expect(
    steps.nth(0).getByRole("link", { name: "Sign now as Editor QA" }),
  ).toHaveAttribute("href", "http://127.0.0.1:5176/sign/fixture-link-1");
  await expect(
    steps.nth(0).getByRole("button", { name: /^Copy link|^Email/ }),
  ).toHaveCount(0);
  await expect(
    steps.nth(1).getByRole("link", { name: /^Sign now/ }),
  ).toHaveCount(0);
  await expect(
    steps.nth(1).getByRole("button", { name: "Copy link for Jonas Ekberg" }),
  ).toBeVisible();
  await capture(page, "own-turn-1440");
});

test("when copying fails, the link box appears with the link selected", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
  });
  const ready = signer(2, "Jonas Ekberg", "ready");
  const steps = await openPanel(page, [
    signer(1, "Avery Lindqvist", "signed"),
    ready,
    signer(3, "Mira Solberg", "waiting"),
  ]);
  await steps
    .nth(1)
    .getByRole("button", { name: "Copy link for Jonas Ekberg", exact: true })
    .click();
  await expect(steps.nth(1).getByRole("alert")).toHaveText(
    "Could not copy the link. Select and copy it from the box.",
  );
  const box = page.getByRole("textbox", {
    name: "Signing link for Jonas Ekberg",
    exact: true,
  });
  await expect(box).toHaveValue(ready.url!);
  await expect(box).toBeFocused();
  expect(
    await box.evaluate(
      (input: HTMLInputElement) =>
        input.selectionEnd! - input.selectionStart! === input.value.length,
    ),
  ).toBe(true);
  await expect(steps.nth(2).getByRole("textbox")).toHaveCount(0);
  await capture(page, "copy-failed-1440");
});
