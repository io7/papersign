import {
  createHash,
  timingSafeEqual,
  verify as nodeVerify,
  webcrypto,
  X509Certificate,
} from "node:crypto";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import {
  SealVerificationError,
  type ChainValidationOptions,
  type DetachedCmsVerificationOptions,
  type SealHashAlgorithm,
  type TimestampVerificationOptions,
  type ValidatedChain,
  type ValidatedDetachedCms,
  type ValidatedTimestamp,
} from "./types.js";

const cryptoEngine = new pki.CryptoEngine({
  name: "PaperSign Node WebCrypto",
  crypto: webcrypto as unknown as Crypto,
});
const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  essV1: "1.2.840.113549.1.9.16.2.12",
  essV2: "1.2.840.113549.1.9.16.2.47",
  timestamp: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  basic: "2.5.29.19",
  ku: "2.5.29.15",
  eku: "2.5.29.37",
  tsa: "1.3.6.1.5.5.7.3.8",
  ski: "2.5.29.14",
  aki: "2.5.29.35",
};
const HASHES: Record<
  SealHashAlgorithm,
  { oid: string; name: string; size: number }
> = {
  "SHA-256": { oid: "2.16.840.1.101.3.4.2.1", name: "sha256", size: 32 },
  "SHA-384": { oid: "2.16.840.1.101.3.4.2.2", name: "sha384", size: 48 },
  "SHA-512": { oid: "2.16.840.1.101.3.4.2.3", name: "sha512", size: 64 },
};
const SIG_HASH: Record<string, string> = {
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
};
const MAX_CHAIN = 8;
const MAX_CRL = 8 * 1024 * 1024;
const CLOCK_SKEW = 5 * 60 * 1000;
const fail = (code: string): never => {
  throw new SealVerificationError(code);
};
function assert(condition: unknown, code: string): asserts condition {
  if (!condition) fail(code);
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
function bytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
function fingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}
function der(value: {
  toSchema(): { toBER(sizeOnly?: boolean): ArrayBuffer };
}): Uint8Array {
  return new Uint8Array(value.toSchema().toBER(false));
}
function raw(node: asn1.BaseBlock): Uint8Array {
  return node.valueBeforeDecodeView.length
    ? node.valueBeforeDecodeView
    : new Uint8Array(node.toBER(false));
}
/** Bound parsing and reject BER indefinite lengths; signed protocol values must be DER. */
function decode(input: Uint8Array, max = 512 * 1024): asn1.BaseBlock {
  assert(input.length > 0 && input.length <= max, "der_size");
  const parsed = asn1.fromBER(input, {
    maxDepth: 32,
    maxNodes: 200000,
    maxContentLength: max,
  });
  assert(parsed.offset === input.length && !parsed.result.error, "der_parse");
  let count = 0;
  const inspect = (node: asn1.BaseBlock, depth: number) => {
    assert(
      ++count <= 200000 && depth <= 32 && !node.lenBlock.isIndefiniteForm,
      "der_structure",
    );
    if (node.idBlock.isConstructed) {
      const children = (
        node.valueBlock as unknown as { value?: asn1.BaseBlock[] }
      ).value;
      assert(Array.isArray(children), "der_constructed_value");
      for (const child of children) inspect(child, depth + 1);
    }
  };
  inspect(parsed.result, 0);
  return parsed.result;
}
function sequence(node: unknown): asn1.BaseBlock[] {
  assert(node instanceof asn1.Sequence, "asn1_sequence");
  return node.valueBlock.value;
}
function octets(node: unknown): Uint8Array {
  assert(
    node instanceof asn1.OctetString && !node.idBlock.isConstructed,
    "asn1_octets",
  );
  return node.valueBlock.valueHexView;
}
function oid(node: unknown): string {
  assert(node instanceof asn1.ObjectIdentifier, "asn1_oid");
  return node.valueBlock.toString();
}
function positiveInteger(node: unknown): Uint8Array {
  assert(node instanceof asn1.Integer, "asn1_integer");
  let value = node.valueBlock.valueHexView;
  assert(value.length > 0 && (value[0]! & 128) === 0, "asn1_negative_integer");
  assert(
    value.length === 1 || value[0] !== 0 || (value[1]! & 128) !== 0,
    "asn1_nonminimal_integer",
  );
  if (value.length > 1 && value[0] === 0) value = value.subarray(1);
  return value;
}
function normalizeNonce(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start + 1 < value.length && value[start] === 0) start++;
  return value.subarray(start);
}
function hashForOid(value: string): {
  oid: string;
  name: string;
  size: number;
} {
  const found = Object.values(HASHES).find((h) => h.oid === value);
  assert(found, "unsupported_digest");
  return found;
}
function simpleAlgorithm(algorithm: pki.AlgorithmIdentifier): void {
  assert(
    !algorithm.algorithmParams ||
      algorithm.algorithmParams instanceof asn1.Null,
    "unsupported_algorithm_parameters",
  );
}
function signatureHash(
  algorithm: pki.AlgorithmIdentifier,
  cmsDigest?: string,
): string {
  simpleAlgorithm(algorithm);
  if (algorithm.algorithmId === "1.2.840.113549.1.1.1") {
    assert(cmsDigest, "unsupported_signature_algorithm");
    return cmsDigest;
  }
  const hash = SIG_HASH[algorithm.algorithmId];
  assert(
    hash && (!cmsDigest || cmsDigest === hash),
    "unsupported_signature_algorithm",
  );
  return hash;
}
function signatureKeyMatches(
  algorithm: pki.AlgorithmIdentifier,
  cert: pki.Certificate,
): void {
  const type = nativeCert(cert).publicKey.asymmetricKeyType;
  assert(
    (algorithm.algorithmId.startsWith("1.2.840.10045.") && type === "ec") ||
      (algorithm.algorithmId.startsWith("1.2.840.113549.1.1.") &&
        type === "rsa"),
    "signature_key_mismatch",
  );
}
function extension(
  cert: pki.Certificate,
  id: string,
): pki.Extension | undefined {
  return cert.extensions?.find((e) => e.extnID === id);
}
function extensionValue(ext: pki.Extension): asn1.BaseBlock {
  return decode(ext.extnValue.valueBlock.valueHexView, 65536);
}
function keyUsage(cert: pki.Certificate): Uint8Array {
  const ext = extension(cert, OID.ku);
  assert(ext, "certificate_key_usage_missing");
  const bits = extensionValue(ext);
  assert(
    bits instanceof asn1.BitString && !bits.idBlock.isConstructed,
    "certificate_key_usage",
  );
  return bits.valueBlock.valueHexView;
}
function basicConstraints(
  cert: pki.Certificate,
): pki.BasicConstraints | undefined {
  const ext = extension(cert, OID.basic);
  return ext
    ? new pki.BasicConstraints({ schema: extensionValue(ext) })
    : undefined;
}
function eku(cert: pki.Certificate): string[] | undefined {
  const ext = extension(cert, OID.eku);
  return ext
    ? new pki.ExtKeyUsage({ schema: extensionValue(ext) }).keyPurposes
    : undefined;
}
function checkDate(cert: pki.Certificate, at: Date): void {
  const time = at.getTime();
  assert(
    Number.isFinite(time) &&
      Number.isFinite(cert.notBefore.value.getTime()) &&
      Number.isFinite(cert.notAfter.value.getTime()),
    "certificate_time",
  );
  assert(
    cert.notBefore.value.getTime() <= time &&
      time <= cert.notAfter.value.getTime(),
    "certificate_expired_or_not_yet_valid",
  );
}
function nativeCert(cert: pki.Certificate): X509Certificate {
  return new X509Certificate(der(cert));
}
function checkCertificate(cert: pki.Certificate, at: Date): void {
  checkDate(cert, at);
  assert(
    equal(der(cert.signature), der(cert.signatureAlgorithm)),
    "certificate_algorithm_mismatch",
  );
  signatureHash(cert.signatureAlgorithm);
  const serial = positiveInteger(cert.serialNumber);
  assert(
    serial.length <= 20 && serial.some((byte) => byte !== 0),
    "certificate_serial",
  );
  assert(
    cert.signatureValue.valueBlock.unusedBits === 0,
    "certificate_signature_bits",
  );
  const extensions = cert.extensions ?? [];
  assert(
    new Set(extensions.map((e) => e.extnID)).size === extensions.length,
    "duplicate_certificate_extension",
  );
  for (const ext of extensions) {
    assert(
      !ext.critical || [OID.basic, OID.ku, OID.eku].includes(ext.extnID),
      "unsupported_critical_certificate_extension",
    );
    // These constrain path acceptance and cannot be ignored even if marked noncritical.
    assert(
      !["2.5.29.30", "2.5.29.33", "2.5.29.36", "2.5.29.54"].includes(
        ext.extnID,
      ),
      "unsupported_certificate_constraint",
    );
  }
  const publicKey = nativeCert(cert).publicKey;
  if (publicKey.asymmetricKeyType === "rsa") {
    assert(
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
      "weak_certificate_key",
    );
  } else if (publicKey.asymmetricKeyType === "ec") {
    assert(
      ["prime256v1", "secp384r1", "secp521r1"].includes(
        publicKey.asymmetricKeyDetails?.namedCurve ?? "",
      ),
      "unsupported_certificate_curve",
    );
  } else fail("unsupported_certificate_key");
}
function checkCa(cert: pki.Certificate, subordinateCas: number): void {
  const ext = extension(cert, OID.basic);
  const basic = basicConstraints(cert);
  assert(ext?.critical && basic?.cA, "issuer_not_ca");
  const usage = keyUsage(cert)[0] ?? 0;
  assert((usage & 0x04) !== 0 && (usage & 0x02) !== 0, "issuer_key_usage");
  if (basic.pathLenConstraint !== undefined) {
    assert(
      typeof basic.pathLenConstraint === "number" &&
        basic.pathLenConstraint >= subordinateCas,
      "certificate_path_length",
    );
  }
}
function checkLeaf(
  cert: pki.Certificate,
  purpose: ChainValidationOptions["purpose"],
): void {
  assert(!basicConstraints(cert)?.cA, "signer_is_ca");
  const usage = keyUsage(cert)[0] ?? 0;
  assert((usage & 0xc0) !== 0 && (usage & 0x06) === 0, "signer_key_usage");
  const purposes = eku(cert);
  if (purpose === "timestamp") {
    assert(
      extension(cert, OID.eku)?.critical &&
        purposes?.length === 1 &&
        purposes[0] === OID.tsa &&
        (usage & 0x80) !== 0,
      "timestamp_eku",
    );
  } else if (purposes) {
    assert(
      purposes.some((p) =>
        [
          "1.3.6.1.5.5.7.3.36",
          "1.2.840.113583.1.1.5",
          "1.3.6.1.4.1.311.10.3.12",
        ].includes(p),
      ),
      "document_signing_eku",
    );
  }
}
function parseCert(input: Uint8Array): pki.Certificate {
  return new pki.Certificate({ schema: decode(input, 65536) });
}
export function parseCertificateDer(input: Uint8Array): pki.Certificate {
  try {
    return parseCert(input);
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    return fail("certificate_parse");
  }
}
function verifyCrl(
  crl: pki.CertificateRevocationList,
  issuer: pki.Certificate,
  subject: pki.Certificate,
  at: Date,
): void {
  assert(crl.issuer.isEqual(issuer.subject), "crl_issuer");
  assert(
    equal(der(crl.signature), der(crl.signatureAlgorithm)),
    "crl_algorithm_mismatch",
  );
  const hash = signatureHash(crl.signatureAlgorithm);
  signatureKeyMatches(crl.signatureAlgorithm, issuer);
  assert(
    nodeVerify(
      hash,
      crl.tbsView,
      nativeCert(issuer).publicKey,
      crl.signatureValue.valueBlock.valueHexView,
    ),
    "crl_signature",
  );
  assert(crl.signatureValue.valueBlock.unusedBits === 0, "crl_signature_bits");
  const start = crl.thisUpdate.value.getTime();
  const end = crl.nextUpdate?.value.getTime();
  assert(
    Number.isFinite(start) &&
      end !== undefined &&
      Number.isFinite(end) &&
      start <= at.getTime() &&
      end > at.getTime() &&
      start < end,
    "crl_not_current",
  );
  const extensions = crl.crlExtensions?.extensions ?? [];
  assert(
    new Set(extensions.map((e) => e.extnID)).size === extensions.length,
    "duplicate_crl_extension",
  );
  for (const ext of extensions) {
    assert(
      !["2.5.29.27", "2.5.29.28", "2.5.29.46"].includes(ext.extnID),
      "unsupported_crl_scope",
    );
    assert(!ext.critical, "unsupported_critical_crl_extension");
    if (ext.extnID === OID.aki) {
      const authority = new pki.AuthorityKeyIdentifier({
        schema: extensionValue(ext),
      });
      const ski = extension(issuer, OID.ski);
      if (authority.keyIdentifier && ski)
        assert(
          equal(
            authority.keyIdentifier.valueBlock.valueHexView,
            octets(extensionValue(ski)),
          ),
          "crl_authority_key",
        );
    }
  }
  for (const revoked of crl.revokedCertificates ?? []) {
    for (const ext of revoked.crlEntryExtensions?.extensions ?? []) {
      assert(
        ext.extnID !== "2.5.29.29" && !ext.critical,
        "unsupported_crl_entry",
      );
    }
    assert(
      !equal(
        positiveInteger(revoked.userCertificate),
        positiveInteger(subject.serialNumber),
      ),
      "certificate_revoked",
    );
  }
}

