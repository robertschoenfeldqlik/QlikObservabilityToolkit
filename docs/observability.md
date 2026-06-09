# Observability

The server exports **Prometheus metrics** on an opt-in HTTP endpoint, and
its structured JSON logs are ready to ship to **Loki / Grafana** with no
transformation. A turnkey `docker compose` stack in [deploy/](../deploy/)
brings up Prometheus + Loki + Promtail + Grafana with the dashboard
pre-provisioned.

## Quick start

```bash
TMC_PAT=tcp_xxx docker compose -f docker-compose.observability.yml up -d
# Wait ~10s for everything to settle
open http://localhost:3000        # Grafana (no login — anonymous Admin on localhost)
open http://localhost:9090        # Prometheus
open http://localhost:9464/metrics  # Raw exposition from the MCP server
open http://localhost:9464/health   # Readiness probe
```

The Grafana dashboard "Qlik Observability Toolkit" lands in the default folder
automatically — no import step.

## Metrics endpoint

The MCP server speaks stdio, so the metrics endpoint is **separate** and
only starts when you opt in:

| Env var | Default | Description |
| --- | --- | --- |
| `TMC_METRICS_PORT` | unset | If set, the server binds a small HTTP server here. Off by default. |
| `TMC_METRICS_HOST` | `0.0.0.0` | Bind address for the metrics endpoint. Use `127.0.0.1` if you don't want it reachable from other containers. |

The endpoint exposes:

| Path | Returns |
| --- | --- |
| `GET /metrics` | Prometheus exposition format (`text/plain; version=0.0.4`). |
| `GET /health` | `200 {"status":"ok"}` once startup is complete and the server isn't draining. `503 {"status":"draining"}` otherwise. JSON. |
| `GET /` | Plain-text landing page describing the above. |

`/health` is suitable for k8s `readinessProbe` and `livenessProbe`. The
synthetic-initialize check baked into the Docker `HEALTHCHECK` is
independent and runs whether or not the metrics endpoint is on.

## Metric reference

All metrics are prefixed `tmc_mcp_` and follow Prometheus conventions
(seconds for time, `_total` suffix on monotonic counters).

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `tmc_mcp_tool_calls_total` | counter | `tool`, `api`, `method`, `status`, `http_status` | Every MCP tool invocation. `status` is `ok` or `error`. `http_status` is `"0"` when the upstream call never returned (network error). |
| `tmc_mcp_tool_call_duration_seconds` | histogram | `tool`, `api`, `method`, `status` | End-to-end wall-clock per call, including all retries. Buckets cover 5 ms → 30 s. |
| `tmc_mcp_tool_retries_total` | counter | `tool`, `api`, `reason` | Retry attempts. `reason` ∈ `status_5xx`, `status_429`, `timeout`, `transient`. |
| `tmc_mcp_tool_in_flight` | gauge | — | Tool calls currently being processed. |
| `tmc_mcp_upstream_requests_total` | counter | `region`, `method`, `http_status` | Outbound HTTPS calls to `api.<region>.cloud.talend.com`. Includes retried attempts. |
| `tmc_mcp_server_info` | gauge | `version`, `region`, `tools_loaded`, `specs_loaded` | Always `1`. Labels carry server identity for dashboard variable templating. |
| `tmc_mcp_tools_registered` | gauge | — | Count of MCP tools generated at startup (one per OpenAPI operation). |
| `tmc_mcp_specs_loaded` | gauge | — | Count of upstream OpenAPI specs loaded from `specs/`. |
| `tmc_mcp_process_*` | various | — | Standard Node process metrics (CPU, memory, FDs). |
| `tmc_mcp_nodejs_*` | various | — | Node-specific metrics (heap, GC, event-loop lag). |

## PromQL recipes

```promql
# Calls per second, by tool, top 10
topk(10, sum by (tool) (rate(tmc_mcp_tool_calls_total[5m])))

# p95 latency by tool
histogram_quantile(0.95,
  sum by (le, tool) (rate(tmc_mcp_tool_call_duration_seconds_bucket[5m])))

# Error ratio over the last 5 min
sum(rate(tmc_mcp_tool_calls_total{status="error"}[5m]))
/ clamp_min(sum(rate(tmc_mcp_tool_calls_total[5m])), 1e-9)

# Retries per call (proxy for upstream flakiness)
sum(rate(tmc_mcp_tool_retries_total[5m]))
/ clamp_min(sum(rate(tmc_mcp_tool_calls_total[5m])), 1e-9)

# 429s per region
sum by (region) (rate(tmc_mcp_upstream_requests_total{http_status="429"}[5m]))

# Event-loop blockage (anything > 50 ms p99 is suspicious)
tmc_mcp_nodejs_eventloop_lag_p99_seconds > 0.05
```

