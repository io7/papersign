/** Internal phase of restore-rehearsal.ts. Never points at an existing application database. */
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { eq, sql } from "drizzle-orm";
import { config } from "../server/config.js";
import { db, pool } from "../server/db.js";
import { auth } from "../server/auth.js";
import {
  documents,
  invitations,
  exportsTable,
  user,
} from "../server/schema.js";
import {
  completedEvidence,
  getCompletedRecord,
  ensureCanonicalExport,
  recordAcceptance,
  recordFinalization,
  retainReview,
  verifiedEvidenceFile,
} from "../server/evidence.js";
import { buildEvidenceArchive } from "../server/evidence-archive.js";
import { sha256, storeFile, seal, unseal } from "../server/storage.js";
import { renderPdf } from "../server/pdf.js";
import { restoreConnection } from "./restore-safety.js";

const url = new URL(config.DATABASE_URL);
restoreConnection(config.DATABASE_URL, url.pathname.slice(1));
if (
  !process.env.RESTORE_FIXTURE_REPORT ||
  !process.env.RESTORE_TEST_EMAIL ||
  !process.env.RESTORE_TEST_PASSWORD
)
  throw new Error("Restore fixture context is missing.");
try {
  if (process.argv[2] === "seed") {
    const signedUp = await auth.api.signUpEmail({
      body: {
        name: "Restore fixture owner",
        email: process.env.RESTORE_TEST_EMAIL,
        password: process.env.RESTORE_TEST_PASSWORD,
      },
    });
    const userId = signedUp.user.id,
      documentId = randomUUID(),
      actor = `owner:${userId}`;
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, userId));
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([400, 500]),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("PaperSign isolated recovery rehearsal", {
      x: 20,
      y: 460,
      size: 12,
      font,
    });
    const bytes = Buffer.from(await pdf.save()),
      originalKey = await storeFile(bytes, "pdf");
    const canvas = createCanvas(200, 60),
      context = canvas.getContext("2d");
    context.strokeStyle = "#172c25";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(10, 40);
    context.bezierCurveTo(70, 0, 90, 60, 180, 10);
    context.stroke();
    const png = await canvas.encode("png"),
      imageKey = await storeFile(png, "png");
    const layer = {
      id: randomUUID(),
      pageIndex: 0,
      x: 0.1,
      y: 0.7,
      width: 0.5,
      height: 0.12,
      imageKey,
    };
    await db.insert(documents).values({
      id: documentId,
      userId,
      name: "Completed recovery fixture.pdf",
      fileKey: originalKey,
      sourceHash: sha256(bytes),
      byteSize: bytes.length,
      pages: [{ width: 400, height: 500 }],
    });
    const review = await db.transaction((tx) =>
      retainReview(tx, { documentId, actor, revision: 1, bytes }),
    );
    const finalBytes = await renderPdf(originalKey, [layer], false),
      fileKey = await storeFile(finalBytes, "pdf");
    const acceptance = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from document where id = ${documentId} for update`,
      );
      const accepted = await recordAcceptance(tx, {
        documentId,
        actor,
        revision: 1,
        reviewId: review.id,
        authentication: {
          method: "verified-account",
          email: process.env.RESTORE_TEST_EMAIL!,
          checkedAt: new Date().toISOString(),
        },
        statedName: "Restore fixture owner",
        consent: {
          version: "2026-10-22.1",
          text: "I have reviewed and accept this synthetic recovery fixture.",
        },
        signature: { fileKey: imageKey, bytes: png },
        fields: { layers: [layer] },
      });
      await tx
        .update(documents)
        .set({ status: "completed", revision: 2 })
        .where(eq(documents.id, documentId));
      const canonical = await ensureCanonicalExport(tx, {
        documentId,
        revision: 2,
        originalKey,
        layers: [layer],
      });
      await tx
        .update(exportsTable)
        .set({ state: "ready", fileKey, sha256: sha256(finalBytes) })
        .where(eq(exportsTable.id, canonical.id));
      await recordFinalization(tx, canonical, { fileKey, bytes: finalBytes });
      return accepted;
    });
    const evidence = await completedEvidence(documentId);
    const pendingDocumentId = randomUUID(),
      invitationId = randomUUID(),
      token = randomBytes(32).toString("base64url");
    await db.insert(documents).values({
      id: pendingDocumentId,
      userId,
      name: "Pending recovery fixture.pdf",
      fileKey: originalKey,
      previewKey: originalKey,
      sourceHash: sha256(bytes),
      byteSize: bytes.length,
      pages: [{ width: 400, height: 500 }],
      status: "awaiting",
    });
    await db.insert(invitations).values({
      id: invitationId,
      documentId: pendingDocumentId,
      name: "Pending recipient",
      email: "pending-restore@example.invalid",
      signingOrder: 1,
      tokenHash: sha256(token),
      sealedToken: seal(token),
      field: {
        id: randomUUID(),
        pageIndex: 0,
        x: 0.1,
        y: 0.7,
        width: 0.5,
        height: 0.12,
      },
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    });
    // Reproduce an in-flight upgrade: owner PNG and an earlier guest signature
    // predate acceptance evidence, while the last guest uses the new flow.
    const partialDocumentId = randomUUID(),
      oldRecipientId = randomUUID(),
      newRecipientId = randomUUID();
    const ownerLayer = { ...layer, id: randomUUID(), y: 0.4 },
      oldLayer = { ...layer, id: randomUUID(), y: 0.55 },
      newLayer = { ...layer, id: randomUUID(), y: 0.7 };
    const previewBytes = await renderPdf(originalKey, [ownerLayer], false),
      previewKey = await storeFile(previewBytes, "pdf");
    await db.insert(documents).values({
      id: partialDocumentId,
      userId,
      name: "In-flight upgrade recovery fixture.pdf",
      fileKey: originalKey,
      previewKey,
      sourceHash: sha256(bytes),
      byteSize: bytes.length,
      pages: [{ width: 400, height: 500 }],
      placements: [
        {
          id: ownerLayer.id,
          signatureId: randomUUID(),
          pageIndex: 0,
          x: ownerLayer.x,
          y: ownerLayer.y,
          width: ownerLayer.width,
          height: ownerLayer.height,
        },
      ],
      status: "completed",
      revision: 3,
    });
    for (const [id, order, field] of [
      [oldRecipientId, 1, oldLayer],
      [newRecipientId, 2, newLayer],
    ] as const) {
      const invitationToken = randomBytes(32).toString("base64url");
      const { imageKey: _image, ...geometry } = field;
      await db.insert(invitations).values({
        id,
        documentId: partialDocumentId,
        name: order === 1 ? "Legacy signer" : "New verified signer",
        email: `restore-signer-${order}@example.invalid`,
        signingOrder: order,
        tokenHash: sha256(invitationToken),
        sealedToken: seal(invitationToken),
        field: geometry,
        state: "signed",
        signedAt: new Date(),
        signedName: order === 1 ? "Legacy signer" : "New verified signer",
        imageKey,
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      });
    }
    const reviewBytes = await renderPdf(previewKey, [oldLayer], false);
    const partialReview = await db.transaction((tx) =>
      retainReview(tx, {
        documentId: partialDocumentId,
        actor: newRecipientId,
        revision: 2,
        bytes: reviewBytes,
      }),
    );
    const partialExport = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from document where id = ${partialDocumentId} for update`,
      );
      await recordAcceptance(tx, {
        documentId: partialDocumentId,
        actor: newRecipientId,
        revision: 2,
        reviewId: partialReview.id,
        authentication: {
          method: "email-one-time-code",
          email: "restore-signer-2@example.invalid",
          verifiedAt: new Date().toISOString(),
        },
        statedName: "New verified signer",
        consent: {
          version: "2026-10-22.1",
          text: "I accept this synthetic in-flight recovery fixture.",
        },
        signature: { fileKey: imageKey, bytes: png },
        fields: { signature: newLayer },
      });
      return ensureCanonicalExport(tx, {
        documentId: partialDocumentId,
        revision: 3,
        originalKey: previewKey,
        layers: [oldLayer, newLayer],
      });
    });
    if (partialExport.evidenceComplete)
      throw new Error(
        "The in-flight legacy record was incorrectly classified as complete evidence.",
      );
    const queuedExportId = randomUUID();
    await db.insert(exportsTable).values({
      id: queuedExportId,
      documentId,
      revision: 2,
      rasterize: false,
      originalKey,
      layers: [layer],
      sourceFiles: [
        {
          name: "original",
          fileKey: originalKey,
          sha256: sha256(bytes),
          size: bytes.length,
        },
        {
          name: "signature",
          fileKey: imageKey,
          sha256: sha256(png),
          size: png.length,
        },
      ],
    });
    const report = {
      userId,
      documentId,
      pendingDocumentId,
      invitationId,
      queuedExportId,
      partialDocumentId,
      partialExportId: partialExport.id,
      acceptanceHash: acceptance.hash,
      receipt: evidence.receipt,
      files: [
        ...evidence.files,
        {
          fileKey: previewKey,
          sha256: sha256(previewBytes),
          size: previewBytes.length,
        },
        {
          fileKey: partialReview.fileKey,
          sha256: partialReview.sha256,
          size: reviewBytes.length,
        },
      ].map((file) => ({
        fileKey: file.fileKey,
        sha256: file.sha256,
        size: file.size,
      })),
    };
    await writeFile(
      process.env.RESTORE_FIXTURE_REPORT,
      JSON.stringify(report, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      "Synthetic completed record, pending invitation and durable export queued.",
    );
  } else if (process.argv[2] === "verify") {
    const expected = JSON.parse(
      await readFile(process.env.RESTORE_FIXTURE_REPORT, "utf8"),
    );
    const actual = await completedEvidence(expected.documentId);
    if (
      actual.receipt.manifestSha256 !== expected.receipt.manifestSha256 ||
      actual.receipt.finalPdfSha256 !== expected.receipt.finalPdfSha256
    )
      throw new Error("Restored receipt or final PDF changed.");
    for (const file of expected.files)
      await verifiedEvidenceFile(file.fileKey, file.sha256);
    const [invitation] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, expected.invitationId));
    if (
      !invitation ||
      sha256(unseal(invitation.sealedToken)) !== invitation.tokenHash
    )
      throw new Error(
        "Pending invitation cannot be recovered with the restored secret.",
      );
    const archive = await buildEvidenceArchive(expected.documentId),
      chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
    await writeFile(
      join(process.env.RESTORE_OUTPUT_DIR!, "restored-evidence.tar"),
      Buffer.concat(chunks),
      { mode: 0o600 },
    );
    console.log(
      "Restored document hashes, evidence chain and encrypted pending invitation verified.",
    );
  } else if (process.argv[2] === "verify-partial") {
    const expected = JSON.parse(
      await readFile(process.env.RESTORE_FIXTURE_REPORT, "utf8"),
    );
    const final = await getCompletedRecord(expected.partialDocumentId);
    if (final.evidenceComplete)
      throw new Error(
        "Legacy signatures were incorrectly represented as complete evidence.",
      );
    await verifiedEvidenceFile(final.fileKey!, final.sha256!);
    let incompleteRejected = false;
    try {
      await completedEvidence(expected.partialDocumentId);
    } catch (error) {
      incompleteRejected =
        (error as { statusCode?: number }).statusCode === 409 &&
        (error as Error).message.includes("earlier signatures");
    }
    if (!incompleteRejected)
      throw new Error(
        "Incomplete legacy evidence package was not blocked explicitly.",
      );
    console.log(
      "In-flight legacy workflow produced a verified canonical PDF without inventing historical acceptance evidence.",
    );
  } else throw new Error("Unknown restore fixture phase.");
} finally {
  await pool.end();
}
