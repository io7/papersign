import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  createReceipt,
  evidenceHash,
  hashEvidenceRecord,
  verifyEvidenceManifest,
} from "../server/evidence-core.js";
import {
  offlineVerifierSource,
  verifyEvidenceDirectory,
} from "../server/evidence-verifier.js";
import { tarHeader } from "../server/evidence-archive.js";
import type { EvidenceManifest, EvidenceRecord } from "../shared/evidence.js";

const execute = promisify(execFile);
let scratch: string;
function fixture() {
  const documentId = randomUUID(),
    actor = randomUUID();
  const bytes: Record<string, Buffer> = {
    "original.pdf": Buffer.from("%PDF-original"),
    "reviews/signer-1.pdf": Buffer.from("%PDF-reviewed-with-prior-signatures"),
    "signatures/signer.png": Buffer.from("signature-png"),
    "final.pdf": Buffer.from("%PDF-final-with-accepted-signature"),
  };
  const files = Object.entries(bytes).map(([name, data]) => ({
    name,
    sha256: evidenceHash(data),
    size: data.length,
  }));
  const records: EvidenceRecord[] = [];
  const add = (
    kind: EvidenceRecord["kind"],
    body: EvidenceRecord["body"],
    names: string[],
  ) => {
    const record = {
      id: randomUUID(),
      documentId,
      actor: kind === "finalization" ? "system:pdf-worker" : actor,
      sequence: records.length + 1,
      kind,
      revision: kind === "finalization" ? 2 : 1,
      createdAt: "2026-10-22T10:00:00.000Z",
      previousHash: records.at(-1)?.hash ?? null,
      body,
      files: files.filter((file) => names.includes(file.name)),
    };
    records.push({ ...record, hash: hashEvidenceRecord(record) });
  };
  add("review", { pdfSha256: files[1].sha256 }, [files[1].name]);
  add(
    "acceptance",
    {
      reviewId: records[0].id,
      reviewedPdfSha256: files[1].sha256,
      statedName: "Test signer",
      consent: {
        version: "2026-10-22.1",
        text: "I have reviewed and agree to this document.",
      },
      authentication: {
        method: "email-one-time-code",
        email: "signer@example.invalid",
        verifiedAt: "2026-10-22T09:59:00.000Z",
      },
      signatureSha256: files[2].sha256,
      fields: { textValues: [{ id: "place", text: "London" }] },
    },
    [files[2].name],
  );
  add(
    "finalization",
    {
      pdfSha256: files[3].sha256,
      acceptanceHashes: [records[1].hash],
      exportId: randomUUID(),
      sealPolicyId: "",
    },
    [files[3].name],
  );
  const manifest: EvidenceManifest = {
    format: "papersign-evidence-v1",
    document: {
      id: documentId,
      name: "Agreement.pdf",
      sourceHash: files[0].sha256,
      ownerId: randomUUID(),
      ownerEmail: "owner@example.invalid",
      status: "completed",
    },
    finalPdf: files[3],
    originalPdf: files[0],
    outcome: "all-signed",
    participants: [
      {
        id: actor,
        name: "Test signer",
        email: "signer@example.invalid",
        order: 1,
        state: "signed",
      },
    ],
    records,
    files,
  };
  return { manifest, bytes };
}
async function directory() {
  const dir = await mkdtemp(join(scratch, "package-"));
  const data = fixture();
  for (const [name, bytes] of Object.entries(data.bytes)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), bytes);
  }
  await writeFile(join(dir, "manifest.json"), canonicalJson(data.manifest));
  await writeFile(
    join(dir, "receipt.json"),
    canonicalJson(createReceipt(data.manifest)),
  );
  await writeFile(join(dir, "verify.mjs"), offlineVerifierSource());
  return { dir, ...data };
}
function rehash(manifest: EvidenceManifest) {
  let previousHash: string | null = null;
  for (const record of manifest.records) {
    record.previousHash = previousHash;
    if (record.kind === "finalization")
      record.body.acceptanceHashes = manifest.records
        .filter((item) => item.kind === "acceptance")
        .map((item) => item.hash);
    const { hash: _hash, ...content } = record;
    record.hash = hashEvidenceRecord(content);
    previousHash = record.hash;
  }
}
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "papersign-evidence-tests-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("portable signing evidence", () => {
  it("checks the actual original, reviewed PDF, consent, signature and canonical final bytes without a server", async () => {
    const { dir, manifest } = await directory();
    const fingerprint = createReceipt(manifest).manifestSha256;
    const result = await verifyEvidenceDirectory(
      dir,
      fingerprint,
      manifest.records[1].hash,
    );
    expect(result.filesVerified).toBe(4);
    expect(result.independentlyMatched).toBe(true);
    await execute(
      process.execPath,
      [join(dir, "verify.mjs"), dir, "--receipt", fingerprint],
      { env: { ...process.env, NODE_OPTIONS: "" } },
    );
    await expect(
      execute(
        process.execPath,
        [join(dir, "verify.mjs"), dir, "--receipt", "f".repeat(64)],
        { env: { ...process.env, NODE_OPTIONS: "" } },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
  it.each([
    "original.pdf",
    "reviews/signer-1.pdf",
    "signatures/signer.png",
    "final.pdf",
  ])("rejects changed bytes in %s", async (name) => {
    const { dir } = await directory();
    await writeFile(join(dir, name), "replaced");
    await expect(verifyEvidenceDirectory(dir)).rejects.toThrow(
      "Evidence file changed",
    );
  });
  it("rejects altered consent and reordered/deleted events", () => {
    const consent = fixture().manifest;
    consent.records[1].body.consent = {
      version: "different",
      text: "Something else",
    };
    expect(() => verifyEvidenceManifest(consent)).toThrow("chain was changed");
    const reordered = fixture().manifest;
    reordered.records.reverse();
    expect(() => verifyEvidenceManifest(reordered)).toThrow(
      "chain was changed",
    );
    const deleted = fixture().manifest;
    deleted.records.splice(0, 1);
    expect(() => verifyEvidenceManifest(deleted)).toThrow("chain was changed");
  });
  it("accepts an account authenticator proof with its time, and rejects one without", () => {
    const manifest = fixture().manifest;
    manifest.records[1].body.authentication = {
      method: "account-authenticator",
      factor: "code",
      accountId: randomUUID(),
      email: "signer@example.invalid",
      verifiedAt: "2026-10-22T09:59:00.000Z",
    };
    rehash(manifest);
    expect(() => verifyEvidenceManifest(manifest)).not.toThrow();
    const timeless = fixture().manifest;
    timeless.records[1].body.authentication = {
      method: "account-authenticator",
      factor: "session",
      email: "signer@example.invalid",
    };
    rehash(timeless);
    expect(() => verifyEvidenceManifest(timeless)).toThrow(
      "authentication or signature evidence",
    );
  });
  it("rejects a rehashed acceptance borrowed from another signer or revision", () => {
    const manifest = fixture().manifest;
    manifest.records[1].revision++;
    rehash(manifest);
    expect(() => verifyEvidenceManifest(manifest)).toThrow(
      "signer's reviewed PDF",
    );
  });
  it("rejects a rewritten history against an independently retained fingerprint", async () => {
    const { dir, manifest } = await directory();
    const oldReceipt = createReceipt(manifest).manifestSha256;
    const oldAcceptance = manifest.records[1].hash;
    manifest.records[1].body.statedName = "Changed name";
    rehash(manifest);
    await writeFile(join(dir, "manifest.json"), canonicalJson(manifest));
    await writeFile(
      join(dir, "receipt.json"),
      canonicalJson(createReceipt(manifest)),
    );
    expect((await verifyEvidenceDirectory(dir)).independentlyMatched).toBe(
      false,
    );
    await expect(verifyEvidenceDirectory(dir, oldReceipt)).rejects.toThrow(
      "independently retained receipt",
    );
    await expect(
      verifyEvidenceDirectory(dir, undefined, oldAcceptance),
    ).rejects.toThrow("independently retained acceptance");
  });
  it("does not describe revoked recipients as signed", () => {
    const manifest = fixture().manifest;
    manifest.participants.push({
      id: randomUUID(),
      name: "Not signed",
      email: "revoked@example.invalid",
      order: 2,
      state: "revoked",
    });
    expect(() => verifyEvidenceManifest(manifest)).toThrow("signing outcome");
    manifest.outcome = "completed-with-revocations";
    expect(() => verifyEvidenceManifest(manifest)).not.toThrow();
  });
  it("rejects an acceptance-free package and path traversal", () => {
    const manifest = fixture().manifest;
    manifest.files[0].name = "../original.pdf";
    expect(() => verifyEvidenceManifest(manifest)).toThrow(
      "Invalid evidence file",
    );
    const empty = fixture().manifest;
    empty.records = [];
    expect(() => verifyEvidenceManifest(empty)).toThrow("empty evidence");
  });
  it("preserves cancellation distinctly from a successful signing workflow", () => {
    const manifest = fixture().manifest;
    manifest.document.status = "cancelled";
    expect(() => verifyEvidenceManifest(manifest)).toThrow("signing outcome");
    manifest.outcome = "cancelled";
    expect(() => verifyEvidenceManifest(manifest)).not.toThrow();
  });
  it("writes archives that standard tar reads safely and without dependencies", async () => {
    const { manifest } = fixture();
    const bytes = Buffer.from(canonicalJson(manifest));
    const tar = join(scratch, "portable.tar");
    await writeFile(
      tar,
      Buffer.concat([
        tarHeader("manifest.json", bytes.length),
        bytes,
        Buffer.alloc((512 - (bytes.length % 512)) % 512),
        Buffer.alloc(1024),
      ]),
    );
    const extracted = await execute("tar", ["-xOf", tar, "manifest.json"]);
    expect(extracted.stdout).toBe(bytes.toString());
    expect(() => tarHeader("../unsafe", 1)).toThrow("Invalid archive member");
    expect((await readFile(tar)).length % 512).toBe(0);
  });
});
