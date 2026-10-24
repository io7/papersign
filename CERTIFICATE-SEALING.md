# Node certificate sealing

PaperSign can seal completed exports with an organization certificate, an RFC
3161 timestamp, and validated certificate chains/full CRLs in the PDF Document
Security Store (DSS). The output profile is PAdES B-LT. All runtime processing is
Node/TypeScript. Sealing is disabled until an operator supplies credentials and
provider configuration. Existing stored exports are never rewritten.

This protects the completed PDF, including visual signatures and text. It does
not give invited participants individual certificates or establish their identity.
Recipient viewer trust depends on the issuing CA and the viewer's trust policy;
embedding a root does not make it trusted. Local test certificates prove mechanics,
not public trust. Scheduled archival timestamp renewal (PAdES B-LTA) is not
implemented. One timestamp does not promise perpetual validation.

## Processing and supported profile

The worker freezes the document revision and completed fields, stamps them and
optionally rasterizes, then submits the final bytes to an isolated Node sealer.
The sealer validates the signing certificate, obtains and verifies the timestamp,
embeds only validated certificate/CRL evidence, and reopens the final PDF to verify
its signature and evidence. It stores immutable bytes, SHA256, policy identity
and verification metadata with an audit event. Failures never silently downgrade
an intended sealed export to an unsealed download. Previews are not sealed.

The restricted profile supports RSA keys >=2048 bits, supported NIST EC curves
and SHA-256/384/512 signatures. RSA-PSS, SHA-1-signed chains, unsupported critical
extensions and advanced path constraints are rejected. TSA certificates require
the critical exclusive timestamping EKU. Roots are explicitly operator-pinned.
CMS certificate-binding attributes must identify exactly one signing certificate.
Additional ESS certificate references and ESS policy constraints are rejected
because this narrow profile does not process those constraints. This also applies
to the TSA's token and must be checked with the chosen provider before activation.
Every non-root certificate in both signing and TSA chains needs authenticated,
current **full direct CRLs**. OCSP-only issuers, delta/indirect/scoped CRLs and
incomplete evidence are rejected. This is an acceptance gate for newly created
exports, not a general historical validator for arbitrary uploaded signed PDFs.
The embedded evidence allows later verification at the trusted signing time.

TSA requests require HTTPS. CRLs permit HTTP/HTTPS because their signatures are
verified. Transport uses exact configured URLs, public IP checks, pinned DNS,
no redirects, 15-second deadlines and bounded responses. Uploaded documents and
certificate AIA URLs cannot trigger arbitrary network fetching. Overall sealing
has a 120-second deadline and a 128 MiB input/output limit.

## Credentials and policy

Use a dedicated organization document-signing certificate and a suitable TSA.
No provider is preselected or contacted automatically. Custom TSA authentication
headers are not supported. Keep keys/passwords out of the web environment,
database, source, logs and document storage.

The `papersign-sealer` systemd service runs as a separate, non-login Unix user
`papersign-sealer`, with group `papersign` for release/socket access. Its
`LoadCredential` entries read these root-owned mode-0600 files from a mode-0700
directory:

- `/etc/papersign/sealing/policy.json`
- `/etc/papersign/sealing/seal.p12`
- `/etc/papersign/sealing/password`

The password is UTF-8 with one terminal newline removed, not a shell script. The
web/worker user and rendering subprocesses cannot read the credential mount. The
private protocol uses `/run/papersign-sealer/sealer.sock`, mode 0660. The sealer
never imports the web application's database/environment configuration.

Policy example (replace illustrative values; certificates are canonical base64
of DER, and the fingerprint is SHA256 of the organization's DER certificate):

```json
{
  "tsaUrl": "https://your-timestamp-provider.example/timestamp",
  "tsaPolicyOid": "1.2.3.4",
  "expectedSignerFingerprint": "64-lowercase-hex-characters",
  "trustedRoots": ["BASE64_DER_ROOT_CERTIFICATE"],
  "certificateChain": ["BASE64_DER_INTERMEDIATE_CERTIFICATE"],
  "crlUrls": ["https://your-ca.example/full.crl"],
  "name": "Your organization",
  "reason": "Organization seal of the completed document"
}
```

`tsaPolicyOid`, `certificateChain`, `name` and `reason` are optional. Supply every
needed CRL endpoint, including TSA-chain issuers. Limits: eight CRL URLs, eight
roots and sixteen intermediates. Calculate the public policy ID offline:

```sh
node dist-server/server/sealing/policy-id.js /etc/papersign/sealing/policy.json
```

Set both public values in the normal application environment:

```text
SEAL_SOCKET=/run/papersign-sealer/sealer.sock
SEAL_POLICY_ID=<the printed SHA256>
```

The ID covers certificate, roots, endpoints, timestamp policy, description and
implementation-policy version. After a change, recalculate it and restart the
sealer, web and worker together. Queued jobs with a mismatched ID fail rather than
use another policy. Existing ready files remain unchanged. Validation-semantic
changes require incrementing the version in `server/sealing/configuration.ts`.

## Activation and verification

Before production activation, test the actual certificate/TSA/CRL combination
against this profile and inspect its output in the intended recipient viewer,
including offline validation with the viewer's trust configuration. The local
OpenSSL tests independently prove CMS/timestamp cryptography; they are not an
external PAdES conformity certification.

An approved deployment must create the dedicated service user, install the unit,
supply protected credentials, enable/start the sealer, and restart web/worker
with the matching ID. The release installer restarts an already enabled sealer;
it does not obtain credentials or enable sealing. Take the usual database/storage
backup. Additive migration `0004_certificate_seals` leaves old exports unsealed.

`tests/sealing.test.ts` runs the actual pipeline against generated local PKI/TSA
fixtures and independent OpenSSL checks. Service and transport tests cover process
boundaries, safe failures and network restrictions. The isolated export suite
checks the actual API/worker path. No customer documents or real provider calls
are used by tests. See the QA artifacts for executed checks and their limits.
