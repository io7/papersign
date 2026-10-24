import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { test, vi } from "vitest";
import { createBoundedFetch } from "../server/sealing/http.js";

const network = vi.hoisted(() => ({
  request: undefined as
    | undefined
    | ((
        url: URL,
        options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) => ClientRequest),
}));
vi.mock("node:https", () => ({
  request: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    assert(
      network.request,
      "Unexpected network call in a sealing transport test",
    );
    return network.request(url, options, callback);
  },
}));

function mockResponse(
  status: number,
  chunks: Buffer[],
  headers: Record<string, string> = {},
): RequestOptions[] {
  const captured: RequestOptions[] = [];
  network.request = (_url, options, callback) => {
    captured.push(options);
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      queueMicrotask(() => {
        const response = Readable.from(chunks) as IncomingMessage;
        response.statusCode = status;
        response.headers = headers;
        callback(response);
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  };
  return captured;
}

const endpoint = "https://tsa.example.invalid/timestamp";
const rejects = (operation: Promise<unknown>, code: string) =>
  assert.rejects(operation, { code });

test("sealing transport rejects a URL outside the exact operator allowlist before DNS", async () => {
  let lookups = 0;
  const fetch = createBoundedFetch([endpoint], {
    lookup: async () => {
      lookups++;
      return [];
    },
  });
  await rejects(fetch(`${endpoint}?other=1`), "NETWORK_NOT_ALLOWED");
  await rejects(
    fetch("https://other.example.invalid/timestamp"),
    "NETWORK_NOT_ALLOWED",
  );
  assert.equal(lookups, 0);
});

test("sealing transport rejects local, private, reserved and mapped IP destinations", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ]) {
    const fetch = createBoundedFetch([endpoint], {
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    });
    await rejects(fetch(endpoint), "NETWORK_PRIVATE_ADDRESS");
  }
});

test("sealing transport rejects a mixed public/private DNS answer", async () => {
  const fetch = createBoundedFetch([endpoint], {
    lookup: async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  await rejects(fetch(endpoint), "NETWORK_PRIVATE_ADDRESS");
});

test("sealing transport bounds DNS time and honors caller cancellation", async () => {
  const fetch = createBoundedFetch([endpoint], {
    timeoutMs: 20,
    lookup: async () => new Promise(() => undefined),
  });
  await rejects(fetch(endpoint), "NETWORK_TIMEOUT");
  const controller = new AbortController();
  controller.abort();
  await rejects(
    fetch(endpoint, { signal: controller.signal }),
    "NETWORK_TIMEOUT",
  );
});

test("sealing transport rejects URL credentials, reserved headers and oversized requests", async () => {
  assert.throws(
    () => createBoundedFetch(["https://user:password@tsa.example.invalid/"]),
    { code: "NETWORK_URL" },
  );
  const fetch = createBoundedFetch([endpoint], {
    lookup: async () => {
      throw new Error("Must not resolve");
    },
  });
  await rejects(fetch(endpoint, { method: "DELETE" }), "NETWORK_METHOD");
  await rejects(
    fetch(endpoint, { headers: { Host: "localhost" } }),
    "NETWORK_HEADERS",
  );
  await rejects(
    fetch(endpoint, { method: "POST", body: new Uint8Array(65_537) }),
    "NETWORK_BODY",
  );
});

test("sealing transport pins the accepted DNS answer and bounds successful binary responses", async () => {
  const options = mockResponse(200, [Buffer.from([0, 1, 255])], {
    "content-type": "application/timestamp-reply",
  });
  const fetch = createBoundedFetch([endpoint], {
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  const response = await fetch(endpoint, {
    method: "POST",
    body: new Uint8Array([1, 2]),
  });
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    new Uint8Array([0, 1, 255]),
  );
  assert.equal(
    response.headers.get("content-type"),
    "application/timestamp-reply",
  );
  assert.equal(options[0].agent, false);
  assert.equal(options[0].family, 4);
  assert(options[0].lookup);
  await new Promise<void>((resolve, reject) => {
    options[0].lookup!("tsa.example.invalid", {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, "1.1.1.1");
      assert.equal(family, 4);
      resolve();
    });
  });
});

test("sealing transport rejects redirects and declared or streaming response overflow", async () => {
  const fetch = createBoundedFetch([endpoint], {
    maxResponseBytes: 8,
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  mockResponse(302, [], { location: "https://other.example.invalid/" });
  await rejects(fetch(endpoint), "NETWORK_REDIRECT");
  mockResponse(200, [], { "content-length": "9" });
  await rejects(fetch(endpoint), "NETWORK_TOO_LARGE");
  mockResponse(200, [Buffer.alloc(5), Buffer.alloc(5)]);
  await rejects(fetch(endpoint), "NETWORK_TOO_LARGE");
});
