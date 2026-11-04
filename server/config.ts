import { resolve } from "node:path";
import { z } from "zod";
try {
  process.loadEnvFile();
} catch {
  /* environment variables are also supported */
}
const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    APP_URL: z.string().url().default("http://localhost:5176"),
    PORT: z.coerce.number().default(3176),
    HOST: z.string().default("127.0.0.1"),
    TRUSTED_PROXY: z.string().optional(),
    DATA_DIR: z.string().default(".local/data"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    SMTP_SECURE: z.string().default("false"),
    // Plain SMTP is accepted only for a trusted relay on the same private
    // network (for example a mail container in the same compose project).
    SMTP_REQUIRE_TLS: z.enum(["true", "false"]).default("true"),
    // Postmark's HTTP API instead of SMTP. It answers each send at once, so a
    // refused email (sending limit, inactive recipient) shows as failed.
    POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    POSTMARK_MESSAGE_STREAM: z.string().min(1).default("outbound"),
    // Sender for all email, whichever way it is sent. SMTP_FROM still works.
    MAIL_FROM: z.string().min(1).optional(),
    // Optional: email every server error to this address (throttled; no
    // signing links, tokens or document content).
    ERROR_ALERT_EMAIL: z.string().email().optional(),
    REGISTRATION_ENABLED: z.string().default("true"),
    // Who runs this installation, shown on the privacy page.
    OPERATOR_NAME: z.string().trim().min(1).max(200).optional(),
    ACCOUNT_STORAGE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(25 * 1024 * 1024)
      .default(500 * 1024 * 1024),
    MAX_ACTIVE_EXPORTS: z.coerce.number().int().min(1).max(20).default(3),
    DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    DELETION_APPROVAL_REQUIRED: z.enum(["true", "false"]).default("false"),
    BACKUP_FILE: z.string().default("/var/lib/postgresql/papersign.dump"),
    ALERT_WEBHOOK_URL: z.string().url().optional(),
    EVIDENCE_TIMESTAMP_POLICY: z.string().startsWith("/").optional(),
    SEAL_SOCKET: z.string().startsWith("/").optional(),
    SEAL_POLICY_ID: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (value) => Boolean(value.SEAL_SOCKET) === Boolean(value.SEAL_POLICY_ID),
    {
      message: "SEAL_SOCKET and SEAL_POLICY_ID must be configured together.",
    },
  )
  .refine((value) => !(value.SMTP_HOST && value.POSTMARK_SERVER_TOKEN), {
    message: "Set either SMTP_HOST or POSTMARK_SERVER_TOKEN, not both.",
  })
  .refine(
    (value) =>
      !value.ERROR_ALERT_EMAIL ||
      Boolean(
        (value.SMTP_HOST || value.POSTMARK_SERVER_TOKEN) &&
        (value.MAIL_FROM || value.SMTP_FROM),
      ),
    {
      message:
        "ERROR_ALERT_EMAIL needs email delivery: SMTP_HOST or POSTMARK_SERVER_TOKEN, and MAIL_FROM.",
    },
  )
  // An empty value means "not set", as Docker Compose passes unset optional
  // variables as empty strings.
  .parse(
    Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== ""),
    ),
  );
export const config = {
  ...env,
  DATA_DIR: resolve(env.DATA_DIR),
  APP_URL: new URL(env.APP_URL).origin,
  /** The sender for all email: MAIL_FROM, or SMTP_FROM from older setups. */
  MAIL_FROM: env.MAIL_FROM ?? env.SMTP_FROM,
};
export const emailEnabled = Boolean(
  (config.SMTP_HOST || config.POSTMARK_SERVER_TOKEN) && config.MAIL_FROM,
);
