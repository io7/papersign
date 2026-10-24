# PaperSign administration

This document describes the Admin feature: roles, invitations, API keys,
deletion review, statistics and first-Admin setup.

## Roles and access

**User** accounts manage their own documents and reusable signatures and can
create document signing links. **Admin** accounts have those same personal
features plus the Admin section: account invitations, role management, usage
statistics, and access to uploaded original PDFs across accounts.

The Admin section has **Users**, **Invitations**, **Documents** and **API keys**
views with search and pagination. Users show their document and active signature counts.
Their document shortcut filters the Documents view to that account.

The overview groups usage figures above a shared management area. Section
navigation, search and refresh stay together, and desktop records align account
or document identity, activity/status, and actions in consistent columns. The
invitation form occupies its own section. **Invite user** on Users or Documents
opens that form and places keyboard focus in Name.

The selected view, submitted search, page and document-owner filter are retained
in the URL, so reloading and browser Back/Forward preserve the working context.
On smaller screens, **Show usage statistics** expands the summary; the lists and
invitation form stay near the top. A failed list request shows a retry action
without retaining rows or counts from the previous view. Statistics can be
retried independently. Copy success or failure appears beside the invitation
link, and closing the email preview returns keyboard focus to its opening button.

Every Admin API request checks the current database role, verified account email,
enabled authenticator and successful MFA confirmation in the current session.
Existing and newly promoted Admins must complete enrollment through **Account
security** before opening Admin. Recovery codes must be saved separately; an
Admin cannot disable MFA while holding that role. A session created
while someone was an Admin does not retain those permissions after demotion.
Role changes include the expected previous role; stale changes are rejected so
the operator can refresh the list. A transaction lock serializes role changes
and prevents concurrent requests from demoting the last remaining Admin.
Ordinary signup and profile updates cannot set a role.

Admin access has a specific privacy boundary:

- **Open uploaded PDF** opens the original upload, without adding the owner's
  signature placements or recipient signatures. Each successful retrieval
  records the Admin, document and owner in `admin_event` before returning bytes.
- Admins can see document names, ownership, status, page counts, sizes and dates.
  They do not receive another user's reusable signature images, signing tokens,
  editing access or access to the owner's export routes through this feature.
- Ordinary document, signature and export routes retain their ownership checks.
  The dedicated Admin PDF route supplies the additional read permission.
- Administration audit events also record role changes, account invitation
  creation/revocation/acceptance, email acceptance by SMTP, first-Admin setup,
  API key creation and revocation, and every non-GET API key request.
  The audit is stored in the database; this release has no audit-log viewer.
- An API key acts only as the Admin who created it, so it never reaches another
  user's documents.

## API keys

In **Admin → API keys**, name the program that will use the key, choose a
lifetime of 30 days, 90 days (default) or one year, and select **Create key**.
The key is shown once; copy it into the program's private configuration and
choose **I have stored it**. PaperSign keeps only a hash and the first 12
characters for identification. Each Admin can hold ten active keys.

A key acts as its creator. It can upload PDFs, add text, add signers with
their signature and text fields, create signing links, send the previewed
invitation emails, cancel or reissue requests and download completed records.
It cannot sign, review or finalize the owner's own signature, use saved
signatures, open Admin, or reach account and authentication routes. Every Admin
sees all keys and can revoke any of them; revocation takes effect on the next
request. Keys stop working when they expire or when their creator loses the
Admin role, a verified email or two-step verification. Usable keys are listed
first. See `docs/api-keys.md` for the endpoint list and the command-line client.

## Invite someone to create an account

In **Admin → Invitations**, enter the person's name and email, choose **User**
or **Admin**, and select **Create invitation**. User is the default role. Copy the
private link and share it with the intended recipient. Creating a link does not
send email. Admin invitations grant access to account administration and uploaded
PDFs, so choose that role deliberately.

The invitation expires seven days after creation and can be revoked while
pending. Only one unexpired pending invitation per email is allowed. Accepted,
revoked and expired links cannot be reused; an expired link requires a new
invitation. Link tokens are random, hashed for lookup and encrypted at rest for
later copying. They are bearer credentials and must stay private.

The recipient opens `/join/<token>`, sees the invited email and role, and enters
their name and a password of 12–128 characters. The server takes the email and
role from the invitation; the browser cannot replace them. User creation,
credential creation and invitation consumption occur in one transaction. After
acceptance, the browser offers the ordinary sign-in page. Email verification is
required before signing or creating document invitations; Admin access also
requires authenticator enrollment and confirmation.

Account invitation acceptance works when `REGISTRATION_ENABLED=false`; that
setting closes public signup, not invited signup. Account invitations are
separate from document signing invitations, which let guests sign without
creating an account. Neither flow verifies a person's legal identity, and the
account email verification flag remains false for a newly invited account.

If the email already has an account when an Admin creates the invitation, use
**Users** to manage that account's role instead. If the person registers after
the invitation was created, they must sign into the matching account before
accepting. Acceptance preserves the existing name and password. An Admin
invitation can promote that account; a User invitation never demotes an existing
Admin. A different signed-in account cannot accept on that person's behalf.

