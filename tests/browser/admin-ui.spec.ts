import { test as base, expect, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { emailHtml } from "../../server/email-design.js";
import type {
  AccountInvitation,
  AdminDocument,
  AdminUser,
} from "../../shared/admin-types";

// These tests can inspect a deployed bundle safely: every API request, including
// unexpected writes, is intercepted. Only frontend assets reach TEST_BASE_URL.
const users: AdminUser[] = Array.from({ length: 50 }, (_, index) => ({
  id: `fixture-user-${index + 1}`,
  name: index === 0 ? "Alex Example" : `Sample User ${index + 1}`,
  email:
    index === 2
      ? "alexandra.longname.department+accounts.signature.review@example-corporate-group.invalid"
      : `user${index + 1}@example.invalid`,
  role: index < 2 ? "admin" : "user",
  createdAt: "2026-10-21T08:00:00Z",
  documentCount: index < 4 ? 13 : 0,
  signatureCount: index % 3,
}));
const documents: AdminDocument[] = Array.from({ length: 52 }, (_, index) => ({
  id: `fixture-document-${index + 1}`,
  name: `Sample agreement ${String(index + 1).padStart(2, "0")}.pdf`,
  owner: users[index % 4],
  status: ["draft", "awaiting", "completed"][index % 3],
  byteSize: 152300 + index * 1000,
  pageCount: 10,
  createdAt: "2026-10-21T08:00:00Z",
  updatedAt: "2026-10-21T09:00:00Z",
}));
const invitations: AccountInvitation[] = Array.from(
  { length: 8 },
  (_, index) => ({
    id: `fixture-invitation-${index + 1}`,
    name: `Sample Colleague ${index + 1}`,
    email: `invite${index + 1}@example.invalid`,
    role: "user",
    state: "pending",
    createdAt: "2026-10-21T08:00:00Z",
    expiresAt: "2026-10-28T08:00:00Z",
    acceptedAt: null,
    url: `https://papersign.example.invalid/join/SYNTHETIC-NOT-REAL-${index + 1}`,
  }),
);
const summary = {
  users: 50,
  admins: 2,
  documents: 52,
  documentsAwaiting: 17,
  documentsCompleted: 17,
  storedSignatures: 16,
  uploadedBytes: 45000000,
  pendingAccountInvitations: 8,
};

type RequestRecord = { method: string; path: string; query: string };
type ApiFixture = {
  failures: Set<string>;
  requests: RequestRecord[];
  holdNext: (
    path: string,
    status?: number,
  ) => {
    started: Promise<void>;
    release: () => void;
    finished: Promise<void>;
  };
};

const test = base.extend<{ mockApi: ApiFixture }>({
  mockApi: async ({ context }, use) => {
    const failures = new Set<string>();
    const requests: RequestRecord[] = [];
    const unexpected: string[] = [];
    const holds = new Map<
      string,
      {
        wait: Promise<void>;
        start: () => void;
        finish: () => void;
        status: number;
      }
    >();
    await context.route("**/api/**", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      requests.push({ method: request.method(), path, query: url.search });
      const fulfill = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (request.method() !== "GET") {
        unexpected.push(`${request.method()} ${path}`);
        return fulfill({ message: "Test intercepted this write." }, 409);
      }
      if (path === "/api/me")
        return fulfill({
          user: {
            ...users[0],
            emailVerified: true,
            twoFactorEnabled: true,
            mfaVerified: true,
          },
        });
      if (path === "/api/config")
        return fulfill({ registrationEnabled: true, emailEnabled: false });

      const hold = holds.get(path);
      if (hold) {
        holds.delete(path);
        hold.start();
        await hold.wait;
      }
      try {
        if (failures.has(path) || (hold && hold.status !== 200))
          return await fulfill(
            { message: "Synthetic service unavailable. Please try again." },
            hold?.status === 200 ? 500 : (hold?.status ?? 500),
          );
        if (path === "/api/admin/summary") return await fulfill(summary);
        if (/^\/api\/admin\/account-invitations\/[^/]+\/email$/.test(path)) {
          const invitation = invitations.find((item) => path.includes(item.id));
          if (invitation)
            return await fulfill({
              to: invitation.email,
              subject: "Alex Example invited you to PaperSign",
              body: `Hello ${invitation.name},\n\nJoin PaperSign with this private link:\n${invitation.url}`,
              html: emailHtml(
                `Hello ${invitation.name},\n\nJoin PaperSign with this private link:\n${invitation.url}`,
                {
                  heading: "You’re invited to PaperSign",
                  preview: "An invitation to PaperSign",
                  action: { label: "Accept invitation", url: invitation.url! },
                },
              ),
              attachments: [],
              previewHash: "SYNTHETIC",
              enabled: false,
            });
        }
        const data =
          path === "/api/admin/users"
            ? users
            : path === "/api/admin/documents"
              ? documents
              : path === "/api/admin/account-invitations"
                ? invitations
                : null;
        if (data) {
          const search = url.searchParams.get("search")?.toLowerCase() ?? "";
          const page = Number(url.searchParams.get("page") ?? 1);
          const owner = url.searchParams.get("userId");
          const items = data.filter((item) => {
            const values = [item.name];
            if ("email" in item) values.push(item.email);
            if ("owner" in item) values.push(item.owner.name, item.owner.email);
            return (
              values.join(" ").toLowerCase().includes(search) &&
              (!owner || ("owner" in item && item.owner.id === owner))
            );
          });
          return await fulfill({
            items: items.slice((page - 1) * 25, page * 25),
            total: items.length,
            page,
            pageSize: 25,
          });
        }
        unexpected.push(`GET ${path}`);
        return await fulfill(
          { message: "Unmapped synthetic API request." },
          404,
        );
      } finally {
        hold?.finish();
      }
    });
    await use({
      failures,
      requests,
      holdNext(path, status = 200) {
        let start!: () => void;
        let release!: () => void;
        let finish!: () => void;
        const started = new Promise<void>((resolve) => (start = resolve));
        const wait = new Promise<void>((resolve) => (release = resolve));
        const finished = new Promise<void>((resolve) => (finish = resolve));
        holds.set(path, { wait, start, finish, status });
        return { started, release, finished };
      },
    });
    expect(unexpected, "All API operations must stay in the fixture").toEqual(
      [],
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  },
});

test.use({ serviceWorkers: "block", actionTimeout: 10000 });

async function section(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}
async function capture(page: Page, name: string) {
  const dir =
    process.env.ADMIN_UI_ARTIFACTS ?? ".local/qa/admin-ui-regressions";
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${dir}/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("failed initial and switched lists show retry instead of empty or stale data", async ({
  page,
  mockApi,
}) => {
  mockApi.failures.add("/api/admin/users");
  await page.goto("/admin");
  await expect(
    page.getByRole("alert").filter({ hasText: /Could not load users\./ }),
  ).toBeVisible();
  await expect(page.getByText("No users yet.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.locator(".admin-pagination")).toHaveCount(0);
  mockApi.failures.clear();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("article", { name: users[0].email, exact: true }),
  ).toBeVisible();

  await section(page, "Documents");
  await expect(
    page.getByRole("article", { name: documents[0].name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".admin-pagination")).toContainText("52 documents");
  mockApi.failures.add("/api/admin/users");
  await section(page, "Users");
  await expect(
    page.getByRole("alert").filter({ hasText: /Could not load users\./ }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.locator(".admin-pagination")).toHaveCount(0);
  await expect(page.getByText("No users yet.", { exact: true })).toHaveCount(0);
  await capture(page, "list-error-desktop");
  mockApi.failures.clear();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".admin-pagination")).toContainText("50 users");
});

test("statistics failure leaves the selected list usable and has its own retry", async ({
  page,
  mockApi,
}) => {
  mockApi.failures.add("/api/admin/summary");
  await page.goto("/admin?section=documents");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /Usage statistics could not be loaded\./ }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: documents[0].name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".admin-pagination")).toContainText("52 documents");
  mockApi.failures.clear();
  await page
    .getByRole("button", { name: "Retry statistics", exact: true })
    .click();
  await expect(
    page.getByLabel("Usage statistics", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /Usage statistics could not be loaded\./ }),
  ).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(25);
});

