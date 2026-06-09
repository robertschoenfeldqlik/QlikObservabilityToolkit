import {
  HTTP_METHODS,
  type HttpMethod,
  type JsonSchema,
  type OpenApiSpec,
  type Operation,
  type Parameter,
} from "./openapi-types.js";

/**
 * Compiled metadata for a single MCP tool generated from one OpenAPI operation.
 * The dispatcher reads this to turn a tool call into an HTTP request.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  api: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  bodyContentType?: string;
}

const MAX_TOOL_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const MAX_REF_DEPTH = 8;

export function generateToolsForSpec(api: string, spec: OpenApiSpec): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];
  const usedNames = new Set<string>();

  for (const [pathTemplate, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    const pathLevelParams = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const tool = buildTool(api, spec, method, pathTemplate, op, pathLevelParams, usedNames);
      tools.push(tool);
    }
  }
  return tools;
}

function buildTool(
  api: string,
  spec: OpenApiSpec,
  method: HttpMethod,
  pathTemplate: string,
  op: Operation,
  pathLevelParams: Parameter[],
  usedNames: Set<string>,
): ToolDescriptor {
  const name = pickToolName(api, method, pathTemplate, op, usedNames);
  const description = buildDescription(op, method, pathTemplate);

  const params: Parameter[] = [...pathLevelParams, ...(op.parameters ?? [])];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const pathParams: string[] = [];
  const queryParams: string[] = [];
  const headerParams: string[] = [];

  for (const p of params) {
    if (!p?.name || p.in === "cookie") continue;
    const schema = p.schema ? resolveRefs(p.schema, spec) : { type: "string" };
    const propSchema: JsonSchema = {
      ...schema,
      description: p.description ?? schema.description,
    };
    properties[p.name] = propSchema;
    if (p.required) required.push(p.name);
    if (p.in === "path") pathParams.push(p.name);
    else if (p.in === "query") queryParams.push(p.name);
    else if (p.in === "header") headerParams.push(p.name);
  }

  let bodyContentType: string | undefined;
  if (op.requestBody?.content) {
    const [contentType, mediaType] = pickBodyContent(op.requestBody.content);
    bodyContentType = contentType;
    if (mediaType?.schema) {
      properties.body = {
        ...resolveRefs(mediaType.schema, spec),
        description:
          mediaType.schema.description ?? op.requestBody.description ?? `Request body (${contentType})`,
      };
      if (op.requestBody.required) required.push("body");
    }
  }

  // Inject a multi-tenant routing parameter. The server uses it to pick which
  // configured Talend tenant the call targets — omit it and the default
  // tenant is used. Listed last in the schema so it shows up after the
  // operation's own parameters in tool-list output.
  properties.tenant = {
    type: "string",
    description:
      "Optional. ID of the configured Talend tenant to target. Omit to use the default tenant. " +
      "Use the `tmc_list_environments` meta-tool to discover available IDs.",
  };

  const inputSchema: JsonSchema = {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };

  return {
    name,
    description,
    inputSchema,
    api,
    method,
    pathTemplate,
    pathParams,
    queryParams,
    headerParams,
    bodyContentType,
  };
}

function pickBodyContent(
  content: Record<string, { schema?: JsonSchema }>,
): [string, { schema?: JsonSchema } | undefined] {
  if (content["application/json"]) return ["application/json", content["application/json"]];
  if (content["multipart/form-data"]) return ["multipart/form-data", content["multipart/form-data"]];
  if (content["application/x-www-form-urlencoded"])
    return ["application/x-www-form-urlencoded", content["application/x-www-form-urlencoded"]];
  const first = Object.keys(content)[0];
  return [first, content[first]];
}

function buildDescription(op: Operation, method: HttpMethod, pathTemplate: string): string {
  const base = op.summary ?? op.description ?? `${method.toUpperCase()} ${pathTemplate}`;
  const detail = op.description && op.description !== op.summary ? ` ${op.description}` : "";
  const trail = ` [${method.toUpperCase()} ${pathTemplate}]`;
  const raw = `${base}${detail}${trail}`.replace(/\s+/g, " ").trim();
  return raw.length > MAX_DESCRIPTION_LEN ? raw.slice(0, MAX_DESCRIPTION_LEN - 1) + "…" : raw;
}

function pickToolName(
  api: string,
  method: HttpMethod,
  pathTemplate: string,
  op: Operation,
  usedNames: Set<string>,
): string {
  const apiPart = sanitizeNamePart(api);
  let opPart: string;
  if (op.operationId) {
    opPart = sanitizeNamePart(op.operationId);
  } else {
    opPart = sanitizeNamePart(`${method}_${pathTemplate}`);
  }
  let candidate = truncate(`${apiPart}__${opPart}`, MAX_TOOL_NAME_LEN);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    candidate = truncate(`${apiPart}__${opPart}`, MAX_TOOL_NAME_LEN - suffix.length) + suffix;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not allocate unique tool name for ${api} ${method} ${pathTemplate}`);
}

function sanitizeNamePart(s: string): string {
  return s
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

/**
 * Inline $ref pointers against #/components/schemas. Bounded depth + cycle guard
 * keeps recursive schemas (e.g. JSON Schema's own schema) from blowing the stack.
 * Cycles or over-depth refs collapse to `{}` (accept anything) so the tool stays usable.
 */
function resolveRefs(
  schema: JsonSchema,
  spec: OpenApiSpec,
  depth = 0,
  seen: Set<string> = new Set(),
): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;
  if (depth > MAX_REF_DEPTH) return {};

  // Only treat `$ref` as an OpenAPI reference when it's a string. SCIM schemas
  // (Group.members, etc.) include a property literally named `$ref` whose value
  // is a JsonSchema describing the field — those must be passed through, not dereferenced.
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (seen.has(ref)) return {};
    const next = new Set(seen);
    next.add(ref);
    const resolved = lookupRef(ref, spec);
    if (!resolved) return {};
    return resolveRefs(resolved, spec, depth + 1, next);
  }

  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    // We only get here when schema.$ref is NOT a string (handled above), so
    // any `$ref` key we still see is a regular property — e.g. SCIM
    // Group.members[].$ref — and must be preserved.
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" ? resolveRefs(item as JsonSchema, spec, depth + 1, seen) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = resolveRefs(v as JsonSchema, spec, depth + 1, seen);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function lookupRef(ref: string, spec: OpenApiSpec): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let cur: any = spec;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur as JsonSchema | undefined;
}
