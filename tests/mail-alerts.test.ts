import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  config: {
    APP_URL: "https://papersign.example.test",
    SMTP_HOST: "smtp.example.test" as string | undefined,
    SMTP_PORT: 587,
    SMTP_USER: "fixture",
    SMTP_PASSWORD: "private",
    SMTP_FROM: undefined as string | undefined,
    MAIL_FROM: "PaperSign <noreply@example.test>" as string | undefined,
    SMTP_SECURE: "false",
    SMTP_REQUIRE_TLS: undefined as string | undefined,
    SMTP_EHLO_NAME: undefined as string | undefined,
    POSTMARK_SERVER_TOKEN: undefined as string | undefined,
    POSTMARK_MESSAGE_STREAM: "outbound",
    ERROR_ALERT_EMAIL: undefined as string | undefined,
  },
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock("../server/config.js", () => ({ config: fixture.config }));
vi.mock("nodemailer", () => ({
  default: { createTransport: fixture.createTransport },
}));
import { sendSecurityMail } from "../server/mail.js";
import { reportError, resetAlertsForTests } from "../server/alerts.js";

const recipient = "recipient@example.test";
const logged = () =>
  vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");

beforeEach(() => {
  Object.assign(fixture.config, {
    APP_URL: "https://papersign.example.test",
    SMTP_EHLO_NAME: undefined,
    SMTP_HOST: "smtp.example.test",
    MAIL_FROM: "PaperSign <noreply@example.test>",
    POSTMARK_SERVER_TOKEN: undefined,
    ERROR_ALERT_EMAIL: undefined,
  });
  fixture.sendMail
    .mockReset()
    .mockResolvedValue({ accepted: [recipient], rejected: [] });
  fixture.close.mockReset();
  fixture.createTransport
    .mockReset()
    .mockReturnValue({ sendMail: fixture.sendMail, close: fixture.close });
  resetAlertsForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Postmark API delivery", () => {
  beforeEach(() => {
    fixture.config.SMTP_HOST = undefined;
    fixture.config.POSTMARK_SERVER_TOKEN = "server-token";
  });
  it("posts the message to Postmark's email API instead of using SMTP", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ErrorCode: 0, MessageID: "m-1" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await sendSecurityMail({ to: recipient, subject: "Hello", text: "Body" });
    expect(fixture.createTransport).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.headers["X-Postmark-Server-Token"]).toBe("server-token");
    expect(JSON.parse(init.body)).toEqual({
      From: "PaperSign <noreply@example.test>",
      To: recipient,
      Subject: "Hello",
      TextBody: "Body",
      MessageStream: "outbound",
    });
  });
  it("fails at once when Postmark refuses, and logs Postmark's answer without the address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ErrorCode: 406, Message: "Inactive recipient." }),
          { status: 422 },
        ),
      ),
    );
    await expect(
      sendSecurityMail({
        to: recipient,
        subject: "Code",
        text: "123456",
        label: "Verification code email",
      }),
    ).rejects.toThrow("Email delivery failed. Please try again later.");
    const log = logged();
    expect(log).toContain('"alert":"email_failed"');
    expect(log).toContain('"errorCode":406');
    expect(log).toContain('"httpStatus":422');
    expect(log).toContain('"recipientDomain":"example.test"');
    expect(log).not.toContain(recipient);
    expect(log).not.toContain("123456");
  });
});

describe("SMTP greeting name", () => {
  const greeting = () => fixture.createTransport.mock.calls[0][0].name;
  const send = () =>
    sendSecurityMail({ to: recipient, subject: "Hello", text: "Body" });
  it("greets the server with the domain in APP_URL, not [127.0.0.1]", async () => {
    await send();
    expect(greeting()).toBe("papersign.example.test");
  });
  it("uses SMTP_EHLO_NAME when it is set", async () => {
    fixture.config.SMTP_EHLO_NAME = "mail.example.test";
    await send();
    expect(greeting()).toBe("mail.example.test");
  });
  it.each([
    "http://localhost:5176",
    "http://127.0.0.1:3176",
    "http://[::1]:3176",
  ])("leaves the choice to nodemailer when APP_URL is %s", async (url) => {
    fixture.config.APP_URL = url;
    await send();
    expect(greeting()).toBeUndefined();
  });
});

