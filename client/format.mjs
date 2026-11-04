// Plain-text summaries shared by the command line and the MCP server.

export function reportLines(plan) {
  return plan.report.map((item) => {
    const where = `page ${item.page}, ${item.position} “${item.matched}”`;
    const many = item.matches > 1 ? ` (${item.matches} matches)` : "";
    const box = `${item.box.width}×${item.box.height} pt at ${item.box.left},${item.box.top}`;
    const warning = item.warning ? `; ${item.warning}` : "";
    return `${item.what}: ${where}${many}; ${box}${warning}`;
  });
}

export function signerLine(invitation) {
  const when = invitation.signedAt
    ? `signed ${invitation.signedAt.slice(0, 16).replace("T", " ")}`
    : `expires ${invitation.expiresAt.slice(0, 10)}`;
  return `${invitation.signingOrder}. ${invitation.name} <${invitation.email}>: ${invitation.signingStatus}, ${when}`;
}

/** What happened to the invitation emails when the signing links were created. */
export function emailLines(links, sendEmail) {
  if (!sendEmail) return ["No email was sent."];
  // Servers before 0.7.6 ignore the request and report nothing.
  if (links.every((link) => link.invitationEmail === undefined))
    return ["This PaperSign server cannot email on create. No email was sent."];
  const lines = links.flatMap((link) => {
    const who = `${link.name} <${link.email}>`;
    if (link.invitationEmail === "sent") return [`Emailed ${who}.`];
    if (link.invitationEmail === "failed")
      return [`Could not email ${who}. The link works; send the email again.`];
    return [];
  });
  if (!lines.length)
    lines.push("No one was emailed now: the first turn is yours.");
  if (links.length > 1)
    lines.push("PaperSign emails each later signer when their turn opens.");
  return lines;
}

export function pendingSigners(document, emails = []) {
  const wanted = emails.map((email) => email.toLowerCase());
  return (document.invitations ?? []).filter(
    (invitation) =>
      ["ready", "waiting"].includes(invitation.signingStatus) &&
      (!wanted.length || wanted.includes(invitation.email.toLowerCase())),
  );
}
