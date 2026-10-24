import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
const identities = vi.hoisted(
  () =>
    new Map<
      string,
      {
        id: string;
        name: string;
        email: string;
        emailVerified: boolean;
        twoFactorEnabled: boolean;
      }
    >(),
);
vi.mock("../server/auth.js", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const actor = identities.get(headers.get("x-test-user") ?? "");
        return actor
          ? {
              user: actor,
              session: {
                id: `session-${actor.id}`,
                mfaVerified: headers.get("x-test-mfa") === "yes",
              },
            }
          : null;
      },
    },
  },
}));
import { buildApp } from "../server/app.js";
import { db, pool } from "../server/db.js";
import { config } from "../server/config.js";
import {
  user,
  documents,
  exportsTable,
  invitations,
  audit,
  adminEvents,
} from "../server/schema.js";
import {
  storeFile,
  removeFile,
  loadFile,
  sha256,
  seal,
} from "../server/storage.js";
import {
  planDocumentDeletion,
  applyDocumentDeletion,
  resumeDocumentCleanup,
} from "../server/deletion.js";
import {
  accountStorageBytes,
  assertStorageBudget,
} from "../server/storage-usage.js";
import { samplePdf } from "./fixtures.js";
let app: FastifyInstance,
  owner: string,
  outsider: string,
  admin: string,
  docId: string,
  file: string,
  derived: string,
  bytes: Buffer;
const ids: string[] = [],
  files: string[] = [],
  docIds: string[] = [];
