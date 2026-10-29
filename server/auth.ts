import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, eq, gt, gte, like, ne, sql } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./schema.js";
import { twoFactor } from "./account-security-schema.js";
import { config } from "./config.js";
import { mailConfigured, sendSecurityMail } from "./mail.js";
import { emailHtml, type EmailDesign } from "./email-design.js";

const verifiedFactorPaths = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);
const sensitiveFactorPaths = new Set([
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
]);

/**
 * "Remember this browser": the authenticator code is skipped at sign-in for 7
 * days, counted from the code that remembered the browser. Better Auth would
 * renew the 7 days at every sign-in; rememberedBrowserLimit keeps the first
 * expiry. A sign-in this way is not marked mfaVerified, so Admin and security
 * changes still ask for a fresh code.
 */
export const REMEMBERED_BROWSER_SECONDS = 7 * 24 * 60 * 60;
const REMEMBERED_BROWSER_PREFIX = "trust-device-";
const rememberedBrowserRows = (userId: string) =>
  and(
    eq(schema.verification.value, userId),
    like(schema.verification.identifier, `${REMEMBERED_BROWSER_PREFIX}%`),
  );
export async function forgetRememberedBrowsers(userId: string) {
  const removed = await db
    .delete(schema.verification)
    .where(rememberedBrowserRows(userId))
    .returning({ id: schema.verification.id });
  return removed.length;
}
export async function rememberedBrowserCount(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.verification)
    .where(
      and(
        rememberedBrowserRows(userId),
        gt(schema.verification.expiresAt, new Date()),
      ),
    );
  return row?.count ?? 0;
}
const signInStarts = new WeakMap<object, { startedAt: Date; until?: Date }>();
// Requests that confirm a newly set-up authenticator.
const enrollments = new WeakSet<object>();
function rememberedBrowserLimit() {
  const signIn = (ctx: { path?: string }) => ctx.path === "/sign-in/email";
  return {
    id: "papersign-remembered-browser-limit",
    hooks: {
      // Registered after the two-factor plugin, so these run around its own
      // sign-in hook, which replaces the remembered-browser record.
      before: [
        {
          matcher: signIn,
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request) return;
            const cookie = ctx.context.createAuthCookie("trust_device", {
              maxAge: REMEMBERED_BROWSER_SECONDS,
            });
            const value = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret,
            );
            const identifier = value ? value.split("!")[1] : undefined;
            const record = identifier
              ? await ctx.context.internalAdapter.findVerificationValue(
                  identifier,
                )
              : null;
            signInStarts.set(ctx.request, {
              startedAt: new Date(),
              until: record?.expiresAt,
            });
          }),
        },
      ],
      after: [
        {
          matcher: signIn,
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.newSession?.user.id;
            if (!userId) return;
            const start = ctx.request
              ? signInStarts.get(ctx.request)
              : undefined;
            const since = new Date(
              (start?.startedAt.getTime() ?? Date.now() - 60_000) - 1_000,
            );
            const renewed = and(
              rememberedBrowserRows(userId),
              gte(schema.verification.createdAt, since),
            );
            // Keep the original expiry. Without it, fail closed: the next
            // sign-in asks for the authenticator code again.
            if (start?.until)
              await db
                .update(schema.verification)
                .set({
                  expiresAt: sql`least(${schema.verification.expiresAt}, ${start.until})`,
                })
                .where(renewed);
            else await db.delete(schema.verification).where(renewed);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

// Keep known and unknown account responses indistinguishable, including SMTP
// failures. Operators monitor delivery failures without logging tokens/bodies.
async function accountMail(
  to: string,
  subject: string,
  text: string,
  design: EmailDesign,
) {
  try {
    await sendSecurityMail({
      to,
      subject,
      text,
      html: emailHtml(text, design),
    });
  } catch {
    console.error("PaperSign account email delivery failed.");
  }
}
export const auth = betterAuth({
  appName: "PaperSign",
  // Better Auth may otherwise log a database exception containing token values.
  logger: {
    level: "error",
    log: () => console.error("PaperSign authentication request failed."),
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    transaction: true,
    schema: { ...schema, twoFactor },
  }),
  onAPIError: {
    onError: (error) => {
      if (
        !(error instanceof APIError) ||
        error.status === "INTERNAL_SERVER_ERROR"
      )
        console.error("PaperSign authentication request failed.");
    },
  },
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.APP_URL,
  trustedOrigins: [config.APP_URL],
  plugins: [
    twoFactorPlugin({
      issuer: "PaperSign",
      twoFactorCookieMaxAge: 300,
      trustDeviceMaxAge: REMEMBERED_BROWSER_SECONDS,
    }),
    rememberedBrowserLimit(),
  ],
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
        defaultValue: "user",
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    disableSignUp: config.REGISTRATION_ENABLED !== "true",
    autoSignIn: false,
    resetPasswordTokenExpiresIn: 30 * 60,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      // A pending second-factor challenge issued before the password reset must
      // not become a fresh authenticated session afterwards.
      await db
        .delete(schema.verification)
        .where(eq(schema.verification.value, user.id));
    },
    sendResetPassword: async ({ user, url }) => {
      void accountMail(
        user.email,
        "Reset your PaperSign password",
        `A password reset was requested for your PaperSign account.\n\nChoose a new password using this link within 30 minutes:\n${url}\n\nAll existing sessions will be signed out when you reset your password. Your authenticator remains enabled.\n\nIf you did not request this, ignore this email.\n\nPaperSign`,
        {
          heading: "Reset your password",
          preview:
            "Choose a new PaperSign password. This link expires in 30 minutes.",
          action: { label: "Reset password", url },
        },
      );
    },
  },
  emailVerification: {
    sendOnSignUp: mailConfigured(),
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      void accountMail(
        user.email,
        "Verify your PaperSign email address",
        `Confirm that this email address belongs to you by opening this link within one hour:\n${url}\n\nIf you did not request this, ignore this email.\n\nPaperSign`,
        {
          heading: "Verify your email address",
          preview:
            "Confirm your email address to use PaperSign. This link expires in one hour.",
          action: { label: "Verify email address", url },
        },
      );
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    additionalFields: {
      mfaVerified: {
        type: "boolean",
        required: true,
        defaultValue: false,
        input: false,
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, ctx) => ({
          data: {
            ...session,
            mfaVerified: verifiedFactorPaths.has(ctx?.path ?? ""),
          },
        }),
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (
        ["/request-password-reset", "/send-verification-email"].includes(
          ctx.path,
        ) &&
        !mailConfigured()
      )
        throw new APIError("SERVICE_UNAVAILABLE", {
          message:
            "Email delivery is not configured. Contact the administrator.",
        });
      // Only an authenticator code can remember a browser. Recovery codes are
      // for emergencies and must not leave a lasting shortcut behind.
      if (
        ctx.path.startsWith("/two-factor/") &&
        ctx.path !== "/two-factor/verify-totp" &&
        ctx.body?.trustDevice
      )
        throw new APIError("BAD_REQUEST", {
          message: "Only an authenticator code can remember this browser.",
        });
      if (verifiedFactorPaths.has(ctx.path) && ctx.request) {
        const active = await ctx.context.internalAdapter.findSession(
          (await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          )) || "",
        );
        if (active && !active.user.twoFactorEnabled)
          enrollments.add(ctx.request);
      }
      if (sensitiveFactorPaths.has(ctx.path)) {
        const active = await ctx.context.internalAdapter.findSession(
          (await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          )) || "",
        );
        if (
          active?.user.twoFactorEnabled &&
          !(active.session as { mfaVerified?: boolean }).mfaVerified
        )
          throw new APIError("FORBIDDEN", {
            message:
              "Confirm your authenticator code in Account security first.",
          });
        if (
          ctx.path === "/two-factor/disable" &&
          (active?.user as { role?: string } | undefined)?.role === "admin"
        )
          throw new APIError("FORBIDDEN", {
            message: "Administrators must keep two-step verification enabled.",
          });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Turning off the authenticator or changing the password forgets every
      // remembered browser, not only this one.
      if (
        ["/two-factor/disable", "/change-password"].includes(ctx.path) &&
        !(ctx.context.returned instanceof APIError)
      ) {
        const userId =
          ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
        if (userId) await forgetRememberedBrowsers(userId);
        return;
      }
      if (
        !verifiedFactorPaths.has(ctx.path) ||
        ctx.context.returned instanceof APIError
      )
        return;
      const result = ctx.context.returned as { token?: string } | undefined;
      const token = ctx.context.newSession?.session.token ?? result?.token;
      if (!token) return;
      const [active] = await db
        .update(schema.session)
        .set({ mfaVerified: true })
        .where(eq(schema.session.token, token))
        .returning();
      if (!active) return;
      // Enrollment also invalidates sessions established before the second
      // factor existed. A stolen older cookie must never gain Admin access.
      // Later codes leave remembered-browser sessions alone. Without the
      // request to tell, behave as enrollment.
      if (ctx.request && !enrollments.has(ctx.request)) return;
      await db
        .delete(schema.session)
        .where(
          and(
            eq(schema.session.userId, active.userId),
            ne(schema.session.id, active.id),
            eq(schema.session.mfaVerified, false),
          ),
        );
    }),
  },
  advanced: { ipAddress: { ipAddressHeaders: ["x-papersign-client-ip"] } },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    storage: "memory",
    customRules: {
      "/request-password-reset": { window: 600, max: 5 },
      "/send-verification-email": { window: 600, max: 5 },
      "/two-factor/*": { window: 60, max: 10 },
    },
  },
});
