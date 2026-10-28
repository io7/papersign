// PaperSign MCP tools. A request can only be created from a plan made in the
// same session, so what is sent is exactly what was previewed.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createClient, loadKey, serverUrl } from "./api.mjs";
import { pendingSigners, reportLines, signerLine } from "./format.mjs";
import { planSpec } from "./plan.mjs";
import { previewBoxes, renderPreviews } from "./preview.mjs";

const position = z
  .enum(["above", "below", "right", "left", "over"])
  .describe("Where the box goes relative to the anchor text.");
const anchor = {
  anchor: z
    .string()
    .min(1)
    .describe("Text in the PDF to place the box against."),
  near: z
    .string()
    .optional()
    .describe(
      "Use the anchor match closest to this other text (for repeated labels).",
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Which match, in reading order (default 1)."),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Only search this page (1-based)."),
  position: position.optional(),
  width: z.number().positive().optional().describe("Width in points."),
  height: z.number().positive().optional().describe("Height in points."),
  dx: z.number().optional().describe("Horizontal offset in points."),
  dy: z
    .number()
    .optional()
    .describe("Vertical offset in points (down is positive)."),
};
const specSchema = {
  pdf: z.string().describe("Absolute path to the PDF on this machine."),
  name: z
    .string()
    .max(160)
    .optional()
    .describe("Document name in PaperSign (default: file name)."),
  signers: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        email: z.string().email().max(254),
        signature: z
          .object(anchor)
          .describe("Signature box; default 180×40 pt above the anchor."),
        text: z
          .array(
            z.object({
              ...anchor,
              label: z
                .string()
                .min(1)
                .max(80)
                .describe("What the signer fills in, e.g. “Place and date”."),
              fontSize: z.number().min(6).max(36).optional(),
            }),
          )
          .max(10)
          .optional()
          .describe(
            "Text the signer fills in; default 160 pt wide, right of the anchor.",
          ),
      }),
    )
    .min(1)
    .max(10)
    .describe("Signers in signing order."),
  ownerText: z
    .array(
      z.object({
        ...anchor,
        text: z.string().min(1).max(200),
        fontSize: z.number().min(6).max(36).optional(),
      }),
    )
    .optional()
    .describe("Fixed text printed on the document before it is sent."),
};
const documentId = z.string().uuid().describe("PaperSign document id.");

const text = (value) => ({ content: [{ type: "text", text: value }] });

