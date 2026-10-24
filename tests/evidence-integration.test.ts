import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db.js";
import { config } from "../server/config.js";
import { audit, documents, exportsTable, user } from "../server/schema.js";
import { evidenceRecords } from "../server/evidence-schema.js";
import {
  completedEvidence,
  evidenceTimestampStatus,
  ensureCanonicalExport,
  recordAcceptance,
  recordFinalization,
  retainReview,
  verifiedEvidenceFile,
} from "../server/evidence.js";
import { buildEvidenceArchive } from "../server/evidence-archive.js";
import { verifyEvidenceDirectory } from "../server/evidence-verifier.js";
import {
  timestampCompletedEvidence,
  requestEvidenceTimestamp,
  processPendingEvidenceTimestamp,
} from "../server/evidence-timestamp.js";
import { verifyEvidenceTimestamp } from "../server/evidence-timestamp-core.js";
import { evidenceTimestamps } from "../server/evidence-schema.js";
import {
  createSealPkiFixture,
  fixturePolicyOid,
  type SealPkiFixture,
} from "./helpers/seal-pki.js";
import { filePath, removeFile, sha256, storeFile } from "../server/storage.js";
import { renderPdf } from "../server/pdf.js";

const integration = process.env.EVIDENCE_DB_INTEGRATION === "1";
const execute = promisify(execFile);
describe.skipIf(!integration)("durable evidence integration", () => {
  const documentId = randomUUID(),
    userId = `evidence-test-${randomUUID()}`;
  const actor = `owner:${userId}`,
    keys = new Set<string>();
  let directory: string;
  let pki: SealPkiFixture | undefined;
  afterAll(async () => {
    try {
      await db
        .delete(evidenceTimestamps)
        .where(eq(evidenceTimestamps.documentId, documentId));
      await db
        .delete(evidenceRecords)
        .where(eq(evidenceRecords.documentId, documentId));
      await db.delete(audit).where(eq(audit.documentId, documentId));
      await db
        .delete(exportsTable)
        .where(eq(exportsTable.documentId, documentId));
      await db.delete(documents).where(eq(documents.id, documentId));
      await db.delete(user).where(eq(user.id, userId));
    } finally {
      for (const key of keys) await removeFile(key);
      if (directory) await rm(directory, { recursive: true, force: true });
      if (pki) await pki.cleanup();
      await pool.end();
    }
  });
  it("retains reviewed bytes and acceptance atomically, freezes one canonical PDF, and verifies an extracted independent package", async () => {
    const url = new URL(config.DATABASE_URL);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error(
        "Evidence integration is restricted to the isolated local database.",
      );
    directory = await mkdtemp(
      join(tmpdir(), "papersign-evidence-integration-"),
    );
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 500]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Synthetic acceptance integration fixture", {
      x: 20,
      y: 460,
      size: 12,
      font,
    });
    pdf
      .addPage([400, 500])
      .drawText("Second signature page", { x: 20, y: 460, size: 12, font });
    const original = Buffer.from(await pdf.save());
    const originalKey = await storeFile(original, "pdf");
    keys.add(originalKey);
    const canvas = createCanvas(200, 60),
      context = canvas.getContext("2d");
    context.strokeStyle = "#172c25";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(10, 40);
    context.bezierCurveTo(70, 0, 90, 60, 180, 10);
    context.stroke();
    const signatureBytes = await canvas.encode("png");
    const signatureKey = await storeFile(signatureBytes, "png");
    keys.add(signatureKey);
    context.beginPath();
    context.moveTo(20, 52);
    context.lineTo(170, 40);
    context.stroke();
    const secondSignatureBytes = await canvas.encode("png"),
      secondSignatureKey = await storeFile(secondSignatureBytes, "png");
    keys.add(secondSignatureKey);
    const layer = {
      id: randomUUID(),
      imageKey: signatureKey,
      pageIndex: 0,
      x: 0.1,
      y: 0.7,
      width: 0.5,
      height: 0.12,
    };
    const secondLayer = {
      ...layer,
      id: randomUUID(),
      imageKey: secondSignatureKey,
      pageIndex: 1,
    };
    const layers = [layer, secondLayer];
    await db.insert(user).values({
      id: userId,
      name: "Evidence fixture owner",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    });
    await db.insert(documents).values({
      id: documentId,
      userId,
      name: "Evidence fixture.pdf",
      fileKey: originalKey,
      sourceHash: sha256(original),
      byteSize: original.length,
      pages: [
        { width: 400, height: 500 },
        { width: 400, height: 500 },
      ],
      status: "draft",
    });
    const review = await db.transaction((tx) =>
      retainReview(tx, { documentId, actor, revision: 1, bytes: original }),
    );
    keys.add(review.fileKey);
    const repeated = await db.transaction((tx) =>
      retainReview(tx, {
        documentId,
        actor,
        revision: 1,
        bytes: Buffer.from("different rerender metadata"),
      }),
    );
    expect(repeated).toEqual(review);
    expect(await verifiedEvidenceFile(review.fileKey, review.sha256)).toEqual(
      original,
    );
    const acceptanceInput = {
      documentId,
      actor,
      revision: 1,
      reviewId: review.id,
      authentication: {
        method: "verified-account",
        email: `${userId}@example.invalid`,
        checkedAt: new Date().toISOString(),
      },
      statedName: "Evidence fixture owner",
      consent: {
        version: "2026-10-22.1",
        text: "I have reviewed this document and agree to apply my signature.",
      },
      signature: { fileKey: signatureKey, bytes: signatureBytes },
      additionalSignatures: [
        { fileKey: secondSignatureKey, bytes: secondSignatureBytes },
      ],
      fields: { layers },
    };
    await expect(
      db.transaction((tx) =>
        recordAcceptance(tx, { ...acceptanceInput, revision: 2 }),
      ),
    ).rejects.toThrow("review this version");
    const { acceptance, canonical } = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from document where id = ${documentId} for update`,
      );
      const acceptance = await recordAcceptance(tx, acceptanceInput);
      await tx
        .update(documents)
        .set({ status: "completed", revision: 2 })
        .where(eq(documents.id, documentId));
      const canonical = await ensureCanonicalExport(tx, {
        documentId,
        revision: 2,
        originalKey,
        layers,
      });
      // The integration owns this one synthetic record; keep the shared local
      // worker from claiming it while testing the same finalization hooks.
      await tx
        .update(exportsTable)
        .set({ state: "working", startedAt: new Date() })
        .where(eq(exportsTable.id, canonical.id));
      return { acceptance, canonical };
    });
    const finalBytes = await renderPdf(originalKey, layers, false);
    const finalKey = await storeFile(finalBytes, "pdf");
    keys.add(finalKey);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from document where id = ${documentId} for update`,
      );
      await tx
        .update(exportsTable)
        .set({ state: "ready", fileKey: finalKey, sha256: sha256(finalBytes) })
        .where(eq(exportsTable.id, canonical.id));
      await recordFinalization(tx, canonical, {
        fileKey: finalKey,
        bytes: finalBytes,
      });
      const evidence = await completedEvidence(documentId, tx, {
        verifyStoredFiles: true,
      });
      expect(evidence.manifest.outcome).toBe("owner-signed");
      const accepted = evidence.manifest.records.find(
        (record) => record.kind === "acceptance",
      )!;
      expect(accepted.files).toHaveLength(2);
      expect(accepted.body.authentication).toMatchObject({
        method: "verified-account",
        checkedAt: acceptanceInput.authentication.checkedAt,
      });
      expect(accepted.body.authentication).not.toHaveProperty("verifiedAt");
    });
    const again = await db.transaction((tx) =>
      ensureCanonicalExport(tx, {
        documentId,
        revision: 999,
        originalKey,
        layers: [],
      }),
    );
    expect(again.id).toBe(canonical.id);
    expect(again.sha256).toBe(sha256(finalBytes));
    pki = await createSealPkiFixture();
    const timestampPolicy = join(directory, "timestamp-policy.json"),
      tsaUrl = "https://fixture.invalid/timestamp",
      rootCrlUrl = "https://fixture.invalid/root.crl",
      intermediateCrlUrl = "https://fixture.invalid/intermediate.crl";
    await writeFile(
      timestampPolicy,
      JSON.stringify({
        tsaUrl,
        tsaPolicyOid: fixturePolicyOid,
        trustedRoots: [pki.root.der.toString("base64")],
        certificateChain: [pki.intermediate.der.toString("base64")],
        crlUrls: [rootCrlUrl, intermediateCrlUrl],
      }),
    );
    const provider: typeof fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input) === rootCrlUrl)
        return new Response(Uint8Array.from(pki!.rootCrl.der));
      if (String(input) === intermediateCrlUrl)
        return new Response(Uint8Array.from(pki!.intermediateCrl.der));
      if (String(input) !== tsaUrl || !(init?.body instanceof ArrayBuffer))
        throw new Error("Unexpected fixture request.");
      return new Response(
        Uint8Array.from(await pki!.timestampReply(new Uint8Array(init.body))),
      );
    }) as typeof fetch;
    const fingerprint = (await completedEvidence(documentId)).receipt
      .manifestSha256;
    // Enabling a provider later must not invent an automatic job for old records.
    const previousPolicy = config.EVIDENCE_TIMESTAMP_POLICY;
    try {
      config.EVIDENCE_TIMESTAMP_POLICY = timestampPolicy;
      expect((await evidenceTimestampStatus(documentId)).state).toBe(
        "not-requested",
      );
    } finally {
      config.EVIDENCE_TIMESTAMP_POLICY = previousPolicy;
    }
    // The same transaction boundary used by finalization must roll the outbox
    // request back if the ready artifact cannot commit.
    await expect(
      db.transaction(async (tx) => {
        await requestEvidenceTimestamp(
          tx,
          documentId,
          fingerprint,
          timestampPolicy,
        );
        throw new Error("synthetic finalization rollback");
      }),
    ).rejects.toThrow("synthetic finalization rollback");
    expect((await evidenceTimestampStatus(documentId)).state).toBe(
      "not-requested",
    );
    await db.transaction(async (tx) => {
      await requestEvidenceTimestamp(
        tx,
        documentId,
        fingerprint,
        timestampPolicy,
      );
      await requestEvidenceTimestamp(
        tx,
        documentId,
        fingerprint,
        timestampPolicy,
      );
    });
    expect((await evidenceTimestampStatus(documentId)).state).toBe("pending");
    // Simulate process loss after final-PDF commit: reconciliation discovers the
    // persisted request. Hold its provider response to exercise concurrent workers
    // and an operator CLI; none may make a second network attempt.
    let releaseProvider!: () => void, providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let attempted = 0;
    const failingProvider: typeof fetch = async (input, init) => {
      if (String(input) !== tsaUrl) return provider(input, init);
      attempted++;
      providerStarted();
      await release;
      return new Response("synthetic unavailable", { status: 503 });
    };
    const recovered = processPendingEvidenceTimestamp({
      policyPath: timestampPolicy,
      fetch: failingProvider,
    });
    await started;
    try {
      expect(
        (
          await processPendingEvidenceTimestamp({
            policyPath: timestampPolicy,
            fetch: failingProvider,
          })
        ).state,
      ).toBe("busy");
      await expect(
        timestampCompletedEvidence(documentId, timestampPolicy, {
          fetch: provider,
        }),
      ).rejects.toMatchObject({ code: "TIMESTAMP_BUSY" });
      expect((await evidenceTimestampStatus(documentId)).state).toBe("pending");
    } finally {
      releaseProvider();
    }
    expect((await recovered).state).toBe("failed");
    expect((await evidenceTimestampStatus(documentId)).state).toBe("failed");
    expect(
      (
        await processPendingEvidenceTimestamp({
          policyPath: timestampPolicy,
          fetch: failingProvider,
        })
      ).state,
    ).toBe("idle");
    expect(attempted).toBe(1);
    expect((await completedEvidence(documentId)).receipt.manifestSha256).toBe(
      fingerprint,
    );
    // Only an explicit operator retry proceeds after a recorded failure.
    const timestampRow = await timestampCompletedEvidence(
      documentId,
      timestampPolicy,
      { fetch: provider },
    );
    keys.add(timestampRow.fileKey);
    const repeatedTimestamp = await timestampCompletedEvidence(
      documentId,
      "this-policy-path-must-not-be-read-for-existing-timestamps",
    );
    expect(repeatedTimestamp.sha256).toBe(timestampRow.sha256);
    expect((await completedEvidence(documentId)).timestamp.state).toBe(
      "available",
    );
    const archive = await buildEvidenceArchive(documentId),
      chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
    const archivePath = join(directory, "record.tar");
    await writeFile(archivePath, Buffer.concat(chunks));
    await execute("tar", ["-xf", archivePath, "-C", directory]);
    expect(await readFile(join(directory, "final.pdf"))).toEqual(finalBytes);
    const verified = await verifyEvidenceDirectory(
      directory,
      archive.receipt.manifestSha256,
      acceptance.hash,
    );
    expect(verified.outcome).toBe("owner-signed");
    const restoredTimestamp = JSON.parse(
      await readFile(join(directory, "timestamp.json"), "utf8"),
    );
    expect(
      (
        await verifyEvidenceTimestamp(
          restoredTimestamp,
          archive.receipt.manifestSha256,
          [pki.root.der],
        )
      ).manifestSha256,
    ).toBe(archive.receipt.manifestSha256);
    expect(await readFile(join(directory, "timestamp/token.der"))).toEqual(
      Buffer.from(restoredTimestamp.token, "base64"),
    );
    await execute(
      process.execPath,
      [
        join(directory, "verify.mjs"),
        directory,
        "--receipt",
        archive.receipt.manifestSha256,
      ],
      { env: { ...process.env, NODE_OPTIONS: "" } },
    );
    // Mutating the stored canonical artifact must fail serving and archive creation.
    await writeFile(filePath(finalKey), "tampered synthetic PDF");
    await expect(
      verifiedEvidenceFile(finalKey, sha256(finalBytes)),
    ).rejects.toThrow("integrity check");
    await expect(buildEvidenceArchive(documentId)).rejects.toThrow(
      "integrity check",
    );
  });
});
