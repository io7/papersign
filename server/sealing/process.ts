import { sealPdf } from "./seal.js";
import { readSealCredentials } from "./configuration.js";
import { MAX_SEAL_BYTES, sealReportSchema } from "./protocol.js";

try {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) throw new Error();
  const credentials = await readSealCredentials(directory);
  if (credentials.id !== process.env.SEAL_POLICY_ID) throw new Error();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_SEAL_BYTES) throw new Error();
    chunks.push(chunk);
  }
  const result = await sealPdf(Buffer.concat(chunks), credentials);
  if (result.bytes.length > MAX_SEAL_BYTES) throw new Error();
  const report = sealReportSchema.parse(result.report);
  if (!process.send) throw new Error();
  process.send(report, (error) => {
    if (error) process.exitCode = 1;
    else process.stdout.write(result.bytes);
    process.disconnect?.();
  });
} catch {
  // Provider, parser and credential errors must never reach logs or clients.
  process.stderr.write("Certificate sealing failed validation.\n");
  process.exitCode = 1;
  process.disconnect?.();
}
