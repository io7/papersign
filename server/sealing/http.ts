import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { SealVerificationError } from "./types.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2002::", 16],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  );
}

function canonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SealVerificationError("NETWORK_URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new SealVerificationError("NETWORK_URL");
  }
  return url.href;
}

export interface BoundedFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Test seam; production callers use the system resolver. */
  lookup?: (
    hostname: string,
  ) => Promise<readonly { address: string; family: number }[]>;
}

/** Exact URL allowlist, public DNS only, pinned DNS result, no redirects/proxies. */
export function createBoundedFetch(
  allowedUrls: readonly string[],
  options: BoundedFetchOptions = {},
): typeof globalThis.fetch {
  const allowed = new Set(allowedUrls.map(canonicalUrl));
  const timeoutMs = Math.min(options.timeoutMs ?? 15_000, 15_000);
  const maxBytes = Math.min(
    options.maxResponseBytes ?? 8 * 1024 * 1024,
    8 * 1024 * 1024,
  );
  const resolve =
    options.lookup ??
    ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request)
      throw new SealVerificationError("NETWORK_REQUEST");
    const href = canonicalUrl(String(input));
    if (!allowed.has(href))
      throw new SealVerificationError("NETWORK_NOT_ALLOWED");
    const url = new URL(href);
    const method = init?.method?.toUpperCase() ?? "GET";
    if (!["GET", "POST"].includes(method))
      throw new SealVerificationError("NETWORK_METHOD");
    let body: Buffer | undefined;
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === "string") body = Buffer.from(init.body);
      else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body);
      else if (ArrayBuffer.isView(init.body))
        body = Buffer.from(
          init.body.buffer,
          init.body.byteOffset,
          init.body.byteLength,
        );
      else throw new SealVerificationError("NETWORK_BODY");
      if (body.length > 65_536 || method !== "POST")
        throw new SealVerificationError("NETWORK_BODY");
    }
    const headers = new Headers(init?.headers);
    for (const name of [
      "host",
      "connection",
      "transfer-encoding",
      "content-length",
    ]) {
      if (headers.has(name)) throw new SealVerificationError("NETWORK_HEADERS");
    }
    if (body) headers.set("Content-Length", String(body.length));
    const controller = new AbortController();
    const abort = () => controller.abort();
    init?.signal?.addEventListener("abort", abort, { once: true });
    if (init?.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new SealVerificationError("NETWORK_TIMEOUT"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await Promise.race([
        isIP(hostname)
          ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
          : resolve(hostname),
        cancelled,
      ]);
      if (
        !addresses.length ||
        addresses.some((item) => !publicAddress(item.address))
      ) {
        throw new SealVerificationError("NETWORK_PRIVATE_ADDRESS");
      }
      const pinned = addresses[0];
      return await Promise.race([
        new Promise<Response>((resolveResponse, reject) => {
          const request = (
            url.protocol === "https:" ? httpsRequest : httpRequest
          )(
            url,
            {
              method,
              headers: Object.fromEntries(headers),
              signal: controller.signal,
              family: pinned.family,
              // Resolve exactly once, then pin the public address to prevent DNS rebinding.
              lookup: (_hostname, _options, callback) =>
                callback(null, pinned.address, pinned.family),
              agent: false,
            },
            (response) => {
              const status = response.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                response.destroy();
                reject(new SealVerificationError("NETWORK_REDIRECT"));
                return;
              }
              const length = Number(response.headers["content-length"]);
              if (Number.isFinite(length) && length > maxBytes) {
                response.destroy();
                reject(new SealVerificationError("NETWORK_TOO_LARGE"));
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              response.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > maxBytes) {
                  response.destroy();
                  reject(new SealVerificationError("NETWORK_TOO_LARGE"));
                } else chunks.push(chunk);
              });
              response.on("error", reject);
              response.on("end", () => {
                try {
                  const responseHeaders = new Headers();
                  for (const [key, value] of Object.entries(response.headers)) {
                    if (value)
                      responseHeaders.set(
                        key,
                        Array.isArray(value) ? value.join(", ") : value,
                      );
                  }
                  resolveResponse(
                    new Response(
                      status === 204 ? null : Buffer.concat(chunks),
                      { status, headers: responseHeaders },
                    ),
                  );
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          request.on("error", reject);
          request.end(body);
        }),
        cancelled,
      ]);
    } catch (error) {
      if (error instanceof SealVerificationError) throw error;
      throw new SealVerificationError(
        controller.signal.aborted ? "NETWORK_TIMEOUT" : "NETWORK_FAILED",
      );
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abort);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }) as typeof globalThis.fetch;
}
