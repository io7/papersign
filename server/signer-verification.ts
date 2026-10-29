import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { symmetricDecrypt } from "better-auth/crypto";
import { auth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { documents, invitations, user } from "./schema.js";
import { twoFactor } from "./account-security-schema.js";
import { signerVerifications } from "./signer-verification-schema.js";
import { sha256 } from "./storage.js";
import { mailConfigured, sendSecurityMail } from "./mail.js";
import { emailHtml } from "./email-design.js";

export type VerificationContext = {
  invitationId: string;
  documentId: string;
  revision: number;
  email: string;
  purpose: "sign" | "record";
};
type VerificationDb = Pick<
  typeof db,
  "select" | "insert" | "update" | "execute"
>;
export type SignerAuthentication = {
  verificationId: string;
  email: string;
  verifiedAt: string;
} & (
  | { method: "email-one-time-code" }
  | {
      method: "account-authenticator";
      factor: "code" | "session";
      accountId: string;
    }
);
const CODE_TTL = 10 * 60_000;
const GRANT_TTL = 30 * 60_000;
const MAX_ATTEMPTS = 5;
// Failed authenticator codes allowed per hour, for one request and for one
// account across all requests sent to it.
const AUTHENTICATOR_FAILURES_PER_REQUEST = 5;
const AUTHENTICATOR_FAILURES_PER_ACCOUNT = 10;
// Better Auth's TOTP defaults, which PaperSign uses: 30-second steps, six
// digits, HMAC-SHA1, one step of clock drift either way.
const TOTP_PERIOD = 30_000;
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
};

