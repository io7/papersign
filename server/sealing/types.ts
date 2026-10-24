/** Sealing is an organization attestation, separate from participants' drawn signatures. */
export type SealHashAlgorithm = "SHA-256" | "SHA-384" | "SHA-512";
export type CertificatePurpose = "signer" | "timestamp";

/** Only operator-selected trust anchors and CRL endpoints are accepted. */
export interface SealPolicy {
  expectedSignerFingerprint: string;
  tsaUrl: string;
  tsaPolicyOid?: string;
  trustedRoots: Uint8Array[];
  crlUrls: string[];
  certificateChain?: Uint8Array[];
  name?: string;
  reason?: string;
}

export interface SealOptions {
  p12: Uint8Array;
  p12Password: string;
  policy: SealPolicy;
}

export interface SealTrust {
  rootDer: readonly Uint8Array[];
  chainDer?: readonly Uint8Array[];
  crlDer: readonly Uint8Array[];
}

export interface ChainValidationOptions {
  leafDer: Uint8Array;
  chainDer: readonly Uint8Array[];
  rootDer: readonly Uint8Array[];
  crlDer: readonly Uint8Array[];
  at: Date;
  purpose: CertificatePurpose;
}

export interface ValidatedChain {
  /** Validated path, ordered leaf to explicit operator trust anchor. */
  certificates: Uint8Array[];
  crls: Uint8Array[];
  leafFingerprint: string;
}

export interface TimestampVerificationOptions {
  expectedImprint: Uint8Array;
  hashAlgorithm: SealHashAlgorithm;
  /** Unsigned big-endian request nonce. Required when checking a live response. */
  nonce?: Uint8Array;
  policyOid?: string;
  trust: SealTrust;
  now: Date;
}

export interface ValidatedTimestamp {
  tokenDer: Uint8Array;
  genTime: Date;
  policyOid: string;
  signerCertificate: Uint8Array;
  chain: ValidatedChain;
}

export interface DetachedCmsVerificationOptions {
  expectedSignerDer: Uint8Array;
  trust: SealTrust;
  now: Date;
  policyOid?: string;
}

export interface SealReport {
  profile: "PAdES-B-LT";
  signerFingerprint: string;
  timestamp: string;
  tsaFingerprint: string;
  validationCertificates: number;
  validationCrls: number;
}

export interface ValidatedDetachedCms {
  signerCertificate: Uint8Array;
  chain: ValidatedChain;
  timestamp: ValidatedTimestamp;
  report: SealReport;
}

/** Stable public error: do not expose provider responses, key data or parser internals. */
export class SealVerificationError extends Error {
  constructor(public readonly code: string) {
    super(`Certificate seal verification failed (${code}).`);
    this.name = "SealVerificationError";
  }
}