/** Validate a bounded, unambiguous path and every non-root certificate's full direct CRL. */
export async function validateCertificateChain(
  options: ChainValidationOptions,
): Promise<ValidatedChain> {
  try {
    assert(
      options.rootDer.length > 0 &&
        options.rootDer.length <= 16 &&
        options.chainDer.length <= 32 &&
        options.crlDer.length <= 32,
      "trust_material_count",
    );
    const rootMap = new Map(
      options.rootDer.map((item) => [fingerprint(item), parseCert(item)]),
    );
    const pool = new Map(
      [...options.chainDer, ...options.rootDer].map((item) => [
        fingerprint(item),
        parseCert(item),
      ]),
    );
    const leaf = parseCert(options.leafDer);
    checkCertificate(leaf, options.at);
    checkLeaf(leaf, options.purpose);
    const path = [leaf];
    const visited = new Set([fingerprint(der(leaf))]);
    while (!rootMap.has(fingerprint(der(path[path.length - 1]!)))) {
      assert(path.length < MAX_CHAIN, "certificate_path_too_long");
      const child = path[path.length - 1]!;
      const candidates = [...pool.values()].filter((candidate) => {
        if (
          visited.has(fingerprint(der(candidate))) ||
          !child.issuer.isEqual(candidate.subject)
        )
          return false;
        return nativeCert(child).verify(nativeCert(candidate).publicKey);
      });
      assert(
        candidates.length === 1,
        candidates.length
          ? "ambiguous_certificate_chain"
          : "untrusted_certificate_chain",
      );
      const parent = candidates[0]!;
      checkCertificate(parent, options.at);
      checkCa(parent, path.length - 1);
      const parentEku = eku(parent);
      if (parentEku) {
        assert(
          options.purpose === "timestamp"
            ? parentEku.includes(OID.tsa)
            : parentEku.some((p) =>
                [
                  "1.3.6.1.5.5.7.3.36",
                  "1.2.840.113583.1.1.5",
                  "1.3.6.1.4.1.311.10.3.12",
                ].includes(p),
              ),
          "issuer_eku_constraint",
        );
      }
      path.push(parent);
      visited.add(fingerprint(der(parent)));
    }
    assert(path.length >= 2, "leaf_cannot_be_trust_anchor");
    const root = path[path.length - 1]!;
    assert(
      root.issuer.isEqual(root.subject) &&
        nativeCert(root).verify(nativeCert(root).publicKey),
      "trust_anchor_not_self_signed",
    );
    const crls = options.crlDer.map(
      (input) =>
        new pki.CertificateRevocationList({ schema: decode(input, MAX_CRL) }),
    );
    const usedCrls = new Map<string, pki.CertificateRevocationList>();
    for (let i = 0; i < path.length - 1; i++) {
      const subject = path[i]!;
      const issuer = path[i + 1]!;
      const candidates = crls.filter((crl) =>
        crl.issuer.isEqual(issuer.subject),
      );
      assert(candidates.length > 0, "crl_missing");
      // Every supplied CRL for this issuer must be acceptable; never hide a revoked or stale candidate behind another one.
      for (const crl of candidates) {
        verifyCrl(crl, issuer, subject, options.at);
        usedCrls.set(fingerprint(der(crl)), crl);
      }
    }
    const engine = new pki.CertificateChainValidationEngine({
      trustedCerts: [root],
      certs: [...path].reverse(),
      crls: [...usedCrls.values()],
      checkDate: options.at,
    });
    const validated = await engine.verify(
      { passedWhenNotRevValues: false },
      cryptoEngine,
    );
    assert(validated.result, "certificate_path_validation");
    return {
      certificates: path.map(der),
      crls: [...usedCrls.values()].map(der),
      leafFingerprint: fingerprint(options.leafDer),
    };
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    return fail("certificate_validation");
  }
}

