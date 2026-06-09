import { test } from "node:test";
import assert from "node:assert/strict";

import {
  _resetForTests,
  recordRetry,
  recordToolCall,
  registry,
  setServerInfo,
  toolInFlight,
} from "../src/metrics.js";
import { startMetricsServer } from "../src/metrics-server.js";

test("recordToolCall increments counter and histogram", async () => {
  _resetForTests();
  recordToolCall({
    tool: "orchestration__getTasks",
    api: "orchestration",
    method: "GET",
    status: "ok",
    httpStatus: 200,
    durationMs: 123,
    attempts: 0,
    region: "us",
  });
  const out = await registry.metrics();
  // Counter line — labels alphabetized by name, value 1.
  assert.match(out, /tmc_mcp_tool_calls_total\{[^}]*tool="orchestration__getTasks"[^}]*\} 1/);
  // Histogram bucket recorded (123ms = 0.123s).
  assert.match(out, /tmc_mcp_tool_call_duration_seconds_count\{[^}]*tool="orchestration__getTasks"[^}]*\} 1/);
  // Upstream counter incremented with the region label.
  assert.match(out, /tmc_mcp_upstream_requests_total\{[^}]*region="us"[^}]*http_status="200"[^}]*\} 1/);
});

test("recordRetry increments the retry counter labeled by reason", async () => {
  _resetForTests();
  recordRetry({ tool: "api__op", api: "api", reason: "status_429" });
  recordRetry({ tool: "api__op", api: "api", reason: "status_429" });
  recordRetry({ tool: "api__op", api: "api", reason: "timeout" });
  const out = await registry.metrics();
  assert.match(out, /tmc_mcp_tool_retries_total\{[^}]*reason="status_429"[^}]*\} 2/);
  assert.match(out, /tmc_mcp_tool_retries_total\{[^}]*reason="timeout"[^}]*\} 1/);
});

test("toolInFlight inc/dec works", async () => {
  _resetForTests();
  toolInFlight.inc();
  toolInFlight.inc();
  toolInFlight.dec();
  const out = await registry.metrics();
  assert.match(out, /tmc_mcp_tool_in_flight 1/);
});

test("setServerInfo writes static identity labels", async () => {
  _resetForTests();
  setServerInfo({ region: "eu", tools: 315, specs: 20 });
  const out = await registry.metrics();
  assert.match(out, /tmc_mcp_server_info\{[^}]*region="eu"[^}]*tools_loaded="315"[^}]*\} 1/);
  assert.match(out, /tmc_mcp_tools_registered 315/);
  assert.match(out, /tmc_mcp_specs_loaded 20/);
});

test("recordToolCall handles httpStatus=null (network error)", async () => {
  _resetForTests();
  recordToolCall({
    tool: "x__y",
    api: "x",
    method: "POST",
    status: "error",
    httpStatus: null,
    durationMs: 12,
    attempts: 3,
    region: "us",
  });
  const out = await registry.metrics();
  // The upstream counter should NOT have been incremented (no HTTP response).
  assert.doesNotMatch(out, /tmc_mcp_upstream_requests_total\{[^}]*region="us"[^}]*\}/);
  // But the call counter still records the error with http_status="0".
  assert.match(out, /tmc_mcp_tool_calls_total\{[^}]*status="error"[^}]*http_status="0"[^}]*\} 1/);
});

test("default Node.js metrics are registered (process_*, nodejs_*)", async () => {
  const out = await registry.metrics();
  assert.match(out, /tmc_mcp_process_cpu_user_seconds_total/);
  assert.match(out, /tmc_mcp_nodejs_eventloop_lag_seconds/);
});

test("metrics server: /health 200 when ready, 503 when not", async () => {
  let ready = false;
  const srv = await startMetricsServer({
    port: 0, // bind any free port
    host: "127.0.0.1",
    isReady: () => ready,
  });
  // Find the actual bound port from the URL. Test framework may have logged it.
  const port = Number(new URL(srv.url).port);
  assert.ok(Number.isFinite(port) && port > 0);

  let res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 503);
  const draining = await res.json();
  assert.equal(draining.status, "draining");

  ready = true;
  res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const ok = await res.json();
  assert.equal(ok.status, "ok");
  assert.equal(typeof ok.version, "string");

  await srv.close();
});

test("metrics server: /metrics returns Prometheus exposition", async () => {
  const srv = await startMetricsServer({ port: 0, host: "127.0.0.1", isReady: () => true });
  const port = Number(new URL(srv.url).port);
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/plain/);
  const body = await res.text();
  assert.match(body, /^# HELP tmc_mcp_/m);
  assert.match(body, /^# TYPE tmc_mcp_/m);
  await srv.close();
});

test("metrics server: 404 on unknown paths", async () => {
  const srv = await startMetricsServer({ port: 0, host: "127.0.0.1", isReady: () => true });
  const port = Number(new URL(srv.url).port);
  const res = await fetch(`http://127.0.0.1:${port}/nonsense`);
  assert.equal(res.status, 404);
  await srv.close();
});
