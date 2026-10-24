import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson, evidenceHash } from "../server/evidence-core.js";
import {
  readEvidenceTimestampPolicy,
  timestampEvidenceManifest,
  verifyEvidenceTimestamp,
  type EvidenceTimestampPolicy,
  type ManifestTimestamp,
} from "../server/evidence-timestamp-core.js";
import {
  createSealPkiFixture,
  fixturePolicyOid,
  type SealPkiFixture,
} from "./helpers/seal-pki.js";

const tsaUrl = "https://tsa.example.invalid/timestamp",
  rootCrl = "https://ca.example.invalid/root.crl",
  intermediateCrl = "https://ca.example.invalid/intermediate.crl";
const manifestBytes = Buffer.from(
  canonicalJson({
    format: "synthetic-manifest-for-cryptographic-test",
    document: "No real personal data",
  }),
);
const fingerprint = evidenceHash(manifestBytes);
let pki: SealPkiFixture,
  policy: EvidenceTimestampPolicy,
  timestamp: ManifestTimestamp;
const execute = promisify(execFile);
function provider(
  overrides: {
    stale?: boolean;
    wrongPurpose?: boolean;
    badNonce?: boolean;
    rejected?: boolean;
  } = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === rootCrl)
      return new Response(Uint8Array.from(pki.rootCrl.der));
    if (String(input) === intermediateCrl)
      return new Response(
        Uint8Array.from(
          overrides.stale
            ? pki.staleIntermediateCrl.der
            : pki.intermediateCrl.der,
        ),
      );
    if (String(input) !== tsaUrl || !(init?.body instanceof ArrayBuffer))
      throw new Error("Unexpected timestamp test request.");
    if (overrides.rejected)
      return new Response("provider unavailable", { status: 503 });
    let request = Buffer.from(init.body);
    if (overrides.badNonce) {
      request = Buffer.from(request);
      request[request.length - 4] ^= 1;
    }
    return new Response(
      Uint8Array.from(
        await pki.timestampReply(request, {
          wrongPurpose: overrides.wrongPurpose,
        }),
      ),
      { headers: { "Content-Type": "application/timestamp-reply" } },
    );
  }) as typeof fetch;
}
beforeAll(async () => {
  pki = await createSealPkiFixture();
  policy = {
    tsaUrl,
    tsaPolicyOid: fixturePolicyOid,
    trustedRoots: [pki.root.der],
    certificateChain: [pki.intermediate.der],
    crlUrls: [rootCrl, intermediateCrl],
  };
  timestamp = await timestampEvidenceManifest(fingerprint, policy, {
    fetch: provider(),
  });
});
afterAll(async () => {
  if (pki) await pki.cleanup();
});