test("search, page, section and owner survive reload and browser history", async ({
  page,
  mockApi,
}) => {
  await page.goto("/admin");
  await expect(page.getByRole("article")).toHaveCount(25);
  await section(page, "Documents");
  await page
    .getByLabel("Search documents", { exact: true })
    .fill("Sample agreement");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/search=Sample(?:\+|%20)agreement/);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/[?&]page=2(?:&|$)/);
  await expect(
    page.getByRole("article", { name: documents[25].name, exact: true }),
  ).toBeVisible();
  const pageTwo = page.url();
  await page.reload();
  await expect(page).toHaveURL(pageTwo);
  await expect(
    page.getByLabel("Search documents", { exact: true }),
  ).toHaveValue("Sample agreement");
  await expect(page.locator(".admin-pagination")).toContainText("Page 2 of 3");
  await page.goBack();
  await expect(
    page.getByRole("article", { name: documents[0].name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".admin-pagination")).toContainText("Page 1 of 3");
  await page.goForward();
  await expect(
    page.getByRole("article", { name: documents[25].name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Search documents", { exact: true }),
  ).toHaveValue("Sample agreement");

  await section(page, "Users");
  await page
    .getByRole("article", { name: users[2].email, exact: true })
    .getByRole("button", { name: "13 documents", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`userId=${users[2].id}`));
  await expect(page.getByRole("article")).toHaveCount(13);
  const ownerUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(ownerUrl);
  await expect(page.getByRole("article")).toHaveCount(13);
  await expect(page.locator(".admin-owner-filter")).toContainText(
    users[2].email,
  );
  expect(
    mockApi.requests
      .filter((item) => item.path === "/api/admin/documents")
      .at(-1)?.query,
  ).toContain(`userId=${users[2].id}`);
  await page
    .getByRole("button", { name: "Show all users", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(25);
  await expect(page).not.toHaveURL(/userId=/);
  await page.goBack();
  await expect(page.getByRole("article")).toHaveCount(13);
  await expect(page.locator(".admin-owner-filter")).toContainText(
    users[2].email,
  );
});

test("late results and failures cannot replace the current section", async ({
  page,
  mockApi,
}) => {
  await page.goto("/admin");
  await expect(page.getByRole("article")).toHaveCount(25);
  for (const status of [200, 500]) {
    const delayed = mockApi.holdNext("/api/admin/documents", status);
    await section(page, "Documents");
    await delayed.started;
    await section(page, "Users");
    await expect(
      page.getByRole("article", { name: users[0].email, exact: true }),
    ).toBeVisible();
    delayed.release();
    await delayed.finished;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByRole("button", { name: "Users", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("article")).toHaveCount(25);
    await expect(
      page.getByRole("article", { name: users[0].email, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".admin-pagination")).toContainText("50 users");
    await expect(
      page.getByRole("alert").filter({ hasText: /Could not load documents\./ }),
    ).toHaveCount(0);
  }
});

test("navigation at 320px and a long owner at 390px stay within the viewport", async ({
  page,
  mockApi,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/admin?section=invitations");
  await expect(page.getByRole("article")).toHaveCount(8);
  const navigation = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  for (const link of await navigation.getByRole("link").all()) {
    await expect(link).toBeVisible();
    const bounds = await link.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
  }
  await noOverflow(page);
  await capture(page, "invitations-320");
  await page.setViewportSize({ width: 390, height: 844 });
  await section(page, "Users");
  await page
    .getByRole("article", { name: users[2].email, exact: true })
    .getByRole("button", { name: "13 documents", exact: true })
    .click();
  await expect(page.locator(".admin-owner-filter")).toContainText(
    users[2].email,
  );
  await expect(page.getByRole("article")).toHaveCount(13);
  await page.evaluate(() => scrollTo(0, 0));
  await noOverflow(page);
  await capture(page, "owner-filter-390");
});

test("copy success and failure are announced beside the invitation in view", async ({
  page,
  mockApi,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });
  await page.goto("/admin?section=invitations");
  const row = page.getByRole("article", {
    name: invitations[3].email,
    exact: true,
  });
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  await expect(row.getByRole("status")).toContainText("Link copied.");
  const bounds = await row.getByRole("status").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await capture(page, "copy-success-390");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
  });
  const failedRow = page.getByRole("article", {
    name: invitations[4].email,
    exact: true,
  });
  await failedRow
    .getByRole("button", { name: "Copy link", exact: true })
    .click();
  await expect(failedRow.getByRole("alert")).toContainText(
    "Could not copy the link. Select and copy it from the box.",
  );
  await expect(
    failedRow.getByLabel(`Invitation link for ${invitations[4].email}`, {
      exact: true,
    }),
  ).toHaveValue(invitations[4].url!);
  const failedBounds = await failedRow.getByRole("alert").boundingBox();
  expect(failedBounds!.y).toBeGreaterThanOrEqual(0);
  expect(failedBounds!.y + failedBounds!.height).toBeLessThanOrEqual(844);
});

test("mobile statistics collapse keeps invitation creation near the top; desktop and email preview still work", async ({
  page,
  mockApi,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin?section=invitations");
  await expect(page.getByRole("article")).toHaveCount(8);
  const show = page.getByRole("button", {
    name: "Show usage statistics",
    exact: true,
  });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByLabel("Usage statistics", { exact: true }),
  ).toBeHidden();
  const create = await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .boundingBox();
  expect(create!.y).toBeGreaterThanOrEqual(0);
  expect(create!.y + create!.height).toBeLessThanOrEqual(844);
  await show.click();
  await expect(
    page.getByLabel("Usage statistics", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hide usage statistics", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("button", { name: "Hide usage statistics", exact: true })
    .click();
  await expect(
    page.getByLabel("Usage statistics", { exact: true }),
  ).toBeHidden();

  const previewButton = page
    .getByRole("button", { name: "Preview email", exact: true })
    .first();
  await previewButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    page.frameLocator(".email-preview-frame").getByRole("heading", {
      name: "You’re invited to PaperSign",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".email-preview-frame")).toHaveAttribute(
    "sandbox",
    "",
  );
  await expect(dialog).toContainText("Email delivery is not configured.");
  await expect(
    dialog.getByRole("button", { name: "Send invitation email", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  const closeButton = dialog.getByRole("button", {
    name: "Close email preview",
    exact: true,
  });
  if (
    !(await closeButton.evaluate(
      (element) => element === document.activeElement,
    ))
  )
    await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await noOverflow(page);
  await capture(page, "email-preview-390");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(previewButton).toBeFocused();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await expect(
    page.getByLabel("Usage statistics", { exact: true }),
  ).toBeVisible();
  await expect(show).toBeHidden();
  await noOverflow(page);
  await capture(page, "invitations-desktop");
});

test("Invite user opens the invitation form and moves keyboard focus to the name", async ({
  page,
  mockApi,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin?section=documents");
  await expect(page.getByRole("article")).toHaveCount(25);
  await page.getByRole("button", { name: "Invite user", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\?section=invitations$/);
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Role", exact: true }),
  ).toHaveValue("user");
  await expect(
    page.getByRole("heading", {
      name: "Invite someone to PaperSign",
      exact: true,
    }),
  ).toBeVisible();
  expect(mockApi.requests.every((request) => request.method === "GET")).toBe(
    true,
  );
  await noOverflow(page);
});
