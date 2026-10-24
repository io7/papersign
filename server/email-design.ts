export type EmailDesign = {
  heading: string;
  preview: string;
  action?: { label: string; url: string };
  code?: string;
};

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

/** Render the existing plain-text message without accepting caller-provided HTML.
 * No remote fonts, images, tracking or third-party resources are loaded. */
export function emailHtml(text: string, design: EmailDesign): string {
  const action = design.action;
  if (action && !/^https?:\/\//i.test(action.url))
    throw new Error("Email actions must use an HTTP or HTTPS link.");
  const paragraphs = text.trim().split(/\n\n+/);
  if (paragraphs.at(-1) === "PaperSign") paragraphs.pop();
  const paragraph = (value: string) =>
    `<p style="margin:0 0 20px;font-size:16px;line-height:26px;overflow-wrap:anywhere;word-break:break-word">${escape(value).replace(/\n/g, "<br>")}</p>`;
  const body = paragraphs
    .map((value) => {
      if (action && value.includes(action.url)) {
        const [before, after] = value.split(action.url);
        return `${before.trim() ? paragraph(before.trim()) : ""}
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 24px"><tr><td bgcolor="#163f38" style="border-radius:8px;text-align:center;mso-padding-alt:14px 24px">
          <a href="${escape(action.url)}" target="_blank" style="display:inline-block;border:1px solid #163f38;border-radius:8px;padding:14px 24px;font-size:16px;font-weight:700;line-height:22px;color:#ffffff;text-decoration:none">${escape(action.label)}</a>
        </td></tr></table>${after?.trim() ? paragraph(after.trim()) : ""}`;
      }
      if (design.code && value.includes(design.code)) {
        const [before, after] = value.split(design.code);
        return `${before.trim() ? paragraph(before.trim()) : ""}
        <p style="margin:0 0 24px;padding:20px 12px;border:1px solid #dce3dc;border-radius:8px;background:#edf3ed;text-align:center;font-family:Consolas,monospace;font-size:32px;font-weight:700;line-height:40px;letter-spacing:6px;color:#163f38">${escape(design.code)}</p>
        ${after?.trim() ? paragraph(after.trim()) : ""}`;
      }
      return paragraph(value);
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(design.heading)}</title>
<style>@media only screen and (max-width:600px){.email-outer{padding:20px 12px!important}.email-content{padding:28px 24px 12px!important}.email-brand{padding:22px 24px!important}.email-heading{font-size:26px!important;line-height:32px!important}}</style></head>
<body style="margin:0;padding:0;background:#f4f6f3;color:#243b32;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escape(design.preview)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f6f3"><tr><td class="email-outer" align="center" style="padding:40px 20px">
    <!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;table-layout:fixed;background:#ffffff;border:1px solid #dce3dc;border-radius:12px;overflow:hidden">
      <tr><td class="email-brand" bgcolor="#163f38" style="padding:26px 36px;border-radius:11px 11px 0 0;color:#ffffff;font-size:25px;font-weight:700;letter-spacing:-0.5px">PaperSign<span style="color:#a9cdb1">.</span></td></tr>
      <tr><td class="email-content" style="padding:36px 36px 16px">
        <h1 class="email-heading" style="margin:0 0 24px;font-size:28px;line-height:35px;font-weight:700;letter-spacing:-0.5px;color:#163f38;overflow-wrap:anywhere">${escape(design.heading)}</h1>
        ${body}
        ${action ? `<div style="border-top:1px solid #dce3dc;margin:8px 0 20px;padding-top:20px"><p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#586a60">If the button doesn’t work, copy this link into your browser:</p><p style="margin:0;font-size:12px;line-height:20px;word-break:break-all;overflow-wrap:anywhere"><a href="${escape(action.url)}" target="_blank" style="color:#163f38;text-decoration:underline;word-break:break-all">${escape(action.url)}</a></p></div>` : ""}
      </td></tr>
      <tr><td style="padding:20px 24px;border-top:1px solid #dce3dc;text-align:center;font-size:12px;line-height:20px;color:#586a60">PaperSign</td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr></table>
</body></html>`;
}
