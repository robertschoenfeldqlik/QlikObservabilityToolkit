import type { HttpMethod, JsonSchema } from "./openapi-types.js";
import type { ToolDescriptor } from "./tool-generator.js";

/**
 * Hand-curated, read-only Qlik Cloud observability tools.
 *
 * Unlike the Talend tools (auto-generated from OpenAPI specs), the Qlik surface
 * is a deliberately small, observability-only set of GET endpoints from the
 * Qlik Cloud platform REST API: apps, reload runs, audit events, quotas, spaces,
 * users and scheduled reload tasks. Each tool carries a `tenant` parameter so
 * the MCP server routes the call to the right configured Qlik Cloud tenant —
 * tenancy is preserved exactly like the Talend tools.
 *
 * All tools target `https://<tenant>.<region>.qlikcloud.com/api/v1/...` using the
 * tenant's API key (Bearer). They never mutate anything.
 */

// The Qlik-flavoured tenant routing parameter (mirrors the Talend one but points
// at the Qlik tenant pool).
const TENANT_PARAM: JsonSchema = {
  type: "string",
  description:
    "Optional. ID of the configured Qlik Cloud tenant to target. Omit to use the default Qlik " +
    "tenant. Use the `tmc_list_environments` meta-tool to discover IDs (see `qlikTenants[].id`).",
};

const QInt = (description: string): JsonSchema => ({ type: "integer", description });
const QStr = (description: string): JsonSchema => ({ type: "string", description });

interface QlikToolSpec {
  name: string;
  summary: string;
  path: string;
  method?: HttpMethod;
  pathParams?: string[];
  query?: Record<string, JsonSchema>;
}

function build(spec: QlikToolSpec): ToolDescriptor {
  const method: HttpMethod = spec.method ?? "get";
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of spec.pathParams ?? []) {
    properties[p] = { type: "string", description: `Path parameter: ${p}.` };
    required.push(p);
  }
  const queryParams: string[] = [];
  for (const [key, schema] of Object.entries(spec.query ?? {})) {
    properties[key] = schema;
    queryParams.push(key);
  }
  properties.tenant = TENANT_PARAM;

  const displayPath = spec.path.split("?")[0];
  return {
    name: spec.name,
    description: `${spec.summary} [${method.toUpperCase()} ${displayPath}] (Qlik Cloud, read-only)`,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    api: "qlik_observability",
    method,
    pathTemplate: spec.path,
    pathParams: spec.pathParams ?? [],
    queryParams,
    headerParams: [],
    product: "qlik",
  };
}

export const QLIK_OBSERVABILITY_TOOLS: ToolDescriptor[] = [
  build({
    name: "qlik_observability__list_apps",
    summary: "List apps (catalog items of type app) visible to the API key, with their spaces.",
    path: "/api/v1/items?resourceType=app",
    query: {
      limit: QInt("Max items per page (1-100)."),
      name: QStr("Filter by (partial) name."),
      spaceId: QStr("Filter by space id."),
      sort: QStr("Sort field, e.g. -updatedAt."),
    },
  }),
  build({
    name: "qlik_observability__list_reloads",
    summary: "List reload runs and their outcome (succeeded / failed / running) across the tenant.",
    path: "/api/v1/reloads",
    query: {
      limit: QInt("Max reloads per page."),
      appId: QStr("Filter to a single app id."),
      partial: QStr("Set 'true' to include partial reloads."),
    },
  }),
  build({
    name: "qlik_observability__get_reload",
    summary: "Get one reload run by id — status, start/end time, duration and any error.",
    path: "/api/v1/reloads/{reloadId}",
    pathParams: ["reloadId"],
  }),
  build({
    name: "qlik_observability__list_audits",
    summary: "List audit events (who did what, when) for the tenant.",
    path: "/api/v1/audits",
    query: {
      limit: QInt("Max events per page."),
      eventType: QStr("Filter by event type."),
      source: QStr("Filter by event source."),
      userId: QStr("Filter by acting user id."),
      sort: QStr("Sort, e.g. -eventTime."),
    },
  }),
  build({
    name: "qlik_observability__get_quotas",
    summary: "Get the tenant's quota usage and limits (apps, spaces, data size, etc.).",
    path: "/api/v1/quotas",
  }),
  build({
    name: "qlik_observability__list_spaces",
    summary: "List spaces (shared / managed / data) in the tenant.",
    path: "/api/v1/spaces",
    query: {
      limit: QInt("Max spaces per page."),
      name: QStr("Filter by (partial) name."),
      type: QStr("Filter by type: shared | managed | data."),
      sort: QStr("Sort field."),
    },
  }),
  build({
    name: "qlik_observability__list_users",
    summary: "List users in the tenant (status, roles, last access).",
    path: "/api/v1/users",
    query: {
      limit: QInt("Max users per page."),
      filter: QStr("SCIM filter expression, e.g. status eq \"active\"."),
      sort: QStr("Sort field."),
    },
  }),
  build({
    name: "qlik_observability__list_reload_tasks",
    summary: "List scheduled reload tasks and their cadence / last run.",
    path: "/api/v1/reload-tasks",
    query: {
      limit: QInt("Max tasks per page."),
      appId: QStr("Filter to a single app id."),
      partial: QStr("Set 'true' to include partial-reload tasks."),
    },
  }),
];
