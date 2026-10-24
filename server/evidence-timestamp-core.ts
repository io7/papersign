import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import { z } from "zod";
import { createBoundedFetch } from "./sealing/http.js";
import { verifyTimestampResponse } from "./sealing/verify.js";
import {
  SealVerificationError,
  type ValidatedTimestamp,
} from "./sealing/types.js";
import { evidenceHash } from "./evidence-core.js";

const encodedDer = z
  .string()
  .min(1)
  .max(180000)
  .transform((value, context) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 32 || bytes.toString("base64") !== value) {
      context.addIssue({
        code: "custom",
        message: "Use canonical base64 DER certificates.",
      });
      return z.NEVER;
    }
    return bytes;
  });
const endpoint = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, "Use an HTTP(S) URL without credentials or a fragment.");
const policySchema = z
  .object({
    tsaUrl: endpoint.refine(
      (value) => new URL(value).protocol === "https:",
      "The timestamp authority must use HTTPS.",
    ),
    tsaPolicyOid: z
      .string()
      .regex(/^[0-2](?:\.[0-9]+)+$/)
      .optional(),
    trustedRoots: z.array(encodedDer).min(1).max(8),
    certificateChain: z.array(encodedDer).max(16).default([]),
    crlUrls: z.array(endpoint).min(1).max(8),
  })
  .strict();
export type EvidenceTimestampPolicy = z.infer<typeof policySchema>;
export interface ManifestTimestamp {
  format: "papersign-manifest-timestamp-v1";
  manifestSha256: string;
  genTime: string;
  policyOid: string;
  tsaFingerprint: string;
  request: string;
  response: string;
  token: string;
  certificates: string[];
  crls: string[];
  trustedRootFingerprints: string[];
}
export async function readEvidenceTimestampPolicy(path: string) {
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024)
    throw new Error("Timestamp policy is too large.");
  return policySchema.parse(JSON.parse(bytes.toString("utf8")));
}
const arrayBuffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function decode(value: string, max: number) {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4)
    throw new Error("Timestamp evidence exceeds its size limit.");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value)
    throw new Error("Invalid timestamp evidence encoding.");
  return bytes;
}
async function responseBytes(response: Response, max: number) {
  if (!response.ok || !response.body)
    throw new SealVerificationError("TIMESTAMP_NETWORK_RESPONSE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > max)
        throw new SealVerificationError("TIMESTAMP_NETWORK_SIZE");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
function parsedRequest(request: Uint8Array) {
  const parsed = asn1.fromBER(arrayBuffer(request));
  if (parsed.offset !== request.length)
    throw new Error("Malformed timestamp request.");
  const query = new pki.TimeStampReq({ schema: parsed.result });
  if (
    query.version !== 1 ||
    query.messageImprint.hashAlgorithm.algorithmId !==
      "2.16.840.1.101.3.4.2.1" ||
    !query.nonce ||
    !query.certReq
  )
    throw new Error("Unsupported timestamp request.");
  return query;
}
function timestampResult(
  manifestSha256: string,
  request: Uint8Array,
  response: Uint8Array,
  result: ValidatedTimestamp,
  roots: readonly Uint8Array[],
): ManifestTimestamp {
  return {
    format: "papersign-manifest-timestamp-v1",
    manifestSha256,
    genTime: result.genTime.toISOString(),
    policyOid: result.policyOid,
    tsaFingerprint: evidenceHash(result.signerCertificate),
    request: encode(request),
    response: encode(response),
    token: encode(result.tokenDer),
    certificates: result.chain.certificates.map(encode),
    crls: result.chain.crls.map(encode),
    trustedRootFingerprints: roots.map(evidenceHash).sort(),
  };
}

/** Timestamp only the immutable manifest fingerprint; no organization key or seal is needed. */
export async function timestampEvidenceManifest(
  manifestSha256: string,
  policy: EvidenceTimestampPolicy,
  dependencies: { fetch?: typeof globalThis.fetch; now?: () => Date } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256))
    throw new Error("Invalid manifest fingerprint.");
  const fetch =
    dependencies.fetch ??
    createBoundedFetch([policy.tsaUrl, ...policy.crlUrls]);
  const now = dependencies.now ?? (() => new Date());
  const crls = await Promise.all(
    policy.crlUrls.map(async (url) =>
      responseBytes(
        await fetch(url, {
          headers: { Accept: "application/pkix-crl" },
          redirect: "error",
        }),
        8 * 1024 * 1024,
      ),
    ),
  );
  const nonce = randomBytes(16);
  nonce[0] = nonce[0] & 0x7f || 1;
  const imprint = Buffer.from(manifestSha256, "hex");
  const query = new pki.TimeStampReq({
    version: 1,
    messageImprint: new pki.MessageImprint({
      hashAlgorithm: new pki.AlgorithmIdentifier({
        algorithmId: "2.16.840.1.101.3.4.2.1",
        algorithmParams: new asn1.Null(),
      }),
      hashedMessage: new asn1.OctetString({ valueHex: arrayBuffer(imprint) }),
    }),
    nonce: new asn1.Integer({ valueHex: arrayBuffer(nonce) }),
    certReq: true,
    ...(policy.tsaPolicyOid ? { reqPolicy: policy.tsaPolicyOid } : {}),
  });
  const request = new Uint8Array(query.toSchema().toBER(false));
  const response = await responseBytes(
    await fetch(policy.tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        Accept: "application/timestamp-reply",
      },
      body: arrayBuffer(request),
      redirect: "error",
    }),
    1024 * 1024,
  );
  const result = await verifyTimestampResponse({
    responseDer: response,
    expectedImprint: imprint,
    hashAlgorithm: "SHA-256",
    nonce,
    policyOid: policy.tsaPolicyOid,
    trust: {
      rootDer: policy.trustedRoots,
      chainDer: policy.certificateChain,
      crlDer: crls,
    },
    now: now(),
  });
  return timestampResult(
    manifestSha256,
    request,
    response,
    result,
    policy.trustedRoots,
  );
}