async function req(path: string, who = owner, body?: unknown, mfa = true) {
  return app.inject({
    method: body === undefined ? "GET" : "POST",
    url: `/api${path}`,
    remoteAddress: "127.63.0.1",
    headers: {
      origin: config.APP_URL,
      "x-papersign": "1",
      "x-test-user": who,
      "x-test-mfa": mfa ? "yes" : "no",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
describe("Record lifecycle, privacy requests and derived storage", () => {
  beforeEach(() => {
    config.DELETION_APPROVAL_REQUIRED = "false";
  });
  beforeAll(async () => {
    const url = new URL(config.DATABASE_URL);
    if (url.hostname !== "127.0.0.1" || url.port !== "54376")
      throw new Error("Local test database only");
    app = await buildApp();
    for (const role of ["owner", "outsider", "admin"]) {
      const id = randomUUID(),
        actor = {
          id,
          name: role,
          email: `${id}@example.invalid`,
          emailVerified: true,
          twoFactorEnabled: role === "admin",
        };
      identities.set(id, actor);
      ids.push(id);
      await db
        .insert(user)
        .values({ ...actor, role: role === "admin" ? "admin" : "user" });
    }
    [owner, outsider, admin] = ids;
    bytes = await samplePdf();
    file = await storeFile(bytes, "pdf");
    derived = await storeFile(
      Buffer.concat([bytes, Buffer.from("\n% stored derivative")]),
      "pdf",
    );
    files.push(file, derived);
    docId = randomUUID();
    docIds.push(docId);
    await db.insert(documents).values({
      id: docId,
      userId: owner,
      name: "Lifecycle fixture.pdf",
      fileKey: file,
      previewKey: file,
      sourceHash: sha256(bytes),
      byteSize: bytes.length,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    await db.insert(exportsTable).values({
      id: randomUUID(),
      documentId: docId,
      revision: 1,
      rasterize: false,
      originalKey: file,
      layers: [],
      state: "ready",
      fileKey: derived,
      sha256: sha256(
        Buffer.concat([bytes, Buffer.from("\n% stored derivative")]),
      ),
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (docIds.length) {
      await db.delete(audit).where(inArray(audit.documentId, docIds));
      await db
        .delete(invitations)
        .where(inArray(invitations.documentId, docIds));
      await db
        .delete(exportsTable)
        .where(inArray(exportsTable.documentId, docIds));
      await db.delete(documents).where(inArray(documents.id, docIds));
    }
    if (ids.length) {
      await db.delete(adminEvents).where(inArray(adminEvents.actorId, ids));
      await db.delete(user).where(inArray(user.id, ids));
    }
    await Promise.all(files.map(removeFile));
    await pool.end();
  });
  it("counts unique derived files and keeps trash charged to the owner", async () => {
    expect(await accountStorageBytes(owner)).toBe(
      bytes.length * 2 + Buffer.byteLength("\n% stored derivative"),
    );
    expect(await accountStorageBytes(outsider)).toBe(0);
    await expect(
      assertStorageBudget(owner, config.ACCOUNT_STORAGE_LIMIT_BYTES),
    ).rejects.toThrow("storage is full");
  });
  it("guards deletion by owner, exact name, current request and Admin MFA, and preserves reversible data", async () => {
    config.DELETION_APPROVAL_REQUIRED = "true";
    expect(
      (
        await req(`/documents/${docId}/deletion-request`, outsider, {
          revision: 1,
          confirmName: "Lifecycle fixture.pdf",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await req(`/documents/${docId}/deletion-request`, owner, {
          revision: 1,
          confirmName: "wrong",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await req(`/documents/${docId}/deletion-request`, owner, {
          revision: 1,
          confirmName: "Lifecycle fixture.pdf",
        })
      ).statusCode,
    ).toBe(200);
    const requests = (await req("/admin/deletion-requests", admin)).json();
    const requested = requests.documents.find((row: any) => row.id === docId);
    expect(requested.deletedAt).toBeNull();
    const decision = {
      approve: true,
      requestedAt: requested.requestedAt,
      reason: "Synthetic review",
    };
    expect(
      (
        await req(
          `/admin/deletion-requests/${docId}/decision`,
          admin,
          decision,
          false,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await req(`/admin/deletion-requests/${docId}/decision`, admin, {
          ...decision,
          requestedAt: new Date(0).toISOString(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await req(`/admin/deletion-requests/${docId}/decision`, admin, decision))
        .statusCode,
    ).toBe(200);
    expect((await req(`/documents/${docId}/pdf`)).statusCode).toBe(404);
    expect(await accountStorageBytes(owner)).toBe(
      bytes.length * 2 + Buffer.byteLength("\n% stored derivative"),
    );
    expect(
      (await req(`/documents/${docId}/restore`, outsider, {})).statusCode,
    ).toBe(404);
    expect(
      (await req(`/documents/${docId}/restore`, owner, {})).statusCode,
    ).toBe(200);
    expect(
      (await req(`/documents/${docId}/pdf`)).rawPayload.equals(bytes),
    ).toBe(true);
  });
  it("starts the approved recovery window on the owner's request without prior Admin approval", async () => {
    expect((await req("/privacy")).json().deletionApprovalRequired).toBe(false);
    const response = await req(`/documents/${docId}/deletion-request`, owner, {
      revision: 1,
      confirmName: "Lifecycle fixture.pdf",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().state).toBe("recoverable");
    const stored = await db.query.documents.findFirst({
      where: eq(documents.id, docId),
    });
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect((await req(`/documents/${docId}/pdf`)).statusCode).toBe(404);
    const plan = await planDocumentDeletion(docId, admin);
    await expect(
      applyDocumentDeletion(
        docId,
        admin,
        plan.fingerprint,
        "Synthetic premature purge",
      ),
    ).rejects.toThrow("recovery window");
    expect(
      (await req(`/documents/${docId}/restore`, owner, {})).statusCode,
    ).toBe(200);
    expect(
      (await req(`/documents/${docId}/pdf`)).rawPayload.equals(bytes),
    ).toBe(true);
  });
  it("rotates an unfinished invitation and cancellation prevents further signing", async () => {
    const id = randomUUID(),
      invitationId = randomUUID(),
      token = randomBytes(32).toString("base64url");
    docIds.push(id);
    await db.insert(documents).values({
      id,
      userId: owner,
      name: "Request fixture.pdf",
      fileKey: file,
      previewKey: file,
      sourceHash: sha256(bytes),
      byteSize: bytes.length,
      pages: [{ width: 612, height: 792, rotation: 0 }],
      status: "awaiting",
    });
    await db.insert(invitations).values({
      id: invitationId,
      documentId: id,
      name: "Synthetic signer",
      email: "signer@example.invalid",
      signingOrder: 1,
      tokenHash: sha256(token),
      sealedToken: seal(token),
      field: {
        id: randomUUID(),
        pageIndex: 0,
        x: 0.1,
        y: 0.6,
        width: 0.3,
        height: 0.1,
      },
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(
      (
        await req(`/documents/${id}/deletion-request`, owner, {
          revision: 1,
          confirmName: "Request fixture.pdf",
        })
      ).statusCode,
    ).toBe(409);
    const renewed = await req(
      `/documents/${id}/invitations/${invitationId}/reissue`,
      owner,
      { revision: 1 },
    );
    expect(renewed.statusCode, renewed.body).toBe(200);
    const next = renewed.json().url.split("/").pop();
    expect(next).not.toBe(token);
    expect((await req(`/sign/${token}`)).statusCode).toBe(404);
    expect(
      (
        await req(`/documents/${id}/cancel`, owner, {
          revision: 1,
          reason: "stale",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await req(`/documents/${id}/cancel`, owner, {
          revision: 2,
          reason: "Synthetic cancellation",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await req(
          `/documents/${id}/invitations/${invitationId}/reissue`,
          owner,
          { revision: 3 },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await db.query.invitations.findFirst({
        where: eq(invitations.id, invitationId),
      }))!.state,
    ).toBe("revoked");
  });
  it("exports an account index without credentials and makes account deletion a withdrawable review request", async () => {
    const index = (await req("/account/data-index")).json();
    expect(index.account.id).toBe(owner);
    expect(index.documents.every((row: any) => docIds.includes(row.id))).toBe(
      true,
    );
    expect(JSON.stringify(index)).not.toMatch(/password|tokenHash|sealedToken/);
    expect(
      (
        await req("/account/deletion-request", owner, {
          confirmEmail: identities.get(outsider)!.email,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await req("/account/deletion-request", owner, {
          confirmEmail: identities.get(owner)!.email,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await req("/admin/deletion-requests", admin))
        .json()
        .accounts.some((row: any) => row.id === owner),
    ).toBe(true);
    expect(
      (await req("/account/deletion-request/withdraw", owner, {})).statusCode,
    ).toBe(200);
    expect(
      (await db.query.user.findFirst({ where: eq(user.id, owner) }))!
        .deletionRequestedAt,
    ).toBeNull();
  });
  it("requires an approved current deletion plan and elapsed recovery window, preserving shared files", async () => {
    const id = randomUUID(),
      original = await storeFile(bytes, "pdf");
    docIds.push(id);
    files.push(original);
    await db.insert(documents).values({
      id,
      userId: owner,
      name: "Purge fixture.pdf",
      fileKey: original,
      previewKey: file,
      sourceHash: sha256(bytes),
      byteSize: bytes.length,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    await expect(planDocumentDeletion(id, owner)).rejects.toThrow(
      "existing Admin",
    );
    await expect(planDocumentDeletion(id, admin)).rejects.toThrow(
      "requested and approved",
    );
    await db
      .update(documents)
      .set({ deletionRequestedAt: new Date(), deletedAt: new Date() })
      .where(eq(documents.id, id));
    const early = await planDocumentDeletion(id, admin);
    await expect(
      applyDocumentDeletion(id, admin, early.fingerprint, "Synthetic fixture"),
    ).rejects.toThrow("recovery window");
    const old = new Date(
      Date.now() - (config.DELETION_GRACE_DAYS + 1) * 86400_000,
    );
    await db
      .update(documents)
      .set({ deletionRequestedAt: old, deletedAt: old })
      .where(eq(documents.id, id));
    await expect(
      applyDocumentDeletion(id, admin, early.fingerprint, "Synthetic fixture"),
    ).rejects.toThrow("plan changed");
    const approved = await planDocumentDeletion(id, admin);
    const result = await applyDocumentDeletion(
      id,
      admin,
      approved.fingerprint,
      "Synthetic fixture only",
    );
    expect(result).toMatchObject({
      removedFiles: 1,
      sharedFilesRetained: 1,
      cleanupRequired: [],
    });
    expect(
      await db.query.documents.findFirst({ where: eq(documents.id, id) }),
    ).toBeUndefined();
    expect((await loadFile(file)).equals(bytes)).toBe(true);
    await expect(loadFile(original)).rejects.toThrow();
    const tombstone = await db.query.adminEvents.findFirst({
      where: eq(adminEvents.targetId, id),
    });
    expect(tombstone?.event).toBe("document_permanently_deleted");
    expect(tombstone?.details).toMatchObject({
      planFingerprint: approved.fingerprint,
      sourceHash: sha256(bytes),
    });
    await expect(
      resumeDocumentCleanup(id, owner, approved.fingerprint),
    ).rejects.toThrow("existing Admin");
    await expect(
      resumeDocumentCleanup(id, admin, "0".repeat(64)),
    ).rejects.toThrow("fingerprint");
    expect(
      await resumeDocumentCleanup(id, admin, approved.fingerprint),
    ).toMatchObject({
      removedFiles: 1,
      sharedFilesRetained: 1,
      cleanupRequired: [],
    });
    expect((await loadFile(file)).equals(bytes)).toBe(true);
  });
});
