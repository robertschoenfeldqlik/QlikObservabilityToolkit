/**
 * Prometheus metrics for the MCP server.
 *
 * Naming follows the conventions in
 * https://prometheus.io/docs/practices/naming/ — all metrics are prefixed
 * `tmc_mcp_`, units are seconds for time, _total suffix on counters.
 *
 * Default Node.js metrics (process_*, nodejs_*) are also registered so the
 * dashboard can show heap, event loop lag, GC stats out of the box.
 *
 * No metrics are observed unless someone calls observe*(). The metrics
 * server is independently opted in via TMC_METRICS_PORT.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics, type LabelValues } from "prom-client";

import { PKG_VERSION } from "./version.js";

export const registry = new Registry();

// Standard process + nodejs_* metrics (memory, GC, event loop lag, etc).
collectDefaultMetrics({ register: registry, prefix: "tmc_mcp_" });

/** Total number of MCP tool calls handled by this server. */
export const toolCallsTotal = new Counter({
  name: "tmc_mcp_tool_calls_total",
  help: "Total MCP tool invocations.",
  labelNames: ["tool", "api", "method", "status", "http_status"] as const,
  registers: [registry],
});

/** Wall-clock duration per tool call, including all retries. */
export const toolCallDuration = new Histogram({
  name: "tmc_mcp_tool_call_duration_seconds",
  help: "End-to-end duration of MCP tool calls in seconds (includes retries).",
  labelNames: ["tool", "api", "method", "status"] as const,
  // Buckets chosen for a typical HTTP API: 5ms → 30s.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/** Retries attempted per tool call (incremented once per retry, not once per call). */
export const toolRetriesTotal = new Counter({
  name: "tmc_mcp_tool_retries_total",
  help: "Total retry attempts across all tool calls.",
  labelNames: ["tool", "api", "reason"] as const, // reason: "status_5xx" | "status_429" | "timeout" | "transient"
  registers: [registry],
});

/** Currently in-flight tool calls. */
export const toolInFlight = new Gauge({
  name: "tmc_mcp_tool_in_flight",
  help: "MCP tool calls currently being processed.",
  registers: [registry],
});

/** Outbound HTTPS calls to Talend, labeled by region and resulting HTTP status. */
export const upstreamRequestsTotal = new Counter({
  name: "tmc_mcp_upstream_requests_total",
  help: "Outbound HTTPS requests to Talend Cloud.",
  labelNames: ["region", "method", "http_status"] as const,
  registers: [registry],
});

/** One-shot gauge that surfaces server identity for Grafana variable templating. */
export const serverInfo = new Gauge({
  name: "tmc_mcp_server_info",
  help: "Server metadata (always 1). Labels carry version/region/build info.",
  labelNames: ["version", "region", "tools_loaded", "specs_loaded"] as const,
  registers: [registry],
});

/** Number of MCP tools registered at startup. */
export const toolsRegistered = new Gauge({
  name: "tmc_mcp_tools_registered",
  help: "Count of MCP tools registered (one per upstream OpenAPI operation).",
  registers: [registry],
});

/** Number of OpenAPI specs loaded at startup. */
export const specsLoaded = new Gauge({
  name: "tmc_mcp_specs_loaded",
  help: "Count of upstream OpenAPI specs loaded from specs/.",
  registers: [registry],
});

/**
 * Helper: observe a completed tool call. Increments the counter, observes the
 * histogram, and inc()s upstream and retry counters. Centralizes label
 * naming so caller sites don't drift.
 */
export function recordToolCall(opts: {
  tool: string;
  api: string;
  method: string;
  status: "ok" | "error";
  httpStatus: number | null; // null when there was no upstream response (network error etc.)
  durationMs: number;
  attempts: number;
  region: string;
}) {
  const labels: LabelValues<"tool" | "api" | "method" | "status" | "http_status"> = {
    tool: opts.tool,
    api: opts.api,
    method: opts.method.toLowerCase(),
    status: opts.status,
    http_status: opts.httpStatus === null ? "0" : String(opts.httpStatus),
  };
  toolCallsTotal.inc(labels);
  toolCallDuration.observe(
    { tool: opts.tool, api: opts.api, method: opts.method.toLowerCase(), status: opts.status },
    opts.durationMs / 1000,
  );
  if (opts.httpStatus !== null) {
    upstreamRequestsTotal.inc({
      region: opts.region,
      method: opts.method.toLowerCase(),
      http_status: String(opts.httpStatus),
    });
  }
}

export function recordRetry(opts: { tool: string; api: string; reason: string }) {
  toolRetriesTotal.inc({ tool: opts.tool, api: opts.api, reason: opts.reason });
}

/** Call once at startup to set static gauges. Subsequent calls overwrite. */
export function setServerInfo(opts: { region: string; tools: number; specs: number }) {
  toolsRegistered.set(opts.tools);
  specsLoaded.set(opts.specs);
  serverInfo.reset();
  serverInfo.set(
    {
      version: PKG_VERSION,
      region: opts.region,
      tools_loaded: String(opts.tools),
      specs_loaded: String(opts.specs),
    },
    1,
  );
}

/** Reset all metrics — used by tests, not by production code. */
export function _resetForTests() {
  toolCallsTotal.reset();
  toolCallDuration.reset();
  toolRetriesTotal.reset();
  toolInFlight.set(0);
  upstreamRequestsTotal.reset();
  serverInfo.reset();
  toolsRegistered.reset();
  specsLoaded.reset();
}