interface ParsedCms {
  cms: pki.SignedData;
  signer: pki.SignerInfo;
  certificate: pki.Certificate;
  certificates: pki.Certificate[];
}
function parseCms(input: Uint8Array): ParsedCms {
  const content = new pki.ContentInfo({ schema: decode(input) });
  assert(content.contentType === OID.signedData, "cms_content_type");
  const cms = new pki.SignedData({ schema: content.content });
  assert(
    cms.signerInfos.length === 1 && cms.digestAlgorithms.length === 1,
    "cms_signer_count",
  );
  const signer = cms.signerInfos[0]!;
  assert(
    signer.sid instanceof pki.IssuerAndSerialNumber,
    "cms_signer_identifier",
  );
  assert(
    cms.certificates &&
      cms.certificates.length > 0 &&
      cms.certificates.length <= 32 &&
      cms.certificates.every((cert) => cert instanceof pki.Certificate),
    "cms_certificates",
  );
  const certificates = cms.certificates as pki.Certificate[];
  const sid = signer.sid;
  const matching = certificates.filter(
    (cert) =>
      cert.issuer.isEqual(sid.issuer) &&
      equal(
        positiveInteger(cert.serialNumber),
        positiveInteger(sid.serialNumber),
      ),
  );
  assert(matching.length === 1, "cms_signer_certificate");
  simpleAlgorithm(signer.digestAlgorithm);
  simpleAlgorithm(cms.digestAlgorithms[0]!);
  assert(
    cms.digestAlgorithms[0]!.algorithmId === signer.digestAlgorithm.algorithmId,
    "cms_digest_algorithm_mismatch",
  );
  hashForOid(signer.digestAlgorithm.algorithmId);
  return { cms, signer, certificate: matching[0]!, certificates };
}
export function getCmsCertificates(input: Uint8Array): Uint8Array[] {
  try {
    return parseCms(input).certificates.map(der);
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    return fail("cms_parse");
  }
}
function attribute(parsed: ParsedCms, type: string): pki.Attribute | undefined {
  return parsed.signer.signedAttrs?.attributes.find(
    (attr) => attr.type === type,
  );
}
function verifyEss(parsed: ParsedCms, timestamp: boolean): void {
  const v2 = attribute(parsed, OID.essV2);
  const v1 = attribute(parsed, OID.essV1);
  assert(
    (v2 ? 1 : 0) + (v1 ? 1 : 0) === 1 && (timestamp || v2),
    "cms_ess_missing_or_duplicate",
  );
  const attr = (v2 ?? v1)!;
  assert(attr.values.length === 1, "cms_ess_values");
  const value = sequence(attr.values[0]);
  // This profile binds one signing certificate; policy constraints and extra
  // certificate references need their own processing before they can be accepted.
  assert(value.length === 1, "cms_ess_structure");
  const identifiers = sequence(value[0]);
  assert(identifiers.length === 1, "cms_ess_structure");
  const first = sequence(identifiers[0]);
  let cursor = 0;
  let digest = v2 ? "sha256" : "sha1";
  if (v2 && first[0] instanceof asn1.Sequence) {
    const algorithm = new pki.AlgorithmIdentifier({ schema: first[cursor++] });
    simpleAlgorithm(algorithm);
    digest = hashForOid(algorithm.algorithmId).name;
  }
  const reference = octets(first[cursor++]);
  assert(
    equal(
      reference,
      createHash(digest).update(der(parsed.certificate)).digest(),
    ),
    "cms_ess_certificate_mismatch",
  );
  if (cursor < first.length) {
    const issuerSerial = sequence(first[cursor++]);
    assert(issuerSerial.length === 2, "cms_ess_issuer");
    const names = new pki.GeneralNames({ schema: issuerSerial[0] });
    assert(
      names.names.length === 1 &&
        names.names[0]!.type === 4 &&
        (names.names[0]!.value as pki.RelativeDistinguishedNames).isEqual(
          parsed.certificate.issuer,
        ),
      "cms_ess_issuer",
    );
    assert(
      equal(
        positiveInteger(issuerSerial[1]),
        positiveInteger(parsed.certificate.serialNumber),
      ),
      "cms_ess_serial",
    );
  }
  assert(cursor === first.length, "cms_ess_structure");
}
function verifyCmsSignature(
  parsed: ParsedCms,
  contentBytes: Uint8Array,
  contentType: string,
): void {
  const attrs = parsed.signer.signedAttrs;
  assert(
    attrs && attrs.attributes.length > 0 && attrs.attributes.length <= 32,
    "cms_signed_attributes",
  );
  assert(
    new Set(attrs.attributes.map((attr) => attr.type)).size ===
      attrs.attributes.length,
    "cms_duplicate_attribute",
  );
  const content = attribute(parsed, OID.contentType);
  const message = attribute(parsed, OID.messageDigest);
  assert(
    content?.values.length === 1 && oid(content.values[0]) === contentType,
    "cms_signed_content_type",
  );
  const hash = hashForOid(parsed.signer.digestAlgorithm.algorithmId).name;
  assert(
    message?.values.length === 1 &&
      equal(
        octets(message.values[0]),
        createHash(hash).update(contentBytes).digest(),
      ),
    "cms_content_digest",
  );
  verifyEss(parsed, contentType === OID.tstInfo);
  const signatureDigest = signatureHash(parsed.signer.signatureAlgorithm, hash);
  const publicKey = nativeCert(parsed.certificate).publicKey;
  signatureKeyMatches(parsed.signer.signatureAlgorithm, parsed.certificate);
  const signed = bytes(attrs.encodedValue);
  assert(
    signed.length > 0 && signed[0] === 0x31,
    "cms_signed_attributes_encoding",
  );
  const signedSet = decode(signed);
  assert(signedSet instanceof asn1.Set, "cms_signed_attributes_encoding");
  const ordered = signedSet.valueBlock.value.map(raw);
  for (let i = 1; i < ordered.length; i++) {
    assert(
      Buffer.compare(ordered[i - 1]!, ordered[i]!) <= 0,
      "cms_signed_attributes_not_der",
    );
  }
  assert(
    nodeVerify(
      signatureDigest,
      signed,
      publicKey,
      parsed.signer.signature.valueBlock.valueHexView,
    ),
    "cms_signature",
  );
}

