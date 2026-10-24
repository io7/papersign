import { z } from "zod";

export const MAX_SEAL_BYTES = 128 * 1024 * 1024;
export const SEAL_TIMEOUT_MS = 120_000;
export const sealReportSchema = z
  .object({
    profile: z.literal("PAdES-B-LT"),
    signerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    timestamp: z.string().datetime(),
    tsaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    validationCertificates: z.number().int().min(1).max(64),
    validationCrls: z.number().int().min(1).max(32),
  })
  .strict();

export class SealServiceError extends Error {
  constructor() {
    super(
      "The certificate seal could not be verified. No sealed PDF was produced. Please try again or contact the administrator.",
    );
  }
}