## Logging into Grafana via Loki

The server writes one JSON line per log event to **stderr** (stdout is
reserved for the MCP JSON-RPC transport):

```json
{"ts":"2026-06-03T15:04:05.001Z","level":"info","msg":"call succeeded","service":"talend-tmc-mcp","version":"1.0.0","tool":"orchestration__getAvailableTasks","requestId":"4f8d2c1a","status":200,"attempts":0,"ms":127}
```

In the bundled stack, **Promtail** tails `docker logs` for any container
with the `logging=promtail` label (set on the `tmc-mcp` service in
[docker-compose.observability.yml](../docker-compose.observability.yml)),
parses the JSON, and ships it to Loki with `level` and `tool` promoted to
indexed labels and `requestId` / `api` / `status` / `http_status` /
`msg` carried as structured metadata.

In Grafana, query Loki with:

```logql
{service="tmc-mcp"} | json | level="error"
{service="tmc-mcp"} | json | tool=~"orchestration__.*" | http_status>=500
{service="tmc-mcp"} | json | requestId="4f8d2c1a"
```

The Loki datasource is configured with a **derived field** on `requestId`
— in the Logs panel, click any line and Grafana offers a one-click jump
to "all logs with this requestId". Perfect for tracing a single failing
tool call across retries.

## Dashboard tour

The provisioned **Qlik Observability Toolkit** dashboard has four sections:

1. **Overview** — six headline stats: tools loaded, in-flight, calls/sec,
   error %, p95 latency, retries/sec.
2. **Tool calls** — calls/sec by tool (top 10), latency percentiles
   (p50/p95/p99), errors/sec by tool, upstream HTTP status codes.
3. **Retries & process health** — retries broken down by reason,
   event-loop lag p99, heap usage, RSS.
4. **Logs** — live Loki stream filtered by the log-level variable.

Template variables: `tool`, `region`, `loglevel`. Multi-select on all
three. The default time range is the last 30 minutes; refresh is 10s.

## Without docker-compose

If you already run Prometheus / Loki / Grafana elsewhere:

1. Set `TMC_METRICS_PORT=9464` on the server.
2. Add a Prometheus scrape job:
   ```yaml
   - job_name: tmc-mcp
     metrics_path: /metrics
     static_configs:
       - targets: ["<host-or-container>:9464"]
   ```
3. Point your log shipper at the server's stderr stream. The format is
   pure newline-delimited JSON; Promtail, Vector, Fluent Bit all read it
   natively.
4. Import the dashboard JSON: copy
   [`deploy/grafana/dashboards/tmc-mcp.json`](../deploy/grafana/dashboards/tmc-mcp.json)
   into Grafana → Dashboards → Import. If your datasource names aren't
   "Prometheus" and "Loki", edit the dashboard variables after import.

## Production notes

- **Run one MCP container per user.** The metrics are per-process. If you
  multiplex multiple PATs through a single container (don't), they'll all
  pile into the same series.
- **Cardinality.** `tmc_mcp_tool_calls_total` has `tool` as a label (≈9
  values by default, growing if you widen the API surface via `TMC_APIS`).
  That's fine for Prometheus, but `http_status` × `tool` × `api`
  × `method` × `status` gets large. If you scale to many tenants, drop
  `http_status` and `method` via metric_relabel_configs.
- **Retention.** The bundled Prometheus keeps 14 days. Loki keeps 7. Tune
  to your storage budget.
- **Authentication.** This stack is for a local laptop / dev box. Don't
  expose `localhost:3000` to the internet without putting Grafana behind
  an auth proxy first.
- **TLS for /metrics.** The server speaks plaintext HTTP on /metrics by
  design — Prometheus scraping typically happens on a trusted network. If
  you need TLS, terminate at an Envoy / nginx sidecar.

## Related docs

- [operations.md](./operations.md) — log format, retry behavior, signals
- [docker.md](./docker.md) — base image, healthcheck, multi-arch
- [troubleshooting.md](./troubleshooting.md) — what to check when something's red
