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

/** A closed local fixture: only revision-checked placement writes are accepted. */
export async function editorFixture(
  page: Page,
  options: {
    name?: string;
    pdf?: Buffer;
    placements?: Placement[];
    status?: DocumentInfo["status"];
    invitations?: Invitation[];
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
      json = { registrationEnabled: true, emailEnabled: false };
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
