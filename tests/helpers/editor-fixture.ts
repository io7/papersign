import { expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import type { DocumentInfo, Invitation, Placement } from "../../shared/types";
import { normalizePdfText } from "../../shared/pdf-text";
import { samplePdf, signaturePng } from "../fixtures";

export const editorDocumentId = "11111111-1111-4111-8111-111111111111";
export const editorSignatureId = "22222222-2222-4222-8222-222222222222";
export const editorPlacementId = "33333333-3333-4333-8333-333333333333";
export interface EditorSave {
  revision: number;
  placements: Placement[];
}
export interface InviteInput {
  revision: number;
  sendEmail?: boolean;
  recipients: Array<
    Pick<Invitation, "name" | "email" | "field" | "textFields">
  >;
}

/** A closed local fixture: only revision-checked placement writes are accepted. */
export async function editorFixture(
  page: Page,
  options: {
    name?: string;
    pdf?: Buffer;
    placements?: Placement[];
    status?: DocumentInfo["status"];
    invitations?: Invitation[];
    emailEnabled?: boolean;
    /** Accept link creation; the first signer's email gets this outcome. */
    invitationEmail?: "sent" | "failed";
  } = {},
) {
  const bytes = options.pdf ?? (await samplePdf(false));
  const pdf = await PDFDocument.load(bytes);
  const png = await signaturePng();
  let document: DocumentInfo = {
    id: editorDocumentId,
    name: options.name ?? "Editor fixture.pdf",
    byteSize: bytes.length,
    pages: pdf.getPages().map((pdfPage) => {
      const crop = pdfPage.getCropBox();
      const rotation = pdfPage.getRotation().angle;
      return {
        width: rotation % 180 ? crop.height : crop.width,
        height: rotation % 180 ? crop.width : crop.height,
        rotation,
      };
    }),
    placements: options.placements ?? [
      {
        id: editorPlacementId,
        signatureId: editorSignatureId,
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.25,
        height: 0.08,
      },
    ],
    status: options.status ?? "draft",
    revision: 1,
    createdAt: "2026-10-22T00:00:00Z",
    updatedAt: "2026-10-22T00:00:00Z",
    invitations: options.invitations ?? [],
  };
  const saves: EditorSave[] = [];
  const invites: InviteInput[] = [];
  const unexpectedWrites: string[] = [];
  let nextFailure = "";
  let loseResponse = false;
  let heldSave: { started: () => void; released: Promise<void> } | undefined;
  let activeSaves = 0;
  let maximumConcurrentSaves = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "PUT" &&
      path === `/api/documents/${editorDocumentId}/placements`
    ) {
      const input = request.postDataJSON() as EditorSave;
      saves.push(structuredClone(input));
      activeSaves++;
      maximumConcurrentSaves = Math.max(maximumConcurrentSaves, activeSaves);
      const hold = heldSave;
      heldSave = undefined;
      try {
        if (hold) {
          hold.started();
          await hold.released;
        }
        if (nextFailure) {
          const message = nextFailure;
          nextFailure = "";
          return await route.fulfill({ status: 503, json: { message } });
        }
        if (input.revision !== document.revision)
          return await route.fulfill({
            status: 409,
            json: { message: "This document changed. Reload before saving." },
          });
        document = {
          ...document,
          revision: document.revision + 1,
          placements: structuredClone(input.placements).map((placement) =>
            placement.kind === "text"
              ? { ...placement, text: normalizePdfText(placement.text) }
              : placement,
          ),
        };
        if (loseResponse) {
          loseResponse = false;
          return await route.abort("failed");
        }
        return await route.fulfill({ json: document });
      } finally {
        activeSaves--;
      }
    }
    if (
      options.invitationEmail &&
      request.method() === "POST" &&
      path === `/api/documents/${editorDocumentId}/invitations`
    ) {
      const input = request.postDataJSON() as InviteInput;
      invites.push(structuredClone(input));
      const created: Invitation[] = input.recipients.map((r, index) => ({
        id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
        name: r.name,
        email: r.email,
        field: r.field,
        textFields: r.textFields ?? [],
        state: "pending",
        signingOrder: index + 1,
        signingStatus: index ? "waiting" : "ready",
        canSign: index === 0,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        signedAt: null,
        url: `http://127.0.0.1:5176/sign/fixture-created-${index + 1}`,
      }));
      document = {
        ...document,
        status: "awaiting",
        revision: document.revision + 1,
        invitations: created,
      };
      return route.fulfill({
        status: 201,
        json: created.map((invitation, index) => ({
          ...invitation,
          invitationEmail:
            input.sendEmail && index === 0 ? options.invitationEmail : null,
        })),
      });
    }
    if (request.method() !== "GET") {
      unexpectedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 405,
        json: { message: "Unexpected fixture write" },
      });
    }
    let json: unknown;
    if (path === "/api/me")
      json = {
        user: {
          id: "mock-owner",
          name: "Editor QA",
          email: "editor@example.invalid",
          role: "user",
        },
      };
    else if (path === "/api/config")
      json = {
        registrationEnabled: true,
        emailEnabled: options.emailEnabled ?? false,
      };
    else if (path === "/api/signatures")
      json = [
        {
          id: editorSignatureId,
          name: "QA signature",
          source: "uploaded",
          width: 240,
          height: 80,
          isDefault: true,
        },
      ];
    else if (path === `/api/signatures/${editorSignatureId}/image`)
      return route.fulfill({ contentType: "image/png", body: png });
    else if (path === `/api/documents/${editorDocumentId}/pdf`)
      return route.fulfill({ contentType: "application/pdf", body: bytes });
    else if (path === `/api/documents/${editorDocumentId}`) json = document;
    else if (path === "/api/documents") json = [document];
    else
      return route.fulfill({
        status: 404,
        json: { message: "Unmocked fixture endpoint" },
      });
    return route.fulfill({ json });
  });

  return {
    saves,
    invites,
    unexpectedWrites,
    get document() {
      return structuredClone(document);
    },
    get maximumConcurrentSaves() {
      return maximumConcurrentSaves;
    },
    failNextSave(message = "The server could not save this change.") {
      nextFailure = message;
    },
    loseNextSaveResponse() {
      loseResponse = true;
    },
    holdNextSave() {
      let start!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (start = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      heldSave = { started: start, released };
      return { started, release };
    },
    async open() {
      await page.goto(`/documents/${editorDocumentId}`);
      await expect(page.locator(".pdf-overlay").first()).toBeVisible();
    },
  };
}
