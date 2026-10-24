import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { readSealPolicy } from "../server/sealing/configuration.js";

let directory: string;
let socket: string;
let child: ChildProcess;
let policyId: string;
let logs = "";
const fixturePolicy = {
  tsaUrl: "https://tsa.example.invalid/timestamp",
  tsaPolicyOid: "1.2.3.4",
  expectedSignerFingerprint: "a".repeat(64),
  trustedRoots: [Buffer.alloc(64, 1).toString("base64")],
  crlUrls: ["https://crl.example.invalid/root.crl"],
};
function call(method: string, path: string, policy = policyId, body?: Buffer) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        headers: {
          "x-seal-policy": policy,
          "content-type": "application/pdf",
          ...(body ? { "content-length": body.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () =>
      req.destroy(new Error("Fixture service timed out")),
    );
    req.end(body);
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "papersign-seal-service-"));
  socket = join(directory, "sealer.sock");
  await writeFile(
    join(directory, "seal-policy.json"),
    JSON.stringify(fixturePolicy),
    { mode: 0o600 },
  );
  await writeFile(join(directory, "seal.p12"), "invalid-private-key-fixture", {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "seal-password"),
    "secret-fixture-do-not-disclose",
    { mode: 0o600 },
  );
  policyId = (await readSealPolicy(join(directory, "seal-policy.json"))).id;
  child = spawn(process.execPath, ["--import", "tsx", "server/sealer.ts"], {
    env: {
      PATH: process.env.PATH,
      CREDENTIALS_DIRECTORY: directory,
      SEAL_SOCKET: socket,
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    logs += chunk;
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call("GET", "/health")).status === 200) return;
    } catch {
      /* starting */
    }
    if (child.exitCode !== null)
      throw new Error("Isolated sealer failed startup.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Isolated sealer did not start.");
});
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe("isolated certificate-sealing service", () => {
  it("exposes a public policy identity without key material", async () => {
    const response = await call("GET", "/health");
    expect(JSON.parse(response.body)).toEqual({ policyId });
  });
  it("rejects stale policy requests before processing a PDF", async () => {
    expect(
      (await call("POST", "/seal", "b".repeat(64), Buffer.from("%PDF-1.7\n")))
        .status,
    ).toBe(409);
  });
  it("fails malformed PDFs and invalid credentials without disclosing secrets", async () => {
    const malformed = await call(
      "POST",
      "/seal",
      policyId,
      Buffer.from("bad PDF"),
    );
    expect(malformed.status).toBe(502);
    const invalidKey = await call(
      "POST",
      "/seal",
      policyId,
      Buffer.from("%PDF-1.7\n"),
    );
    expect(invalidKey.status).toBe(502);
    expect(invalidKey.body).toBe("Certificate sealing unavailable.");
    expect(logs).not.toContain("secret-fixture");
    expect(logs).not.toContain("invalid-private-key");
    expect((await call("GET", "/health")).status).toBe(200);
  });
  it("changes policy identity when certificate, trust, provider or validation policy changes", async () => {
    for (const changes of [
      { expectedSignerFingerprint: "b".repeat(64) },
      { trustedRoots: [Buffer.alloc(64, 2).toString("base64")] },
      { tsaUrl: "https://tsa.example.invalid/changed" },
      { crlUrls: ["https://crl.example.invalid/changed"] },
      { tsaPolicyOid: "1.2.3.5" },
    ]) {
      const file = join(directory, "changed.json");
      await writeFile(file, JSON.stringify({ ...fixturePolicy, ...changes }));
      expect((await readSealPolicy(file)).id).not.toBe(policyId);
    }
  });
  it("rejects secrets and unknown options in the public policy", async () => {
    const file = join(directory, "invalid.json");
    await writeFile(
      file,
      JSON.stringify({ ...fixturePolicy, p12Password: "never-public" }),
    );
    await expect(readSealPolicy(file)).rejects.toThrow();
  });
});
