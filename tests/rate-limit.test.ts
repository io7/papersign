import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { localFetch, setLocalClientAddress } from "./helpers/local-http.js";

// Fixed to the local instance. Each case uses its own loopback source address
// so it has a fresh rate-limit bucket and cannot affect other suites.
const base = "http://127.0.0.1:3176";
const run = randomUUID();
const source = (n: number) =>
  `127.${parseInt(run.slice(0, 2), 16)}.${parseInt(run.slice(2, 4), 16)}.${200 + n}`;

async function statuses(path: string, count: number) {
  const results: number[] = [];
  for (let index = 0; index < count; index++) {
    const response = await localFetch(`${base}${path}`);
    await response.arrayBuffer();
    results.push(response.status);
  }
  return results;
}

describe("rate limiting", () => {
  it("never limits page files, including the app shell for client routes", async () => {
    setLocalClientAddress(source(1));
    const page = await (await localFetch(`${base}/documents`)).text();
    const script = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    // The limiter counts per route, so each file gets more than the API limit.
    for (const path of ["/favicon.svg", script!, "/documents"])
      expect(new Set(await statuses(path, 185)), path).toEqual(new Set([200]));
  });

  it("still limits the API to 180 requests a minute per address", async () => {
    setLocalClientAddress(source(2));
    const results = await statuses("/api/health", 185);
    expect(results.slice(0, 180).every((status) => status === 200)).toBe(true);
    expect(results.slice(180)).toContain(429);
  });
});
