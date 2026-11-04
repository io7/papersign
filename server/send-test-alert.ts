// Sends one test alert to ERROR_ALERT_EMAIL through the configured email
// delivery (SMTP or Postmark's API), so an operator can confirm alerts arrive:
//   node dist-server/server/send-test-alert.js
import { hostname } from "node:os";
import { config } from "./config.js";
import { sendAlertMail } from "./mail.js";

if (!config.ERROR_ALERT_EMAIL) {
  console.error("ERROR_ALERT_EMAIL is not set, so PaperSign sends no error alerts.");
  process.exit(2);
}
const host = new URL(config.APP_URL).host;
try {
  await sendAlertMail({
    to: config.ERROR_ALERT_EMAIL,
    subject: `[PaperSign] Test alert from ${host}`,
    text: [
      `This is a test of PaperSign's error alerts on ${host}.`,
      "",
      `Sent ${new Date().toISOString()} from ${hostname()} via ${config.POSTMARK_SERVER_TOKEN ? "Postmark's API" : `SMTP (${config.SMTP_HOST})`}.`,
      "No action needed.",
    ].join("\n"),
  });
  console.log(`Test alert accepted for ${config.ERROR_ALERT_EMAIL}.`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
