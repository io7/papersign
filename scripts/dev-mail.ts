import { createServer as createSmtpServer, type Socket } from "node:net";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { decodeTestMessage } from "./mail-mime.js";

// Development-only mailbox: no SMTP relay, no DNS and no outbound connection.
// Bind both listeners to loopback and reject every non-synthetic recipient.
const synthetic = /^[^\s<>@]+@example\.(invalid|test)$/i;
const messages: {
  id: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
}[] = [];
const sockets = new Set<Socket>();
const smtp = createSmtpServer((socket) => {
  sockets.add(socket);
  socket.setTimeout(15_000, () => socket.destroy());
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.write("220 PaperSign local test mailbox\r\n");
  let buffer = "",
    recipient = "",
    data = false,
    content = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length + content.length > 1_048_576) {
      socket.end("552 Message too large\r\n");
      return;
    }
    while (buffer.includes("\r\n")) {
      const index = buffer.indexOf("\r\n"),
        line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data) {
        if (line === ".") {
          messages.push({
            id: randomUUID(),
            to: recipient,
            ...decodeTestMessage(content),
            receivedAt: new Date().toISOString(),
          });
          recipient = "";
          content = "";
          data = false;
          socket.write("250 Captured locally; never relayed\r\n");
        } else content += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
      } else if (/^EHLO\b/i.test(line))
        socket.write("250-localhost\r\n250 SIZE 1048576\r\n");
      else if (/^HELO\b/i.test(line)) socket.write("250 localhost\r\n");
      else if (/^MAIL FROM:/i.test(line)) {
        recipient = "";
        content = "";
        socket.write("250 OK\r\n");
      } else if (/^RCPT TO:/i.test(line)) {
        const address =
          line.match(/^RCPT TO:\s*<([^>]+)>/i)?.[1]?.toLowerCase() ?? "";
        if (!synthetic.test(address) || messages.length >= 5000)
          socket.write("550 Only synthetic test recipients are accepted\r\n");
        else {
          recipient = address;
          socket.write("250 OK\r\n");
        }
      } else if (/^DATA$/i.test(line)) {
        if (!recipient)
          socket.write("503 Supply a synthetic recipient first\r\n");
        else {
          data = true;
          socket.write("354 End with a dot on its own line\r\n");
        }
      } else if (/^RSET$/i.test(line)) {
        recipient = "";
        content = "";
        data = false;
        socket.write("250 OK\r\n");
      } else if (/^QUIT$/i.test(line)) {
        socket.end("221 Goodbye\r\n");
        return;
      } else if (/^NOOP$/i.test(line)) socket.write("250 OK\r\n");
      else socket.write("502 Unsupported by the local test mailbox\r\n");
    }
  });
});
const inbox = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("{}");
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1:3186");
  if (url.pathname === "/health") {
    res.end(
      JSON.stringify({
        service: "papersign-local-test-mail",
        relay: false,
        syntheticRecipientsOnly: true,
      }),
    );
    return;
  }
  if (url.pathname === "/messages") {
    const to = url.searchParams.get("to")?.toLowerCase() ?? "";
    if (!synthetic.test(to)) {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    res.end(JSON.stringify(messages.filter((message) => message.to === to)));
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
smtp.listen(2526, "127.0.0.1");
inbox.listen(3186, "127.0.0.1", () =>
  console.log(
    "PaperSign local-only mail sink: SMTP 127.0.0.1:2526; inbox 127.0.0.1:3186. No real email delivery.",
  ),
);
for (const server of [smtp, inbox])
  server.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const socket of sockets) socket.destroy();
    smtp.close();
    inbox.close();
    process.exit(0);
  });
