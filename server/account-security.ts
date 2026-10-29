import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import {
  auth,
  forgetRememberedBrowsers,
  rememberedBrowserCount,
} from "./auth.js";
import { db } from "./db.js";
import { session, user } from "./schema.js";
import { config } from "./config.js";
import { mailConfigured } from "./mail.js";

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
}
export function requireAccountVerification(actor: { emailVerified: boolean }) {
  if (!actor.emailVerified)
    fail(
      403,
      "Verify your email address in Account security before signing or inviting others.",
    );
}
export function requireAdminMfa(active: {
  user: { twoFactorEnabled?: boolean };
  session: { mfaVerified?: boolean };
}) {
  if (!active.user.twoFactorEnabled || !active.session.mfaVerified)
    fail(
      403,
      "Set up or confirm two-step verification in Account security to access Admin.",
    );
}
async function current(req: FastifyRequest) {
  const active = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!active) fail(401, "Sign in to continue.");
  return active;
}
export async function registerAccountSecurityRoutes(app: FastifyInstance) {
  app.get("/api/account/security", async (req) => {
    const active = await current(req);
    const account = await db.query.user.findFirst({
      where: eq(user.id, active.user.id),
    });
    if (!account) fail(401, "Sign in to continue.");
    const sessions = await db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(
        and(eq(session.userId, account.id), gt(session.expiresAt, new Date())),
      )
      .orderBy(desc(session.createdAt));
    return {
      email: account.email,
      emailVerified: account.emailVerified,
      twoFactorEnabled: account.twoFactorEnabled,
      mfaVerified: active.session.mfaVerified,
      admin: account.role === "admin",
      emailEnabled: mailConfigured(),
      rememberedBrowsers: await rememberedBrowserCount(account.id),
      sessions: sessions.map((item) => ({
        ...item,
        current: item.id === active.session.id,
      })),
    };
  });
  app.post(
    "/api/account/verify-email",
    {
      config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
    },
    async (req) => {
      const active = await current(req);
      if (!mailConfigured())
        fail(
          503,
          "Email delivery is not configured. Contact the administrator.",
        );
      if (!active.user.emailVerified)
        await auth.api.sendVerificationEmail({
          headers: fromNodeHeaders(req.headers),
          body: {
            email: active.user.email,
            callbackURL: `${config.APP_URL}/account?verified=1`,
          },
        });
      return { ok: true };
    },
  );
  app.post("/api/account/remembered-browsers/forget", async (req) => {
    const active = await current(req);
    return { forgotten: await forgetRememberedBrowsers(active.user.id) };
  });
  app.post("/api/account/sessions/revoke-others", async (req) => {
    const active = await current(req);
    await db
      .delete(session)
      .where(
        and(
          eq(session.userId, active.user.id),
          ne(session.id, active.session.id),
        ),
      );
    return { ok: true };
  });
  app.post("/api/account/sessions/:id/revoke", async (req) => {
    const active = await current(req);
    const id = z
      .string()
      .min(1)
      .max(128)
      .parse((req.params as { id: string }).id);
    if (id === active.session.id)
      fail(400, "Use Sign out to end your current session.");
    await db
      .delete(session)
      .where(and(eq(session.id, id), eq(session.userId, active.user.id)));
    return { ok: true };
  });
}
