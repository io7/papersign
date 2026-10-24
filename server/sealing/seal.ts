import { createHash, randomBytes } from "node:crypto";
import {
  PDF,
  P12Signer,
  PdfArray,
  PdfBool,
  PdfDict,
  PdfName,
  PdfNull,
  PdfNumber,
  PdfRef,
  PdfStream,
  PdfString,
  type PdfObject,
  type Signer,
} from "@libpdf/core";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import { createBoundedFetch } from "./http.js";
import { MAX_SEAL_BYTES } from "./protocol.js";
import {
  SealVerificationError,
  type SealOptions,
  type SealReport,
  type SealTrust,
} from "./types.js";
import {
  validateCertificateChain,
  verifyTimestampResponse,
  verifyDetachedCms,
} from "./verify.js";

const FIELD_NAME = "PaperSignOrganizationSeal";
const fingerprint = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const equal = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));
const arrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  new Uint8Array(bytes).buffer;
const unique = (items: readonly Uint8Array[]) => [
  ...new Map(items.map((item) => [fingerprint(item), item])).values(),
];

export interface SealDependencies {
  /** Test-only transport injection; the production service does not expose this. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

async function responseBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (response.status !== 200 || !response.body)
    throw new SealVerificationError("PROVIDER_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > limit)
        throw new SealVerificationError("PROVIDER_RESPONSE_SIZE");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total === 0) throw new SealVerificationError("PROVIDER_RESPONSE_EMPTY");
  return Buffer.concat(chunks, total);
}

function requirePolicy(options: SealOptions): void {
  const policy = options.policy;
  if (
    !/^[a-f0-9]{64}$/i.test(policy.expectedSignerFingerprint) ||
    policy.trustedRoots.length < 1 ||
    policy.trustedRoots.length > 8 ||
    policy.crlUrls.length < 1 ||
    policy.crlUrls.length > 8 ||
    (policy.certificateChain?.length ?? 0) > 16 ||
    (policy.reason?.length ?? 0) > 200 ||
    (policy.name?.length ?? 0) > 100 ||
    (policy.tsaPolicyOid && !/^\d+(\.\d+)+$/.test(policy.tsaPolicyOid))
  ) {
    throw new SealVerificationError("POLICY_INVALID");
  }
  for (const [index, value] of [policy.tsaUrl, ...policy.crlUrls].entries()) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SealVerificationError("POLICY_URL");
    }
    if (
      (index === 0
        ? url.protocol !== "https:"
        : !["https:", "http:"].includes(url.protocol)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new SealVerificationError("POLICY_URL");
  }
  if (options.p12.length < 1 || options.p12.length > 1024 * 1024)
    throw new SealVerificationError("KEY_SIZE");
}

function cmsContents(padded: Uint8Array): Uint8Array {
  const parsed = asn1.fromBER(arrayBuffer(padded));
  if (
    parsed.offset < 1 ||
    padded.subarray(parsed.offset).some((byte) => byte !== 0)
  ) {
    throw new SealVerificationError("PDF_CONTENTS");
  }
  return padded.slice(0, parsed.offset);
}

/** Read the real signature field and cross-check its excluded bytes against /Contents. */
function extractSignature(pdf: PDF, bytes: Uint8Array, revisionLength: number) {
  const resolve = pdf.getObject.bind(pdf);
  const fields =
    pdf
      .getForm()
      ?.getSignatureFields()
      .filter((field) => field.isSigned()) ?? [];
  if (fields.length !== 1 || fields[0].name !== FIELD_NAME)
    throw new SealVerificationError("PDF_SIGNATURE_COUNT");
  const signature = fields[0].getDict().getDict("V", resolve);
  if (
    !signature ||
    signature.getName("SubFilter", resolve)?.value !== "ETSI.CAdES.detached" ||
    signature.getName("Filter", resolve)?.value !== "Adobe.PPKLite" ||
    !/^D:\d{14}Z$/.test(signature.getString("M", resolve)?.asString() ?? "") ||
    signature.has("Cert")
  ) {
    throw new SealVerificationError("PDF_SIGNATURE_FORMAT");
  }
  const range = signature.getArray("ByteRange", resolve);
  const contents = signature.getString("Contents", resolve);
  if (!range || range.length !== 4 || !contents)
    throw new SealVerificationError("PDF_BYTE_RANGE");
  const numbers = range
    .toArray()
    .map((item) => (item instanceof PdfNumber ? item.value : NaN));
  const [start, beforeLength, afterStart, afterLength] = numbers;
  if (
    numbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    start !== 0 ||
    beforeLength >= afterStart ||
    afterStart + afterLength !== revisionLength ||
    revisionLength > bytes.length
  ) {
    throw new SealVerificationError("PDF_BYTE_RANGE");
  }
  const excluded = Buffer.from(
    bytes.subarray(beforeLength, afterStart),
  ).toString("latin1");
  if (
    !/^<[a-fA-F0-9]+>$/.test(excluded) ||
    excluded.length % 2 !== 0 ||
    !equal(Buffer.from(excluded.slice(1, -1), "hex"), contents.bytes)
  ) {
    throw new SealVerificationError("PDF_CONTENTS_RANGE");
  }
  return {
    cmsDer: cmsContents(contents.bytes),
    signedBytes: Buffer.concat([
      bytes.subarray(0, beforeLength),
      bytes.subarray(afterStart, revisionLength),
    ]),
  };
}

function declarePadesExtensions(pdf: PDF): void {
  const catalog = pdf.getCatalog();
  const existing = catalog.getDict("Extensions", pdf.getObject.bind(pdf));
  if (catalog.has("Extensions") && !existing)
    throw new SealVerificationError("PDF_EXTENSIONS");
  const extensions = existing?.clone() ?? new PdfDict();
  const adobe = extensions.getDict("ADBE", pdf.getObject.bind(pdf));
  if (
    extensions.has("ADBE") &&
    (!adobe || adobe.getName("BaseVersion")?.value !== "1.7")
  )
    throw new SealVerificationError("PDF_EXTENSIONS");
  const level = adobe?.getNumber("ExtensionLevel")?.value ?? 0;
  if (!Number.isSafeInteger(level) || level < 0)
    throw new SealVerificationError("PDF_EXTENSIONS");
  // EN 319 142-1:2024, 5.6: Adobe extension 8 declares CAdES and DSS support.
  extensions.set(
    "ADBE",
    PdfDict.of({
      BaseVersion: PdfName.of("1.7"),
      ExtensionLevel: new PdfNumber(Math.max(8, level)),
    }),
  );
  catalog.set("Extensions", extensions);
}

function embedDss(
  pdf: PDF,
  certificates: Uint8Array[],
  crls: Uint8Array[],
): void {
  const registerStream = (bytes: Uint8Array) =>
    pdf.context.register(new PdfStream([], bytes));
  const certRefs = new PdfArray(certificates.map(registerStream));
  const crlRefs = new PdfArray(crls.map(registerStream));
  // EN 319 142-1:2024, 6.3(v): omit optional VRI; DSS carries all evidence.
  const dss = PdfDict.of({
    Type: PdfName.of("DSS"),
    Certs: certRefs,
    CRLs: crlRefs,
  });
  pdf.getCatalog().set("DSS", pdf.context.register(dss));
}

function readDss(pdf: PDF): { certificates: Uint8Array[]; crls: Uint8Array[] } {
  const resolve = pdf.getObject.bind(pdf);
  const dss = pdf.getCatalog().getDict("DSS", resolve);
  if (
    !dss ||
    dss.size !== 3 ||
    dss.getName("Type")?.value !== "DSS" ||
    dss.has("OCSPs") ||
    dss.has("VRI")
  )
    throw new SealVerificationError("DSS_MISSING");
  const readStreams = (dictionary: PdfDict, key: string): Uint8Array[] => {
    const array = dictionary.getArray(key, resolve);
    if (!array || array.length < 1 || array.length > 32)
      throw new SealVerificationError("DSS_MATERIAL");
    return Array.from({ length: array.length }, (_, index) => {
      const stream = array.at(index, resolve);
      if (!(stream instanceof PdfStream))
        throw new SealVerificationError("DSS_STREAM");
      const bytes = stream.getDecodedData();
      if (bytes.length > 8 * 1024 * 1024)
        throw new SealVerificationError("DSS_SIZE");
      return bytes;
    });
  };
  const certificates = readStreams(dss, "Certs");
  const crls = readStreams(dss, "CRLs");
  return { certificates, crls };
}

function exactMaterial(actual: Uint8Array[], expected: Uint8Array[]): boolean {
  return (
    actual.length === expected.length &&
    unique(actual).length === actual.length &&
    actual.every((value) =>
      expected.some((candidate) => equal(value, candidate)),
    )
  );
}

/** An unsigned DSS revision may add evidence; it must not alter displayed document objects. */
function assertOnlyDssUpdate(before: PDF, after: PDF): void {
  const finalCatalog = after.getCatalog().clone();
  finalCatalog.delete("DSS");
  const pending: [PdfObject, PdfObject][] = [
    [before.getCatalog(), finalCatalog],
  ];
  const references = new Set<string>();
  let examined = 0;
  const fail = () => {
    throw new SealVerificationError("PDF_CHANGED_AFTER_SIGNING");
  };
  while (pending.length) {
    if (++examined > 500_000)
      throw new SealVerificationError("PDF_OBJECT_LIMIT");
    const [left, right] = pending.pop()!;
    if (left.type !== right.type) fail();
    if (left instanceof PdfRef && right instanceof PdfRef) {
      if (left.toString() !== right.toString()) fail();
      if (references.has(left.toString())) continue;
      references.add(left.toString());
      const oldObject = before.getObject(left);
      const newObject = after.getObject(right);
      if (!oldObject || !newObject) fail();
      // A reference back to the catalog must use the same DSS exception.
      pending.push([
        oldObject!,
        newObject === after.getCatalog() ? finalCatalog : newObject!,
      ]);
    } else if (left instanceof PdfArray && right instanceof PdfArray) {
      if (left.length !== right.length) fail();
      for (let index = 0; index < left.length; index++)
        pending.push([left.at(index)!, right.at(index)!]);
    } else if (left instanceof PdfDict && right instanceof PdfDict) {
      if (left.size !== right.size) fail();
      if (
        left instanceof PdfStream &&
        right instanceof PdfStream &&
        !equal(left.data, right.data)
      )
        fail();
      for (const [key, value] of left) {
        const candidate = right.get(key);
        if (!candidate) fail();
        pending.push([value, candidate!]);
      }
    } else if (left instanceof PdfString && right instanceof PdfString) {
      if (!equal(left.bytes, right.bytes)) fail();
    } else if (
      (left instanceof PdfNumber && right instanceof PdfNumber) ||
      (left instanceof PdfName && right instanceof PdfName) ||
      (left instanceof PdfBool && right instanceof PdfBool)
    ) {
      if (left.value !== right.value) fail();
    } else if (!(left instanceof PdfNull && right instanceof PdfNull)) fail();
  }
}

/** Final organization seal; call only after all page edits and optional rasterization. */
export async function sealPdf(
  input: Uint8Array,
  options: SealOptions,
  dependencies: SealDependencies = {},
): Promise<{ bytes: Uint8Array; report: SealReport }> {
  requirePolicy(options);
  if (input.length < 8 || input.length > MAX_SEAL_BYTES)
    throw new SealVerificationError("PDF_SIZE");
  const now = dependencies.now ?? (() => new Date());
  const policy = options.policy;
  const fetch =
    dependencies.fetch ??
    createBoundedFetch([policy.tsaUrl, ...policy.crlUrls]);
  try {
    const p12Signer = await P12Signer.create(options.p12, options.p12Password, {
      buildChain: false,
    });
    if (
      fingerprint(p12Signer.certificate) !==
      policy.expectedSignerFingerprint.toLowerCase()
    ) {
      throw new SealVerificationError("SIGNER_FINGERPRINT");
    }
    const pdf = await PDF.load(input, { lenient: false });
    if (
      pdf.recoveredViaBruteForce ||
      pdf.getCatalog().has("DSS") ||
      pdf.getCatalog().has("Perms") ||
      (pdf
        .getForm()
        ?.getSignatureFields()
        .some((field) => field.isSigned()) ??
        false)
    ) {
      throw new SealVerificationError("PDF_ALREADY_SIGNED");
    }
    declarePadesExtensions(pdf);
    const crls = unique(
      await Promise.all(
        policy.crlUrls.map(async (url) =>
          responseBytes(
            await fetch(url, {
              headers: { Accept: "application/pkix-crl" },
              redirect: "error",
            }),
            8 * 1024 * 1024,
          ),
        ),
      ),
    );
    const chainCertificates = unique([
      ...p12Signer.certificateChain,
      ...(policy.certificateChain ?? []),
      ...policy.trustedRoots,
    ]);
    const signerChain = await validateCertificateChain({
      leafDer: p12Signer.certificate,
      chainDer: chainCertificates,
      rootDer: policy.trustedRoots,
      crlDer: crls,
      at: now(),
      purpose: "signer",
    });
    const trust: SealTrust = {
      rootDer: policy.trustedRoots,
      chainDer: chainCertificates,
      crlDer: crls,
    };
    const signer: Signer = {
      certificate: p12Signer.certificate,
      certificateChain: signerChain.certificates.slice(1),
      keyType: p12Signer.keyType,
      signatureAlgorithm: p12Signer.signatureAlgorithm,
      sign: p12Signer.sign.bind(p12Signer),
    };
    const signed = await pdf.sign({
      signer,
      level: "B-T",
      digestAlgorithm: "SHA-256",
      fieldName: FIELD_NAME,
      reason: policy.reason ?? "PaperSign completed document seal",
      estimatedSize: 32768,
      timestampAuthority: {
        async timestamp(imprint, algorithm) {
          if (algorithm !== "SHA-256")
            throw new SealVerificationError("TIMESTAMP_ALGORITHM");
          const nonce = randomBytes(16);
          nonce[0] = nonce[0] & 0x7f || 1;
          const request = new pki.TimeStampReq({
            version: 1,
            messageImprint: new pki.MessageImprint({
              hashAlgorithm: new pki.AlgorithmIdentifier({
                algorithmId: "2.16.840.1.101.3.4.2.1",
                algorithmParams: new asn1.Null(),
              }),
              hashedMessage: new asn1.OctetString({
                valueHex: arrayBuffer(imprint),
              }),
            }),
            nonce: new asn1.Integer({ valueHex: arrayBuffer(nonce) }),
            certReq: true,
            ...(policy.tsaPolicyOid ? { reqPolicy: policy.tsaPolicyOid } : {}),
          });
          const response = await responseBytes(
            await fetch(policy.tsaUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/timestamp-query",
                Accept: "application/timestamp-reply",
              },
              body: request.toSchema().toBER(false),
              redirect: "error",
            }),
            1024 * 1024,
          );
          const result = await verifyTimestampResponse({
            responseDer: response,
            expectedImprint: imprint,
            hashAlgorithm: algorithm,
            nonce,
            policyOid: policy.tsaPolicyOid,
            trust,
            now: now(),
          });
          return result.tokenDer;
        },
      },
    });
    if (signed.warnings.length)
      throw new SealVerificationError("PDF_SIGNING_WARNING");
    const revision = await PDF.load(signed.bytes, { lenient: false });
    const original = extractSignature(
      revision,
      signed.bytes,
      signed.bytes.length,
    );
    const verified = await verifyDetachedCms({
      ...original,
      expectedSignerDer: signer.certificate,
      trust,
      now: now(),
      policyOid: policy.tsaPolicyOid,
    });
    const certificates = unique([
      ...verified.chain.certificates,
      ...verified.timestamp.chain.certificates,
    ]);
    const validatedCrls = unique([
      ...verified.chain.crls,
      ...verified.timestamp.chain.crls,
    ]);
    embedDss(revision, certificates, validatedCrls);
    const bytes = await revision.save({ incremental: true });
    if (bytes.length > MAX_SEAL_BYTES)
      throw new SealVerificationError("PDF_SIZE");
    if (!equal(bytes.subarray(0, signed.bytes.length), signed.bytes))
      throw new SealVerificationError("PDF_REWRITTEN");
    const output = await PDF.load(bytes, { lenient: false });
    assertOnlyDssUpdate(
      await PDF.load(signed.bytes, { lenient: false }),
      output,
    );
    const embedded = readDss(output);
    if (
      !exactMaterial(embedded.certificates, certificates) ||
      !exactMaterial(embedded.crls, validatedCrls)
    ) {
      throw new SealVerificationError("DSS_CONTENT_MISMATCH");
    }
    const finalSignature = extractSignature(output, bytes, signed.bytes.length);
    // Revalidation uses the bytes actually embedded in the PDF, with no provider access.
    const final = await verifyDetachedCms({
      ...finalSignature,
      expectedSignerDer: signer.certificate,
      trust: {
        rootDer: policy.trustedRoots,
        chainDer: embedded.certificates,
        crlDer: embedded.crls,
      },
      now: now(),
      policyOid: policy.tsaPolicyOid,
    });
    return {
      bytes,
      report: {
        ...final.report,
        validationCertificates: embedded.certificates.length,
        validationCrls: embedded.crls.length,
      },
    };
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    // Parsers and providers can include confidential input in error messages.
    throw new SealVerificationError("SEAL_FAILED");
  }
}
