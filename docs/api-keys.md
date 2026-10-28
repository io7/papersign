# API keys

API keys let a trusted program prepare documents for signing on an Admin's
behalf: upload a PDF, add text, add signers with their signature and text
fields, create signing links, send the invitation emails, follow progress and
download the completed record. The first client is `client/papersign.mjs`, a
command-line tool that places fields next to text found in the PDF.

## Managing keys

API keys are an Admin function. In **Admin → API keys**, an Admin with a
verified email and an authenticator-confirmed session can:

- create a key with a name and a lifetime of 30, 90 (default) or 365 days;
- see every key: name, owner, prefix, expiry, last use and state, with usable
  keys first;
- revoke any key, including another Admin's.

A key always acts as the Admin who created it. Admins cannot create keys for
other accounts, so keys never give an Admin access to another user's
documents. Each Admin can hold up to 10 active keys.

The secret (`psk_` followed by 43 characters) is shown once, at creation.
PaperSign stores only its SHA-256 hash and its first 12 characters
(`psk_` plus 8) to identify it in lists and audit events.

A key stops working when it is revoked, when it expires, or when its owner is
no longer an Admin with a verified email address and two-step verification.
Changing the owner's password or signing out other sessions does not revoke
keys; revoke them separately after a suspected compromise.

## Using a key

Send `Authorization: Bearer psk_…` with each request. Key requests do not need
the browser's `Origin` and `X-PaperSign` headers, because a bearer header is
never attached by a browser on its own. Session cookies are ignored when a key
is present.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/documents` | List the owner's documents |
| POST | `/api/documents` | Upload a PDF (multipart, one file) |
| GET | `/api/documents/:id` | Document, pages and signers with links and status |
| GET | `/api/documents/:id/pdf` | Original PDF |
| PUT | `/api/documents/:id/placements` | Owner text fields (text only) |
| POST | `/api/documents/:id/invitations` | Signers, order, fields; creates links |
| GET | `/api/documents/:id/invitations/:invitationId/email` | Email preview and its hash |
| POST | `/api/documents/:id/invitations/:invitationId/email` | Send that previewed email |
| POST | `/api/documents/:id/invitations/:invitationId/reissue` | New link for an unfinished signer |
| POST | `/api/documents/:id/invitations/:invitationId/revoke` | Skip an unfinished signer |
| POST | `/api/documents/:id/cancel` | Cancel an unfinished signing request |
| POST | `/api/documents/:id/deletion-request` | Move a document to recoverable trash |
| GET | `/api/documents/:id/history` | Audit history |
| GET | `/api/documents/:id/record` | Completion record status |
| GET | `/api/documents/:id/record/pdf` | Completed PDF |
| GET | `/api/documents/:id/record/evidence` | Evidence package |

Every other route answers 403 for a key, including Admin, account, saved
signature and authentication routes. Keys cannot sign: owner signature
placements, owner review and owner finalization are refused, so the key owner
signs through a signing link like every other signer.

Placements use the same normalized page coordinates as the browser editor:
`x`, `y`, `width` and `height` are fractions of the displayed page (crop box,
after rotation), measured from the top-left corner.

## Audit

- Creating and revoking keys writes `api_key_created` and `api_key_revoked`
  Admin events.
- Every key request other than GET writes an `api_key_request` Admin event with
  the key, method, route, response status and document id.
- `last_used_at` is updated at most once a minute.
- Document audit events name the key's owner as the actor, as for browser use.

## Client tool

`client/papersign.mjs` talks to the server in `PAPERSIGN_URL`, for example
`https://papersign.example.com`. It reads the key from `PAPERSIGN_API_KEY`, or
from the file named in `PAPERSIGN_KEY_FILE` (default
`~/.config/papersign/api-key`, mode 0600).

```
node client/papersign.mjs plan    spec.json [--out DIR]   # find anchors, write previews
node client/papersign.mjs create  spec.json [--out DIR]   # upload, add fields, create links
node client/papersign.mjs status  DOCUMENT_ID
node client/papersign.mjs email   DOCUMENT_ID [--signer EMAIL]
node client/papersign.mjs download DOCUMENT_ID OUTPUT.pdf
```

`plan` never contacts PaperSign. `create` never sends email. `email` sends the
invitation emails that PaperSign previews, one per pending signer. After that,
PaperSign itself emails each later signer when their turn opens.

A spec names the PDF, the signers in order and, for each field, a piece of text
in the PDF to place it against:

```json
{
  "pdf": "Board minutes.pdf",
  "signers": [
    {
      "name": "Ada Example",
      "email": "ada@example.test",
      "signature": { "anchor": "Ada Example, Chair", "position": "above" },
      "text": [
        { "label": "Place and date", "anchor": "Place and date:",
          "near": "Ada Example, Chair", "position": "right" }
      ]
    }
  ],
  "ownerText": [
    { "text": "London, 23.10.2026", "anchor": "Date:", "position": "right" }
  ]
}
```

- `anchor`: text to find. Matching ignores case and repeated spaces and may
  span several text runs on one line.
- `occurrence`: which match to use, counted in reading order (default 1).
- `near`: instead of `occurrence`, use the match closest to this other text.
- `page`: limit the search to one page (1-based).
- `position`: `above`, `below`, `right` or `over` the anchor.
- `width`, `height`, `dx`, `dy`: size and offset in PDF points (1/72 inch).
  Defaults: signature 180 × 40, text 160 × 16 (or the anchor's height).
- `fontSize` for text fields (default 10).

`plan` writes `plan.json` and one PNG per page that has fields, with each box
drawn and labelled, so placement can be checked before anything is created.
`create --out DIR` writes the same files.

## MCP server

`client/mcp.mjs` offers the same workflow to an MCP client such as Claude Code,
with the same key and server settings:

```
claude mcp add papersign --scope user -- node <repo>/client/mcp.mjs
codex mcp add papersign -- node <repo>/client/mcp.mjs
```

| Tool | Effect |
|---|---|
| `papersign_plan` | Finds anchors in a local PDF and returns the placement report plus a preview image of each page with fields. Contacts nothing. |
| `papersign_create` | Creates the request from a `plan_id`: upload, owner text, signing links. Sends no email. |
| `papersign_status` | Document status and each signer's progress; links only on request. |
| `papersign_list_documents` | The key owner's documents. |
| `papersign_preview_emails` | The invitation emails PaperSign would send. |
| `papersign_send_emails` | Sends those emails to pending signers (all, or the listed ones). |
| `papersign_reissue` | New seven-day link for an unfinished signer. |
| `papersign_cancel` | Cancels an unfinished request. |
| `papersign_download` | Saves the completed PDF and, optionally, the evidence package. |

A request can only be created from a plan made earlier in the same MCP
session, and each plan is used once. What PaperSign receives is therefore
exactly what the preview showed, and a retried call cannot create a duplicate.
`papersign_send_emails` is marked as reaching the outside world, so the client
asks before each call.

## Verification

- `tests/api-keys.test.ts`: key management, scope, revocation, expiry,
  demotion, the owner-signature guard, audit rows, and a full run of the
  command-line client against the local server (create, email, two synthetic
  signers, record download, text placement in the signed PDF), and the MCP
  tools over an in-memory transport (preview images, one-time plans, email
  preview and sending, cancellation).
- `tests/client-anchors.test.ts`: anchor matching and box placement checked
  against the server's own stamping transform on pages rotated 0, 90, 180 and
  270 degrees, with crop boxes.
- `tests/browser/admin-api-keys.spec.ts`: the Admin tab at 1440, 900 and 390
  pixels, one-time display, copy, revoke, column alignment and ordering.
