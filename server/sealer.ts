import { createServer } from "node:http";
import { createConnection } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readSealPolicy } from "./sealing/configuration.js";
import {
  MAX_SEAL_BYTES,
  SEAL_TIMEOUT_MS,
  sealReportSchema,
} from "./sealing/protocol.js";

// This process deliberately does not import web/database config or its .env file.
const directory = process.env.CREDENTIALS_DIRECTORY;
const socket = process.env.SEAL_SOCKET;
if (!directory || !socket?.startsWith("/"))
  throw new Error("Sealer credentials and absolute socket path are required.");
const { id: policyId } = await readSealPolicy(
  join(directory, "seal-policy.json"),
);
let busy = false;
let running: ReturnType<typeof spawn> | undefined;
const server = createServer(async (request, response) => {
  const reject = (status: number) => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end("Certificate sealing unavailable.");
  };
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ policyId }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/seal") {
    reject(404);
    return;
  }
  if (request.headers["x-seal-policy"] !== policyId) {
    reject(409);
    return;
  }
  if (busy) {
    reject(503);
    return;
  }
  if (
    request.headers["content-type"] !== "application/pdf" ||
    Number(request.headers["content-length"]) > MAX_SEAL_BYTES
  ) {
    reject(413);
    return;
  }
  busy = true;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_SEAL_BYTES) throw new Error();
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error();
    const result = await new Promise<{ bytes: Buffer; report: unknown }>(
      (resolve, rejectJob) => {
        const isTs = import.meta.url.endsWith(".ts");
        const child = spawn(
          process.execPath,
          [
            "--max-old-space-size=768",
            ...(isTs ? ["--import", "tsx"] : []),
            fileURLToPath(
              new URL(
                isTs ? "./sealing/process.ts" : "./sealing/process.js",
                import.meta.url,
              ),
            ),
          ],
          {
            stdio: ["pipe", "pipe", "ignore", "ipc"],
            env: {
              PATH: process.env.PATH,
              CREDENTIALS_DIRECTORY: directory,
              SEAL_POLICY_ID: policyId,
              NODE_ENV: "production",
              NODE_OPTIONS: "",
            },
          },
        );
        running = child;
        let report: unknown;
        let size = 0;
        const output: Buffer[] = [];
        const timer = setTimeout(() => child.kill("SIGKILL"), SEAL_TIMEOUT_MS);
        const cancelled = () => {
          if (!response.writableFinished) child.kill("SIGKILL");
        };
        response.once("close", cancelled);
        child.on("message", (message) => {
          report = message;
        });
        child.stdout!.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_SEAL_BYTES) child.kill("SIGKILL");
          else output.push(chunk);
        });
        child.on("error", () => {
          clearTimeout(timer);
          rejectJob(new Error());
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          response.removeListener("close", cancelled);
          running = undefined;
          if (code === 0 && size > 5)
            resolve({ bytes: Buffer.concat(output), report });
          else rejectJob(new Error());
        });
        child.stdin!.on("error", () => child.kill("SIGKILL"));
        child.stdin!.end(bytes);
      },
    );
    const report = sealReportSchema.parse(result.report);
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": result.bytes.length,
      "x-seal-policy": policyId,
      "x-seal-report": Buffer.from(JSON.stringify(report)).toString("base64"),
    });
    response.end(result.bytes);
  } catch {
    if (!response.headersSent) reject(502);
  } finally {
    busy = false;
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.maxConnections = 4;
try {
  const entry = await lstat(socket);
  if (!entry.isSocket())
    throw new Error("Refusing to replace a non-socket path.");
  const active = await new Promise<boolean>((resolve) => {
    const connection = createConnection(socket);
    connection.setTimeout(1000);
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", () => resolve(false));
    connection.once("timeout", () => {
      connection.destroy();
      resolve(true);
    });
  });
  if (active) throw new Error("A sealer already owns this socket.");
  await unlink(socket);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socket, () => resolve());
});
await chmod(socket, 0o660);
console.log("PaperSign certificate sealer ready.");
async function stop() {
  running?.kill("SIGKILL");
  server.close();
  server.closeAllConnections();
  await unlink(socket!).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
