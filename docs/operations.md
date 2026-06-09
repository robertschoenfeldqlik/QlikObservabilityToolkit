# Operations

How the server behaves at runtime: logging, retries, signals, exit codes,
limits, and what to expect when things go sideways.

## Logging

All logs go to **stderr**. stdout is reserved for the MCP JSON-RPC transport.

| Var | Default | Effect |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `LOG_FORMAT` | `json` if `NODE_ENV=production`, else `pretty` | `json` produces newline-delimited JSON. `pretty` is human-readable. |

### JSON format

```
{"ts":"2026-05-13T10:42:18.001Z","level":"info","msg":"server starting","service":"talend-tmc-mcp","version":"1.0.0","specs":20,"tools":315,"region":"us","baseUrl":"https://api.us.cloud.talend.com","timeoutMs":60000,"maxRetries":3}
```

Every line has `ts`, `level`, `msg`. Extra fields depend on the call site
(`tool`, `requestId`, `status`, `attempts`, `ms`, etc.).

### Redaction

The logger automatically scrubs:

- Any field literally named `pat`, `token`, `accessToken`, `Authorization`, `client_secret`, `x-api-key` — value becomes `[REDACTED]`.
- Any `Bearer <something>` substring inside any string value.
- Any token matching `tcp_[A-Za-z0-9_-]{8,}` (Talend PAT shape) anywhere in any string value.