/** Offline point-in-time verification. Trust anchors MUST come from the verifier, not the package. */
export async function verifyEvidenceTimestamp(
  input: ManifestTimestamp,
  expectedManifestSha256: string,
  trustedRoots: readonly Uint8Array[],
) {
  if (!trustedRoots.length || trustedRoots.length > 8)
    throw new Error("Supply independently trusted TSA root certificates.");
  if (
    input.format !== "papersign-manifest-timestamp-v1" ||
    !/^[a-f0-9]{64}$/.test(expectedManifestSha256) ||
    input.manifestSha256 !== expectedManifestSha256
  )
    throw new Error("Timestamp does not bind this manifest.");
  if (
    !Array.isArray(input.certificates) ||
    !input.certificates.length ||
    input.certificates.length > 24 ||
    !Array.isArray(input.crls) ||
    !input.crls.length ||
    input.crls.length > 8
  )
    throw new Error("Invalid timestamp validation material.");
  const request = decode(input.request, 65536),
    response = decode(input.response, 1024 * 1024),
    token = decode(input.token, 1024 * 1024);
  const query = parsedRequest(request);
  if (
    !Buffer.from(
      query.messageImprint.hashedMessage.valueBlock.valueHexView,
    ).equals(Buffer.from(expectedManifestSha256, "hex"))
  )
    throw new Error("Timestamp request used a different manifest imprint.");
  const genTime = new Date(input.genTime);
  if (!Number.isFinite(genTime.getTime()))
    throw new Error("Invalid timestamp time.");
  const result = await verifyTimestampResponse({
    responseDer: response,
    expectedImprint: Buffer.from(expectedManifestSha256, "hex"),
    hashAlgorithm: "SHA-256",
    nonce: query.nonce!.valueBlock.valueHexView,
    policyOid: query.reqPolicy,
    trust: {
      rootDer: trustedRoots,
      chainDer: input.certificates.map((item) => decode(item, 131072)),
      crlDer: input.crls.map((item) => decode(item, 8 * 1024 * 1024)),
    },
    now: genTime,
  });
  // genTime above is untrusted metadata until this exact equality succeeds against
  // the cryptographically verified TSTInfo; it is never treated as current time.
  if (
    result.genTime.toISOString() !== input.genTime ||
    result.policyOid !== input.policyOid ||
    evidenceHash(result.signerCertificate) !== input.tsaFingerprint ||
    !Buffer.from(result.tokenDer).equals(token)
  )
    throw new Error("Timestamp summary does not match its signed token.");
  return {
    manifestSha256: expectedManifestSha256,
    genTime: result.genTime.toISOString(),
    tsaFingerprint: evidenceHash(result.signerCertificate),
    policyOid: result.policyOid,
    validation: "retained-crls-at-signed-generation-time" as const,
    currentRevocationStatusChecked: false,
    archivalRenewalProvided: false,
  };
}
