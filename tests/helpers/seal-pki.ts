import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";

const execute = promisify(execFile);
export const fixturePassword = "PaperSign-isolated-test-only";
export const fixturePolicyOid = "1.3.6.1.4.1.55555.1";

export interface FixtureCertificate {
  der: Buffer;
  pem: Buffer;
  pemPath: string;
  keyPath: string;
}

export interface FixtureCrl {
  der: Buffer;
  pemPath: string;
}

export interface SealPkiFixture {
  directory: string;
  root: FixtureCertificate;
  intermediate: FixtureCertificate;
  signer: FixtureCertificate;
  expiredSigner: FixtureCertificate;
  tsa: FixtureCertificate;
  wrongPurposeTsa: FixtureCertificate;
  unrelatedRoot: FixtureCertificate;
  p12: Buffer;
  expiredP12: Buffer;
  rootCrl: FixtureCrl;
  intermediateCrl: FixtureCrl;
  revokedSignerCrl: FixtureCrl;
  revokedIntermediateCrl: FixtureCrl;
  staleIntermediateCrl: FixtureCrl;
  openssl: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  timestampReply: (
    query: Uint8Array,
    options?: { wrongPurpose?: boolean; multipleEssReferences?: boolean },
  ) => Promise<Buffer>;
  cleanup: () => Promise<void>;
}

function caConfiguration(directory: string, authority: string) {
  return `[ca]
default_ca = issuing_ca
[issuing_ca]
dir = ${directory}/${authority}-ca
database = $dir/index.txt
new_certs_dir = $dir/newcerts
serial = $dir/serial
crlnumber = $dir/crlnumber
certificate = ${directory}/${authority}.pem
private_key = ${directory}/${authority}.key.pem
default_md = sha256
default_days = 30
default_crl_days = 7
unique_subject = no
policy = names
crl_extensions = crl_extensions
[names]
commonName = supplied
organizationName = optional
[intermediate]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[document]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,nonRepudiation
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[timestamp]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[crl_extensions]
authorityKeyIdentifier = keyid:always
`;
}

