# Business + engine metrics

Three Python exporters round out the observability stack so Prometheus
sees *what's happening in Talend itself*, not just what the MCP server is
doing for Claude:

| Exporter | Source | Purpose |
| --- | --- | --- |
| **business-exporter** | TMC REST API (Orchestration + Observability + Execution-History) | Counts of tasks/plans, execution rates, failures, durations |
| **engine-log-scraper** | Files written by a Talend Remote Engine on Linux | Per-engine job lifecycle: started / succeeded / failed / terminated, rejected rows, attempts |
| **qvd-exporter** | Prometheus | See [qlik-export.md](./qlik-export.md) — lands Prometheus into a Qlik Cloud QVD |

All three live in `python/` and ship as a single Docker image
(`talend-tmc-python-exporters`). They join the Prometheus + Loki + Grafana
stack from [observability.md](./observability.md) as opt-in compose
profiles.

## Quick start

```bash
# Bring up base infra (Prometheus, Loki, Grafana, MCP) + the business + engine exporters.
TMC_PAT=tcp_xxx \
TALEND_ENGINE_LOG_DIR_HOST=$(pwd)/deploy/sample-engine-logs \
  docker compose -f docker-compose.observability.yml --profile business --profile engine up -d

# Add the Qlik QVD exporter too:
TMC_PAT=... QLIK_CLOUD_TENANT_URL=... QLIK_CLOUD_API_KEY=... QLIK_CLOUD_CONNECTION_ID=... \
  docker compose -f docker-compose.observability.yml --profile qlik up -d

# Or everything:
... docker compose -f docker-compose.observability.yml --profile all up -d
```

Grafana auto-loads two dashboards:

- **Qlik Observability Toolkit** — server/infra (already covered in [observability.md](./observability.md))
- **Talend TMC Business + Engine** — the metrics from this doc

## business-exporter

Polls the TMC API on an interval and emits per-tenant business signals.

### Env

| Var | Default | Description |
| --- | --- | --- |
| `TMC_PAT` | — | **Required**. Same PAT shape as the MCP server. |
| `TMC_REGION` | `us` | One of the five Talend regions. |
| `TMC_EXPORTER_PORT` | `9465` | `/metrics` bind port. |
| `TMC_EXPORTER_HOST` | `0.0.0.0` | Bind address. |
| `TMC_EXPORTER_INTERVAL` | `60` | Seconds between poll cycles. |
| `TMC_EXPORTER_LOOKBACK` | `300` | Execution-history search window per cycle (seconds). |
| `TMC_WORKSPACES` | "" (all) | Comma-separated workspace IDs to query. Blank = all visible. |

### Metrics

| Name | Type | Labels |
| --- | --- | --- |
| `talend_tasks_total` | gauge | `workspace` |
| `talend_plans_total` | gauge | `workspace` |
| `talend_executions_total` | counter | `status`, `workspace`, `environment` |
| `talend_executions_failed_total` | counter | `workspace`, `environment` |
| `talend_execution_duration_seconds` | histogram | `status` |
| `talend_exporter_poll_duration_seconds` | histogram | `endpoint` |
| `talend_exporter_poll_errors_total` | counter | `endpoint` |
| `talend_exporter_last_success_timestamp` | gauge | `endpoint` |

Each new execution ID is recorded once. The exporter keeps an in-memory
10k-entry recent-ID set, so overlapping `lookback` windows don't
double-count. If you restart the exporter, the bounded set rebuilds —
counters increment from the *first* execution it sees, which is fine for
rate-based PromQL queries.

### Failure mode

A poll that 401s or 429s increments `talend_exporter_poll_errors_total`
and is logged at WARN; the loop continues. A network outage causes the
TMC client's bounded retries to kick in (same defaults as the MCP server:
3 retries, exponential backoff with jitter, honors `Retry-After`).

## engine-log-scraper

Tails the JSON log files that a Talend Remote Engine writes to disk on
Linux. Per Qlik's
[docs](https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/job-management-logs),
each line is a JSON object; we promote the `JOB_STATUS` events to
metrics.

### Env

| Var | Default | Description |
| --- | --- | --- |
| `TALEND_ENGINE_LOG_DIR` | `/var/log/talend` | Legacy single-source directory. Used when neither `TALEND_ENGINE_SOURCES` nor `remoteEngines` config is set. In Docker, mount the engine's `data/log` here. |
| `TALEND_ENGINE_LOG_GLOB` | `*.log:*.json` | Colon-separated globs (relative to the log dir). |
| `TALEND_ENGINE_SOURCES` | "" | **Multi-source.** Comma-separated `name:dir` pairs, e.g. `engine-prod-us:/var/log/talend/prod-us,engine-dev-eu:/var/log/talend/dev-eu`. Lets one scraper fan in N engines into one `/metrics` endpoint. |
| `TALEND_ENGINE_SCRAPE_INTERVAL` | `5` | Seconds between filesystem polls. |
| `TALEND_ENGINE_FROM_BEGINNING` | `0` | Set to `1` to consume the full backlog on startup. Otherwise the scraper resumes at the current end-of-file. Applied to the env-var + legacy paths; the config-file path lets you set `fromBeginning` per source. |
| `TMC_EXPORTER_PORT` | `9466` | `/metrics` bind port. |