export function createPaperSignServer({ baseUrl, key } = {}) {
  const server = new McpServer({ name: "papersign", version: "0.7.1" });
  const plans = new Map();
  let api;
  async function client() {
    api ??= createClient({
      baseUrl: baseUrl ?? serverUrl(),
      key: key ?? (await loadKey()),
    });
    return api;
  }

  server.registerTool(
    "papersign_plan",
    {
      title: "Plan signature and text fields",
      description:
        "Find anchor text in a local PDF, place each signer's signature and text fields, and return a preview image of every page with fields. Contacts nothing. Check the images, then pass plan_id to papersign_create.",
      inputSchema: specSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (spec) => {
      if (!isAbsolute(spec.pdf))
        throw new Error("pdf must be an absolute path.");
      const pdfBytes = await readFile(spec.pdf);
      const plan = await planSpec(spec, pdfBytes);
      const id = randomUUID();
      plans.set(id, { plan, pdfBytes, name: spec.name ?? basename(spec.pdf) });
      const images = await renderPreviews(pdfBytes, previewBoxes(plan));
      return {
        content: [
          {
            type: "text",
            text: [
              `plan_id: ${id}`,
              `Document: ${spec.name ?? basename(spec.pdf)}`,
              ...reportLines(plan),
            ].join("\n"),
          },
          ...images.flatMap((image) => [
            { type: "text", text: `Page ${image.pageIndex + 1}:` },
            {
              type: "image",
              data: image.png.toString("base64"),
              mimeType: "image/png",
            },
          ]),
        ],
      };
    },
  );

  server.registerTool(
    "papersign_create",
    {
      title: "Create a signing request",
      description:
        "Upload the planned PDF to PaperSign, add the owner's text, and create signing links for the signers in order. Sends no email. Returns the document id and each signer's private link.",
      inputSchema: {
        plan_id: z.string().uuid().describe("From papersign_plan."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ plan_id }) => {
      const planned = plans.get(plan_id);
      if (!planned)
        throw new Error("Unknown plan_id. Run papersign_plan first.");
      const papersign = await client();
      const uploaded = await papersign.upload(planned.pdfBytes, planned.name);
      let revision = uploaded.revision;
      if (planned.plan.ownerText.length)
        revision = (
          await papersign.setOwnerText(
            uploaded.id,
            revision,
            planned.plan.ownerText,
          )
        ).revision;
      const links = await papersign.invite(
        uploaded.id,
        revision,
        planned.plan.recipients,
      );
      plans.delete(plan_id);
      return text(
        [
          `Created signing request for ${planned.name}.`,
          `document_id: ${uploaded.id}`,
          ...links.map((link) => `${signerLine(link)}\n   ${link.url}`),
          "No email was sent.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "papersign_status",
    {
      title: "Signing status",
      description: "Show a document's status and each signer's progress.",
      inputSchema: {
        document_id: documentId,
        links: z
          .boolean()
          .optional()
          .describe("Include unfinished signers' private links."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ document_id, links }) => {
      const document = await (await client()).document(document_id);
      return text(
        [
          `${document.name}: ${document.status}`,
          ...(document.invitations ?? []).map((invitation) =>
            links && invitation.signingStatus !== "signed"
              ? `${signerLine(invitation)}\n   ${invitation.url}`
              : signerLine(invitation),
          ),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "papersign_list_documents",
    {
      title: "List documents",
      description: "List the key owner's PaperSign documents, newest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const documents = await (await client()).listDocuments();
      return text(
        documents.length
          ? documents
              .slice(0, 50)
              .map(
                (doc) =>
                  `${doc.id}  ${doc.status.padEnd(9)}  ${doc.updatedAt.slice(0, 10)}  ${doc.name}`,
              )
              .join("\n")
          : "No documents.",
      );
    },
  );

  server.registerTool(
    "papersign_preview_emails",
    {
      title: "Preview invitation emails",
      description:
        "Show the invitation emails PaperSign would send to pending signers. Sends nothing.",
      inputSchema: {
        document_id: documentId,
        signers: z
          .array(z.string().email())
          .optional()
          .describe("Limit to these signer emails."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ document_id, signers }) => {
      const papersign = await client();
      const document = await papersign.document(document_id);
      const pending = pendingSigners(document, signers);
      if (!pending.length) throw new Error("No pending signer matches.");
      const previews = [];
      for (const invitation of pending) {
        const preview = await papersign.emailPreview(
          document.id,
          invitation.id,
        );
        previews.push(
          `To: ${preview.to}\nSubject: ${preview.subject}\n\n${preview.body}`,
        );
      }
      return text(previews.join("\n\n---\n\n"));
    },
  );

  server.registerTool(
    "papersign_send_emails",
    {
      title: "Send invitation emails",
      description:
        "Send PaperSign's invitation email to pending signers. This emails real people: only call it after the user has approved sending for this document.",
      inputSchema: {
        document_id: documentId,
        signers: z
          .array(z.string().email())
          .optional()
          .describe(
            "Only these signer emails (default: every pending signer).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ document_id, signers }) => {
      const papersign = await client();
      const document = await papersign.document(document_id);
      const pending = pendingSigners(document, signers);
      if (!pending.length) throw new Error("No pending signer matches.");
      const sent = [];
      for (const invitation of pending) {
        const preview = await papersign.emailPreview(
          document.id,
          invitation.id,
        );
        await papersign.sendEmail(
          document.id,
          invitation.id,
          preview.previewHash,
        );
        sent.push(`Sent to ${preview.to}: ${preview.subject}`);
      }
      return text(sent.join("\n"));
    },
  );

  server.registerTool(
    "papersign_reissue",
    {
      title: "Reissue a signing link",
      description:
        "Replace an unfinished signer's link with a new seven-day link. The old link stops working.",
      inputSchema: { document_id: documentId, signer: z.string().email() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ document_id, signer }) => {
      const papersign = await client();
      const document = await papersign.document(document_id);
      const invitation = pendingSigners(document, [signer])[0];
      if (!invitation)
        throw new Error(`${signer} has no unfinished signing link.`);
      const result = await papersign.reissue(
        document.id,
        invitation.id,
        document.revision,
      );
      return text(
        `New link for ${invitation.name}, expires ${String(result.expiresAt).slice(0, 10)}:\n${result.url}`,
      );
    },
  );

  server.registerTool(
    "papersign_cancel",
    {
      title: "Cancel a signing request",
      description:
        "Cancel an unfinished signing request. Completed signatures are kept; remaining links stop working.",
      inputSchema: {
        document_id: documentId,
        reason: z.string().min(1).max(500),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ document_id, reason }) => {
      const papersign = await client();
      const document = await papersign.document(document_id);
      await papersign.cancel(document.id, document.revision, reason);
      return text(`Cancelled the signing request for ${document.name}.`);
    },
  );

  server.registerTool(
    "papersign_download",
    {
      title: "Download the completed record",
      description:
        "Save the completed, signed PDF (and optionally the evidence package) to local files.",
      inputSchema: {
        document_id: documentId,
        output_path: z.string().describe("Absolute path for the signed PDF."),
        evidence_path: z
          .string()
          .optional()
          .describe("Absolute path for the evidence .tar."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ document_id, output_path, evidence_path }) => {
      for (const path of [output_path, evidence_path].filter(Boolean))
        if (!isAbsolute(path))
          throw new Error("Output paths must be absolute.");
      const papersign = await client();
      const record = await papersign.record(document_id);
      if (record.state !== "ready")
        throw new Error(
          record.message ??
            `The completed record is ${record.state}, not ready yet.`,
        );
      await writeFile(output_path, await papersign.recordPdf(document_id));
      const saved = [`Saved ${output_path}`];
      if (evidence_path) {
        await writeFile(evidence_path, await papersign.evidence(document_id));
        saved.push(`Saved ${evidence_path}`);
      }
      return text(saved.join("\n"));
    },
  );

  return server;
}
