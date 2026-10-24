import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PDFDocument } from "pdf-lib";
import { config } from "../server/config.js";
import { readSealPolicy } from "../server/sealing/configuration.js";
import { sealPdf } from "../server/sealing/seal.js";
import type { SealOptions, SealPolicy } from "../server/sealing/types.js";
import {
  createSealPkiFixture,
  extractPdfCms,
  verifyDssOnlyIncrement,
  fixturePassword,
  fixturePolicyOid,
  type SealPkiFixture,
} from "./helpers/seal-pki.js";

// The API and real worker use a new disposable database and storage directory.
// They cannot claim exports from the ordinary local development worker.
const integration = process.env.SEAL_EXPORT_INTEGRATION === "1";
const base = "http://127.0.0.1:3196";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!integration)(
  "Configured certificate exports through the real API and worker",
  () => {
    let pki: SealPkiFixture;
    let client: Client;
    let cluster: Client;
    let databaseName = "";
    let databaseUrl = "";
    let socketServer: Server;
    let web: ChildProcess | undefined;
    let worker: ChildProcess | undefined;
    let cookie = "";
    let fixtureUserId = "";
    let doc: { id: string; revision: number };
    let policy: SealPolicy;
    let policyId = "";
    let unsealedId = "";
    let unsealedBytes: Buffer;
    let sealedId = "";
    let sealedBytes: Buffer;
    let sealCalls = 0;
    let providerFailed = false;
    let mismatchedResponse = false;
    const processLogs: string[] = [];
    const evidence: Record<string, unknown> = {};

    async function request(path: string, method = "GET", body?: unknown) {
      const multipart = body instanceof FormData;
      return fetch(base + "/api" + path, {
        method,
        headers: {
          Origin: base,
          "X-PaperSign": "1",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body && !multipart ? { "Content-Type": "application/json" } : {}),
        },
        body: multipart
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
      });
    }

    function launch(script: string, enabled: boolean) {
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
          APP_URL: base,
          PORT: "3196",
          HOST: "127.0.0.1",
          DATA_DIR: join(pki.directory, "data"),
          SMTP_HOST: "",
          SMTP_FROM: "",
          SMTP_USER: "",
          SMTP_PASSWORD: "",
          REGISTRATION_ENABLED: "true",
          EVIDENCE_TIMESTAMP_POLICY: undefined,
          SEAL_SOCKET: undefined,
          SEAL_POLICY_ID: undefined,
          ...(enabled
            ? {
                SEAL_SOCKET: join(pki.directory, "seal.sock"),
                SEAL_POLICY_ID: policyId,
              }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk) =>
        processLogs.push(`${script}: ${chunk}`),
      );
      child.stderr?.on("data", (chunk) =>
        processLogs.push(`${script}: ${chunk}`),
      );
      return child;
    }

    async function stop(child?: ChildProcess) {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      child.kill("SIGTERM");
      for (
        let attempt = 0;
        attempt < 80 && child.exitCode === null && child.signalCode === null;
        attempt++
      )
        await pause(100);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        throw new Error("Isolated test process did not stop gracefully");
      }
    }

    async function start(enabled: boolean) {
      await stop(worker);
      worker = undefined;
      await stop(web);
      web = undefined;
      web = launch("server/index.ts", enabled);
      worker = launch("server/worker.ts", enabled);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (web.exitCode !== null || worker.exitCode !== null)
          throw new Error(
            `Isolated test process exited during startup: ${processLogs.slice(-4).join("\n")}`,
          );
        try {
          if ((await fetch(base + "/api/health")).ok) return;
        } catch {
          /* waiting for the private fixture listener */
        }
        await pause(100);
      }
      throw new Error("Isolated API failed to start");
    }

    async function prepare(rasterize = false) {
      const response = await request(`/documents/${doc.id}/exports`, "POST", {
        rasterize,
        revision: doc.revision,
      });
      expect(response.status, await response.clone().text()).toBe(202);
      return response.json() as Promise<{ id: string }>;
    }

    async function finished(
      id: string,
      expected: "ready" | "failed" = "ready",
    ) {
      for (let attempt = 0; attempt < 250; attempt++) {
        const response = await request(`/exports/${id}`);
        expect(response.status).toBe(200);
        const result = await response.json();
        if (["ready", "failed"].includes(result.state)) {
          expect(result.state, JSON.stringify(result)).toBe(expected);
          return result;
        }
        await pause(100);
      }
      throw new Error("Isolated certificate export did not finish");
    }

    async function download(id: string) {
      const response = await request(`/exports/${id}/download`);
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    }

    async function verifyDownloaded(bytes: Buffer, id: string) {
      await verifyDssOnlyIncrement(bytes);
      const parsed = extractPdfCms(bytes);
      const cms = join(pki.directory, `${id}.der`);
      const content = join(pki.directory, `${id}.bin`);
      await writeFile(cms, parsed.cms);
      await writeFile(content, parsed.signedBytes);
      const verified = await pki.openssl([
        "cms",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-in",
        cms,
        "-content",
        content,
        "-CAfile",
        pki.root.pemPath,
        "-purpose",
        "any",
        "-out",
        join(pki.directory, `${id}.verified`),
      ]);
      expect(verified.stderr).toContain("CMS Verification successful");
      const rows = await client.query(
        "select state, file_key, sha256, seal_policy_id, seal from document_export where id = $1",
        [id],
      );
      expect(rows.rows[0].state).toBe("ready");
      expect(rows.rows[0].sha256).toBe(hash(bytes));
      expect(rows.rows[0].seal_policy_id).toBe(policyId);
      expect(rows.rows[0].seal.signerFingerprint).toBe(hash(pki.signer.der));
      const audit = await client.query(
        "select details from audit_event where document_id = $1 and event = 'certificate_sealed' and details->>'exportId' = $2",
        [doc.id, id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details.sha256).toBe(hash(bytes));
      expect(audit.rows[0].details.policyId).toBe(policyId);
      return {
        sha256: hash(bytes),
        profile: rows.rows[0].seal.profile,
        auditCount: audit.rows.length,
      };
    }

    async function savePolicy(reason: string) {
      const path = join(pki.directory, "policy.json");
      await writeFile(
        path,
        JSON.stringify({
          expectedSignerFingerprint: hash(pki.signer.der),
          tsaUrl: "https://tsa.test.invalid/timestamp",
          tsaPolicyOid: fixturePolicyOid,
          trustedRoots: [pki.root.der.toString("base64")],
          certificateChain: [pki.intermediate.der.toString("base64")],
          crlUrls: [
            "https://crl.test.invalid/root",
            "https://crl.test.invalid/intermediate",
          ],
          name: "PaperSign API fixture",
          reason,
        }),
      );
      ({ policy, id: policyId } = await readSealPolicy(path));
    }

    const localTransport = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === "https://crl.test.invalid/root")
        return new Response(Uint8Array.from(pki.rootCrl.der));
      if (url === "https://crl.test.invalid/intermediate")
        return new Response(Uint8Array.from(pki.intermediateCrl.der));
      if (url === "https://tsa.test.invalid/timestamp") {
        if (providerFailed)
          throw new Error("Synthetic timestamp provider is unavailable");
        const body = init?.body;
        if (!(body instanceof Uint8Array) && !(body instanceof ArrayBuffer))
          throw new Error("Binary TSA request expected");
        return new Response(
          Uint8Array.from(
            await pki.timestampReply(
              body instanceof ArrayBuffer ? new Uint8Array(body) : body,
            ),
          ),
          {
            headers: { "content-type": "application/timestamp-reply" },
          },
        );
      }
      throw new Error("External network is forbidden in certificate fixtures");
    }) as typeof fetch;

    beforeAll(async () => {
      const database = new URL(config.DATABASE_URL);
      if (database.hostname !== "127.0.0.1" || database.port !== "54376")
        throw new Error(
          "Certificate export tests require isolated PostgreSQL on 127.0.0.1:54376",
        );
      if (
        process.env.SEAL_SOCKET ||
        process.env.SEAL_POLICY_ID ||
        process.env.EVIDENCE_TIMESTAMP_POLICY
      )
        throw new Error(
          "Run the isolated suite without an inherited sealing configuration",
        );
      cluster = new Client({ connectionString: config.DATABASE_URL });
      await cluster.connect();
      const name = `papersign_seal_${randomUUID().replaceAll("-", "")}`;
      await cluster.query(`create database "${name}"`);
      databaseName = name;
      database.pathname = `/${databaseName}`;
      databaseUrl = database.toString();
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await migrate(drizzle(client), { migrationsFolder: "drizzle" });
      evidence.databaseIsolation = "unique disposable database";
      pki = await createSealPkiFixture();
      await savePolicy("Initial test policy");
      socketServer = createServer(async (req, res) => {
        try {
          if (
            req.url !== "/seal" ||
            req.method !== "POST" ||
            req.headers["x-seal-policy"] !== policyId
          ) {
            res.writeHead(409).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const credentials: SealOptions = {
            p12: pki.p12,
            p12Password: fixturePassword,
            policy,
          };
          const sealed = await sealPdf(Buffer.concat(chunks), credentials, {
            fetch: localTransport,
          });
          sealCalls++;
          res
            .writeHead(200, {
              "Content-Type": "application/pdf",
              "x-seal-policy": mismatchedResponse ? "ff".repeat(32) : policyId,
              "x-seal-report": Buffer.from(
                JSON.stringify(sealed.report),
              ).toString("base64"),
            })
            .end(sealed.bytes);
        } catch {
          res.writeHead(422).end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        socketServer.once("error", reject);
        socketServer.listen(join(pki.directory, "seal.sock"), resolve);
      });
      await start(false);
      const cfg = await (await request("/config")).json();
      expect(cfg.emailEnabled).toBe(false);
      const email = `seal-${randomUUID()}@example.invalid`;
      const password = `Fixture-${randomUUID()}!`;
      const registration = await request("/auth/sign-up/email", "POST", {
        name: "Certificate export fixture",
        email,
        password,
      });
      expect(registration.status, await registration.clone().text()).toBe(200);
      fixtureUserId = (await registration.json()).user.id;
      const verified = await client.query(
        'update "user" set email_verified = true where id = $1 and email = $2 returning id',
        [fixtureUserId, email],
      );
      expect(verified.rowCount).toBe(1);
      const login = await request("/auth/sign-in/email", "POST", {
        email,
        password,
      });
      expect(login.status, await login.clone().text()).toBe(200);
      cookie = login.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; ");
      const pdf = await PDFDocument.create();
      pdf
        .addPage([300, 400])
        .drawText("Isolated certificate export agreement", {
          x: 20,
          y: 350,
          size: 12,
        });
      const body = new FormData();
      body.append(
        "file",
        new Blob([await pdf.save()], { type: "application/pdf" }),
        "certificate-fixture.pdf",
      );
      const uploaded = await request("/documents", "POST", body);
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      doc = await uploaded.json();
    }, 30000);

    afterAll(async () => {
      await stop(worker);
      worker = undefined;
      await stop(web);
      web = undefined;
      if (socketServer)
        await new Promise<void>((resolve) =>
          socketServer.close(() => resolve()),
        );
      if (client) {
        if (fixtureUserId) {
          await client.query("begin");
          try {
            if (doc?.id) {
              const owned = await client.query(
                "select user_id from document where id = $1",
                [doc.id],
              );
              expect(owned.rows[0]?.user_id).toBe(fixtureUserId);
              await client.query(
                "delete from audit_event where document_id = $1",
                [doc.id],
              );
              await client.query(
                "delete from document_export where document_id = $1",
                [doc.id],
              );
              await client.query(
                "delete from document where id = $1 and user_id = $2",
                [doc.id, fixtureUserId],
              );
            }
            await client.query('delete from "session" where user_id = $1', [
              fixtureUserId,
            ]);
            await client.query("delete from account where user_id = $1", [
              fixtureUserId,
            ]);
            await client.query('delete from "user" where id = $1', [
              fixtureUserId,
            ]);
            await client.query("commit");
            evidence.fixtureMetadataRemoved = true;
            const remaining = await client.query(
              'select (select count(*)::int from document_export where document_id = $1) as "exportsRemaining", (select count(*)::int from "user" where id = $2) as "usersRemaining"',
              [
                doc?.id ?? "00000000-0000-0000-0000-000000000000",
                fixtureUserId,
              ],
            );
            expect(remaining.rows[0]).toEqual({
              exportsRemaining: 0,
              usersRemaining: 0,
            });
            evidence.cleanup = { documentId: doc?.id, ...remaining.rows[0] };
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        }
        await client.end();
      }
      if (cluster) {
        if (databaseName) {
          if (!/^papersign_seal_[a-f0-9]{32}$/.test(databaseName))
            throw new Error("Refusing to remove an unexpected database name");
          await cluster.query(`drop database "${databaseName}"`);
          const remaining = await cluster.query(
            "select 1 from pg_database where datname = $1",
            [databaseName],
          );
          expect(remaining.rowCount).toBe(0);
          evidence.disposableDatabaseRemoved = true;
        }
        await cluster.end();
      }
      await mkdir(".local/qa/node-sealing", { recursive: true });
      await writeFile(
        ".local/qa/node-sealing/export-integration-evidence.json",
        JSON.stringify(evidence, null, 2),
      );
      await writeFile(
        ".local/qa/node-sealing/export-integration-processes.log",
        processLogs
          .join("\n")
          .replaceAll(pki?.directory ?? "<missing>", "<isolated-fixture>"),
      );
      await pki?.cleanup();
    });

    it("preserves an unsealed export and creates a different sealed cache entry when enabled", async () => {
      unsealedId = (await prepare()).id;
      const plain = await finished(unsealedId);
      expect(plain.seal).toBeNull();
      unsealedBytes = await download(unsealedId);
      await start(true);
      sealedId = (await prepare()).id;
      expect(sealedId).not.toBe(unsealedId);
      const sealed = await finished(sealedId);
      expect(sealed.seal.signerFingerprint).toBe(hash(pki.signer.der));
      sealedBytes = await download(sealedId);
      evidence.normal = await verifyDownloaded(sealedBytes, sealedId);
      expect(await download(unsealedId)).toEqual(unsealedBytes);
      evidence.originalUnsealedSha256 = hash(unsealedBytes);
    });

    it("coalesces concurrent requests without signing the same export again", async () => {
      const calls = sealCalls;
      const records = await Promise.all([prepare(), prepare(), prepare()]);
      expect(records.map((record) => record.id)).toEqual([
        sealedId,
        sealedId,
        sealedId,
      ]);
      expect(sealCalls).toBe(calls);
      expect(await download(sealedId)).toEqual(sealedBytes);
      evidence.cacheCoalesced = true;
    });

    it("seals the rasterized output and records final bytes plus one audit event", async () => {
      const record = await prepare(true);
      await finished(record.id);
      evidence.rasterized = await verifyDownloaded(
        await download(record.id),
        record.id,
      );
    });

    it("separates a changed policy cache and retains prior sealed bytes", async () => {
      const oldPolicy = policyId;
      await stop(worker);
      worker = undefined;
      await stop(web);
      web = undefined;
      await savePolicy("Rotated test policy");
      expect(policyId).not.toBe(oldPolicy);
      await start(true);
      const record = await prepare();
      expect(record.id).not.toBe(sealedId);
      await finished(record.id);
      evidence.rotated = await verifyDownloaded(
        await download(record.id),
        record.id,
      );
      expect(await download(sealedId)).toEqual(sealedBytes);
      expect(await download(unsealedId)).toEqual(unsealedBytes);
      evidence.previousArtifactsUnchanged = true;
    });

    it.each(["provider-failure", "policy-response-mismatch"] as const)(
      "does not publish an artifact after %s",
      async (variant) => {
        const saved = await request(`/documents/${doc.id}/placements`, "PUT", {
          revision: doc.revision,
          placements: [],
        });
        expect(saved.status).toBe(200);
        doc = await saved.json();
        providerFailed = variant === "provider-failure";
        mismatchedResponse = variant === "policy-response-mismatch";
        const record = await prepare();
        const result = await finished(record.id, "failed");
        expect(result.seal).toBeNull();
        expect(result.error).not.toContain("Synthetic");
        expect((await request(`/exports/${record.id}/download`)).status).toBe(
          409,
        );
        const rows = await client.query(
          "select file_key, sha256, seal from document_export where id = $1",
          [record.id],
        );
        expect(rows.rows[0]).toEqual({
          file_key: null,
          sha256: null,
          seal: null,
        });
        evidence[variant] = { state: result.state, artifactPublished: false };
        providerFailed = false;
        mismatchedResponse = false;
      },
    );
  },
);
