import { test } from "node:test";
import assert from "node:assert/strict";

import { generateToolsForSpec } from "../src/tool-generator.js";
import type { OpenApiSpec } from "../src/openapi-types.js";

function spec(paths: OpenApiSpec["paths"], components?: OpenApiSpec["components"]): OpenApiSpec {
  return {
    openapi: "3.0.1",
    info: { title: "test", version: "test" },
    paths,
    components,
  };
}

test("generates one tool per operation with snake-cased API prefix", () => {
  const s = spec({
    "/things": {
      get: { operationId: "listThings" },
      post: { operationId: "createThing" },
    },
  });
  const tools = generateToolsForSpec("my-api", s);
  assert.equal(tools.length, 2);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["my_api__createThing", "my_api__listThings"]);
});

test("falls back to method+path when operationId is missing", () => {
  const s = spec({ "/things/{id}": { delete: {} } });
  const tools = generateToolsForSpec("api", s);
  assert.equal(tools.length, 1);
  assert.match(tools[0].name, /^api__delete_things_id$/);
});

test("deduplicates colliding tool names with _2, _3, ...", () => {
  // Two operations could collapse to the same sanitized name.
  const s = spec({
    "/a": { post: {} },
    "/a/b": { post: {} },
  });
  const tools = generateToolsForSpec("x", s)
    .map((t) => t.name)
    .sort();
  assert.equal(new Set(tools).size, tools.length, "names must be unique");
});

test("path/query/header parameters are classified correctly", () => {
  const s = spec({
    "/things/{id}": {
      get: {
        operationId: "getThing",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
          { name: "ignored", in: "cookie", schema: { type: "string" } },
        ],
      },
    },
  });
  const tool = generateToolsForSpec("api", s)[0];
  assert.deepEqual(tool.pathParams, ["id"]);
  assert.deepEqual(tool.queryParams, ["limit"]);
  assert.deepEqual(tool.headerParams, ["X-Trace"]);
  assert.deepEqual(tool.inputSchema.required, ["id"]);
  // Cookie params are dropped.
  assert.equal((tool.inputSchema.properties as Record<string, unknown>).ignored, undefined);
});

test("requestBody schema is inlined into inputSchema.body", () => {
  const s = spec({
    "/things": {
      post: {
        operationId: "createThing",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } },
          },
        },
      },
    },
  });
  const tool = generateToolsForSpec("api", s)[0];
  assert.equal(tool.bodyContentType, "application/json");
  const props = tool.inputSchema.properties as Record<string, { type?: string }>;
  assert.equal(props.body.type, "object");
  assert.deepEqual(tool.inputSchema.required, ["body"]);
});

test("$ref pointers against #/components/schemas get inlined", () => {
  const s = spec(
    {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
          },
        },
      },
    },
    {
      schemas: {
        Thing: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
  );
  const tool = generateToolsForSpec("api", s)[0];
  const body = (tool.inputSchema.properties as Record<string, { type?: string; required?: string[] }>).body;
  assert.equal(body.type, "object");
  assert.deepEqual(body.required, ["name"]);
});

test("$ref cycles collapse to {} instead of stack-overflowing", () => {
  const s = spec(
    {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } },
        },
      },
    },
    {
      schemas: {
        A: { type: "object", properties: { next: { $ref: "#/components/schemas/B" } } },
        B: { type: "object", properties: { back: { $ref: "#/components/schemas/A" } } },
      },
    },
  );
  // The interesting assertion is that this doesn't throw.
  const tool = generateToolsForSpec("api", s)[0];
  assert.equal(tool.bodyContentType, "application/json");
});

test("SCIM-style property literally named $ref is not dereferenced", () => {
  const s = spec({
    "/users": {
      post: {
        operationId: "createUser",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  // This `$ref` is a *property name*, not an OpenAPI pointer.
                  $ref: { type: "string", description: "URI reference" },
                  display: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  });
  // Pre-fix this used to crash with "ref.startsWith is not a function".
  const tool = generateToolsForSpec("scim", s)[0];
  const body = (tool.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).body;
  assert.ok(body.properties);
  assert.ok(body.properties.$ref, "property literally named $ref must be preserved");
});

test("multi-tenant: every generated tool exposes an optional `tenant` parameter", () => {
  const s = spec({
    "/things": { get: { operationId: "listThings" } },
    "/things/{id}": {
      post: {
        operationId: "createThing",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      },
    },
  });
  const tools = generateToolsForSpec("api", s);
  for (const t of tools) {
    const props = (t.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
    assert.ok(props.tenant, `tool ${t.name} must inject a 'tenant' parameter`);
    assert.equal(props.tenant.type, "string");
    assert.match(props.tenant.description ?? "", /tmc_list_environments/);
    // It must NOT be required (defaults to default tenant when omitted).
    if (t.inputSchema.required) {
      assert.ok(!t.inputSchema.required.includes("tenant"));
    }
  }
});

test("tool names cap at 64 characters", () => {
  const longOp = "thisIsAVeryLongOperationIdMeantToBlowPastTheMaxToolNameLengthLimit";
  const s = spec({ "/x": { get: { operationId: longOp } } });
  const tool = generateToolsForSpec("api", s)[0];
  assert.ok(tool.name.length <= 64, `${tool.name} is ${tool.name.length} chars`);
});
