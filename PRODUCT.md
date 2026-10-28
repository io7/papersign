# PaperSign

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vue 3, TypeScript, Vite, Fastify, PostgreSQL, Drizzle, Better Auth, PDF.js, pdf-lib,
pg-boss and @napi-rs/canvas. Rendering, rasterization and signing-evidence
verification run in Node; Python is not required. Certificate and timestamp
verification uses MIT-licensed libraries with permissive dependencies. It runs
self-hosted, from the Docker image or on a dedicated Debian host.

## Users

People who need to place their own signature on PDFs and request signatures from other people. Accounts own a private reusable signature library.

## Product Purpose

Upload a PDF, place a signature, and download a signed copy, optionally rasterized. A saved signature should be reusable without uploading it again.

## Capabilities and Constraints

- Registration, verified email, password recovery and session management;
  private documents and signatures per account. Admin access requires a verified
  account and an authenticator-confirmed session, with saved recovery codes.
- Upload transparent PNG signatures or draw one with mouse, pen, or touch.
- Automatically remove white backgrounds from newly uploaded PNG signatures.
- Save drawings and uploaded PNGs to the account for later documents.
- Place and resize signatures on PDF pages; preserve page dimensions and rotation.
- Resize recipient signing fields with independent width and height. Keep signature
  images proportional when resizing or fitting them inside a recipient field.
- Add, position, resize and edit single-line text such as names, places and dates.
  Choose a font size; text fits uniformly within its field and supports Latin
  letters including æ, ø and å. Values must remain readable and fit inside the
  PDF page.
- Autosave owner text and signature edits with visible save/failure status.
  Select a field for inline text, size and delete controls; click outside to
  deselect it. Unshared signer lists persist when signing links are created.
- Add required text fields to each signer before creating their link. Completed
  values are frozen with their signature and included in subsequent reviews and
  normal or rasterized downloads.
- Delete a selected page signature with the Delete key without changing the saved
  signature library; typing in fields must never trigger placement deletion.
- Scroll through every PDF page while retaining convenient page navigation.
- Keep PDF pages centered within the full scrolling area, with the scrollbar at
  its outer edge and the placement instructions centered beneath it.
- Private signing links and an ordered signer list. Recipients verify control of
  their addressed mailbox and sign sequentially, reviewing earlier signatures.
  Owners and recipients explicitly accept versioned consent against their exact
  retained review PDF; signing locks the accepted fields and signature bytes.
- Expired requests can be reissued, pending recipients revoked, and unfinished
  workflows cancelled. Cancellation preserves prior acceptances and is clearly
  distinguished from all participants signing.
- Automatically create one immutable ordinary final PDF. Preserve per-person
  reviews, acceptance fingerprints, a final receipt and portable evidence with an
  offline Node verifier. Recipients retrieve completed records using a fresh email
  challenge even after the signing link expires.
- Old in-flight workflows with missing historical consent retain a final PDF
  marked as incomplete evidence; never invent historical acceptances.
- Original and rasterized PDF downloads.
- Keep normal downloads simple; expose rasterization in an Advanced download modal.
- Agent testing must never send real email. Local verification/recovery tests use
  a loopback-only synthetic mailbox with no relay. Production SMTP delivery is a
  separate readiness gate; copied links do not bypass email verification.
- Participant signatures are visual signatures with consent and mailbox-control
  evidence, not independently verified legal identities. Optional organization
  certificate sealing is separate and does not certify each participant.
- Optional RFC 3161 timestamps anchor the evidence manifest without an
  organization certificate. Verification pins independently supplied trust roots
  and preserves supported full CRLs. A real provider must be configured and
  validated separately; no indefinite validity or archival renewal is promised.
- Owner-requested deletion starts a recovery period, 30 days by default; prior
  Admin approval is an optional setting. There
  is no automatic expiry or purge. Permanent document deletion is an explicit,
  fingerprint-guarded operator action with resumable file cleanup. Account
  deletion requests require manual review; backup expiry is separate.
- Quotas count retained files, including signing evidence and recoverable trash.
  Admin operations expose worker, storage, queue and backup status. Monitoring
  notifications need a destination the operator has chosen and tested.

## Operating Context

A self-hosted browser application, used on desktop and touch devices. Rasterization
runs asynchronously with bounded resource use.

## Operator Responsibilities

Each installation needs working SMTP delivery, a monitoring destination, tested
backups and the operator's own privacy procedures. Optional external timestamp
and organization seal providers require separate configuration.

Operators can disable public registration with `REGISTRATION_ENABLED=false`;
valid account invitations remain available. Manually initiated invitation emails
have a preview and separate send action; the next signer gets an automatic
"your turn" notice once an earlier request is signed or revoked. User-requested verification and recovery
messages are sent by those actions. Completed records have no automatic expiry;
deletion requests do not silently erase another participant's evidence.
