import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SealPolicy } from "./types.js";

const der = z
  .string()
  .min(1)
  .max(131072)
  .transform((value, ctx) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || bytes.length < 32) {
      ctx.addIssue({
        code: "custom",
        message: "Certificates must use canonical DER base64.",
      });
      return z.NEVER;
    }
    return bytes;
  });
const policySchema = z
  .object({
    tsaUrl: z.string().url().max(2048),
    tsaPolicyOid: z
      .string()
      .regex(/^[0-2](?:\.[0-9]+)+$/)
      .optional(),
    expectedSignerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    trustedRoots: z.array(der).min(1).max(8),
    certificateChain: z.array(der).max(16).default([]),
    crlUrls: z.array(z.string().url().max(2048)).min(1).max(8),
    name: z.string().min(1).max(100).default("PaperSign"),
    reason: z
      .string()
      .min(1)
      .max(200)
      .default("Organization seal of the completed document"),
  })
  .strict();

export async function readSealPolicy(
  path: string,
): Promise<{ policy: SealPolicy; id: string }> {
  const raw = await readFile(path);
  if (raw.length > 1024 * 1024) throw new Error("Seal policy too large.");
  const policy = policySchema.parse(JSON.parse(raw.toString("utf8")));
  const encoded = {
    implementation: "papersign-pades-blt-crl-v1",
    ...policy,
    trustedRoots: policy.trustedRoots.map((b) => b.toString("base64")).sort(),
    certificateChain: policy.certificateChain
      .map((b) => b.toString("base64"))
      .sort(),
    crlUrls: [...policy.crlUrls].sort(),
  };
  return {
    policy,
    id: createHash("sha256").update(JSON.stringify(encoded)).digest("hex"),
  };
}

export async function readSealCredentials(directory: string) {
  const [configuration, p12, password] = await Promise.all([
    readSealPolicy(join(directory, "seal-policy.json")),
    readFile(join(directory, "seal.p12")),
    readFile(join(directory, "seal-password")),
  ]);
  if (p12.length > 1024 * 1024 || password.length > 4096)
    throw new Error("Invalid sealing credentials.");
  return {
    ...configuration,
    p12,
    p12Password: password.toString("utf8").replace(/\r?\n$/, ""),
  };
}
