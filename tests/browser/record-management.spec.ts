import { test as base, expect, type Page, type Route } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const artifacts = ".local/qa/readiness/ui";
const date = "2026-10-22T08:00:00.000Z";
const documentName =
  "Technology-Services-Agreement-" + "long-document-name-".repeat(10) + ".pdf";
const email =
  "alexandra.longname.department+accounts.signature.review@example-corporate-group.invalid";
const user = {
  id: "synthetic-admin",
  name: "Alex Example",
  email,
  role: "admin",
  emailVerified: true,
  twoFactorEnabled: true,
  mfaVerified: true,
};
type Fixture = {
  failures: Set<string>;
  writes: Array<{ path: string; body: any }>;
  hold(path: string): { started: Promise<void>; release(): void };
};
const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({ context, page }, use, info) => {
    const failures = new Set<string>();
    const writes: Fixture["writes"] = [];
    const unexpected: string[] = [],
      errors: string[] = [];
    const holds = new Map<string, { started(): void; wait: Promise<void> }>();
    let accountRequested = false,
      withdrawn = false,
      approved = false;
    const request = () => ({
      id: "synthetic-document",
      name: documentName,
      ownerEmail: email,
      status: "completed",
      requestedAt: date,
      deletedAt: approved ? date : null,
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/api/**", async (route: Route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      const send = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      const hold = holds.get(path);
      if (hold) {
        holds.delete(path);
        hold.started();
        await hold.wait;
      }
      if (failures.has(path))
        return send(
          { message: "Synthetic service unavailable. Please try again." },
          503,
        );
      if (req.method() === "GET") {
        if (path === "/api/me") return send({ user });
        if (path === "/api/config")
          return send({ emailEnabled: false, registrationEnabled: false });
        if (path === "/api/privacy")
          return send({
            operator: "Example Operator Ltd",
            evidence:
              "PaperSign retains the original PDF, reviewed versions, acceptance wording and the completed document.",
            adminAccess:
              "Administrators may inspect original documents. Reads are recorded.",
            retention:
              "Completed signing records have no automatic expiry. Deletion requests require review.",
            backups:
              "Recovery backups retain deleted content until their configured expiry.",
            recoveryDays: 30,
          });
        if (path === "/api/account/storage")
          return send({
            usedBytes: 490 * 1024 ** 2,
            limitBytes: 500 * 1024 ** 2,
            deletionRequestedAt: accountRequested ? date : null,
          });
        if (path === "/api/documents/trash/list")
          return send(withdrawn ? [] : [request()]);
        if (path === "/api/admin/operations")
          return send({
            checks: [
              { name: "database", ok: true, detail: "Connected" },
              { name: "worker", ok: false, detail: "No worker heartbeat" },
              {
                name: "backup",
                ok: false,
                detail:
                  "Backup unavailable: /var/lib/postgresql/" +
                  "long-backup-path-".repeat(10) +
                  "papersign.dump",
              },
              { name: "storage", ok: true, detail: "12738 MB available" },
            ],
          });
        if (path === "/api/admin/deletion-requests")
          return send({
            documents: withdrawn ? [] : [request()],
            accounts: [
              {
                id: "synthetic-account",
                name: "Alexandra Example" + "-long-name".repeat(8),
                email,
                requestedAt: date,
              },
            ],
            recoveryDays: 30,
          });
      }
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        if (
          path === "/api/admin/deletion-requests/synthetic-document/decision"
        ) {
          writes.push({ path, body });
          approved = body.approve;
          withdrawn = !body.approve;
          return send({ ok: true });
        }
        if (path === "/api/documents/synthetic-document/restore") {
          writes.push({ path, body });
          withdrawn = true;
          return send({ ok: true });
        }
        if (path === "/api/account/deletion-request") {
          writes.push({ path, body });
          accountRequested = true;
          return send({ state: "awaiting-approval" });
        }
        if (path === "/api/account/deletion-request/withdraw") {
          writes.push({ path, body });
          accountRequested = false;
          return send({ ok: true });
        }
      }
      unexpected.push(`${req.method()} ${path}`);
      return send(
        { message: "Unexpected API request blocked by browser fixture." },
        409,
      );
    });
    await use({
      failures,
      writes,
      hold(path) {
        let start!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          start = resolve;
        });
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        holds.set(path, { started: start, wait });
        return { started, release };
      },
    });
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      `${artifacts}/${info.title.replace(/[^a-zA-Z0-9-]/g, "-")}-checks.json`,
      JSON.stringify(
        { unexpected, errors, interceptedWrites: writes },
        null,
        2,
      ),
    );
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  },
});
test.use({ video: "on", trace: "retain-on-failure" });

async function screenshot(page: Page, name: string) {
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
  await writeFile(
    `${artifacts}/${name}-layout.json`,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        url: page.url(),
        ...(await page.evaluate(() => ({
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          contentWidth: document.documentElement.scrollWidth,
        }))),
      },
      null,
      2,
    ),
  );
}
async function noOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
}
for (const width of [1440, 768, 390]) {
  test(`privacy long content at ${width}`, async ({ page, fixture }) => {
    void fixture;
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/privacy");
    await expect(
      page.getByRole("heading", { name: "Your data and records" }),
    ).toBeVisible();
    await expect(
      page.getByText("490.0 MB of 500 MB used", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Withdraw request", exact: true }),
    ).toBeVisible();
    await screenshot(page, `privacy-${width}`);
    await noOverflow(page);
  });
  test(`operations long content at ${width}`, async ({ page, fixture }) => {
    void fixture;
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/operations");
    await expect(
      page.getByRole("heading", { name: "Operations and data requests" }),
    ).toBeVisible();
    await expect(
      page.getByText("Needs attention", { exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Approve recovery window" }),
    ).toBeVisible();
    await screenshot(page, `operations-${width}`);
    await noOverflow(page);
  });
}
test("privacy loading and error recovery", async ({ page, fixture }) => {
  const hold = fixture.hold("/api/privacy");
  fixture.failures.add("/api/privacy");
  await page.goto("/privacy");
  await hold.started;
  await expect(page.getByRole("status")).toContainText(
    "Loading your data policy",
  );
  await screenshot(page, "privacy-loading");
  hold.release();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic service unavailable",
  );
  await expect(
    page.getByText("Loading your data policy", { exact: false }),
  ).toBeHidden();
  await screenshot(page, "privacy-error");
  fixture.failures.clear();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "What is recorded" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});
test("operations loading error recovery and guarded decisions", async ({
  page,
  fixture,
}) => {
  const hold = fixture.hold("/api/admin/operations");
  fixture.failures.add("/api/admin/operations");
  await page.goto("/admin/operations");
  await hold.started;
  await expect(page.getByRole("status")).toContainText("Checking PaperSign");
  await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await screenshot(page, "operations-loading");
  hold.release();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic service unavailable",
  );
  await screenshot(page, "operations-error");
  fixture.failures.clear();
  const refresh = fixture.hold("/api/admin/operations");
  await page.getByRole("button", { name: "Refresh" }).click();
  await refresh.started;
  await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Checking PaperSign");
  refresh.release();
  await expect(
    page.getByRole("button", { name: "Approve recovery window" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Approve recovery window" }).click();
  expect(fixture.writes).toHaveLength(0);
  page.once("dialog", (dialog) =>
    dialog.accept("Approved synthetic request; no real records affected."),
  );
  await page.getByRole("button", { name: "Approve recovery window" }).click();
  await expect(
    page.getByText("Recovery window started", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve recovery window" }),
  ).toBeHidden();
  expect(fixture.writes).toEqual([
    {
      path: "/api/admin/deletion-requests/synthetic-document/decision",
      body: {
        approve: true,
        requestedAt: date,
        reason: "Approved synthetic request; no real records affected.",
      },
    },
  ]);
  await screenshot(page, "operations-approved");
});
test("privacy withdrawal and account request", async ({ page, fixture }) => {
  await page.goto("/privacy");
  await page
    .getByRole("button", { name: "Withdraw request", exact: true })
    .click();
  await expect(
    page.getByText("No pending requests.", { exact: false }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept(email));
  await page.getByRole("button", { name: "Request account deletion" }).click();
  await expect(
    page.getByRole("button", { name: "Withdraw account request" }),
  ).toBeVisible();
  await screenshot(page, "privacy-account-requested");
  await page.getByRole("button", { name: "Withdraw account request" }).click();
  await expect(
    page.getByRole("button", { name: "Request account deletion" }),
  ).toBeVisible();
  expect(fixture.writes.map((write) => write.path)).toEqual([
    "/api/documents/synthetic-document/restore",
    "/api/account/deletion-request",
    "/api/account/deletion-request/withdraw",
  ]);
});
