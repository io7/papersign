# Signing evidence and recovery

PaperSign preserves a separate, immutable PDF for each review, then records the
signer's completed fields, signature image(s), exact consent wording/version and
authentication assertion. Guest authentication records when the email code was
verified. Account authentication records when the already-verified email status
was checked; it does not invent an earlier mailbox-verification time.

The final ordinary PDF is created automatically and has one canonical export ID.
Rasterized or later certificate-policy exports do not replace it. Every export
gets a finalization audit event, including unsealed exports. Canonical rendering
checks the frozen input hashes before use and the completed evidence chain/files before
publishing the output. Stored downloads are checked against their hashes.

The portable TAR contains `original.pdf`, the exact reviewed PDFs, the signature
images, `final.pdf`, `manifest.json`, `receipt.json`, `report.txt` and `verify.mjs`.
Cancellation and completion with revoked recipients remain distinguishable from
everybody signing. The archive is streamed with standard POSIX ustar records;
there is no archive dependency, compression service or Python runtime.

## Independent receipts

Extract the archive and run Node.js 24 or newer:

```sh
node verify.mjs . --receipt <separately-retained-manifest-fingerprint>
```

The fingerprint is SHA-256 of the canonical JSON manifest, without its trailing
newline. Canonical JSON sorts object keys, preserves array order and permits only
ordinary JSON values. The manifest binds all included document/signature bytes,
ordered evidence events, consent and the finalization event. It intentionally
excludes an optional later timestamp, so timestamping never changes this receipt.

An acceptance fingerprint saved immediately after signing can instead be checked
with `--acceptance <fingerprint>`. That anchors the person's review and acceptance;
it does not anchor a subsequently generated final PDF. Retain the final receipt
as well. Obtain or review verification software independently when the package's
origin is in doubt. The included verifier is the same implementation shipped by
PaperSign, not a certification authority.

Without an independent fingerprint, the checks establish internal consistency
only. A database operator able to rewrite all hashes could create another
consistent history. Email verification establishes mailbox control, not legal
identity or authority to bind an organization. Ordinary server times are not
trusted timestamps.

## Standalone trusted timestamps

An organization certificate is **not required** to timestamp the manifest's
fingerprint. This optional feature uses RFC 3161 and the existing strict Node
certificate/CRL verifier. It does not use a P12, private organization key or
`SEAL_SOCKET`.

The operator supplies a JSON policy, for example:

```json
{
  "tsaUrl": "https://your-authorized-tsa.example/timestamp",
  "tsaPolicyOid": "1.2.3.4",
  "trustedRoots": ["BASE64_DER_ROOT_CHOSEN_INDEPENDENTLY"],
  "certificateChain": ["BASE64_DER_INTERMEDIATE"],
  "crlUrls": ["https://your-ca.example/current-full.crl"]
}
```

Set `EVIDENCE_TIMESTAMP_POLICY` to that policy's absolute path to timestamp new
canonical records automatically. Finalization commits a durable timestamp request
with the ready PDF. The worker recovers unfinished requests after a restart and
serializes bounded attempts across workers and the operator CLI. Enabling the
setting later does not queue older completed records: they remain explicitly
not requested until an operator timestamps them. These example URLs are placeholders: no real
provider account, authorization, pricing or interoperability is implied. The
operator must confirm the provider permits the intended usage. Network requests
use exact URL allowlists, HTTPS for the TSA, public DNS/address checks, pinned DNS
results, response limits, timeouts and no redirects. The supported revocation
profile is fresh full direct CRLs; OCSP, indirect/delta CRLs and unsupported
certificate algorithms fail closed.

Timestamp failure preserves the completed PDF and records an explicit failed
timestamp status; reconciliation does not automatically retry a failed provider
attempt. Removing or changing the requested policy path also records a failure.
Retry a failed or previously untimestamped record deliberately:

```sh
node dist-server/scripts/timestamp-evidence.js <document-id> /absolute/operator-policy.json
```

For source development, the equivalent is
`node --import tsx scripts/timestamp-evidence.ts <document-id> /absolute/operator-policy.json`.

A successful timestamp is immutable and idempotent. It is saved separately from
the manifest; the archive additionally includes `timestamp.json`, the binary
request, response and token, and the certificate/CRL material used for validation.

