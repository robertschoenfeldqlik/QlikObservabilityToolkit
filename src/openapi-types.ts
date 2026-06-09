/**
 * Minimal OpenAPI 3.0 type definitions covering the fields we touch.
 * Not exhaustive — Talend specs are well-behaved and only use the parts we model here.
 */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export const HTTP_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; description?: string; version: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface PathItem {
  parameters?: Parameter[];
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  options?: Operation;
  head?: Operation;
}

export interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, unknown>;
}

export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
}
