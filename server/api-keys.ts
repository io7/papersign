import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { adminEvents, apiKeys, user } from "./schema.js";
import { sha256 } from "./storage.js";
import { adminMutation, audit, requireAdmin } from "./admin.js";
import type { AdminApiKey } from "../shared/admin-types.js";

export interface ApiKeyActor {
  keyId: string;
  prefix: string;
  user: typeof user.$inferSelect;
}
declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyActor | null;
  }
}

const KEY_PATTERN = /^psk_[A-Za-z0-9_-]{43}$/;
const INVALID_KEY = "This API key is invalid, expired or revoked.";
const MAX_ACTIVE_KEYS = 10;
const LAST_USED_RESOLUTION_MS = 60_000;
export const API_KEY_LIFETIMES = [30, 90, 365] as const;

// The only routes a key may call. A key prepares and follows signing requests
// for its owner; it never signs, manages accounts or reaches Admin.
const ALLOWED_ROUTES = new Set([
  "GET /api/documents",
  "POST /api/documents",
  "GET /api/documents/:id",
  "GET /api/documents/:id/pdf",
  "PUT /api/documents/:id/placements",
  "POST /api/documents/:id/invitations",
  "GET /api/documents/:id/invitations/:invitationId/email",
  "POST /api/documents/:id/invitations/:invitationId/email",
  "POST /api/documents/:id/invitations/:invitationId/reissue",
  "POST /api/documents/:id/invitations/:invitationId/revoke",
  "POST /api/documents/:id/cancel",
  "POST /api/documents/:id/deletion-request",
  "GET /api/documents/:id/history",
  "GET /api/documents/:id/record",
  "GET /api/documents/:id/record/pdf",
  "GET /api/documents/:id/record/evidence",
]);

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
}

export function generateApiKey() {
  const secret = `psk_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 12), keyHash: sha256(secret) };
}

function bearerSecret(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const secret = header.match(/^Bearer (\S+)$/)?.[1];
  if (!secret || !KEY_PATTERN.test(secret)) fail(401, INVALID_KEY);
  return secret;
}

// Runs before the browser request checks. Returns true when the request carries
// a valid key for an allowed route; session cookies are then ignored.
export async function authenticateApiKey(req: FastifyRequest) {
  const secret = bearerSecret(req);
  if (!secret) return false;
  const [row] = await db
    .select({ key: apiKeys, owner: user })
    .from(apiKeys)
    .innerJoin(user, eq(apiKeys.userId, user.id))
    .where(eq(apiKeys.keyHash, sha256(secret)));
  const now = new Date();
  if (
    !row ||
    row.key.revokedAt ||
    row.key.expiresAt <= now ||
    row.owner.role !== "admin" ||
    !row.owner.emailVerified ||
    !row.owner.twoFactorEnabled
  )
    fail(401, INVALID_KEY);
  if (!ALLOWED_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ""}`))
    fail(403, "API keys cannot use this endpoint.");
  if (
    !row.key.lastUsedAt ||
    now.getTime() - row.key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
  )
    await db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(eq(apiKeys.id, row.key.id));
  req.apiKey = { keyId: row.key.id, prefix: row.key.prefix, user: row.owner };
  return true;
}

export async function recordApiKeyRequest(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  if (!req.apiKey || req.method === "GET") return;
  try {
    const params = req.params as { id?: string } | undefined;
    await db.insert(adminEvents).values({
      id: randomUUID(),
      actorId: req.apiKey.user.id,
      event: "api_key_request",
      targetType: "api_key",
      targetId: req.apiKey.keyId,
      details: {
        prefix: req.apiKey.prefix,
        method: req.method,
        route: req.routeOptions.url,
        status: reply.statusCode,
        documentId: params?.id ?? null,
      },
    });
  } catch {
    req.log.error("API key request could not be recorded.");
  }
}

function keyState(key: typeof apiKeys.$inferSelect): AdminApiKey["state"] {
  if (key.revokedAt) return "revoked";
  return key.expiresAt <= new Date() ? "expired" : "active";
}
function publicKey(
  key: typeof apiKeys.$inferSelect,
  owner: { id: string; name: string; email: string },
): AdminApiKey {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    owner,
    state: keyState(key),
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
  search: z.string().trim().max(200).default(""),
});

export async function registerApiKeyRoutes(app: FastifyInstance) {
  app.get("/api/admin/api-keys", async (req) => {
    await requireAdmin(req);
    const { page, pageSize, search } = pageSchema.parse(req.query);
    const where = search
      ? or(
          ilike(apiKeys.name, `%${search}%`),
          ilike(apiKeys.prefix, `%${search}%`),
          ilike(user.name, `%${search}%`),
          ilike(user.email, `%${search}%`),
        )
      : undefined;
    const rows = await db
      .select({
        key: apiKeys,
        owner: { id: user.id, name: user.name, email: user.email },
      })
      .from(apiKeys)
      .innerJoin(user, eq(apiKeys.userId, user.id))
      .where(where)
      // Usable keys first; revoked and expired keys stay listed for the record.
      .orderBy(
        desc(
          sql`(${apiKeys.revokedAt} is null and ${apiKeys.expiresAt} > now())`,
        ),
        desc(apiKeys.createdAt),
        desc(apiKeys.id),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(apiKeys)
      .innerJoin(user, eq(apiKeys.userId, user.id))
      .where(where);
    return {
      items: rows.map((row) => publicKey(row.key, row.owner)),
      total: count.total,
      page,
      pageSize,
    };
  });
  app.post(
    "/api/admin/api-keys",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          lifetimeDays: z
            .union(API_KEY_LIFETIMES.map((days) => z.literal(days)))
            .default(90),
        })
        .strict()
        .parse(req.body);
      const created = await adminMutation(req, async (tx, actor) => {
        const [active] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.userId, actor.id),
              isNull(apiKeys.revokedAt),
              gt(apiKeys.expiresAt, new Date()),
            ),
          );
        if (active.total >= MAX_ACTIVE_KEYS)
          fail(
            409,
            `You can have up to ${MAX_ACTIVE_KEYS} active API keys. Revoke one before creating another.`,
          );
        const { secret, prefix, keyHash } = generateApiKey();
        const [key] = await tx
          .insert(apiKeys)
          .values({
            id: randomUUID(),
            name: body.name,
            userId: actor.id,
            prefix,
            keyHash,
            expiresAt: new Date(Date.now() + body.lifetimeDays * 86_400_000),
          })
          .returning();
        await audit(tx, actor.id, "api_key_created", "api_key", key.id, {
          name: key.name,
          prefix,
          expiresAt: key.expiresAt.toISOString(),
        });
        return {
          key: publicKey(key, {
            id: actor.id,
            name: actor.name,
            email: actor.email,
          }),
          secret,
        };
      });
      return reply.status(201).send(created);
    },
  );
  app.post("/api/admin/api-keys/:id/revoke", async (req) => {
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    return adminMutation(req, async (tx, actor) => {
      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: actor.id })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning();
      if (!revoked) fail(409, "This API key is already revoked.");
      await audit(tx, actor.id, "api_key_revoked", "api_key", revoked.id, {
        prefix: revoked.prefix,
        ownerId: revoked.userId,
      });
      return { ok: true };
    });
  });
}
