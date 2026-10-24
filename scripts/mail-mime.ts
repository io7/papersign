// Decode the text and HTML alternatives emitted by Nodemailer for the local
// synthetic mailbox. This is not an SMTP relay or a production MIME parser.
export function decodeTestMessage(raw: string): {
  subject: string;
  text: string;
  html?: string;
} {
  const split = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const body = raw.slice(split + 4);
  const subject = headers.match(/^Subject:\s*(.*)$/im)?.[1] ?? "";
  const boundary = headers.match(/boundary="([^"]+)"/i)?.[1];
  if (/^Content-Type:\s*multipart\//im.test(headers) && boundary) {
    const alternatives = body
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((part) => decodeTestMessage(part.replace(/^\r\n/, "")));
    return {
      subject,
      text: alternatives.map((part) => part.text).join(""),
      html: alternatives.map((part) => part.html ?? "").join("") || undefined,
    };
  }
  let decoded = body;
  if (/^Content-Transfer-Encoding:\s*base64/im.test(headers))
    decoded = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  else if (/^Content-Transfer-Encoding:\s*quoted-printable/im.test(headers)) {
    const bytes: number[] = [];
    for (const part of body
      .replace(/=\r\n/g, "")
      .match(/=[a-f0-9]{2}|[\s\S]/gi) ?? [])
      bytes.push(
        part.length === 3 && part.startsWith("=")
          ? parseInt(part.slice(1), 16)
          : part.charCodeAt(0),
      );
    decoded = Buffer.from(bytes).toString("utf8");
  }
  return /^Content-Type:\s*text\/html/im.test(headers)
    ? { subject, text: "", html: decoded }
    : { subject, text: decoded };
}
