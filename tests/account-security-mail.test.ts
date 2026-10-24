import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  config: {
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 587,
    SMTP_USER: "fixture",
    SMTP_PASSWORD: "private",
    SMTP_FROM: "PaperSign <noreply@example.test>",
    SMTP_SECURE: "false",
    SMTP_REQUIRE_TLS: undefined as string | undefined,
  },
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock("../server/config.js", () => ({ config: fixture.config }));
vi.mock("nodemailer", () => ({
  default: { createTransport: fixture.createTransport },
}));
import { mailConfigured, sendSecurityMail } from "../server/mail.js";
beforeEach(() => {
  fixture.config.SMTP_HOST = "smtp.example.test";
  fixture.config.SMTP_FROM = "PaperSign <noreply@example.test>";
  fixture.config.SMTP_REQUIRE_TLS = undefined;
  fixture.sendMail
    .mockReset()
    .mockResolvedValue({ accepted: ["recipient@example.test"], rejected: [] });
  fixture.close.mockReset();
  fixture.createTransport
    .mockReset()
    .mockReturnValue({ sendMail: fixture.sendMail, close: fixture.close });
});
describe("Security mail delivery", () => {
  it("requires encrypted remote SMTP, bounds timeouts and disables resource loading", async () => {
    await sendSecurityMail({
      to: "recipient@example.test",
      subject: "Verify",
      text: "Private test token",
    });
    expect(fixture.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      }),
    );
    expect(fixture.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recipient@example.test",
        text: "Private test token",
      }),
    );
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("allows plain SMTP only when SMTP_REQUIRE_TLS is explicitly false", async () => {
    for (const [setting, required] of [
      ["true", true],
      ["false", false],
    ] as const) {
      fixture.config.SMTP_REQUIRE_TLS = setting;
      fixture.createTransport.mockClear();
      await sendSecurityMail({
        to: "recipient@example.test",
        subject: "Verify",
        text: "Private test token",
      });
      expect(fixture.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ requireTLS: required }),
      );
    }
  });
  it("fails without creating a transport when email is unconfigured", async () => {
    fixture.config.SMTP_FROM = "";
    expect(mailConfigured()).toBe(false);
    await expect(
      sendSecurityMail({
        to: "recipient@example.test",
        subject: "Verify",
        text: "token",
      }),
    ).rejects.toThrow("not configured");
    expect(fixture.createTransport).not.toHaveBeenCalled();
  });
  it("does not leak rejected recipients, SMTP credentials or tokens in errors", async () => {
    fixture.sendMail.mockRejectedValue(
      new Error("SMTP rejected private:token for recipient@example.test"),
    );
    await expect(
      sendSecurityMail({
        to: "recipient@example.test",
        subject: "Verify",
        text: "secret",
      }),
    ).rejects.toThrow(/^Email delivery failed\. Please try again later\.$/);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("treats a rejected message as failed delivery", async () => {
    fixture.sendMail.mockResolvedValue({
      accepted: [],
      rejected: ["recipient@example.test"],
    });
    await expect(
      sendSecurityMail({
        to: "recipient@example.test",
        subject: "Verify",
        text: "secret",
      }),
    ).rejects.toThrow("Email delivery failed");
  });
});
