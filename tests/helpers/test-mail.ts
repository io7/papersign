export type TestMail = {
  id: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
};
const sink = "http://127.0.0.1:3186";
export async function assertTestMail(base: string) {
  const url = new URL(base);
  if (url.hostname !== "127.0.0.1" || url.port !== "3176")
    throw new Error("Test email can only use local PaperSign:3176.");
  const config = await (await fetch(`${base}/api/config`)).json();
  if (!config.emailEnabled) return;
  if (!config.emailTestSink)
    throw new Error(
      "Email is enabled without the synthetic-only SMTP test sink.",
    );
  const status = await (await fetch(`${sink}/health`)).json();
  if (
    status.service !== "papersign-local-test-mail" ||
    status.relay !== false ||
    status.syntheticRecipientsOnly !== true
  )
    throw new Error(
      "The local mailbox does not guarantee synthetic-only delivery.",
    );
}
export async function latestTestMail(
  to: string,
  subject = "",
  after = 0,
): Promise<TestMail | undefined> {
  if (!/@example\.(invalid|test)$/i.test(to))
    throw new Error("Only synthetic test mailboxes may be read.");
  const messages = (await (
    await fetch(`${sink}/messages?to=${encodeURIComponent(to)}`, {
      signal: AbortSignal.timeout(2000),
    })
  ).json()) as TestMail[];
  return messages.findLast(
    (message) =>
      message.subject.includes(subject) &&
      Date.parse(message.receivedAt) >= after,
  );
}
export async function waitForTestMail(
  to: string,
  subject = "",
  after = 0,
): Promise<TestMail> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = await latestTestMail(to, subject, after);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(
    "Expected synthetic email was not captured by the local-only mailbox.",
  );
}