This applies recursively through arrays and nested objects. The MCP tool
responses (which can contain Talend's own API responses) flow back to the
client unredacted — only *log output* is scrubbed.

Test it locally:

```bash
LOG_LEVEL=debug LOG_FORMAT=pretty npm run dev
```

## Retry behavior

`TmcClient` retries on these conditions:

| Trigger | Retried? |
| --- | --- |
| HTTP 429 (Too Many Requests) | ✅ — honors `Retry-After` (seconds or HTTP-date) |
| HTTP 408 (Request Timeout) | ✅ |
| HTTP 5xx | ✅ |
| Network errors (ECONNRESET, ETIMEDOUT, fetch failed, EAI_AGAIN, etc.) | ✅ |
| Per-request timeout (`AbortError`) | ✅ |
| HTTP 4xx (other than 408/429) | ❌ — body returned as-is |

Backoff: exponential with **full jitter**. `delay = random(0, baseMs * 2^attempt)`,
capped at `retryMaxMs`. Full jitter spreads concurrent retries so a recovering
Talend region doesn't get thundered.

| Var | Default | Range | Effect |
| --- | --- | --- | --- |
| `TMC_MAX_RETRIES` | `3` | 0–8 | Number of retries after the initial attempt (so up to 4 total tries). |
| `TMC_TIMEOUT_MS` | `60000` | 1+ | Per-request timeout, applied to each attempt. |

`Retry-After` overrides the computed jitter delay. If a 429 says
`Retry-After: 30`, the client waits at least 30s (capped at `retryMaxMs`, default 10s).

### What surfaces in MCP tool responses

Successful response header line:

```
HTTP 200 OK · 123ms · req=4f8d2c1a · tool=orchestration__getAvailableTasks
```

After 2 retries:

```
HTTP 200 OK · 2 retries · 4517ms · req=4f8d2c1a · tool=orchestration__getAvailableTasks
```

Failed call (all retries exhausted, network error):

```
Tool orchestration__getAvailableTasks failed [requestId=4f8d2c1a attempts=3]: HTTP request failed for GET https://api.us.cloud.talend.com/orchestration/executables/tasks (after 3 retries): fetch failed
```

The `requestId` correlates the tool response with stderr log lines.

## Result size limit

| Var | Default | Effect |
| --- | --- | --- |
| `TMC_MAX_RESULT_BYTES` | `262144` (256 KiB) | Tool responses larger than this are truncated. |

A truncation marker is appended to the response so the model knows to
paginate / filter rather than assuming complete data:

```
[truncated: 1572864 more bytes]
```

Most Talend listing endpoints support `limit`/`offset` or `name`/`tag`
filters — encourage the model to use them rather than bumping this limit.

## Signals and shutdown

The server traps these:

| Signal | Behavior | Exit code |
| --- | --- | --- |
| `SIGINT` (Ctrl-C) | Stop accepting new tool calls. Wait for in-flight up to `TMC_SHUTDOWN_DRAIN_MS` (default 5000). Close MCP server. | 130 |
| `SIGTERM` (docker stop, kubectl delete) | Same as SIGINT. | 143 |
| stdin closes (parent died) | Same as SIGINT, but exit code 0. | 0 |

During shutdown:

1. `shuttingDown` flag flips → new `tools/call` requests return an
   `isError: true` "shutting down" response immediately instead of starting work.
2. The client waits up to `TMC_SHUTDOWN_DRAIN_MS` for in-flight calls to settle.
3. `Server.close()` ends the MCP transport.
4. Process exits with the matching code.

### Drain timeout tuning

Default is 5s. Tune if you regularly have long-running Talend calls:

```bash
TMC_SHUTDOWN_DRAIN_MS=30000 node dist/index.js
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean shutdown. |
| 1 | Pre-server crash (config load failure, spec parse error, unhandled exception). |
| 78 | EX_CONFIG — invalid configuration (missing PAT, bad region, malformed `TMC_APIS`, bad numeric env). |
| 130 | SIGINT (Ctrl-C). |
| 143 | SIGTERM. |

## Environment variables — full table

See [configuration.md](./configuration.md) for the user-facing config table.
This is the operator-facing one:

| Var | Default | Notes |
| --- | --- | --- |
| `TMC_PAT` | — | **Required** unless config file has one. Redacted from logs. |
| `TMC_REGION` | `us` | `us`, `eu`, `ap`, `au`, `us-west`. |
| `TMC_APIS` | (all 20) | Trim the tool surface. |
| `TMC_API_VERSION` | `2021-03` | Used at spec-fetch time. |
| `TMC_TIMEOUT_MS` | `60000` | Per-request HTTP timeout. |
| `TMC_MAX_RETRIES` | `3` | 0–8. |
| `TMC_MAX_RESULT_BYTES` | `262144` | 256 KiB. Truncates oversized tool responses. |
| `TMC_SHUTDOWN_DRAIN_MS` | `5000` | How long to wait for in-flight tool calls on shutdown. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `LOG_FORMAT` | `json` in prod, else `pretty` | Override explicitly with `json` or `pretty`. |
| `NODE_ENV` | unset | Setting to `production` flips `LOG_FORMAT` to `json`. The Docker image sets this. |
| `TMC_CONFIG_PORT` | `8788` | Config UI port. |
| `TMC_CONFIG_HOST` | `127.0.0.1` | Don't change. |
| `TMC_CONFIG_NO_OPEN` | unset | Set to `1` to skip auto-opening the browser. |
| `TMC_CRED_STORE` | `file` (or `patStorage` field) | `file` or `keychain`. Forces the credential backend at startup. See [pat-storage.md](./pat-storage.md). |
| `TMC_METRICS_PORT` | unset (off) | If set, exposes Prometheus `/metrics` + `/health` on this port. See [observability.md](./observability.md). |
| `TMC_METRICS_HOST` | `0.0.0.0` | Bind address for the metrics endpoint. |

## Observability hooks

Set `TMC_METRICS_PORT=9464` to expose Prometheus `/metrics` and a `/health`
readiness probe alongside the stdio MCP server. Full details — metric
reference, PromQL recipes, the bundled Grafana + Loki + Promtail stack —
in [observability.md](./observability.md).

For situations where you can't run the metrics endpoint:

- Pipe stderr to your aggregator (it's already JSON in prod).
- Filter by `level >= warn` for actionable alerts.
- `requestId` is the natural correlation key across logs + tool responses.
- The Talend tenant itself has audit logs (see
  [api-reference/audit-logs.md](./api-reference/audit-logs.md)) — useful
  for "was this action actually applied?" investigations.

## Capacity guidance

This is a per-user MCP server, typically running as a sidecar to one Claude
client. It's not designed for high-throughput multi-tenant use.

- Memory: ~30–40 MB resident.
- Concurrency: bounded by the MCP client (Claude generally sends one
  `tools/call` at a time per conversation turn).
- Talend rate limits: see Talend's docs. We honor `Retry-After` on 429 but
  don't pre-emptively throttle.

For shared deployments, run one container per user — the PAT is per-user
and the server doesn't multiplex tenants.
