import nodemailer from "nodemailer";
import { config } from "./config.js";
import { reportError } from "./alerts.js";

export type SecurityMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** What kind of email this is, for error alerts ("Verification code", …). */
  label?: string;
};

const POSTMARK_API = "https://api.postmarkapp.com/email";
const sender = () => config.MAIL_FROM ?? config.SMTP_FROM;
export const mailConfigured = () =>
  Boolean((config.SMTP_HOST || config.POSTMARK_SERVER_TOKEN) && sender());

/** What the mail service answered, without addresses, credentials or content. */
export type DeliveryFailure = {
  transport: "smtp" | "postmark";
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  httpStatus?: number;
  errorCode?: number;
};
class DeliveryError extends Error {
  constructor(readonly failure: DeliveryFailure) {
    super("Email delivery failed.");
  }
}
/**
 * What request handlers see when email cannot be sent: a 503 with a message
 * the person can act on. The failure itself was already reported, so the
 * server's error handler does not report it again as a failed request.
 */
const unavailable = (message: string) =>
  Object.assign(new Error(message), { statusCode: 503, publicError: true });

/**
 * The name PaperSign greets the SMTP server with. Without one, nodemailer uses
 * the machine's host name if it has a dot, otherwise "[127.0.0.1]", which
 * Google's SMTP relay mostly refuses with "421 4.7.0 Try again later".
 */
export function ehloName(): string | undefined {
  if (config.SMTP_EHLO_NAME) return config.SMTP_EHLO_NAME;
  const host = new URL(config.APP_URL).hostname;
  const ip = /^[\d.]+$/.test(host) || host.includes(":");
  return host.includes(".") && !ip ? host : undefined;
}

async function deliverSmtp(message: SecurityMail) {
  const local = ["localhost", "127.0.0.1", "::1"].includes(config.SMTP_HOST!);
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    name: ehloName(),
    secure: config.SMTP_SECURE === "true",
    // Only an explicit SMTP_REQUIRE_TLS=false allows plain remote SMTP.
    requireTLS:
      !local &&
      config.SMTP_SECURE !== "true" &&
      config.SMTP_REQUIRE_TLS !== "false",
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    auth: config.SMTP_USER
      ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
      : undefined,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({
      from: sender(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    if (result.rejected?.length || !result.accepted?.length)
      throw new DeliveryError({
        transport: "smtp",
        code: "REJECTED",
        response: "The server did not accept the recipient.",
      });
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    const e = error as {
      code?: string;
      command?: string;
      responseCode?: number;
      response?: string;
      message?: string;
    };
    throw new DeliveryError({
      transport: "smtp",
      code: e.code,
      command: e.command,
      responseCode: e.responseCode,
      response: e.response ?? e.message,
    });
  } finally {
    transport.close();
  }
}

// Postmark's HTTP API validates each message before answering, so a refusal
// (monthly limit, inactive recipient, unknown sender) fails here. Its SMTP
// endpoint accepts first and drops later, which looks like success.
async function deliverPostmark(message: SecurityMail) {
  let response: Response;
  try {
    response = await fetch(POSTMARK_API, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": config.POSTMARK_SERVER_TOKEN!,
      },
      body: JSON.stringify({
        From: sender(),
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        MessageStream: config.POSTMARK_MESSAGE_STREAM,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    throw new DeliveryError({
      transport: "postmark",
      code: (error as { name?: string }).name ?? "FETCH_FAILED",
      response: (error as Error).message,
    });
  }
  const body = (await response.json().catch(() => ({}))) as {
    ErrorCode?: number;
    Message?: string;
    MessageID?: string;
  };
  if (!response.ok || body.ErrorCode !== 0 || !body.MessageID)
    throw new DeliveryError({
      transport: "postmark",
      httpStatus: response.status,
      errorCode: body.ErrorCode,
      response: body.Message,
    });
}

function deliver(message: SecurityMail) {
  return config.POSTMARK_SERVER_TOKEN
    ? deliverPostmark(message)
    : deliverSmtp(message);
}

const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).replace(/>$/, "");

/** Only callers choose recipients. SMTP details and message bodies never enter logs. */
export async function sendSecurityMail(message: SecurityMail): Promise<void> {
  if (!mailConfigured())
    throw unavailable(
      "Email delivery is not configured. Contact the administrator.",
    );
  try {
    await deliver(message);
  } catch (error) {
    const failure =
      error instanceof DeliveryError
        ? error.failure
        : { transport: "smtp" as const, response: (error as Error)?.message };
    void reportError(
      "email_failed",
      `${message.label ?? "Email"} could not be sent`,
      { ...failure, recipientDomain: domainOf(message.to) },
    );
    throw unavailable("Email delivery failed. Please try again later.");
  }
}

/** Sends an operator alert. Its failures are not reported again, which would loop. */
export async function sendAlertMail(message: SecurityMail): Promise<void> {
  if (!mailConfigured()) throw new Error("Email delivery is not configured.");
  try {
    await deliver(message);
  } catch (error) {
    const failure = error instanceof DeliveryError ? error.failure : undefined;
    throw new Error(
      `Alert email failed${failure ? `: ${JSON.stringify(failure)}` : ""}`,
    );
  }
}