describe("standalone RFC3161 manifest timestamps without an organization certificate", () => {
  it("gets a verified timestamp with no organization key and preserves all offline validation material", async () => {
    expect(timestamp.manifestSha256).toBe(fingerprint);
    expect(timestamp.certificates).toHaveLength(3);
    expect(timestamp.crls).toHaveLength(2);
    const result = await verifyEvidenceTimestamp(timestamp, fingerprint, [
      pki.root.der,
    ]);
    expect(result.validation).toBe("retained-crls-at-signed-generation-time");
    expect(result.currentRevocationStatusChecked).toBe(false);
    expect(result.archivalRenewalProvided).toBe(false);
    await writeFile(join(pki.directory, "manifest.json"), manifestBytes);
    await writeFile(
      join(pki.directory, "manifest.tsr"),
      Buffer.from(timestamp.response, "base64"),
    );
    const independent = await pki.openssl([
      "ts",
      "-verify",
      "-in",
      join(pki.directory, "manifest.tsr"),
      "-data",
      join(pki.directory, "manifest.json"),
      "-CAfile",
      pki.root.pemPath,
      "-untrusted",
      pki.intermediate.pemPath,
    ]);
    expect(independent.stdout).toContain("Verification: OK");
  });
  it("requires independently selected roots instead of trusting roots included in the package", async () => {
    await expect(
      verifyEvidenceTimestamp(timestamp, fingerprint, []),
    ).rejects.toThrow("independently trusted");
    await expect(
      verifyEvidenceTimestamp(timestamp, fingerprint, [pki.unrelatedRoot.der]),
    ).rejects.toThrow();
  });
  it("rejects changed manifest bytes, signed token, timestamp metadata, or request nonce", async () => {
    await expect(
      verifyEvidenceTimestamp(timestamp, evidenceHash("changed"), [
        pki.root.der,
      ]),
    ).rejects.toThrow("does not bind");
    const corruptToken = Buffer.from(timestamp.token, "base64");
    corruptToken[corruptToken.length - 1] ^= 1;
    await expect(
      verifyEvidenceTimestamp(
        { ...timestamp, token: corruptToken.toString("base64") },
        fingerprint,
        [pki.root.der],
      ),
    ).rejects.toThrow("summary");
    await expect(
      verifyEvidenceTimestamp(
        {
          ...timestamp,
          genTime: new Date(
            new Date(timestamp.genTime).getTime() + 1000,
          ).toISOString(),
        },
        fingerprint,
        [pki.root.der],
      ),
    ).rejects.toThrow("summary");
    await expect(
      timestampEvidenceManifest(fingerprint, policy, {
        fetch: provider({ badNonce: true }),
      }),
    ).rejects.toThrow();
  });
  it("fails closed on stale revocation data, wrong TSA purpose and provider failure", async () => {
    await expect(
      timestampEvidenceManifest(fingerprint, policy, {
        fetch: provider({ stale: true }),
      }),
    ).rejects.toThrow();
    await expect(
      timestampEvidenceManifest(fingerprint, policy, {
        fetch: provider({ wrongPurpose: true }),
      }),
    ).rejects.toThrow();
    await expect(
      timestampEvidenceManifest(fingerprint, policy, {
        fetch: provider({ rejected: true }),
      }),
    ).rejects.toThrow();
  });
  it("validates at the signed historical time with retained CRLs and rejects unauthenticated date changes", async () => {
    const future = new Date(
      new Date(timestamp.genTime).getTime() + 366 * 86400_000,
    );
    // Creation verification cannot pretend a stale token arrived a year later.
    await expect(
      timestampEvidenceManifest(fingerprint, policy, {
        fetch: provider(),
        now: () => future,
      }),
    ).rejects.toThrow();
    const archived = await verifyEvidenceTimestamp(timestamp, fingerprint, [
      pki.root.der,
    ]);
    expect(archived.genTime).toBe(timestamp.genTime);
    await expect(
      verifyEvidenceTimestamp(
        { ...timestamp, genTime: future.toISOString() },
        fingerprint,
        [pki.root.der],
      ),
    ).rejects.toThrow();
  });
  it("runs the cryptographic verifier without a database, application secret or network access", async () => {
    const timestampFile = join(pki.directory, "timestamp.json"),
      rootsFile = join(pki.directory, "root.der");
    await writeFile(timestampFile, JSON.stringify(timestamp));
    await writeFile(rootsFile, pki.root.der);
    const code = `import {readFile} from 'node:fs/promises'; import {verifyEvidenceTimestamp} from './server/evidence-timestamp-core.ts'; const timestamp=JSON.parse(await readFile(process.argv[1],'utf8')); const root=await readFile(process.argv[2]); await verifyEvidenceTimestamp(timestamp,timestamp.manifestSha256,[root]);`;
    await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
        timestampFile,
        rootsFile,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: "",
          BETTER_AUTH_SECRET: "",
          NODE_OPTIONS: "",
        },
      },
    );
  });
  it("loads a bounded standalone policy and rejects organization credentials and insecure TSA endpoints", async () => {
    const path = join(pki.directory, "timestamp-policy.json");
    const json = {
      tsaUrl,
      tsaPolicyOid: fixturePolicyOid,
      trustedRoots: [pki.root.der.toString("base64")],
      certificateChain: [pki.intermediate.der.toString("base64")],
      crlUrls: [rootCrl, intermediateCrl],
    };
    await writeFile(path, JSON.stringify(json));
    expect((await readEvidenceTimestampPolicy(path)).trustedRoots[0]).toEqual(
      pki.root.der,
    );
    await writeFile(
      path,
      JSON.stringify({ ...json, tsaUrl: "http://tsa.example.invalid" }),
    );
    await expect(readEvidenceTimestampPolicy(path)).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify({ ...json, p12: "must-not-be-needed" }),
    );
    await expect(readEvidenceTimestampPolicy(path)).rejects.toThrow();
  });
});
