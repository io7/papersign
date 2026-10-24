import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import {
  validateCertificateChain,
  verifyDetachedCms,
  verifyTimestampResponse,
} from "../server/sealing/verify.js";
import type { SealOptions, SealTrust } from "../server/sealing/types.js";
import {
  createSealPkiFixture,
  extractPdfCms,
  verifyDssOnlyIncrement,
  fixturePassword,
  fixturePolicyOid,
  type SealPkiFixture,
} from "./helpers/seal-pki.js";

const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest();
const tsaUrl = "https://tsa.test.invalid/timestamp";
const rootCrlUrl = "https://crl.test.invalid/root.crl";
const intermediateCrlUrl = "https://crl.test.invalid/intermediate.crl";
const evidenceDirectory = ".local/qa/node-sealing/test-output";
let pki: SealPkiFixture;
let requestSequence = 0;

beforeAll(async () => {
  pki = await createSealPkiFixture();
  await mkdir(evidenceDirectory, { recursive: true });
});
afterAll(async () => pki?.cleanup());

function trust(): SealTrust {
  return {
    rootDer: [pki.root.der],
    chainDer: [pki.intermediate.der],
    crlDer: [pki.rootCrl.der, pki.intermediateCrl.der],
  };
}

function options(): SealOptions {
  return {
    p12: pki.p12,
    p12Password: fixturePassword,
    policy: {
      expectedSignerFingerprint: sha256(pki.signer.der).toString("hex"),
      tsaUrl,
      tsaPolicyOid: fixturePolicyOid,
      trustedRoots: [pki.root.der],
      certificateChain: [pki.intermediate.der],
      crlUrls: [rootCrlUrl, intermediateCrlUrl],
      name: "PaperSign isolated fixture seal",
      reason: "Test final document integrity",
    },
  };
}

function transport(
  overrides: {
    timestampQuery?: (query: Buffer) => Buffer;
    timestampResponse?: (reply: Buffer) => Buffer;
    intermediateCrl?: Buffer;
    failTimestamp?: boolean;
  } = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === rootCrlUrl)
      return new Response(Uint8Array.from(pki.rootCrl.der), {
        headers: { "Content-Type": "application/pkix-crl" },
      });
    if (url === intermediateCrlUrl)
      return new Response(
        Uint8Array.from(overrides.intermediateCrl ?? pki.intermediateCrl.der),
        {
          headers: { "Content-Type": "application/pkix-crl" },
        },
      );
    if (url === tsaUrl) {
      if (overrides.failTimestamp)
        throw new Error("Fixture provider refused test-only credential secret");
      const body = init?.body;
      if (!(body instanceof Uint8Array) && !(body instanceof ArrayBuffer))
        throw new Error("Expected binary timestamp request");
      const query = Buffer.from(
        body instanceof ArrayBuffer ? new Uint8Array(body) : body,
      );
      const reply = await pki.timestampReply(
        overrides.timestampQuery?.(query) ?? query,
      );
      return new Response(
        Uint8Array.from(overrides.timestampResponse?.(reply) ?? reply),
        {
          headers: { "Content-Type": "application/timestamp-reply" },
        },
      );
    }
    throw new Error(`Unexpected test network destination: ${url}`);
  }) as typeof fetch;
}

async function timestampRequest() {
  const imprint = sha256(
    Buffer.from(`PaperSign timestamp fixture ${requestSequence}`),
  );
  const path = join(pki.directory, `query-${requestSequence++}.tsq`);
  await pki.openssl([
    "ts",
    "-query",
    "-digest",
    imprint.toString("hex"),
    "-sha256",
    "-cert",
    "-tspolicy",
    fixturePolicyOid,
    "-out",
    path,
  ]);
  let query = await readFile(path);
  const parsed = new pkijs.TimeStampReq({
    schema: asn1js.fromBER(query).result,
  });
  let nonce = Buffer.from(parsed.nonce!.valueBlock.valueHexView);
  nonce = nonce[0] === 0 ? nonce.subarray(1) : nonce;
  // OpenSSL's random integer can occasionally encode in fewer than eight bytes.
  // Keep the live-response fixture inside the application's minimum nonce size.
  if (nonce.length < 8) {
    const padded = new Uint8Array(8);
    padded[0] = 1;
    padded.set(nonce, padded.length - nonce.length);
    parsed.nonce = new asn1js.Integer({ valueHex: padded.buffer });
    nonce = Buffer.from(padded);
    query = Buffer.from(parsed.toSchema().toBER(false));
  }
  return { query, imprint, nonce };
}

