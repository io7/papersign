# Ordered signing

Signing requests follow the owner's ordered list, with a separate private link
for every person. The list can be rearranged before links are created. Creating
links fixes the order and the PDF.

The owner can copy every link immediately and see each person's status. Later
recipients see a waiting screen until earlier requests are signed or revoked.
The next recipient reviews a PDF containing the earlier signatures. Invitation
emails keep their preview and explicit send step. When SMTP is configured,
PaperSign emails a recipient automatically once their turn opens, after an
earlier request is signed or revoked. The document history records whether that
email was sent (`turn_email_sent`) or failed (`turn_email_failed`); a failure
never undoes the signature or revocation that caused it.

## Signatures and downloads

- Newly uploaded PNGs automatically lose white and near-white backgrounds, with
  antialiased edges adjusted to avoid white halos. Preview and server processing
  use the same cleanup; all-white files are rejected.
- Delete removes the selected editable signature field from the document without
  deleting its saved account signature. Typing, dialogs and locked documents are
  protected from this shortcut.
- Recipient field width and height resize independently with the corner handle
  or Alt+arrow keys, within the page bounds. PNG signature placements keep their
  aspect ratio; recipient signature ink is fitted without distortion.
- Owners and invited signers can scroll through the entire PDF. Page navigation
  remains available. The viewer loads each PDF once and renders nearby pages with
  bounded canvas memory.
- **Advanced download** opens a modal containing **Rasterize the download**.
  The ordinary **Prepare download** action always preserves the PDF's original
  text and content, even after a previous rasterized export.

## Consistency and privacy

- The server assigns positive, unique positions from the submitted recipient list.
  Duplicate email addresses and field IDs are rejected.
- Document row locks serialize signing, revocation and export decisions. The
  signature endpoint rechecks eligibility after acquiring the lock.
- PDF previews and signature acceptance require the reviewed document revision.
  A concurrent change requires the recipient to review again and renew consent.
- Recipient metadata exposes only that person's position and the number of
  earlier unfinished requests, without other people's names, emails or links.
- Cumulative previews start with the frozen owner PDF and accepted signature
  copies. Removing a reusable account signature cannot alter that document.
- Links expire seven days after creation, including time spent waiting. An expired
  earlier signer blocks the queue until the owner reissues or revokes that request.

## Migration

`drizzle/0002_serial_signing.sql` adds `invitation.signing_order`. Accepted
historical signatures are ordered first by signing time; remaining requests use
creation time and ID as a deterministic order. Tokens, signature files, document
content and existing consent records are preserved.

Releases from before this migration cannot create invitations afterwards. Going
back to one requires restoring the pre-migration database and files together
with that release.