### Multi-source configuration

The scraper picks its source list with this precedence:

1. **`TALEND_ENGINE_SOURCES`** env var (above).
2. **`remoteEngines`** array in the shared config file (the one
   resolved by `common.tenants` — defaults to
   `$APPDATA/talend-tmc-mcp/config.json` on Windows or
   `$XDG_CONFIG_HOME/talend-tmc-mcp/config.json` on Linux/macOS; override
   with `TMC_CONFIG_PATH`). Schema:

   ```json
   {
     "remoteEngines": [
       { "id": "engine-prod-us", "label": "Prod US engine",
         "logDir": "/var/log/talend/prod-us" },
       { "id": "engine-dev-eu",  "label": "Dev EU engine",
         "logDir": "/var/log/talend/dev-eu",
         "logGlob": "*.json", "fromBeginning": true }
     ]
   }
   ```

3. **Legacy single-source** env vars `TALEND_ENGINE_LOG_DIR` +
   `TALEND_ENGINE_LOG_GLOB`. Existing deployments keep working with no
   config change.

Each line's `engine` label is the JSON's `context.remoteEngineId` when
present, falling back to the source's `id` when the line lacks that
field (e.g. heartbeats) — never empty-string.

### Metrics

| Name | Type | Labels |
| --- | --- | --- |
| `talend_engine_jobs_started_total` | counter | `engine`, `workspace`, `environment` |
| `talend_engine_jobs_succeeded_total` | counter | `engine`, `workspace`, `environment` |
| `talend_engine_jobs_failed_total` | counter | `engine`, `workspace`, `environment` |
| `talend_engine_jobs_terminated_total` | counter | `engine`, `workspace`, `environment` |
| `talend_engine_job_attempts` | histogram | `engine` |
| `talend_engine_rejected_rows` | histogram | `engine`, `workspace` |
| `talend_engine_log_lines_total` | counter | `level` |
| `talend_engine_log_parse_errors_total` | counter | — |
| `talend_engine_last_event_timestamp` | gauge | `engine` |
| `talend_engine_scraper_files_followed` | gauge | `source_name` |
| `talend_engine_scraper_sources` | gauge | `source_name`, `dir` — one row per configured source, value `1` |

`talend_engine_last_event_timestamp` is the foundation for a staleness
alert — if `time() - talend_engine_last_event_timestamp > 600` for an
engine you expect to be busy, something's wrong with the engine, the
log writer, or the scraper.

### Deploying on the engine host

The compose file in this repo mounts `./deploy/sample-engine-logs` so you
get a working demo without a real engine. For a real install, override
`TALEND_ENGINE_LOG_DIR_HOST`:

```bash
TALEND_ENGINE_LOG_DIR_HOST=/opt/Talend/RemoteEngine/data/log \
  docker compose -f docker-compose.observability.yml --profile engine up -d
```

For the multi-engine pattern, mount each engine's `data/log` into its
own subdirectory under `/engine-logs/` and set `TALEND_ENGINE_SOURCES`
accordingly. The demo log file at
`deploy/sample-engine-logs/job_management.log` works just as well when
pointed at by multiple sources — useful for kicking the tires on the
multi-source path before you have a second engine.

You can also run the scraper as a tiny systemd unit on the engine host
directly:

```ini
# /etc/systemd/system/talend-engine-log-scraper.service
[Unit]
Description=Talend Remote Engine log scraper
After=network.target

[Service]
Type=simple
User=talend
Environment=TALEND_ENGINE_LOG_DIR=/opt/Talend/RemoteEngine/data/log
Environment=TMC_EXPORTER_PORT=9466
ExecStart=/opt/talend-mcp/python/.venv/bin/python /opt/talend-mcp/python/exporters/engine_log_scraper.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then add the engine's IP:9466 to your Prometheus scrape config.

### Rotation handling

The scraper detects file rotation by inode change and resets its read
position. If the file is truncated in-place (rare on Linux but possible),
position resets too — you may lose lines written during the truncate
window, but not silently double-count old ones.

## Grafana dashboard

The "Talend TMC Business + Engine" dashboard (provisioned automatically)
has three rows:

1. **TMC inventory + runs** — totals, execution rate by status,
   duration percentiles.
2. **Remote Engine jobs** — per-engine throughput, rejected-row
   distribution, staleness, parse-error stat.
3. **Qlik QVD export** — last successful run, row count, byte size,
   error counts, phase latencies.

Template variables: `workspace` (multi), `engine` (multi).

## Related

- [observability.md](./observability.md) — the underlying Prometheus + Loki + Grafana stack
- [qlik-export.md](./qlik-export.md) — what the QVD exporter actually does once you point it at a Qlik Cloud tenant
- [operations.md](./operations.md) — env-var matrix for the MCP server proper