export async function createSealPkiFixture(): Promise<SealPkiFixture> {
  const directory = await mkdtemp(join(tmpdir(), "papersign-seal-pki-"));
  const openssl = (args: string[]) =>
    execute("openssl", args, {
      cwd: directory,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
  const file = (name: string) => join(directory, name);
  const write = (name: string, contents: string | Uint8Array) =>
    writeFile(file(name), contents, { mode: 0o600 });
  try {
    for (const authority of ["root", "intermediate"]) {
      await mkdir(file(`${authority}-ca/newcerts`), { recursive: true });
      await write(`${authority}-ca/index.txt`, "");
      await write(`${authority}-ca/serial`, "1000\n");
      await write(`${authority}-ca/crlnumber`, "1000\n");
      await write(`${authority}-ca.cnf`, caConfiguration(directory, authority));
    }
    for (const name of ["root", "unrelated-root"]) {
      await openssl([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "3650",
        "-keyout",
        file(`${name}.key.pem`),
        "-out",
        file(`${name}.pem`),
        "-subj",
        `/CN=PaperSign fixture ${name}/O=PaperSign Local Tests`,
        "-addext",
        "basicConstraints=critical,CA:TRUE,pathlen:1",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        "-addext",
        "subjectKeyIdentifier=hash",
      ]);
    }
    async function issue(
      name: string,
      issuer: string,
      extension: string,
      expired = false,
    ) {
      await openssl([
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-keyout",
        file(`${name}.key.pem`),
        "-out",
        file(`${name}.csr.pem`),
        "-subj",
        `/CN=PaperSign fixture ${name}/O=PaperSign Local Tests`,
      ]);
      await openssl([
        "ca",
        "-batch",
        "-notext",
        "-config",
        file(`${issuer}-ca.cnf`),
        "-extensions",
        extension,
        "-in",
        file(`${name}.csr.pem`),
        "-out",
        file(`${name}.pem`),
        ...(expired
          ? ["-startdate", "20200101000000Z", "-enddate", "20210101000000Z"]
          : ["-days", "365"]),
      ]);
    }
    await issue("intermediate", "root", "intermediate");
    await issue("signer", "intermediate", "document");
    await issue("expired-signer", "intermediate", "document", true);
    await issue("tsa", "intermediate", "timestamp");
    await issue("wrong-purpose-tsa", "intermediate", "document");

    const chain = Buffer.concat([
      await readFile(file("intermediate.pem")),
      await readFile(file("root.pem")),
    ]);
    await write("chain.pem", chain);
    for (const name of ["signer", "expired-signer"]) {
      await openssl([
        "pkcs12",
        "-export",
        "-inkey",
        file(`${name}.key.pem`),
        "-in",
        file(`${name}.pem`),
        "-certfile",
        file("chain.pem"),
        "-out",
        file(`${name}.p12`),
        "-passout",
        `pass:${fixturePassword}`,
      ]);
    }
    async function certificate(name: string): Promise<FixtureCertificate> {
      await openssl([
        "x509",
        "-in",
        file(`${name}.pem`),
        "-outform",
        "DER",
        "-out",
        file(`${name}.der`),
      ]);
      return {
        der: await readFile(file(`${name}.der`)),
        pem: await readFile(file(`${name}.pem`)),
        pemPath: file(`${name}.pem`),
        keyPath: file(`${name}.key.pem`),
      };
    }
    async function crl(
      issuer: string,
      name: string,
      stale = false,
    ): Promise<FixtureCrl> {
      await openssl([
        "ca",
        "-gencrl",
        "-config",
        file(`${issuer}-ca.cnf`),
        "-out",
        file(`${name}.crl.pem`),
        ...(stale
          ? [
              "-crl_lastupdate",
              "20200101000000Z",
              "-crl_nextupdate",
              "20200108000000Z",
            ]
          : []),
      ]);
      await openssl([
        "crl",
        "-in",
        file(`${name}.crl.pem`),
        "-outform",
        "DER",
        "-out",
        file(`${name}.crl.der`),
      ]);
      return {
        der: await readFile(file(`${name}.crl.der`)),
        pemPath: file(`${name}.crl.pem`),
      };
    }
    const rootCrl = await crl("root", "root");
    const intermediateCrl = await crl("intermediate", "intermediate");
    const staleIntermediateCrl = await crl("intermediate", "stale", true);
    await openssl([
      "ca",
      "-config",
      file("intermediate-ca.cnf"),
      "-revoke",
      file("signer.pem"),
      "-crl_reason",
      "keyCompromise",
    ]);
    const revokedSignerCrl = await crl("intermediate", "revoked-signer");
    await openssl([
      "ca",
      "-config",
      file("root-ca.cnf"),
      "-revoke",
      file("intermediate.pem"),
      "-crl_reason",
      "keyCompromise",
    ]);
    const revokedIntermediateCrl = await crl("root", "revoked-intermediate");

    for (const name of ["tsa", "wrong-purpose-tsa"]) {
      await write(`${name}.serial`, "2000\n");
      await write(
        `${name}.cnf`,
        `[tsa]
default_tsa = timestamp_authority
[timestamp_authority]
serial = ${file(`${name}.serial`)}
crypto_device = builtin
signer_cert = ${file(`${name}.pem`)}
signer_key = ${file(`${name}.key.pem`)}
signer_digest = sha256
certs = ${file("chain.pem")}
default_policy = ${fixturePolicyOid}
digests = sha256,sha384,sha512
accuracy = secs:1
clock_precision_digits = 0
ordering = yes
tsa_name = yes
ess_cert_id_chain = no
ess_cert_id_alg = sha256
`,
      );
    }
    let responseSequence = 0;
    return {
      directory,
      root: await certificate("root"),
      intermediate: await certificate("intermediate"),
      signer: await certificate("signer"),
      expiredSigner: await certificate("expired-signer"),
      tsa: await certificate("tsa"),
      wrongPurposeTsa: await certificate("wrong-purpose-tsa"),
      unrelatedRoot: await certificate("unrelated-root"),
      p12: await readFile(file("signer.p12")),
      expiredP12: await readFile(file("expired-signer.p12")),
      rootCrl,
      intermediateCrl,
      revokedSignerCrl,
      revokedIntermediateCrl,
      staleIntermediateCrl,
      openssl,
      async timestampReply(query, options) {
        const stem = `timestamp-${responseSequence++}`;
        await write(`${stem}.tsq`, query);
        let configPath = file(
          `${options?.wrongPurpose ? "wrong-purpose-tsa" : "tsa"}.cnf`,
        );
        if (options?.multipleEssReferences) {
          const config = await readFile(configPath, "utf8");
          configPath = file(`${stem}.cnf`);
          await writeFile(
            configPath,
            config.replace("ess_cert_id_chain = no", "ess_cert_id_chain = yes"),
          );
        }
        await openssl([
          "ts",
          "-reply",
          "-queryfile",
          file(`${stem}.tsq`),
          "-config",
          configPath,
          "-out",
          file(`${stem}.tsr`),
        ]);
        return readFile(file(`${stem}.tsr`));
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Extract exact signed bytes without loading/resaving the PDF. */
export function extractPdfCms(bytes: Uint8Array) {
  const pdf = Buffer.from(bytes);
  const text = pdf.toString("latin1");
  const matches = [
    ...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g),
  ];
  if (matches.length !== 1)
    throw new Error("Expected one final organization seal");
  const [firstStart, firstLength, secondStart, secondLength] = matches[0]
    .slice(1)
    .map(Number);
  const signedRevisionLength = secondStart + secondLength;
  if (
    firstStart !== 0 ||
    secondStart <= firstLength ||
    signedRevisionLength > pdf.length ||
    !/%%EOF\s*$/.test(pdf.subarray(0, signedRevisionLength).toString("latin1"))
  )
    throw new Error("Seal does not cover a complete PDF revision");
  const excluded = text.slice(firstLength, secondStart);
  if (!/^<[0-9a-fA-F]+>$/.test(excluded))
    throw new Error("Unexpected PDF signature contents");
  const padded = Buffer.from(excluded.slice(1, -1), "hex");
  if (padded[0] !== 0x30) throw new Error("Expected DER CMS sequence");
  let header = 2;
  let size = padded[1];
  if (size & 0x80) {
    const count = size & 0x7f;
    if (count < 1 || count > 4) throw new Error("Unexpected CMS DER length");
    header += count;
    size = padded.readUIntBE(2, count);
  }
  if (header + size > padded.length) throw new Error("Truncated CMS signature");
  return {
    cms: padded.subarray(0, header + size),
    signedRevision: pdf.subarray(0, signedRevisionLength),
    signedBytes: Buffer.concat([
      pdf.subarray(firstStart, firstStart + firstLength),
      pdf.subarray(secondStart, secondStart + secondLength),
    ]),
  };
}

/** Independent pdf-lib parsing: only DSS may change after the sealed revision. */
export async function verifyDssOnlyIncrement(bytes: Uint8Array) {
  const { signedRevision } = extractPdfCms(bytes);
  const before = await PDFDocument.load(signedRevision, {
    updateMetadata: false,
  });
  const after = await PDFDocument.load(bytes, { updateMetadata: false });
  const root = before.context.trailerInfo.Root;
  if (!root || after.context.trailerInfo.Root?.toString() !== root.toString())
    throw new Error("Incremental update replaced the document root");
  const dss = after.catalog.lookup(PDFName.of("DSS"), PDFDict);
  if (!dss) throw new Error("Missing final validation evidence");
  for (const [ref, original] of before.context.enumerateIndirectObjects()) {
    const updated = after.context.lookup(ref);
    if (!updated) throw new Error(`Incremental update removed ${ref}`);
    if (ref.toString() === root.toString()) {
      if (!(original instanceof PDFDict) || !(updated instanceof PDFDict))
        throw new Error("Invalid document catalog");
      const originalCatalog = original.clone();
      const updatedCatalog = updated.clone();
      originalCatalog.delete(PDFName.of("DSS"));
      updatedCatalog.delete(PDFName.of("DSS"));
      if (originalCatalog.toString() !== updatedCatalog.toString())
        throw new Error("Incremental update changed non-DSS catalog contents");
    } else if (original.toString() !== updated.toString()) {
      throw new Error(`Incremental update changed signed object ${ref}`);
    }
  }
  return {
    signedRevisionBytes: signedRevision.length,
    finalBytes: bytes.length,
  };
}