function alteredTimestampQuery(query: Buffer, field: "nonce" | "imprint") {
  const parsed = new pkijs.TimeStampReq({
    schema: asn1js.fromBER(query).result,
  });
  if (field === "nonce") {
    const changed = Uint8Array.from(parsed.nonce!.valueBlock.valueHexView);
    changed[changed.length - 1] ^= 1;
    parsed.nonce = new asn1js.Integer({ valueHex: changed.buffer });
  } else {
    const changed = Uint8Array.from(
      parsed.messageImprint.hashedMessage.valueBlock.valueHexView,
    );
    changed[0] ^= 1;
    parsed.messageImprint.hashedMessage = new asn1js.OctetString({
      valueHex: changed.buffer,
    });
  }
  return Buffer.from(parsed.toSchema().toBER(false));
}

async function samplePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  page.drawText("Final signed agreement", { x: 30, y: 350, size: 16 });
  page.drawText("Alex Example / accepted", { x: 30, y: 70, size: 12 });
  return Buffer.from(await pdf.save());
}

async function independentVerification(bytes: Uint8Array, stem: string) {
  const revisionEvidence = await verifyDssOnlyIncrement(bytes);
  const extracted = extractPdfCms(bytes);
  const cmsPath = join(pki.directory, `${stem}.cms.der`);
  const contentPath = join(pki.directory, `${stem}.signed.bin`);
  const verifiedPath = join(pki.directory, `${stem}.verified.bin`);
  const tokenPath = join(pki.directory, `${stem}.timestamp.der`);
  const signaturePath = join(pki.directory, `${stem}.signature.bin`);
  await writeFile(cmsPath, extracted.cms);
  await writeFile(contentPath, extracted.signedBytes);
  const cms = await pki.openssl([
    "cms",
    "-verify",
    "-binary",
    "-inform",
    "DER",
    "-in",
    cmsPath,
    "-content",
    contentPath,
    "-CAfile",
    pki.root.pemPath,
    "-certfile",
    pki.intermediate.pemPath,
    "-purpose",
    "any",
    "-out",
    verifiedPath,
  ]);
  expect(await readFile(verifiedPath)).toEqual(extracted.signedBytes);
  const content = new pkijs.ContentInfo({
    schema: asn1js.fromBER(extracted.cms).result,
  });
  const signed = new pkijs.SignedData({ schema: content.content });
  expect(signed.signerInfos).toHaveLength(1);
  const signer = signed.signerInfos[0];
  const timestamps = signer.unsignedAttrs?.attributes.filter(
    (attribute) => attribute.type === "1.2.840.113549.1.9.16.2.14",
  );
  expect(timestamps).toHaveLength(1);
  await writeFile(
    tokenPath,
    Buffer.from(timestamps![0].values[0].toBER(false)),
  );
  await writeFile(
    signaturePath,
    Buffer.from(signer.signature.valueBlock.valueHexView),
  );
  const timestamp = await pki.openssl([
    "ts",
    "-verify",
    "-token_in",
    "-in",
    tokenPath,
    "-data",
    signaturePath,
    "-CAfile",
    pki.root.pemPath,
    "-untrusted",
    pki.intermediate.pemPath,
  ]);
  const crls = Buffer.concat([
    await readFile(pki.rootCrl.pemPath),
    await readFile(pki.intermediateCrl.pemPath),
  ]);
  const crlsPath = join(pki.directory, "all.crls.pem");
  await writeFile(crlsPath, crls);
  const revocation = await pki.openssl([
    "verify",
    "-purpose",
    "any",
    "-crl_check_all",
    "-CAfile",
    pki.root.pemPath,
    "-untrusted",
    pki.intermediate.pemPath,
    "-CRLfile",
    crlsPath,
    pki.signer.pemPath,
    pki.tsa.pemPath,
  ]);
  await writeFile(join(evidenceDirectory, `${stem}.pdf`), bytes);
  await writeFile(
    join(evidenceDirectory, `${stem}-validation.json`),
    JSON.stringify(
      {
        openssl: (await pki.openssl(["version"])).stdout.trim(),
        sha256: sha256(bytes).toString("hex"),
        revisionEvidence,
        cms: cms.stderr.trim(),
        timestamp: timestamp.stdout.trim(),
        revocation: revocation.stdout
          .trim()
          .replaceAll(pki.directory, "<isolated-fixture>"),
        trust:
          "Generated fixture CA only; no production trust or PAdES conformance certification asserted",
      },
      null,
      2,
    ),
  );
  return extracted;
}

