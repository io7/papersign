import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { emailHtml } from "../server/email-design.js";
import { decodeTestMessage } from "../scripts/mail-mime.js";

describe("Email presentation", () => {
  it("escapes names, document titles, preview text and link attributes", () => {
    const url =
      'https://papersign.example.invalid/sign/fixture?token=a&next="unsafe"';
    const html = emailHtml(
      `Hello <img src=x onerror=alert(1)>,\n\nOpen your link:\n${url}\n\nPaperSign`,
      {
        heading: '<script>alert("title")</script>',
        preview: '<img src="https://tracker.invalid">',
        action: { label: "<b>Review</b>", url },
      },
    );
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;Review&lt;/b&gt;");
    expect(html).toContain(
      'href="https://papersign.example.invalid/sign/fixture?token=a&amp;next=&quot;unsafe&quot;"',
    );
    expect(html).not.toContain("<link");
  });

  it("rejects non-web action links", () => {
    expect(() =>
      emailHtml("Untrusted link", {
        heading: "Review",
        preview: "Review",
        action: { label: "Review", url: "javascript:alert(1)" },
      }),
    ).toThrow("HTTP or HTTPS");
  });

  it("retains expiry and security instructions alongside a readable verification code", () => {
    const html = emailHtml(
      "Your PaperSign verification code is: 123456\n\nIt expires in 10 minutes.\n\nDo not share this code.\n\nPaperSign",
      {
        heading: "Your verification code",
        preview: "Expires in 10 minutes",
        code: "123456",
      },
    );
    expect(html).toContain(">123456</p>");
    expect(html).toContain("It expires in 10 minutes.");
    expect(html).toContain("Do not share this code.");
    expect(html).not.toContain("href=");
  });

  it("keeps the original text and matching action links in a real multipart message", async () => {
    const url =
      "https://papersign.example.invalid/verify?token=synthetic&callback=%2Faccount";
    const text = `Confirm your email within one hour:\n${url}\n\nIf you did not request this, ignore this email.\n\nPaperSign`;
    const html = emailHtml(text, {
      heading: "Verify your email address",
      preview: "Expires in one hour",
      action: { label: "Verify email address", url },
    });
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    });
    const result = await transport.sendMail({
      from: "PaperSign <noreply@example.invalid>",
      to: "fixture@example.invalid",
      subject: "Verify your PaperSign email address",
      text,
      html,
    });
    const decoded = decodeTestMessage(result.message.toString());
    expect(decoded.subject).toBe("Verify your PaperSign email address");
    expect(decoded.text.trim().replace(/\r\n/g, "\n")).toBe(text);
    expect(decoded.html?.trim().replace(/\r\n/g, "\n")).toBe(html);
    expect(decoded.text).not.toContain("<!doctype");
    expect(decoded.html).toContain("Verify email address</a>");
  });
});
