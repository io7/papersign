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

export function pendingSigners(document, emails = []) {
  const wanted = emails.map((email) => email.toLowerCase());
  return (document.invitations ?? []).filter(
    (invitation) =>
      ["ready", "waiting"].includes(invitation.signingStatus) &&
      (!wanted.length || wanted.includes(invitation.email.toLowerCase())),
  );
}