## Email delivery

The prepared release also uses requested security emails for account verification,
password recovery and recipient one-time codes. Those are separate from manually
previewed invitation emails. Production SMTP must be configured and delivery
validated before enabling the new signing workflow; copying a document link alone
no longer permits signing. All automated delivery tests use a loopback-only sink.

## Operations and data requests

**Operations and data requests** shows database/worker/storage/queue checks and
pending deletion requests. A document owner requests deletion by confirming its
exact name, starting the approved 30-day recovery window. Setting
`DELETION_APPROVAL_REQUIRED=true` optionally requires an Admin to review the current
request and record a reason before the window starts. The owner can withdraw the request and restore
the document during that window. No scheduled job permanently deletes records.

After the recovery window, an operator can prepare a precise deletion plan with
`node --env-file=/etc/papersign/papersign.env dist-server/scripts/delete-document.js
--document UUID --actor ADMIN_USER_ID`. This is read-only. Executing with
`--execute --fingerprint APPROVED_PLAN_HASH --reason "Approved reason"` requires
separate approval of that exact plan. The CLI checks the current Admin, request,
document revision, file hashes, recovery deadline and pending work. It preserves
files still referenced by another record and retains a minimal deletion tombstone.
If interrupted, `--cleanup --fingerprint APPROVED_PLAN_HASH` resumes file cleanup
from that tombstone and checks references and hashes again. Nonempty
`cleanupRequired` means physical cleanup is unfinished.

Account deletion requests are reviewed manually. The interface does not promise
automatic account erasure; retained participant records, legal holds, backup
expiry and the final account-removal plan must be considered by the operator.

## Invitation email

Without SMTP, **Copy link** works, and **Preview email** shows the proposed
recipient, subject and full plain-text body, but sending is disabled until an
operator configures SMTP.

When SMTP is configured, sending is a separate action after reviewing the
preview. The send request includes a hash of the preview; the server checks it
against the current invitation and sender before sending. A revoked or expired
link cannot be sent. There are no CC/BCC recipients or attachments. Successful
SMTP acceptance is recorded as `account_invitation_email_accepted`; it is not
proof of inbox delivery. Sender/provider setup remains an operator decision.

## What the statistics count

All figures cover every account and reflect current database state:

| Statistic           | Meaning                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Users / Admins      | All registered accounts and the subset currently assigned Admin.                                            |
| Uploaded PDFs       | Number of uploaded document records across accounts.                                                        |
| Size of originals   | Sum of original PDF upload sizes. Excludes signatures, previews, exports, database and backup storage.      |
| Awaiting signatures | Documents with status `awaiting`; an expired outstanding signer can still leave a document in this state.   |
| Completed           | Documents with status `completed`; this is a workflow status, not certificate-based signature verification. |
| Saved signatures    | Active reusable signature library entries, excluding entries removed from the library.                      |
| Pending invites     | Unexpired pending account invitations, excluding document signing requests.                                 |

## Set the first Admin

`drizzle/0003_account_administration.sql` is additive: it adds `user.role`,
`account_invitation` and `admin_event`, with role/state checks and foreign keys.
Every existing account starts as User. No email, account position or signup
order causes automatic promotion.

After applying migrations and verifying the intended existing account's exact ID
and email, an operator runs the compiled CLI from the installed release directory
with the production environment. For example:

```sh
cd /opt/papersign/current
runuser -u papersign -- /opt/node/bin/node \
  --env-file=/etc/papersign/papersign.env \
  dist-server/scripts/bootstrap-admin.js \
  --user-id EXACT_ID --email EXACT_EMAIL
```

With Docker, run `docker compose exec web papersign bootstrap-admin --email
EXACT_EMAIL` in the `docker` folder.

This requires the existing account; the command creates no account, password or
session and sends no email. It accepts either `--email EXACT_EMAIL` alone or
`--user-id EXACT_ID --email EXACT_EMAIL`, in that order. The email must match
the stored address exactly.
Under the same transaction lock used by role management, it requires:

1. There are currently zero Admin accounts.
2. The supplied user ID, or else the supplied email, identifies an account.
3. Its stored email exactly equals the supplied email.
4. Its current role is User.

Only that account is promoted. The same transaction records
`first_admin_bootstrapped`, including the old/new role and `operator_cli` method.
The command prints the promoted ID, email and role; the operator should verify
the role and corresponding audit row independently. A second bootstrap attempt
fails once any Admin exists. Subsequent changes use the Admin section.

Do not print the production environment or include credentials in release
archives. The CLI is compiled to `dist-server/scripts/bootstrap-admin.js` by the
normal build, so production does not need the development `tsx` dependency.

## Upgrade and recovery

Keep a fresh pre-upgrade database/files backup before applying migration 0003.
The separate 0.3 text feature also extends existing document, invitation and
export JSON. Once text is saved, 0.2 binaries cannot interpret those records.
The additive Admin migration does not make a symlink-only rollback to 0.2 safe.
Preserve subsequent user changes and use a tested, compatible recovery plan;
do not discard current data or blindly reverse migrations.
