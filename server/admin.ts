import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { hashPassword } from "better-auth/crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, ilike, or, sql, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { sendSecurityMail } from "./mail.js";
import { emailHtml } from "./email-design.js";
import { auth } from "./auth.js";
import {
  requireAccountVerification,
  requireAdminMfa,
} from "./account-security.js";
import { operationalChecks } from "./operations.js";
import { config, emailEnabled } from "./config.js";
import { db } from "./db.js";
import {
  account,
  accountInvitations,
  adminEvents,
  documents,
  user,
} from "./schema.js";
import { loadFile, seal, sha256, unseal } from "./storage.js";
import type { CurrentUser, UserRole } from "../shared/admin-types.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select" | "query">;
const roleSchema = z.enum(["admin", "user"]);
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
}
const id = (req: FastifyRequest) =>
  z
    .string()
    .min(1)
    .max(128)
    .parse((req.params as { id?: string }).id);
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
  search: z.string().trim().max(200).default(""),
});
const publicUser = (row: typeof user.$inferSelect): CurrentUser => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role as UserRole,
  emailVerified: row.emailVerified,
  twoFactorEnabled: row.twoFactorEnabled,
});
async function sessionUser(req: FastifyRequest) {
  return (
    (await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }))
      ?.user ?? null
  );
}
async function currentUser(req: FastifyRequest, reader: Reader = db) {
  const session = await sessionUser(req);
  if (!session) return null;
  return (
    (await reader.query.user.findFirst({ where: eq(user.id, session.id) })) ??
    null
  );
}
export async function requireAdmin(req: FastifyRequest, reader: Reader = db) {
  const active = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  const actor = await currentUser(req, reader);
  if (!actor || !active) fail(401, "Sign in to continue.");
  if (actor.role !== "admin") fail(403, "Administrator access is required.");
  requireAccountVerification(actor);
  requireAdminMfa({ user: actor, session: active.session });
  return actor;
}
// All role and invitation mutations, including the first-admin CLI, use this
// transaction lock. Rechecking the actor after taking it prevents stale grants.
export async function lockAdministration(tx: Transaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(142, 41001)`);
}
export async function adminMutation<T>(
  req: FastifyRequest,
  work: (tx: Transaction, actor: typeof user.$inferSelect) => Promise<T>,
) {
  // Resolve the session before reserving a transaction connection. Waiting
  // mutation transactions must not fill the pool while the lock holder needs
  // another connection for BetterAuth's session lookup.
  const active = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!active) fail(401, "Sign in to continue.");
  return db.transaction(async (tx) => {
    await lockAdministration(tx);
    const actor = await tx.query.user.findFirst({
      where: eq(user.id, active.user.id),
    });
    if (!actor) fail(401, "Sign in to continue.");
    if (actor.role !== "admin") fail(403, "Administrator access is required.");
    requireAccountVerification(actor);
    requireAdminMfa({ user: actor, session: active.session });
    return work(tx, actor);
  });
}
export function audit(
  tx: Pick<Transaction, "insert">,
  actorId: string,
  event: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
) {
  return tx.insert(adminEvents).values({
    id: randomUUID(),
    actorId,
    event,
    targetType,
    targetId,
    details,
  });
}
const activeInvitation = (invitation: typeof accountInvitations.$inferSelect) =>
  invitation.state === "pending" && invitation.expiresAt > new Date();
function publicInvitation(invitation: typeof accountInvitations.$inferSelect) {
  const active = activeInvitation(invitation);
  return {
    id: invitation.id,
    name: invitation.name,
    email: invitation.email,
    role: invitation.role,
    state:
      invitation.state === "pending" && !active ? "expired" : invitation.state,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    acceptedAt: invitation.acceptedAt,
    url: active
      ? `${config.APP_URL}/join/${unseal(invitation.sealedToken)}`
      : null,
  };
}
const tokenHash = (req: FastifyRequest) => {
  const token = (req.params as { token: string }).token;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    fail(404, "This account invitation is no longer available.");
  return sha256(token);
};
async function invitationForToken(req: FastifyRequest, reader: Reader = db) {
  const invitation = await reader.query.accountInvitations.findFirst({
    where: eq(accountInvitations.tokenHash, tokenHash(req)),
  });
  if (!invitation || !activeInvitation(invitation))
    fail(404, "This account invitation is no longer available.");
  return invitation;
}
function emailPreview(
  invitation: typeof accountInvitations.$inferSelect,
  sender: string,
) {
  const url = `${config.APP_URL}/join/${unseal(invitation.sealedToken)}`;
  const body = `Hello ${invitation.name},\n\n${sender} has invited you to join PaperSign as ${invitation.role === "admin" ? "an Admin" : "a User"}.\n\nCreate your account using your private invitation link:\n${url}\n\nThis link expires on ${invitation.expiresAt.toISOString().slice(0, 10)}. If you already have an account with this email address, sign in before accepting.\n\nPaperSign`;
  return {
    to: invitation.email,
    subject: `${sender} invited you to PaperSign`,
    body,
    html: emailHtml(body, {
      heading: "You’re invited to PaperSign",
      preview: `${sender} invited you to join PaperSign.`,
      action: { label: "Accept invitation", url },
    }),
    attachments: [],
  };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/me", async (req) => {
    const actor = await currentUser(req);
    const active = actor
      ? await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
      : null;
    return {
      user: actor
        ? {
            ...publicUser(actor),
            mfaVerified: active?.session.mfaVerified === true,
          }
        : null,
    };
  });
  app.get("/api/admin/operations", async (req) => {
    await requireAdmin(req);
    return { checks: await operationalChecks(true) };
  });
  app.get("/api/admin/deletion-requests", async (req) => {
    await requireAdmin(req);
    const documentRequests = await db
      .select({
        id: documents.id,
        name: documents.name,
        requestedAt: documents.deletionRequestedAt,
        deletedAt: documents.deletedAt,
        ownerEmail: user.email,
      })
      .from(documents)
      .innerJoin(user, eq(documents.userId, user.id))
      .where(isNotNull(documents.deletionRequestedAt))
      .orderBy(desc(documents.deletionRequestedAt))
      .limit(200);
    const accountRequests = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        requestedAt: user.deletionRequestedAt,
      })
      .from(user)
      .where(isNotNull(user.deletionRequestedAt))
      .limit(200);
    return {
      documents: documentRequests,
      accounts: accountRequests,
      recoveryDays: config.DELETION_GRACE_DAYS,
    };
  });
  app.post("/api/admin/deletion-requests/:id/decision", async (req) => {
    const documentId = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      body = z
        .object({
          approve: z.boolean(),
          requestedAt: z.string().datetime(),
          reason: z.string().trim().min(1).max(500),
        })
        .parse(req.body);
    return adminMutation(req, async (tx, actor) => {
      await tx.execute(
        sql`select id from document where id = ${documentId} for update`,
      );
      const document = await tx.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (
        !document?.deletionRequestedAt ||
        document.deletionRequestedAt.toISOString() !== body.requestedAt
      )
        fail(409, "This deletion request changed. Reload before deciding.");
      if (document.status === "awaiting")
        fail(
          409,
          "The signing request must be cancelled before deletion can be approved.",
        );
      if (document.deletedAt)
        fail(409, "This deletion is already in its recovery window.");
      await tx
        .update(documents)
        .set(
          body.approve
            ? { deletedAt: new Date(), updatedAt: new Date() }
            : {
                deletionRequestedAt: null,
                deletedAt: null,
                updatedAt: new Date(),
              },
        )
        .where(eq(documents.id, documentId));
      await audit(
        tx,
        actor.id,
        body.approve
          ? "document_deletion_approved"
          : "document_deletion_declined",
        "document",
        documentId,
        { reason: body.reason, recoveryDays: config.DELETION_GRACE_DAYS },
      );
      return { ok: true };
    });
  });
  app.get("/api/admin/summary", async (req) => {
    await requireAdmin(req);
    const result = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM "user") AS "users",
        (SELECT count(*)::int FROM "user" WHERE role = 'admin') AS "admins",
        (SELECT count(*)::int FROM document) AS "documents",
        (SELECT count(*)::int FROM document WHERE status = 'awaiting') AS "documentsAwaiting",
        (SELECT count(*)::int FROM document WHERE status = 'completed') AS "documentsCompleted",
        (SELECT count(*)::int FROM signature WHERE deleted_at IS NULL) AS "storedSignatures",
        (SELECT coalesce(sum(byte_size), 0)::float8 FROM document) AS "uploadedBytes",
        (SELECT count(*)::int FROM account_invitation WHERE state = 'pending' AND expires_at > now()) AS "pendingAccountInvitations"
    `);
    return result.rows[0];
  });
  app.get("/api/admin/users", async (req) => {
    await requireAdmin(req);
    const { page, pageSize, search } = pageSchema.parse(req.query);
    const where = search
      ? or(ilike(user.name, `%${search}%`), ilike(user.email, `%${search}%`))
      : undefined;
    const items = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        documentCount: sql<number>`(select count(*)::int from document where document.user_id = "user"."id")`,
        signatureCount: sql<number>`(select count(*)::int from signature where signature.user_id = "user"."id" and signature.deleted_at is null)`,
      })
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt), desc(user.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(user)
      .where(where);
    return { items, total: count.total, page, pageSize };
  });
  app.patch("/api/admin/users/:id/role", async (req) => {
    const body = z
      .object({ role: roleSchema, expectedRole: roleSchema })
      .strict()
      .parse(req.body);
    return adminMutation(req, async (tx, actor) => {
      const target = await tx.query.user.findFirst({
        where: eq(user.id, id(req)),
      });
      if (!target) fail(404, "User not found.");
      if (target.role !== body.expectedRole)
        fail(409, "This user's role changed. Reload the user list.");
      if (target.role === body.role) return { user: publicUser(target) };
      if (target.role === "admin" && body.role === "user") {
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(user)
          .where(eq(user.role, "admin"));
        if (count.total <= 1) fail(409, "Keep at least one Admin account.");
      }
      const [updated] = await tx
        .update(user)
        .set({ role: body.role, updatedAt: new Date() })
        .where(eq(user.id, target.id))
        .returning();
      await audit(tx, actor.id, "user_role_changed", "user", target.id, {
        previousRole: target.role,
        role: body.role,
      });
      return { user: publicUser(updated) };
    });
  });
  app.get("/api/admin/documents", async (req) => {
    await requireAdmin(req);
    const { page, pageSize, search, userId } = pageSchema
      .extend({ userId: z.string().min(1).max(128).optional() })
      .parse(req.query);
    const where = and(
      userId ? eq(documents.userId, userId) : undefined,
      search
        ? or(
            ilike(documents.name, `%${search}%`),
            ilike(user.name, `%${search}%`),
            ilike(user.email, `%${search}%`),
          )
        : undefined,
    );
    const items = await db
      .select({
        id: documents.id,
        name: documents.name,
        owner: { id: user.id, name: user.name, email: user.email },
        status: documents.status,
        byteSize: documents.byteSize,
        pageCount: sql<number>`jsonb_array_length(${documents.pages})`,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .innerJoin(user, eq(documents.userId, user.id))
      .where(where)
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(documents)
      .innerJoin(user, eq(documents.userId, user.id))
      .where(where);
    return { items, total: count.total, page, pageSize };
  });
  app.get("/api/admin/documents/:id/pdf", async (req, reply) => {
    const actor = await requireAdmin(req);
    const document = await db.query.documents.findFirst({
      where: eq(documents.id, id(req)),
    });
    if (!document) fail(404, "Document not found.");
    const bytes = await loadFile(document.fileKey);
    await audit(
      db,
      actor.id,
      "document_original_viewed",
      "document",
      document.id,
      { ownerId: document.userId },
    );
    return reply
      .header(
        "Content-Disposition",
        `inline; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      )
      .type("application/pdf")
      .send(bytes);
  });
  app.get("/api/admin/account-invitations", async (req) => {
    await requireAdmin(req);
    const { page, pageSize, search } = pageSchema.parse(req.query);
    const where = search
      ? or(
          ilike(accountInvitations.name, `%${search}%`),
          ilike(accountInvitations.email, `%${search}%`),
        )
      : undefined;
    const items = await db
      .select()
      .from(accountInvitations)
      .where(where)
      .orderBy(desc(accountInvitations.createdAt), desc(accountInvitations.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(accountInvitations)
      .where(where);
    return {
      items: items.map(publicInvitation),
      total: count.total,
      page,
      pageSize,
    };
  });
  app.post(
    "/api/admin/account-invitations",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(100),
          email: z
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
          role: roleSchema.default("user"),
        })
        .strict()
        .parse(req.body);
      const invitation = await adminMutation(req, async (tx, actor) => {
        if (
          await tx.query.user.findFirst({ where: eq(user.email, body.email) })
        )
          fail(
            409,
            "This email already has an account. Change its role in Users instead.",
          );
        if (
          await tx.query.accountInvitations.findFirst({
            where: and(
              eq(accountInvitations.email, body.email),
              eq(accountInvitations.state, "pending"),
              gt(accountInvitations.expiresAt, new Date()),
            ),
          })
        )
          fail(
            409,
            "An active account invitation already exists for this email.",
          );
        const token = randomBytes(32).toString("base64url");
        const [created] = await tx
          .insert(accountInvitations)
          .values({
            id: randomUUID(),
            ...body,
            tokenHash: sha256(token),
            sealedToken: seal(token),
            createdBy: actor.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          })
          .returning();
        await audit(
          tx,
          actor.id,
          "account_invitation_created",
          "account_invitation",
          created.id,
          { email: body.email, role: body.role },
        );
        return publicInvitation(created);
      });
      return reply.status(201).send(invitation);
    },
  );
  app.post("/api/admin/account-invitations/:id/revoke", async (req) =>
    adminMutation(req, async (tx, actor) => {
      const [revoked] = await tx
        .update(accountInvitations)
        .set({ state: "revoked" })
        .where(
          and(
            eq(accountInvitations.id, id(req)),
            eq(accountInvitations.state, "pending"),
          ),
        )
        .returning();
      if (!revoked)
        fail(409, "Only a pending account invitation can be revoked.");
      await audit(
        tx,
        actor.id,
        "account_invitation_revoked",
        "account_invitation",
        revoked.id,
      );
      return { ok: true };
    }),
  );
  app.get("/api/admin/account-invitations/:id/email", async (req) => {
    const actor = await requireAdmin(req);
    const invitation = await db.query.accountInvitations.findFirst({
      where: eq(accountInvitations.id, id(req)),
    });
    if (!invitation || !activeInvitation(invitation))
      fail(409, "This account invitation is no longer active.");
    const preview = emailPreview(invitation, actor.name);
    return {
      ...preview,
      previewHash: sha256(JSON.stringify(preview)),
      enabled: emailEnabled,
    };
  });
  app.post(
    "/api/admin/account-invitations/:id/email",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const body = z
        .object({ previewHash: z.string().length(64) })
        .strict()
        .parse(req.body);
      return adminMutation(req, async (tx, actor) => {
        if (!emailEnabled)
          fail(
            503,
            "Email delivery is not configured. Copy the invitation link instead.",
          );
        const invitation = await tx.query.accountInvitations.findFirst({
          where: eq(accountInvitations.id, id(req)),
        });
        if (!invitation || !activeInvitation(invitation))
          fail(409, "This account invitation is no longer active.");
        const preview = emailPreview(invitation, actor.name);
        if (sha256(JSON.stringify(preview)) !== body.previewHash)
          fail(409, "The invitation changed. Review the email again.");
        await sendSecurityMail({
          to: preview.to,
          subject: preview.subject,
          text: preview.body,
          html: preview.html,
        });
        await audit(
          tx,
          actor.id,
          "account_invitation_email_accepted",
          "account_invitation",
          invitation.id,
        );
        return { ok: true };
      });
    },
  );
  app.get(
    "/api/account-invitations/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const invitation = await invitationForToken(req);
      return {
        name: invitation.name,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      };
    },
  );
  app.post(
    "/api/account-invitations/:token/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          password: z.string().min(12).max(128).optional(),
        })
        .strict()
        .parse(req.body);
      // Reject dead links before expensive hashing; the transaction checks again.
      const preview = await invitationForToken(req);
      const existing = await db.query.user.findFirst({
        where: eq(user.email, preview.email),
      });
      const signedIn = await sessionUser(req);
      if (
        signedIn &&
        signedIn.email.toLowerCase() !== preview.email.toLowerCase()
      )
        fail(
          409,
          "You are signed in with a different account. Sign out before accepting this invitation.",
        );
      if (existing && signedIn?.id !== existing.id)
        fail(
          409,
          "This email already has an account. Sign in with that account to accept the invitation.",
        );
      if (!existing && (!body.name || !body.password))
        fail(400, "Enter your name and a password of at least 12 characters.");
      const passwordHash = !existing
        ? await hashPassword(body.password!)
        : null;
      const result = await db.transaction(async (tx) => {
        await lockAdministration(tx);
        const invitation = await invitationForToken(req, tx);
        const current = await tx.query.user.findFirst({
          where: eq(user.email, invitation.email),
        });
        let acceptedUser: typeof user.$inferSelect;
        if (current) {
          if (signedIn?.id !== current.id)
            fail(
              409,
              "This email already has an account. Sign in with that account to accept the invitation.",
            );
          acceptedUser = current;
          if (invitation.role === "admin" && current.role !== "admin") {
            [acceptedUser] = await tx
              .update(user)
              .set({ role: "admin", updatedAt: new Date() })
              .where(eq(user.id, current.id))
              .returning();
            await audit(
              tx,
              current.id,
              "user_role_changed",
              "user",
              current.id,
              {
                previousRole: current.role,
                role: "admin",
                invitationId: invitation.id,
              },
            );
          }
        } else {
          if (!passwordHash || !body.name)
            fail(409, "Reload this invitation to create your account.");
          const userId = randomUUID();
          const created = await tx
            .insert(user)
            .values({
              id: userId,
              name: body.name,
              email: invitation.email,
              role: invitation.role,
              emailVerified: false,
            })
            .onConflictDoNothing({ target: user.email })
            .returning();
          if (!created.length)
            fail(
              409,
              "This email already has an account. Sign in with that account to accept the invitation.",
            );
          acceptedUser = created[0];
          await tx.insert(account).values({
            id: randomUUID(),
            userId,
            accountId: userId,
            providerId: "credential",
            password: passwordHash,
          });
        }
        await tx
          .update(accountInvitations)
          .set({
            state: "accepted",
            acceptedBy: acceptedUser.id,
            acceptedAt: new Date(),
          })
          .where(eq(accountInvitations.id, invitation.id));
        await audit(
          tx,
          acceptedUser.id,
          "account_invitation_accepted",
          "account_invitation",
          invitation.id,
          { createdBy: invitation.createdBy, role: acceptedUser.role },
        );
        return { ok: true, email: acceptedUser.email };
      });
      return reply.status(200).send(result);
    },
  );
}
