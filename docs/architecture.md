# Architecture

## High-level shape

```
+----------------------+        stdio JSON-RPC        +----------------------+
| MCP client           | <--------------------------> | talend-tmc-mcp       |
| (Claude Desktop,     |                              |  (Node.js process)   |
|  Claude Code, etc.)  |                              +----------+-----------+
+----------------------+                                         |
                                                                 |  HTTPS + Bearer PAT
                                                                 v
                                                  +-------------------------+
                                                  | api.<region>.cloud.     |
                                                  | talend.com              |
                                                  +-------------------------+
```

The server is a single Node.js process that:

1. Loads OpenAPI specs from `specs/` at startup.
2. Converts every operation into an MCP tool descriptor.
3. Listens on stdin/stdout for JSON-RPC messages.
4. On `tools/call`, builds an HTTPS request from the tool's stored metadata
   and the caller's arguments, then proxies the response back.

There is **no live OpenAPI parsing per request** — tool descriptors are
materialized once at boot and held in a `Map<string, ToolDescriptor>`.

## File responsibilities

| File | Role |
| --- | --- |
| [src/index.ts](../src/index.ts) | Entrypoint. Reads env + config file, loads specs, wires `Server`, dispatches `tools/list` and `tools/call`. |
| [src/apis.ts](../src/apis.ts) | The canonical list of 20 TMC APIs and the 5 region base URLs. |
| [src/openapi-types.ts](../src/openapi-types.ts) | Minimal OpenAPI 3.0 type definitions (only the fields the generator touches). |
| [src/spec-loader.ts](../src/spec-loader.ts) | Reads cached JSON from `specs/`, applies optional `TMC_APIS` filter. |
| [src/tool-generator.ts](../src/tool-generator.ts) | The heart of the project: OpenAPI operation → MCP tool descriptor. |
| [src/http-client.ts](../src/http-client.ts) | `fetch()` wrapper that turns a `ToolDescriptor + args` into an HTTPS call. |
| [src/config.ts](../src/config.ts) | Locates and reads the user's config file (PAT, region, etc.). |
| [scripts/setup.ts](../scripts/setup.ts) | Interactive setup wizard. Talks to a TTY, not to MCP. |
| [scripts/fetch-specs.ts](../scripts/fetch-specs.ts) | Downloads OpenAPI specs from `talend.qlik.dev`. |
| [scripts/gen-docs.ts](../scripts/gen-docs.ts) | Regenerates `docs/api-reference/*.md`. |

## OpenAPI → MCP tool mapping

For each operation in each spec, the generator builds a `ToolDescriptor`:

```typescript
interface ToolDescriptor {
  name: string;            // e.g. "orchestration__getAvailableArtifacts"
  description: string;     // OpenAPI summary + "[METHOD /path]"
  inputSchema: JsonSchema; // flattened path + query + header + body params
  api: string;             // slug ("orchestration")
  method: HttpMethod;      // "get" | "post" | "put" | "patch" | "delete"
  pathTemplate: string;    // raw OpenAPI path with {placeholders}
  pathParams: string[];    // which inputSchema keys go into the path
  queryParams: string[];   // which keys go into the URL query string
  headerParams: string[];  // which keys go into request headers
  bodyContentType?: string; // "application/json" | "multipart/form-data" | ...
}
```

### Naming rules

`<api_slug>__<operationId>`, sanitized and length-capped.

- API slug: hyphens replaced with underscores (`dynamic-engine` → `dynamic_engine`).
- `operationId`: kept as-is if present, otherwise built from `<method>_<path>` and sanitized to `[A-Za-z0-9_]`.
- Names truncated to **64 characters** (MCP/Claude limit).
- Duplicates within an API get a `_2`, `_3`, … suffix.

### Input schema construction

For each operation:

1. Merge **path-item-level** and **operation-level** `parameters` arrays.
2. For each parameter (except `in: cookie`):
   - Resolve any `$ref` against `#/components/schemas` (depth-bounded, cycle-safe).
   - Add it to `inputSchema.properties[<name>]` with the resolved type.
   - If `required`, add to `inputSchema.required`.
   - Remember its `in` value (`path` / `query` / `header`) for later dispatch.