The dependency-free `verify.mjs` checks document evidence hashes and **does not
validate timestamp cryptography**. For cryptographic verification, use the
PaperSign compiled release and production dependencies, with a TSA root obtained independently
of the archive:

```sh
node dist-server/scripts/verify-evidence-timestamp.js /path/to/extracted-package /path/to/trusted-root.pem
```

The source equivalent is
`node --import tsx scripts/verify-evidence-timestamp.ts /path/to/extracted-package /path/to/trusted-root.pem`.
The compiled ordinary hash verifier is
`node dist-server/scripts/verify-evidence.js /path/to/extracted-package --receipt <fingerprint>`.

This command needs no database, application secret or network access. It checks
the signed manifest imprint, nonce, token signature, TSA purpose, certificate
path and retained revocation information at the signed generation time. Roots
embedded in the archive are never automatically trusted. It reports that current
revocation status and archival timestamp renewal have not been checked/provided;
this is not a PAdES-LTA renewal system or a guarantee of indefinite cryptographic
validity.

## Deletion and retained evidence

Completed records have no automatic expiry. By default, an owner's deletion
request starts a 30-day recovery window. Prior Admin approval is optional. The
operator may configure `DELETION_GRACE_DAYS` and `DELETION_APPROVAL_REQUIRED`, but
neither setting schedules a purge. Retained trash still counts towards the account
storage quota. Account-deletion requests require manual operator review.

The permanent document-deletion CLI first prints a plan, without changing data:

```sh
node dist-server/scripts/delete-document.js --document <document-id> --actor <admin-user-id>
```

Review the exact document, retained file hashes, recovery deadline and evidence
hashes. Obtain approval for that specific permanent deletion before executing:

```sh
node dist-server/scripts/delete-document.js --document <document-id> --actor <admin-user-id> --execute --fingerprint <reviewed-plan-fingerprint> --reason 'Approved reason'
```

The command refuses a changed plan, an unexpired recovery window, unfinished
signing or active exports. It records a deletion tombstone, retains files still
referenced elsewhere and returns a nonzero exit status if file cleanup is
incomplete. Resume only that already-approved deletion using its fingerprint:

```sh
node dist-server/scripts/delete-document.js --document <document-id> --actor <admin-user-id> --cleanup --fingerprint <reviewed-plan-fingerprint>
```

This does not remove backup copies or perform account deletion. Backup retention
and expiry need a separately recorded operator action and a disclosed policy.

## Restore rehearsal

Run the rehearsal using an isolated development configuration with all external
certificate/timestamp providers disabled. PostgreSQL `pg_dump` and `pg_restore`
must match or support the local PostgreSQL server version. Override their paths
with `PG_DUMP` and `PG_RESTORE` when they are not installed on `PATH`.

```sh
node --import tsx scripts/restore-rehearsal.ts
```

The tool accepts only a loopback PostgreSQL connection. It creates a new source
and a new target database with generated `papersign_restore_` names and refuses
to reuse a database. It creates synthetic signing evidence, a pending encrypted
invitation and a queued PDF export; takes a real custom-format PostgreSQL dump;
copies the referenced files and a generated application secret stored with mode
0600; then restores into the separate target. It verifies document/evidence
hashes, independent receipts, offline verification, token decryption, an HTTP
account login and real worker recovery. Cleanup drops only the exact generated
databases and independently checks they are gone.

The report is `.local/qa/readiness/restore-report.json`; its private rehearsal
directory retains the synthetic dump, files and generated recovery secret.
This demonstrates recovery mechanics. It does **not** establish that a production
backup is complete or restorable. A production-backup rehearsal must separately
include a consistent database/files snapshot, the actual encryption/authentication
secret and any separately protected signing credentials, restored into an
isolated environment with outbound mail/provider actions disabled.

For workflows already in progress before acceptance evidence was introduced,
PaperSign still creates an immutable, hash-checked final PDF. It marks the record
as incomplete when a historical signer or an owner-applied PNG has no preserved
acceptance. It does not manufacture old consent, issue a complete receipt/package
or timestamp such an incomplete record. The rehearsal also exercises this
upgrade path through the real restored PDF worker.