export function codeDigest(id: string, code: string) {
  return createHmac("sha256", config.BETTER_AUTH_SECRET)
    .update(`papersign:mailbox-code:v1:${id}:${code}`)
    .digest("hex");
}
export function equalDigest(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
export function maskedEmail(email: string) {
  const at = email.lastIndexOf("@");
  return at < 1
    ? "the invited email address"
    : `${email[0]}•••${email.slice(at)}`;
}
function cookieName(context: VerificationContext) {
  return `papersign_${context.purpose}_${sha256(context.invitationId).slice(0, 16)}`;
}
function browserCredential(req: FastifyRequest, context: VerificationContext) {
  const value = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName(context)}=`))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!value || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) return;
  const [id, secret] = value.split(".");
  return { id, secretHash: sha256(secret) };
}
function setBrowserCredential(
  reply: FastifyReply,
  context: VerificationContext,
  value: string,
) {
  reply.header(
    "Set-Cookie",
    `${cookieName(context)}=${value}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${GRANT_TTL / 1000}${config.APP_URL.startsWith("https:") ? "; Secure" : ""}`,
  );
}
async function lockContext(
  reader: VerificationDb,
  context: VerificationContext,
) {
  await reader.execute(
    sql`select id from document where id = ${context.documentId} for update`,
  );
  const [invitation] = await reader
    .select()
    .from(invitations)
    .where(eq(invitations.id, context.invitationId));
  const [document] = await reader
    .select()
    .from(documents)
    .where(eq(documents.id, context.documentId));
  if (
    !invitation ||
    !document ||
    invitation.documentId !== document.id ||
    invitation.email.toLowerCase() !== context.email.toLowerCase()
  )
    fail(404, "This signing request is unavailable.");
  if (document.revision !== context.revision)
    fail(409, "This document changed. Reload it before verifying your email.");
  if (
    context.purpose === "sign" &&
    (invitation.state !== "pending" ||
      invitation.expiresAt <= new Date() ||
      document.status !== "awaiting" ||
      document.deletedAt)
  )
    fail(409, "This signing request is no longer active.");
  if (context.purpose === "record" && invitation.state !== "signed")
    fail(403, "Only a participant who signed can access this signing record.");
}
async function browserChallenge(
  req: FastifyRequest,
  context: VerificationContext,
  reader: VerificationDb = db,
) {
  const credential = browserCredential(req, context);
  if (!credential) return;
  const [row] = await reader
    .select()
    .from(signerVerifications)
    .where(eq(signerVerifications.id, credential.id));
  if (
    !row ||
    !equalDigest(row.secretHash, credential.secretHash) ||
    row.invitationId !== context.invitationId ||
    row.documentId !== context.documentId ||
    row.purpose !== context.purpose ||
    row.revision !== context.revision ||
    row.email.toLowerCase() !== context.email.toLowerCase()
  )
    return;
  return row;
}

/** The PaperSign account that can prove this address with its authenticator. */
async function authenticatorAccount(
  email: string,
  reader: VerificationDb = db,
) {
  const [account] = await reader
    .select({
      id: user.id,
      secret: twoFactor.secret,
      lockedUntil: twoFactor.lockedUntil,
    })
    .from(user)
    .innerJoin(twoFactor, eq(twoFactor.userId, user.id))
    .where(
      and(
        sql`lower(${user.email}) = ${email.toLowerCase()}`,
        eq(user.emailVerified, true),
        eq(user.twoFactorEnabled, true),
        isNull(user.deletionRequestedAt),
        eq(twoFactor.verified, true),
      ),
    )
    .limit(1);
  return account;
}
/** A signed-in session for the invited address, confirmed with the authenticator. */
async function confirmedSession(
  req: FastifyRequest,
  context: VerificationContext,
) {
  const active = await auth.api
    .getSession({ headers: fromNodeHeaders(req.headers) })
    .catch(() => null);
  if (
    !active ||
    active.user.email.toLowerCase() !== context.email.toLowerCase() ||
    !active.user.emailVerified ||
    !active.user.twoFactorEnabled ||
    !(active.session as { mfaVerified?: boolean }).mfaVerified
  )
    return;
  return active;
}
function hotp(secret: string, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(message)
    .digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
/** The time step the code belongs to, or undefined. Checks every step, so timing does not reveal which. */
function matchingStep(secret: string, code: string, now: number) {
  const current = Math.floor(now / TOTP_PERIOD);
  let matched: number | undefined;
  for (const step of [current - 1, current, current + 1]) {
    const equal = timingSafeEqual(
      Buffer.from(hotp(secret, step)),
      Buffer.from(code),
    );
    if (equal && matched === undefined) matched = step;
  }
  return matched;
}

export async function verificationStatus(
  req: FastifyRequest,
  context: VerificationContext,
) {
  const row = await browserChallenge(req, context);
  // Account proofs are offered for signing only. The signing record keeps
  // its email check.
  const signing = context.purpose === "sign";
  const [account, session] = signing
    ? await Promise.all([
        authenticatorAccount(context.email),
        confirmedSession(req, context),
      ])
    : [undefined, undefined];
  return {
    required: true as const,
    verified: Boolean(
      row?.verifiedAt &&
      row.deliveredAt &&
      !row.consumedAt &&
      row.expiresAt > new Date(),
    ),
    emailHint: maskedEmail(context.email),
    deliveryAvailable: mailConfigured(),
    authenticatorAvailable: Boolean(account),
    accountSession: Boolean(session),
  };
}

export async function sendVerificationCode(
  req: FastifyRequest,
  reply: FastifyReply,
  context: VerificationContext,
) {
  if (!mailConfigured())
    fail(
      503,
      "Email verification is unavailable. Ask the sender to contact the PaperSign administrator.",
    );
  const id = randomUUID(),
    secret = randomBytes(32).toString("base64url"),
    code = String(randomInt(0, 1_000_000)).padStart(6, "0"),
    now = new Date();
  await db.transaction(async (tx) => {
    await lockContext(tx, context);
    // The document lock makes these mailbox-wide limits hold across browsers,
    // processes and concurrent requests. Failed deliveries also count.
    const recent = await tx
      .select({
        sentAt: signerVerifications.sentAt,
        purpose: signerVerifications.purpose,
      })
      .from(signerVerifications)
      .where(
        and(
          eq(signerVerifications.invitationId, context.invitationId),
          eq(signerVerifications.method, "email-one-time-code"),
          gte(
            signerVerifications.sentAt,
            new Date(now.getTime() - 24 * 60 * 60_000),
          ),
        ),
      );
    if (
      recent.some(
        (row) =>
          row.purpose === context.purpose &&
          row.sentAt.getTime() > now.getTime() - 60_000,
      )
    )
      fail(429, "Wait a minute before requesting another email code.");
    if (
      recent.length >= 20 ||
      recent.filter((row) => row.sentAt.getTime() > now.getTime() - 60 * 60_000)
        .length >= 5
    )
      fail(429, "Too many email codes were requested. Try again later.");
    const previous = await browserChallenge(req, context, tx);
    if (previous && !previous.consumedAt)
      await tx
        .update(signerVerifications)
        .set({ consumedAt: now, codeHash: null })
        .where(eq(signerVerifications.id, previous.id));
    await tx.insert(signerVerifications).values({
      id,
      invitationId: context.invitationId,
      documentId: context.documentId,
      revision: context.revision,
      email: context.email.toLowerCase(),
      purpose: context.purpose,
      secretHash: sha256(secret),
      codeHash: codeDigest(id, code),
      sentAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL),
    });
  });
  try {
    const text = `Your PaperSign verification code is: ${code}\n\nIt expires in 10 minutes and only works in the browser that requested it. ${context.purpose === "sign" ? "Use it to verify your email before reviewing and signing the document." : "Use it to access your completed signing record."}\n\nDo not share this code, including with the document sender. If you did not request it, ignore this email.\n\nPaperSign`;
    await sendSecurityMail({
      to: context.email,
      subject: "Your PaperSign verification code",
      text,
      html: emailHtml(text, {
        heading: "Your verification code",
        preview: "Your PaperSign verification code expires in 10 minutes.",
        code,
      }),
    });
    await db
      .update(signerVerifications)
      .set({ deliveredAt: new Date() })
      .where(eq(signerVerifications.id, id));
  } catch {
    await db
      .update(signerVerifications)
      .set({ consumedAt: new Date(), codeHash: null })
      .where(eq(signerVerifications.id, id));
    fail(
      503,
      "The verification email could not be sent. Wait a minute and try again.",
    );
  }
  setBrowserCredential(reply, context, `${id}.${secret}`);
  return {
    sent: true,
    expiresInSeconds: CODE_TTL / 1000,
    resendAfterSeconds: 60,
  };
}

export async function confirmVerificationCode(
  req: FastifyRequest,
  context: VerificationContext,
  code: string,
) {
  const result = await db.transaction(async (tx) => {
    await lockContext(tx, context);
    const row = await browserChallenge(req, context, tx),
      now = new Date();
    if (
      !row ||
      !row.deliveredAt ||
      row.consumedAt ||
      row.verifiedAt ||
      !row.codeHash ||
      row.expiresAt <= now ||
      row.attempts >= MAX_ATTEMPTS
    )
      return false;
    const matches =
      /^\d{6}$/.test(code) &&
      equalDigest(row.codeHash, codeDigest(row.id, code));
    await tx
      .update(signerVerifications)
      .set(
        matches
          ? {
              attempts: row.attempts + 1,
              codeHash: null,
              verifiedAt: now,
              expiresAt: new Date(now.getTime() + GRANT_TTL),
            }
          : {
              attempts: row.attempts + 1,
              ...(row.attempts + 1 >= MAX_ATTEMPTS
                ? { consumedAt: now, codeHash: null }
                : {}),
            },
      )
      .where(eq(signerVerifications.id, row.id));
    return matches;
  });
  // Throw after committing, so failed attempts cannot roll themselves back.
  if (!result)
    fail(
      400,
      "That code is incorrect, expired or already used. Request a new code if needed.",
    );
  return { verified: true };
}

async function replaceBrowserChallenge(
  tx: VerificationDb,
  req: FastifyRequest,
  context: VerificationContext,
) {
  // A new proof replaces this browser's earlier challenge for the request.
  const previous = await browserChallenge(req, context, tx);
  if (previous && !previous.consumedAt)
    await tx
      .update(signerVerifications)
      .set({ consumedAt: new Date(), codeHash: null })
      .where(eq(signerVerifications.id, previous.id));
}

/** Proves the invited address with the six-digit code from the account's authenticator. */
export async function confirmAuthenticatorCode(
  req: FastifyRequest,
  reply: FastifyReply,
  context: VerificationContext,
  code: string,
) {
  const account = await authenticatorAccount(context.email);
  if (!account) fail(400, "Use an email code to verify this address.");
  if (account!.lockedUntil && account!.lockedUntil > new Date())
    fail(
      429,
      "Your authenticator is locked for a while after failed attempts. Use an email code instead.",
    );
  const secret = await symmetricDecrypt({
    key: (await auth.$context).secretConfig,
    data: account!.secret,
  });
  const now = new Date(),
    step = /^\d{6}$/.test(code)
      ? matchingStep(secret, code, now.getTime())
      : undefined;
  const id = randomUUID(),
    browserSecret = randomBytes(32).toString("base64url");
  const outcome = await db.transaction(async (tx) => {
    await lockContext(tx, context);
    // One account's attempts are serialised, so the limits and the
    // single-use check below cannot be raced.
    await tx.execute(
      sql`select id from "user" where id = ${account!.id} for update`,
    );
    const [failures] = await tx
      .select({
        request: sql<number>`count(*) filter (where ${signerVerifications.invitationId} = ${context.invitationId})::int`,
        account: sql<number>`count(*)::int`,
      })
      .from(signerVerifications)
      .where(
        and(
          eq(signerVerifications.userId, account!.id),
          eq(signerVerifications.method, "account-authenticator"),
          eq(signerVerifications.factor, "code"),
          isNull(signerVerifications.verifiedAt),
          gte(
            signerVerifications.sentAt,
            new Date(now.getTime() - 60 * 60_000),
          ),
        ),
      );
    if (
      failures.request >= AUTHENTICATOR_FAILURES_PER_REQUEST ||
      failures.account >= AUTHENTICATOR_FAILURES_PER_ACCOUNT
    )
      return "limited" as const;
    let accepted = step !== undefined;
    if (accepted) {
      const [used] = await tx
        .select({ id: signerVerifications.id })
        .from(signerVerifications)
        .where(
          and(
            eq(signerVerifications.userId, account!.id),
            eq(signerVerifications.totpStep, step!),
          ),
        )
        .limit(1);
      accepted = !used;
    }
    if (accepted) await replaceBrowserChallenge(tx, req, context);
    await tx.insert(signerVerifications).values({
      id,
      invitationId: context.invitationId,
      documentId: context.documentId,
      revision: context.revision,
      email: context.email.toLowerCase(),
      purpose: context.purpose,
      method: "account-authenticator",
      factor: "code",
      userId: account!.id,
      secretHash: sha256(browserSecret),
      attempts: 1,
      sentAt: now,
      deliveredAt: now,
      verifiedAt: accepted ? now : null,
      consumedAt: accepted ? null : now,
      totpStep: accepted ? step! : null,
      expiresAt: accepted ? new Date(now.getTime() + GRANT_TTL) : now,
    });
    return accepted ? ("verified" as const) : ("rejected" as const);
  });
  // Throw after committing, so failed attempts cannot roll themselves back.
  if (outcome === "limited")
    fail(
      429,
      "Too many authenticator codes were tried. Use an email code or try again in an hour.",
    );
  if (outcome === "rejected")
    fail(
      400,
      "That code is incorrect or was already used. Wait for a new code in your authenticator app.",
    );
  setBrowserCredential(reply, context, `${id}.${browserSecret}`);
  return { verified: true };
}

/** Proves the invited address with a session that was confirmed with the authenticator. */
export async function confirmAccountSession(
  req: FastifyRequest,
  reply: FastifyReply,
  context: VerificationContext,
) {
  const active = await confirmedSession(req, context);
  if (!active)
    fail(
      403,
      "Sign in with the invited email address and your authenticator first.",
    );
  const id = randomUUID(),
    browserSecret = randomBytes(32).toString("base64url"),
    now = new Date();
  await db.transaction(async (tx) => {
    await lockContext(tx, context);
    await replaceBrowserChallenge(tx, req, context);
    await tx.insert(signerVerifications).values({
      id,
      invitationId: context.invitationId,
      documentId: context.documentId,
      revision: context.revision,
      email: context.email.toLowerCase(),
      purpose: context.purpose,
      method: "account-authenticator",
      factor: "session",
      userId: active!.user.id,
      secretHash: sha256(browserSecret),
      sentAt: now,
      deliveredAt: now,
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + GRANT_TTL),
    });
  });
  setBrowserCredential(reply, context, `${id}.${browserSecret}`);
  return { verified: true };
}

export async function requireVerifiedMailbox(
  req: FastifyRequest,
  context: VerificationContext,
  reader: VerificationDb = db,
): Promise<SignerAuthentication> {
  const row = await browserChallenge(req, context, reader);
  if (
    !row?.verifiedAt ||
    !row.deliveredAt ||
    row.consumedAt ||
    row.expiresAt <= new Date()
  )
    fail(
      403,
      "Verify the invited email address in this browser before continuing.",
    );
  const proof = {
    verificationId: row!.id,
    email: row!.email,
    verifiedAt: row!.verifiedAt!.toISOString(),
  };
  if (row!.method === "account-authenticator")
    return {
      ...proof,
      method: "account-authenticator",
      factor: row!.factor === "session" ? "session" : "code",
      accountId: row!.userId!,
    };
  return { ...proof, method: "email-one-time-code" };
}
export async function consumeSignerVerification(
  reader: VerificationDb,
  verificationId: string,
) {
  const [used] = await reader
    .update(signerVerifications)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(signerVerifications.id, verificationId),
        eq(signerVerifications.purpose, "sign"),
        isNull(signerVerifications.consumedAt),
        sql`${signerVerifications.verifiedAt} IS NOT NULL AND ${signerVerifications.expiresAt} > now()`,
      ),
    )
    .returning({ id: signerVerifications.id });
  if (!used)
    fail(403, "Verify the invited email address again before signing.");
}