3. If `requestBody` exists:
   - Pick `application/json` (preferred) or whatever the first media type is.
   - Add the resolved schema as `inputSchema.properties.body`.
   - If `requestBody.required`, push `"body"` into `inputSchema.required`.
4. Stamp `additionalProperties: false` so the client validates strictly.

### `$ref` resolution

The OpenAPI specs use `$ref` heavily for shared models. The generator inlines
them recursively against `#/components/schemas/...`, with two guards:

- **Cycle detection:** a `seen` Set of refs already in the current chain. A
  repeated ref collapses to `{}` (accept anything) rather than recursing.
- **Depth bound:** `MAX_REF_DEPTH = 8`. Past this, the subtree collapses to
  `{}`. This catches pathological specs without throwing.

One subtle case: **SCIM** schemas (`scim-v2`) include a property *literally
named* `$ref` (it's part of the SCIM spec, e.g. `Group.members[].$ref`). The
generator only treats `schema.$ref` as a pointer when its value is a string —
when it's an object, it's a normal property called `$ref` and gets passed
through. This is the kind of thing you only learn when the resolver crashes.

### Annotations

Each tool exposes the standard MCP annotation hints:

| Annotation | When set |
| --- | --- |
| `readOnlyHint` | HTTP `GET` |
| `destructiveHint` | HTTP `DELETE` |
| `idempotentHint` | HTTP `GET`, `PUT`, `DELETE` |

These help clients (like Claude Desktop) render warnings before destructive calls.

## Tool-call dispatch

When the client sends `tools/call { name, arguments }`:

1. **Look up** the `ToolDescriptor` by name. Unknown names return an error result.
2. **Build the URL:**
   - Start with `https://api.<region>.cloud.talend.com` + `tool.pathTemplate`.
   - For each `pathParam`, substitute `{name}` with the URL-encoded argument value. Missing required path params throw.
   - For each `queryParam`, append to the query string (arrays expand to repeated keys).
3. **Build headers:**
   - Always: `Authorization: Bearer <PAT>`, `Accept: application/json`.
   - For each `headerParam`, add `header-name: <value>`.
   - If a body is present, set `Content-Type: <tool.bodyContentType>`.
4. **Build the body:**
   - `application/json` → `JSON.stringify(args.body)`.
   - `application/x-www-form-urlencoded` → `URLSearchParams`.
   - Anything else → stringify.
5. **Fetch** with `AbortController` for the configured timeout.
6. **Format result** as a single text block: `HTTP <status> <statusText>\n\n<pretty-json or raw body>`. `isError` is set when `response.ok` is false.

## Region routing

Regions are listed in [src/apis.ts](../src/apis.ts) as a const object:

```typescript
export const TMC_REGIONS = {
  eu: "https://api.eu.cloud.talend.com",
  us: "https://api.us.cloud.talend.com",
  ap: "https://api.ap.cloud.talend.com",
  au: "https://api.au.cloud.talend.com",
  "us-west": "https://api.us-west.cloud.talend.com",
} as const;
```

The same set of 20 APIs is available in every region. Changing region just
swaps the base URL — tool definitions don't change.

## What's deliberately NOT here

- **No client-side caching of API responses.** Each tool call hits Talend.
  Caching adds correctness risks (stale data, invalidation) that aren't worth
  it for a developer tool.
- **No retry logic.** A 5xx or network error returns the failure to the caller
  so the model can decide. Retrying transparently can mask outages or trigger
  rate limits.
- **No pagination wrapping.** Listing endpoints expose `limit`/`offset`
  directly; the model paginates if needed.
- **No OAuth/service-account flow.** PAT only, for now. See [development.md](./development.md#future-work).
- **No resources / prompts / sampling.** Just tools.

## Performance notes

- Startup is dominated by reading 20 JSON files and generating descriptors —
  about 100ms on a recent laptop.
- Per-call overhead is ~1ms generator-side + however long Talend takes (usually 100-500ms).
- Memory: ~30-40 MB resident with all 20 specs loaded.

If startup ever becomes a bottleneck, the natural next step would be to
serialize the generated descriptors to disk and skip the runtime generation
pass. Not worth it today.
