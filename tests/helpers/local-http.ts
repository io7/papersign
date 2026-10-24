import { request as httpRequest } from "node:http";

let clientAddress = "127.0.0.1";
export const setLocalClientAddress = (address: string) => {
  clientAddress = address;
};
/** Use real loopback clients to isolate test rate-limit buckets; never spoof proxy headers. */
export async function localFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:")
    throw new Error("The test HTTP client only connects to loopback.");
  const prepared = new Request(url, init),
    bytes = init.body ? Buffer.from(await prepared.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      target,
      {
        method: prepared.method,
        localAddress: clientAddress,
        headers: {
          ...Object.fromEntries(prepared.headers),
          ...(bytes ? { "Content-Length": String(bytes.length) } : {}),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const headers = new Headers();
          for (let index = 0; index < res.rawHeaders.length; index += 2)
            headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
          resolve(
            new Response(
              [204, 205, 304].includes(res.statusCode!)
                ? null
                : Buffer.concat(chunks),
              { status: res.statusCode, headers },
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(new Error("Local test request timed out.")),
    );
    req.end(bytes);
  });
}
