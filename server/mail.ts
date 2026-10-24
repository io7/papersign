import nodemailer from "nodemailer";
import { config } from "./config.js";

export type SecurityMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};
export const mailConfigured = () =>
  Boolean(config.SMTP_HOST && config.SMTP_FROM);

/** Only callers choose recipients. SMTP details and message bodies never enter logs. */
export async function sendSecurityMail(message: SecurityMail): Promise<void> {
  if (!mailConfigured())
    throw new Error(
      "Email delivery is not configured. Contact the administrator.",
    );
  const local = ["localhost", "127.0.0.1", "::1"].includes(config.SMTP_HOST!);
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
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
      from: config.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    if (result.rejected?.length || !result.accepted?.length)
      throw new Error("Message was not accepted.");
  } catch {
    throw new Error("Email delivery failed. Please try again later.");
  } finally {
    transport.close();
  }
}
