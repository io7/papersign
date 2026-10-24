import { request } from "node:http";
import { config } from "./config.js";
import {
  MAX_SEAL_BYTES,
  SEAL_TIMEOUT_MS,
  sealReportSchema,
  SealServiceError,
} from "./sealing/protocol.js";
import type { CertificateSeal } from "../shared/types.js";

export async function requestCertificateSeal(
  bytes: Buffer,
  policyId: string,
): Promise<{ bytes: Buffer; report: CertificateSeal }> {
  if (
    !config.SEAL_SOCKET ||
    config.SEAL_POLICY_ID !== policyId ||
    bytes.length > MAX_SEAL_BYTES
  )
    throw new SealServiceError();
  return new Promise((resolve, reject) => {
    const fail = () => reject(new SealServiceError());
    const req = request(
      {
        socketPath: config.SEAL_SOCKET,
        path: "/seal",
        method: "POST",
        headers: {
          "content-type": "application/pdf",
          "content-length": bytes.length,
          "x-seal-policy": policyId,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        if (response.statusCode !== 200) {
          response.resume();
          fail();
          return;
        }
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_SEAL_BYTES) {
            response.destroy();
            fail();
          } else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          try {
            const header = response.headers["x-seal-report"];
            if (
              typeof header !== "string" ||
              header.length > 8192 ||
              length < 5 ||
              response.headers["x-seal-policy"] !== policyId
            )
              throw new Error();
            const report = sealReportSchema.parse(
              JSON.parse(Buffer.from(header, "base64").toString("utf8")),
            );
            const output = Buffer.concat(chunks);
            if (!output.subarray(0, 5).equals(Buffer.from("%PDF-")))
              throw new Error();
            resolve({ bytes: output, report });
          } catch {
            fail();
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail();
    }, SEAL_TIMEOUT_MS + 10_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", fail);
    req.end(bytes);
  });
}
