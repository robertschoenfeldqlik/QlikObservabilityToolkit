import { test } from "node:test";
import assert from "node:assert/strict";

import { TmcCallError, TmcClient } from "../src/http-client.js";
import type { ToolDescriptor } from "../src/tool-generator.js";

function tool(over: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "api__op",
    description: "test op",
    inputSchema: { type: "object" },
    api: "api",
    method: "get",
    pathTemplate: "/things",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    ...over,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function captureFetch(handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return handler(input, init);
  };
  return { fetchImpl: fn, calls };
}

const muteLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return muteLogger;
  },
} as unknown as ConstructorParameters<typeof TmcClient>[0]["logger"];

// Disable metrics for all unit tests so the global Prometheus registry stays
// clean between cases (counters increment monotonically by design).
const baseOpts = { disableMetrics: true } as const;

test("buildUrl encodes path params and appends query params", async () => {
  const { fetchImpl, calls } = captureFetch(async () => jsonResponse(200, { ok: true }));
  const c = new TmcClient({ pat: "x", region: "us", fetchImpl, logger: muteLogger, ...baseOpts });
  await c.call(
    tool({
      pathTemplate: "/things/{id}/items",
      pathParams: ["id"],
      queryParams: ["limit", "tag"],
    }),
    { id: "ab/cd", limit: 5, tag: ["a", "b"] },
  );
  const sent = calls[0].url;
  assert.match(sent, /\/things\/ab%2Fcd\/items/);
  assert.match(sent, /limit=5/);
  // Array query params expand into repeated keys.
  assert.match(sent, /tag=a/);
  assert.match(sent, /tag=b/);
});

test("missing required path param throws synchronously", async () => {
  const { fetchImpl } = captureFetch(async () => jsonResponse(200, {}));
  const c = new TmcClient({ pat: "x", region: "us", fetchImpl, logger: muteLogger, ...baseOpts });
  await assert.rejects(
    () => c.call(tool({ pathTemplate: "/things/{id}", pathParams: ["id"] }), {}),
    /Missing required path parameter "id"/,
  );
});

test("Bearer header carries the PAT", async () => {
  const { fetchImpl, calls } = captureFetch(async () => jsonResponse(200, {}));
  const c = new TmcClient({
    pat: "tcp_secrettoken1234",
    region: "us",
    fetchImpl,
    logger: muteLogger,
    ...baseOpts,
  });
  await c.call(tool(), {});
  const sentHeaders = calls[0].init?.headers as Record<string, string>;
  assert.equal(sentHeaders.Authorization, "Bearer tcp_secrettoken1234");
});

test("JSON body is serialized and Content-Type set", async () => {
  const { fetchImpl, calls } = captureFetch(async () => jsonResponse(200, {}));
  const c = new TmcClient({ pat: "x", region: "us", fetchImpl, logger: muteLogger, ...baseOpts });
  await c.call(tool({ method: "post", bodyContentType: "application/json" }), { body: { name: "thing" } });
  const sent = calls[0].init!;
  assert.equal((sent.headers as Record<string, string>)["Content-Type"], "application/json");
  assert.equal(sent.body, '{"name":"thing"}');
});

test("retries on 503 then succeeds; reports attempts", async () => {
  let n = 0;
  const { fetchImpl } = captureFetch(async () => {
    n++;
    if (n < 3) return jsonResponse(503, { msg: "no" });
    return jsonResponse(200, { ok: true });
  });
  const c = new TmcClient({
    pat: "x",
    region: "us",
    fetchImpl,
    logger: muteLogger,
    disableMetrics: true,
    retryBaseMs: 1,
    retryMaxMs: 5,
  });
  const r = await c.call(tool(), {});
  assert.equal(r.status, 200);
  assert.equal(r.attempts, 2);
});

test("retries on 429 honoring Retry-After (seconds)", async () => {
  let n = 0;
  const start = Date.now();
  const { fetchImpl } = captureFetch(async () => {
    n++;
    if (n === 1) return jsonResponse(429, {}, { "retry-after": "0" });
    return jsonResponse(200, {});
  });
  const c = new TmcClient({
    pat: "x",
    region: "us",
    fetchImpl,
    logger: muteLogger,
    retryBaseMs: 1,
    ...baseOpts,
  });
  const r = await c.call(tool(), {});
  assert.equal(r.status, 200);
  assert.equal(r.attempts, 1);
  assert.ok(Date.now() - start < 1000, "retry-after=0 should not stall");
});

test("does NOT retry on 4xx (other than 408/429)", async () => {
  let n = 0;
  const { fetchImpl } = captureFetch(async () => {
    n++;
    return jsonResponse(403, { msg: "forbidden" });
  });
  const c = new TmcClient({ pat: "x", region: "us", fetchImpl, logger: muteLogger, ...baseOpts });
  const r = await c.call(tool(), {});
  assert.equal(r.status, 403);
  assert.equal(n, 1);
  assert.equal(r.attempts, 0);
});

test("gives up after maxRetries and throws TmcCallError with requestId", async () => {
  const { fetchImpl } = captureFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const c = new TmcClient({
    pat: "x",
    region: "us",
    fetchImpl,
    logger: muteLogger,
    disableMetrics: true,
    maxRetries: 2,
    retryBaseMs: 1,
    retryMaxMs: 2,
  });
  try {
    await c.call(tool(), {});
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof TmcCallError);
    assert.equal((err as TmcCallError).attempts, 2);
    assert.match((err as TmcCallError).requestId, /^[0-9a-f]{8}$/);
  }
});

test("attempts/durationMs/requestId surface in CallResult", async () => {
  const { fetchImpl } = captureFetch(async () => jsonResponse(200, { ok: true }));
  const c = new TmcClient({ pat: "x", region: "us", fetchImpl, logger: muteLogger, ...baseOpts });
  const r = await c.call(tool(), {});
  assert.equal(r.attempts, 0);
  assert.ok(r.durationMs >= 0);
  assert.match(r.requestId, /^[0-9a-f]{8}$/);
});