/** Validate a timestamp token for a newly created seal, not arbitrary historical PDFs. */
export async function verifyTimestampToken(
  tokenDer: Uint8Array,
  options: TimestampVerificationOptions,
): Promise<ValidatedTimestamp> {
  try {
    const parsed = parseCms(tokenDer);
    assert(
      parsed.cms.encapContentInfo.eContentType === OID.tstInfo &&
        parsed.cms.encapContentInfo.eContent,
      "timestamp_content",
    );
    const content = octets(parsed.cms.encapContentInfo.eContent);
    verifyCmsSignature(parsed, content, OID.tstInfo);
    const info = new pki.TSTInfo({ schema: decode(content) });
    assert(
      info.version === 1 && Number.isFinite(info.genTime.getTime()),
      "timestamp_info",
    );
    assert(
      Math.abs(info.genTime.getTime() - options.now.getTime()) <= CLOCK_SKEW,
      "timestamp_time",
    );
    positiveInteger(info.serialNumber);
    if (info.accuracy) {
      const { seconds = 0, millis, micros } = info.accuracy;
      assert(
        Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 300,
        "timestamp_accuracy",
      );
      for (const fraction of [millis, micros]) {
        assert(
          fraction === undefined ||
            (Number.isSafeInteger(fraction) &&
              fraction >= 1 &&
              fraction <= 999),
          "timestamp_accuracy",
        );
      }
    }
    assert(!info.extensions?.length, "unsupported_timestamp_extension");
    const expectedHash = HASHES[options.hashAlgorithm];
    simpleAlgorithm(info.messageImprint.hashAlgorithm);
    assert(
      info.messageImprint.hashAlgorithm.algorithmId === expectedHash.oid &&
        options.expectedImprint.length === expectedHash.size &&
        equal(
          info.messageImprint.hashedMessage.valueBlock.valueHexView,
          options.expectedImprint,
        ),
      "timestamp_imprint",
    );
    if (options.nonce)
      assert(
        options.nonce.length >= 8 &&
          info.nonce &&
          equal(positiveInteger(info.nonce), normalizeNonce(options.nonce)),
        "timestamp_nonce",
      );
    if (options.policyOid)
      assert(info.policy === options.policyOid, "timestamp_policy");
    if (info.tsa)
      assert(
        info.tsa.type === 4 &&
          (info.tsa.value as pki.RelativeDistinguishedNames).isEqual(
            parsed.certificate.subject,
          ),
        "timestamp_name",
      );
    const chain = await validateCertificateChain({
      leafDer: der(parsed.certificate),
      chainDer: [
        ...parsed.certificates.map(der),
        ...(options.trust.chainDer ?? []),
      ],
      rootDer: options.trust.rootDer,
      crlDer: options.trust.crlDer,
      at: options.now,
      purpose: "timestamp",
    });
    for (const certificate of chain.certificates)
      checkDate(parseCert(certificate), info.genTime);
    return {
      tokenDer,
      genTime: info.genTime,
      policyOid: info.policy,
      signerCertificate: der(parsed.certificate),
      chain,
    };
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    return fail("timestamp_validation");
  }
}
export async function verifyTimestampResponse(
  options: TimestampVerificationOptions & { responseDer: Uint8Array },
): Promise<ValidatedTimestamp> {
  try {
    assert(options.nonce, "timestamp_request_nonce_required");
    const response = new pki.TimeStampResp({
      schema: decode(options.responseDer),
    });
    assert(
      (response.status.status === 0 || response.status.status === 1) &&
        response.timeStampToken &&
        !response.status.failInfo,
      "timestamp_response_status",
    );
    return await verifyTimestampToken(der(response.timeStampToken), options);
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    return fail("timestamp_response");
  }
}