describe("SMTP failure details", () => {
  it("answers requests with a 503 and a message the person can act on", async () => {
    fixture.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("Try again later"), {
        code: "ECONNECTION",
        command: "EHLO",
        responseCode: 421,
      }),
    );
    await expect(send()).rejects.toMatchObject({
      statusCode: 503,
      publicError: true,
      message: "Email delivery failed. Please try again later.",
    });
    function send() {
      return sendSecurityMail({ to: recipient, subject: "Hi", text: "Body" });
    }
  });
  const authError = Object.assign(new Error("Invalid login"), {
    code: "EAUTH",
    command: "AUTH PLAIN",
    responseCode: 535,
    response: "535-5.7.8 Username and Password not accepted",
  });
  it("logs the server's code and answer, and emails nothing when alerts are off", async () => {
    fixture.sendMail.mockRejectedValueOnce(authError);
    await expect(
      sendSecurityMail({ to: recipient, subject: "Code", text: "123456" }),
    ).rejects.toThrow("Email delivery failed");
    const log = logged();
    expect(log).toContain('"code":"EAUTH"');
    expect(log).toContain('"responseCode":535');
    expect(log).toContain('"command":"AUTH PLAIN"');
    expect(fixture.sendMail).toHaveBeenCalledOnce();
  });
  it("emails the operator when ERROR_ALERT_EMAIL is set", async () => {
    fixture.config.ERROR_ALERT_EMAIL = "ops@example.test";
    fixture.sendMail.mockRejectedValueOnce(authError);
    await expect(
      sendSecurityMail({
        to: recipient,
        subject: "Code",
        text: "123456",
        label: "Verification code email",
      }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.sendMail).toHaveBeenCalledTimes(2));
    const alert = fixture.sendMail.mock.calls[1][0];
    expect(alert.to).toBe("ops@example.test");
    expect(alert.subject).toBe(
      "[PaperSign] Verification code email could not be sent",
    );
    expect(alert.text).toContain("responseCode: 535");
    expect(alert.text).toContain("recipientDomain: example.test");
    expect(alert.text).not.toContain(recipient);
    expect(alert.text).not.toContain("123456");
  });
  it("does not report a failed alert email as another alert", async () => {
    fixture.config.ERROR_ALERT_EMAIL = "ops@example.test";
    fixture.sendMail.mockRejectedValue(authError);
    await expect(
      sendSecurityMail({ to: recipient, subject: "Code", text: "1" }),
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(logged()).toContain('"alert":"alert_email_failed"'),
    );
    expect(fixture.sendMail).toHaveBeenCalledTimes(2);
  });
});

describe("Alert throttling and scrubbing", () => {
  beforeEach(() => {
    fixture.config.ERROR_ALERT_EMAIL = "ops@example.test";
  });
  it("emails the first error of a kind at once and sums up the rest after 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    await reportError("export_failed", "A PDF export failed", { error: "one" });
    await reportError("export_failed", "A PDF export failed", { error: "two" });
    await reportError("export_failed", "A PDF export failed", {
      error: "three",
    });
    expect(fixture.sendMail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fixture.sendMail).toHaveBeenCalledTimes(2);
    const summary = fixture.sendMail.mock.calls[1][0].text;
    expect(summary).toContain("This happened 2 times");
    expect(summary).toContain("error: three");
  });
  it("throttles each kind on its own", async () => {
    await reportError("export_failed", "A PDF export failed");
    await reportError("queue_failed", "The queue failed");
    expect(fixture.sendMail).toHaveBeenCalledTimes(2);
  });
  it("removes signing-link tokens and API keys from logs and emails", async () => {
    const token = "A".repeat(43);
    await reportError("request_failed", `GET /api/sign/${token}/record failed`, {
      key: "psk_abcdefghijklmnop",
    });
    const text = fixture.sendMail.mock.calls[0][0].text + logged();
    expect(text).not.toContain(token);
    expect(text).not.toContain("psk_abcdefghijklmnop");
    expect(text).toContain("/api/sign/[redacted]/record");
  });
});
