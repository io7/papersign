import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, eq, ne } from "drizzle-orm";
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
    twoFactorPlugin({ issuer: "PaperSign", twoFactorCookieMaxAge: 300 }),
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
      // Trusted-device bypass would weaken the Admin policy. Every fresh login
      // must prove possession of the authenticator or a one-use recovery code.
      if (ctx.path.startsWith("/two-factor/") && ctx.body?.trustDevice)
        throw new APIError("BAD_REQUEST", {
          message: "Use your authenticator for each sign-in.",
        });
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
