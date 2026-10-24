// Minimal PaperSign API client for an Admin API key.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEY_FILE =
  process.env.PAPERSIGN_KEY_FILE ||
  join(homedir(), ".config/papersign/api-key");

/** The PaperSign server to talk to, from PAPERSIGN_URL. */
export function serverUrl() {
  const url = process.env.PAPERSIGN_URL?.trim();
  if (!url)
    throw new Error(
      "Set PAPERSIGN_URL to your PaperSign address, for example https://papersign.example.com.",
    );
  return url;
}

export async function loadKey() {
  if (process.env.PAPERSIGN_API_KEY)
    return process.env.PAPERSIGN_API_KEY.trim();
  let info;
  try {
    info = await stat(KEY_FILE);
  } catch {
    throw new Error(
      `No API key. Create one in PaperSign Admin → API keys and save it to ${KEY_FILE} (chmod 600), or set PAPERSIGN_API_KEY.`,
    );
  }
  if (info.mode & 0o077)
    throw new Error(`${KEY_FILE} must be private: run chmod 600 on it.`);
  return (await readFile(KEY_FILE, "utf8")).trim();
}

export class PaperSignError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createClient({ baseUrl, key }) {
  if (!baseUrl) throw new Error("No PaperSign address given.");
  if (!/^psk_[A-Za-z0-9_-]{43}$/.test(key ?? ""))
    throw new Error("The API key does not look like a PaperSign key (psk_…).");
  const root = baseUrl.replace(/\/+$/, "");

  async function call(method, path, body, { binary = false } = {}) {
    const multipart = body instanceof FormData;
    const response = await fetch(`${root}/api${path}`, {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== undefined && !multipart
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: multipart || body === undefined ? body : JSON.stringify(body),
    });
    if (!response.ok) {
      let message = `PaperSign answered ${response.status}.`;
      try {
        message = (await response.json()).message ?? message;
      } catch {
        /* not JSON */
      }
      throw new PaperSignError(message, response.status);
    }
    if (binary) return Buffer.from(await response.arrayBuffer());
    return response.status === 204 ? undefined : response.json();
  }

  return {
    listDocuments: () => call("GET", "/documents"),
    document: (id) => call("GET", `/documents/${id}`),
    upload(bytes, filename) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
        filename,
      );
      return call("POST", "/documents", form);
    },
    setOwnerText: (id, revision, placements) =>
      call("PUT", `/documents/${id}/placements`, { revision, placements }),
    invite: (id, revision, recipients) =>
      call("POST", `/documents/${id}/invitations`, {
        revision,
        termsLocked: true,
        recipients,
      }),
    emailPreview: (id, invitationId) =>
      call("GET", `/documents/${id}/invitations/${invitationId}/email`),
    sendEmail: (id, invitationId, previewHash) =>
      call("POST", `/documents/${id}/invitations/${invitationId}/email`, {
        previewHash,
      }),
    reissue: (id, invitationId, revision) =>
      call("POST", `/documents/${id}/invitations/${invitationId}/reissue`, {
        revision,
      }),
    revoke: (id, invitationId) =>
      call("POST", `/documents/${id}/invitations/${invitationId}/revoke`, {}),
    cancel: (id, revision, reason) =>
      call("POST", `/documents/${id}/cancel`, { revision, reason }),
    discard: (id, revision, confirmName) =>
      call("POST", `/documents/${id}/deletion-request`, {
        revision,
        confirmName,
      }),
    history: (id) => call("GET", `/documents/${id}/history`),
    record: (id) => call("GET", `/documents/${id}/record`),
    recordPdf: (id) =>
      call("GET", `/documents/${id}/record/pdf`, undefined, { binary: true }),
    evidence: (id) =>
      call("GET", `/documents/${id}/record/evidence`, undefined, {
        binary: true,
      }),
  };
}
