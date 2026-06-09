import test from "node:test";
import assert from "node:assert/strict";

import { QlikClient } from "../src/http-client.js";
import { QLIK_OBSERVABILITY_TOOLS } from "../src/qlik-tools.js";

const muteLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return muteLogger;
  },
} as unknown as ConstructorParameters<typeof QlikClient>[0]["logger"];

function captureFetch(handler: () => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return handler();
  };
  return { fetchImpl: fn, calls };
}

test("every Qlik observability tool is read-only, tenancy-aware, and product=qlik", () => {
  assert.ok(QLIK_OBSERVABILITY_TOOLS.length >= 6, "expected a handful of Qlik tools");
  for (const t of QLIK_OBSERVABILITY_TOOLS) {
    assert.equal(t.product, "qlik", `${t.name} should be product=qlik`);
    assert.equal(t.method, "get", `${t.name} should be a read-only GET`);
    assert.ok(t.name.startsWith("qlik_observability__"), `${t.name} prefix`);
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("tenant" in props, `${t.name} must expose a tenant parameter`);
    assert.ok(t.pathTemplate.startsWith("/api/v1/"), `${t.name} targets the Qlik platform API`);
  }
});

test("QlikClient targets the tenant URL with Bearer API key and keeps baked query filters", async () => {
  const { fetchImpl, calls } = captureFetch(async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const client = new QlikClient({
    apiKey: "qlik-key-123",
    tenantUrl: "https://demo.us.qlikcloud.com/",
    fetchImpl,
    logger: muteLogger,
    disableMetrics: true,
  });
  const listApps = QLIK_OBSERVABILITY_TOOLS.find((t) => t.name === "qlik_observability__list_apps")!;
  await client.call(listApps, { limit: 10 });

  const { url, init } = calls[0];
  assert.match(url, /^https:\/\/demo\.us\.qlikcloud\.com\/api\/v1\/items/);
  // The resourceType=app filter baked into the path template survives.
  assert.match(url, /resourceType=app/);
  assert.match(url, /limit=10/);
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer qlik-key-123");
});