describe("Node certificate chain and trusted timestamp verification", () => {
  it("validates a complete signer chain with independently signed direct CRLs", async () => {
    const result = await validateCertificateChain({
      leafDer: pki.signer.der,
      chainDer: [pki.intermediate.der],
      rootDer: [pki.root.der],
      crlDer: [pki.rootCrl.der, pki.intermediateCrl.der],
      at: new Date(),
      purpose: "signer",
    });
    expect(result.certificates).toHaveLength(3);
    expect(result.leafFingerprint).toBe(sha256(pki.signer.der).toString("hex"));
  });

  it.each([
    "untrusted",
    "expired",
    "revoked",
    "revoked-intermediate",
    "stale-crl",
    "missing-crl",
    "bad-crl-signature",
    "wrong-tsa-purpose",
  ] as const)("rejects %s certificate evidence", async (variant) => {
    const codes = {
      untrusted: "untrusted_certificate_chain",
      expired: "certificate_expired_or_not_yet_valid",
      revoked: "certificate_revoked",
      "revoked-intermediate": "certificate_revoked",
      "stale-crl": "crl_not_current",
      "missing-crl": "crl_missing",
      "bad-crl-signature": "crl_signature",
      "wrong-tsa-purpose": "timestamp_eku",
    };
    const badCrl = Buffer.from(pki.intermediateCrl.der);
    badCrl[badCrl.length - 1] ^= 1;
    await expect(
      validateCertificateChain({
        leafDer:
          variant === "expired"
            ? pki.expiredSigner.der
            : variant === "wrong-tsa-purpose"
              ? pki.wrongPurposeTsa.der
              : pki.signer.der,
        chainDer: [pki.intermediate.der],
        rootDer: [
          variant === "untrusted" ? pki.unrelatedRoot.der : pki.root.der,
        ],
        crlDer:
          variant === "missing-crl"
            ? [pki.rootCrl.der]
            : [
                variant === "revoked-intermediate"
                  ? pki.revokedIntermediateCrl.der
                  : pki.rootCrl.der,
                variant === "revoked"
                  ? pki.revokedSignerCrl.der
                  : variant === "stale-crl"
                    ? pki.staleIntermediateCrl.der
                    : variant === "bad-crl-signature"
                      ? badCrl
                      : pki.intermediateCrl.der,
              ],
        at: new Date(),
        purpose: variant === "wrong-tsa-purpose" ? "timestamp" : "signer",
      }),
    ).rejects.toMatchObject({ code: codes[variant] });
  });

  it("verifies a real RFC3161 response produced by OpenSSL", async () => {
    const request = await timestampRequest();
    const result = await verifyTimestampResponse({
      responseDer: await pki.timestampReply(request.query),
      expectedImprint: request.imprint,
      hashAlgorithm: "SHA-256",
      nonce: request.nonce,
      policyOid: fixturePolicyOid,
      trust: trust(),
      now: new Date(),
    });
    expect(result.policyOid).toBe(fixturePolicyOid);
    expect(result.signerCertificate).toEqual(new Uint8Array(pki.tsa.der));
  });

  it("rejects a cryptographically valid OpenSSL timestamp with multiple ESS certificate references", async () => {
    const request = await timestampRequest();
    const response = await pki.timestampReply(request.query, {
      multipleEssReferences: true,
    });
    const queryPath = join(pki.directory, "multiple-ess.tsq");
    const responsePath = join(pki.directory, "multiple-ess.tsr");
    await writeFile(queryPath, request.query);
    await writeFile(responsePath, response);
    const verified = await pki.openssl([
      "ts",
      "-verify",
      "-queryfile",
      queryPath,
      "-in",
      responsePath,
      "-CAfile",
      pki.root.pemPath,
      "-untrusted",
      pki.intermediate.pemPath,
    ]);
    expect(verified.stdout).toContain("Verification: OK");
    await expect(
      verifyTimestampResponse({
        responseDer: response,
        expectedImprint: request.imprint,
        hashAlgorithm: "SHA-256",
        nonce: request.nonce,
        policyOid: fixturePolicyOid,
        trust: trust(),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "cms_ess_structure" });
  });

  it.each(["nonce", "imprint", "untrusted", "policy", "signature"] as const)(
    "rejects a timestamp with mismatched %s",
    async (variant) => {
      const codes = {
        nonce: "timestamp_nonce",
        imprint: "timestamp_imprint",
        untrusted: "untrusted_certificate_chain",
        policy: "timestamp_policy",
        signature: "cms_signature",
      };
      const request = await timestampRequest();
      const response = await pki.timestampReply(
        variant === "nonce" || variant === "imprint"
          ? alteredTimestampQuery(request.query, variant)
          : request.query,
      );
      if (variant === "signature") {
        const parsed = new pkijs.TimeStampResp({
          schema: asn1js.fromBER(response).result,
        });
        const cms = new pkijs.SignedData({
          schema: parsed.timeStampToken!.content,
        });
        const signature = Buffer.from(
          cms.signerInfos[0].signature.valueBlock.valueHexView,
        );
        const offset = response.indexOf(signature);
        expect(offset).toBeGreaterThan(0);
        response[offset] ^= 1;
      }
      await expect(
        verifyTimestampResponse({
          responseDer: response,
          expectedImprint: request.imprint,
          hashAlgorithm: "SHA-256",
          nonce: request.nonce,
          policyOid:
            variant === "policy" ? "1.3.6.1.4.1.55555.999" : fixturePolicyOid,
          trust:
            variant === "untrusted"
              ? { ...trust(), rootDer: [pki.unrelatedRoot.der] }
              : trust(),
          now: new Date(),
        }),
      ).rejects.toMatchObject({ code: codes[variant] });
    },
  );
});

describe("Final Node organization seal and embedded evidence", () => {
  let sealPdf: typeof import("../server/sealing/seal.js").sealPdf;
  beforeAll(async () => {
    ({ sealPdf } = await import("../server/sealing/seal.js"));
  });

  it("rejects changed CMS certificate binding, unsupported ESS references or policies, digest, signature, and missing timestamp", async () => {
    const sealed = await sealPdf(await samplePdf(), options(), {
      fetch: transport(),
    });
    const extracted = extractPdfCms(sealed.bytes);
    const mutations = [
      ["ess", "cms_ess_certificate_mismatch"],
      ["ess-extra-reference", "cms_ess_structure"],
      ["ess-policy", "cms_ess_structure"],
      ["digest", "cms_content_digest"],
      ["signature", "cms_signature"],
      ["timestamp", "signature_timestamp_required"],
    ] as const;
    for (const [variant, code] of mutations) {
      const content = new pkijs.ContentInfo({
        schema: asn1js.fromBER(extracted.cms).result,
      });
      const signed = new pkijs.SignedData({ schema: content.content });
      const signer = signed.signerInfos[0];
      if (variant === "signature")
        signer.signature.valueBlock.valueHexView[0] ^= 1;
      else if (variant === "timestamp") signer.unsignedAttrs = undefined;
      else {
        const oid = variant.startsWith("ess")
          ? "1.2.840.113549.1.9.16.2.47"
          : "1.2.840.113549.1.9.4";
        const attribute = signer.signedAttrs!.attributes.find(
          (item) => item.type === oid,
        )!;
        if (variant === "ess-extra-reference") {
          const binding = attribute.values[0] as asn1js.Sequence;
          const identifiers = binding.valueBlock.value[0] as asn1js.Sequence;
          identifiers.valueBlock.value.push(
            asn1js.fromBER(identifiers.valueBlock.value[0].toBER(false)).result,
          );
        } else if (variant === "ess-policy") {
          const binding = attribute.values[0] as asn1js.Sequence;
          binding.valueBlock.value.push(
            new asn1js.Sequence({
              value: [
                new asn1js.Sequence({
                  value: [new asn1js.ObjectIdentifier({ value: "1.2.3.4" })],
                }),
              ],
            }),
          );
        } else {
          const findOctets = (
            node: asn1js.BaseBlock,
          ): asn1js.OctetString | undefined => {
            if (node instanceof asn1js.OctetString) return node;
            if (node.idBlock.isConstructed) {
              const children = (
                node.valueBlock as unknown as { value: asn1js.BaseBlock[] }
              ).value;
              for (const child of children) {
                const found = findOctets(child);
                if (found) return found;
              }
            }
            return undefined;
          };
          const value = findOctets(attribute.values[0]);
          expect(value).toBeDefined();
          value!.valueBlock.valueHexView[0] ^= 1;
        }
      }
      content.content = signed.toSchema();
      await expect(
        verifyDetachedCms({
          cmsDer: new Uint8Array(content.toSchema().toBER(false)),
          signedBytes: extracted.signedBytes,
          expectedSignerDer: pki.signer.der,
          trust: trust(),
          now: new Date(),
          policyOid: fixturePolicyOid,
        }),
      ).rejects.toMatchObject({ code });
    }
  });
  it.each([false, true])(
    "independently verifies final PDF bytes with rasterization=%s",
    async (rasterize) => {
      let input = await samplePdf();
      if (rasterize) {
        const inputPath = join(pki.directory, "before-rasterization.pdf");
        const outputPath = join(pki.directory, "after-rasterization.pdf");
        await writeFile(inputPath, input);
        await execute(
          process.execPath,
          [
            "--max-old-space-size=512",
            "--import",
            "tsx",
            "server/pdf-rasterize.ts",
            inputPath,
            outputPath,
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        input = await readFile(outputPath);
      }
      const result = await sealPdf(input, options(), { fetch: transport() });
      expect(result.report.signerFingerprint).toBe(
        sha256(pki.signer.der).toString("hex"),
      );
      expect(result.report.validationCrls).toBeGreaterThanOrEqual(2);
      expect(result.report.validationCertificates).toBeGreaterThanOrEqual(3);
      const pdf = await PDFDocument.load(result.bytes);
      expect(
        pdf.getPages().map((page) => [page.getWidth(), page.getHeight()]),
      ).toEqual([[300, 400]]);
      const dss = pdf.catalog.lookup(PDFName.of("DSS"), PDFDict);
      expect(dss).toBeTruthy();
      const extracted = await independentVerification(
        result.bytes,
        rasterize ? "rasterized-sealed" : "ordinary-sealed",
      );
      const altered = Buffer.from(extracted.signedBytes);
      altered[altered.length - 10] ^= 1;
      const badContent = join(pki.directory, "tampered.signed.bin");
      const cmsPath = join(pki.directory, "tamper-check.cms.der");
      await writeFile(badContent, altered);
      await writeFile(cmsPath, extracted.cms);
      await expect(
        pki.openssl([
          "cms",
          "-verify",
          "-binary",
          "-inform",
          "DER",
          "-in",
          cmsPath,
          "-content",
          badContent,
          "-CAfile",
          pki.root.pemPath,
          "-purpose",
          "any",
          "-out",
          join(pki.directory, "tampered-output.bin"),
        ]),
      ).rejects.toThrow();
    },
  );

  it.each([
    "revoked",
    "stale",
    "expired",
    "wrong-identity",
    "nonce",
    "imprint",
    "provider-failure",
  ] as const)(
    "fails final sealing for %s rather than returning a weaker PDF",
    async (variant) => {
      const config = options();
      if (variant === "expired") {
        config.p12 = pki.expiredP12;
        config.policy.expectedSignerFingerprint = sha256(
          pki.expiredSigner.der,
        ).toString("hex");
      }
      if (variant === "wrong-identity")
        config.policy.expectedSignerFingerprint = "00".repeat(32);
      const promise = sealPdf(await samplePdf(), config, {
        fetch: transport({
          intermediateCrl:
            variant === "revoked"
              ? pki.revokedSignerCrl.der
              : variant === "stale"
                ? pki.staleIntermediateCrl.der
                : undefined,
          timestampQuery:
            variant === "nonce" || variant === "imprint"
              ? (query) => alteredTimestampQuery(query, variant)
              : undefined,
          failTimestamp: variant === "provider-failure",
        }),
      });
      await expect(promise).rejects.toThrow();
      if (variant === "provider-failure")
        await expect(promise).rejects.not.toThrow(
          "test-only credential secret",
        );
    },
  );
});