/** Verify the exact detached CMS and signed ByteRange bytes extracted from the final PDF. */
export async function verifyDetachedCms(
  options: DetachedCmsVerificationOptions & {
    cmsDer: Uint8Array;
    signedBytes: Uint8Array;
  },
): Promise<ValidatedDetachedCms> {
  try {
    const parsed = parseCms(options.cmsDer);
    assert(
      parsed.cms.encapContentInfo.eContentType === OID.data &&
        !parsed.cms.encapContentInfo.eContent,
      "cms_not_detached",
    );
    assert(
      equal(der(parsed.certificate), options.expectedSignerDer),
      "unexpected_document_signer",
    );
    assert(!attribute(parsed, OID.signingTime), "pades_cms_signing_time");
    assert(
      parsed.signer.signedAttrs?.attributes.every((attr) =>
        [OID.contentType, OID.messageDigest, OID.essV2].includes(attr.type),
      ),
      "unsupported_pades_attribute",
    );
    verifyCmsSignature(parsed, options.signedBytes, OID.data);
    const unsigned = parsed.signer.unsignedAttrs?.attributes ?? [];
    assert(
      unsigned.length === 1 &&
        unsigned[0]!.type === OID.timestamp &&
        unsigned[0]!.values.length === 1,
      "signature_timestamp_required",
    );
    const tokenDer = raw(unsigned[0]!.values[0]!);
    const tst = new pki.TSTInfo({
      schema: decode(octets(parseCms(tokenDer).cms.encapContentInfo.eContent)),
    });
    const hashEntry = Object.entries(HASHES).find(
      ([, entry]) => entry.oid === tst.messageImprint.hashAlgorithm.algorithmId,
    );
    assert(hashEntry, "unsupported_timestamp_digest");
    const timestamp = await verifyTimestampToken(tokenDer, {
      expectedImprint: createHash(hashEntry[1].name)
        .update(parsed.signer.signature.valueBlock.valueHexView)
        .digest(),
      hashAlgorithm: hashEntry[0] as SealHashAlgorithm,
      policyOid: options.policyOid,
      trust: options.trust,
      now: options.now,
    });
    const chain = await validateCertificateChain({
      leafDer: der(parsed.certificate),
      chainDer: [
        ...parsed.certificates.map(der),
        ...(options.trust.chainDer ?? []),
      ],
      rootDer: options.trust.rootDer,
      crlDer: options.trust.crlDer,
      at: options.now,
      purpose: "signer",
    });
    for (const certificate of chain.certificates)
      checkDate(parseCert(certificate), timestamp.genTime);
    return {
      signerCertificate: der(parsed.certificate),
      chain,
      timestamp,
      report: {
        profile: "PAdES-B-LT",
        signerFingerprint: chain.leafFingerprint,
        timestamp: timestamp.genTime.toISOString(),
        tsaFingerprint: timestamp.chain.leafFingerprint,
        validationCertificates: new Set(
          [...chain.certificates, ...timestamp.chain.certificates].map(
            fingerprint,
          ),
        ).size,
        validationCrls: new Set(
          [...chain.crls, ...timestamp.chain.crls].map(fingerprint),
        ).size,
      },
    };
  } catch (error) {
    if (error instanceof SealVerificationError) throw error;
    return fail("detached_cms_validation");
  }
}
