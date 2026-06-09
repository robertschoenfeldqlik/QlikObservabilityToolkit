# Observability capabilities — Talend Cloud & Qlik Cloud

The Qlik Observability Toolkit observes two domains — **Talend Cloud** (orchestration / data integration) and **Qlik Cloud** (analytics) — and surfaces what it sees through four channels:

| Channel | What you get |
|---------|--------------|
| **MCP tools** | Read-only tools an AI agent (Claude, etc.) calls over stdio to ask live questions ("which reloads failed today?", "show the last 10 task runs"). |
| **Prometheus** | Time-series metrics scraped from the MCP server and the Python exporters. |
| **Grafana + Loki** | Dashboards over those metrics + a correlated log stream. |
| **Qlik Sense (via QVD)** | The QVD bridge lands Prometheus data in a Qlik app for BI-style trend analysis. |

Everything is **read-only** and **multi-tenant**: every MCP tool and every exporter is keyed by a `tenant` id, so one deployment can watch many Talend and many Qlik tenants at once.

---

## 1. Talend Cloud observability

### What is observed

| Area | Source | Detail |
|------|--------|--------|
| **Task / job runs** | `observability-metrics` API | Execution counts, status, timing for tasks and plans. |
| **Execution logs** | `execution-logs` API | Per-execution log retrieval for a run. |
| **Execution history** | `execution-history-search` API | Search historical executions across workspaces/environments. |
| **Audit (optional)** | `audit-logs` API | Identity / security events. Off by default; enable with the `logging` preset. |
| **Remote Engine job logs** | Local JSON log files on each engine host | Job lifecycle events (start / success / fail / terminate), rejected rows, attempts — scraped by the `qlik-engine-extractor` / engine log scraper. |

### MCP tools (default surface)

The MCP server defaults to the **observability** preset — 8 auto-generated read-only tools plus the `tmc_list_environments` meta-tool:

| Tool prefix | From | Purpose |
|-------------|------|---------|
| `observability_metrics__*` | observability-metrics | Execution metrics for tasks/plans. |
| `execution_logs__*` | execution-logs | Fetch logs for an execution. |
| `execution_history_search__*` | execution-history-search | Search past executions. |
| `tmc_list_environments` | meta-tool | List every configured Talend + Qlik tenant. |

Widen with `TMC_APIS_PRESET=logging` (adds audit) or an explicit `TMC_APIS=<list>`.

### Prometheus metrics

- From the **MCP server** (`/metrics`, port 9464): `tmc_mcp_tool_calls_total`, `tmc_mcp_tool_call_duration_seconds`, `tmc_mcp_tool_retries_total`, `tmc_mcp_server_info`.
- From the **business exporter** (port 9465): task/plan/run inventory + outcomes.
- From the **engine log scraper** (port 9466): `talend_engine_*` job lifecycle counters, plus the self-diagnosis gauges `talend_engine_source_path_exists`, `talend_engine_logging_enabled`, `talend_engine_logging_verdict{verdict}`.

See [observability.md](./observability.md), [business-metrics.md](./business-metrics.md) and the Remote Engine job-logs reference: <https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/job-management-logs>.

---

## 2. Qlik Cloud observability

### What is observed

| Area | Qlik REST endpoint | Detail |
|------|--------------------|--------|
| **Apps** | `GET /api/v1/items?resourceType=app` | Apps visible to the API key, by space. |
| **Reloads** | `GET /api/v1/reloads`, `GET /api/v1/reloads/{id}` | Reload runs and outcomes (succeeded / failed / running) + duration. |
| **Audit events** | `GET /api/v1/audits` | Who did what, when. |
| **Quotas** | `GET /api/v1/quotas` | Tenant quota usage and limits. |
| **Spaces** | `GET /api/v1/spaces` | Shared / managed / data spaces. |
| **Users** | `GET /api/v1/users` | Users, status, roles. |
| **Reload tasks** | `GET /api/v1/reload-tasks` | Scheduled reloads + cadence. |

### MCP tools (new)

When a Qlik tenant has the **"Enable Qlik Cloud observability"** checkbox on (the default), the MCP server registers a read-only Qlik tool family — each routed to a Qlik tenant by the `tenant` parameter:

| Tool | Endpoint |
|------|----------|
| `qlik_observability__list_apps` | apps (catalog items) |
| `qlik_observability__list_reloads` | reload runs |
| `qlik_observability__get_reload` | one reload by id |
| `qlik_observability__list_audits` | audit events |
| `qlik_observability__get_quotas` | tenant quotas |
| `qlik_observability__list_spaces` | spaces |
| `qlik_observability__list_users` | users |
| `qlik_observability__list_reload_tasks` | scheduled reload tasks |

They authenticate with the tenant's Qlik Cloud API key (Bearer) against `https://<tenant>.<region>.qlikcloud.com`.

### Prometheus metrics

From the **Qlik observability exporter** (port 9468): `qlik_apps_total`, `qlik_reloads_total`, `qlik_reload_duration_seconds`, `qlik_audit_events_total`, `qlik_quotas`, plus poll health (`qlik_exporter_poll_*`, `qlik_exporter_last_success_timestamp`).

Qlik APIs reference: <https://qlik.dev/apis/>.

---

## 3. Multi-tenancy (applies to both)

Every MCP tool accepts an optional `tenant` argument:

- **Talend tools** route to a configured Talend tenant (default = the default Talend tenant).
- **Qlik tools** route to a configured Qlik tenant (default = the default Qlik tenant).

Discover ids with the `tmc_list_environments` meta-tool, then pass `tenant: "<id>"` to target a specific one. In Prometheus, the `tenant` label keeps every series attributable to its source tenant.

```jsonc
// "show failed reloads in our EU Qlik tenant"
{ "name": "qlik_observability__list_reloads",
  "arguments": { "tenant": "qlik-eu", "partial": "false", "limit": 50 } }
```

---

## 4. How it reaches a Qlik Sense app

The QVD bridge turns Prometheus series into long-form rows (`timestamp, metric, labels, value`), writes a QVD with `pyqvd`, and uploads it through the Qlik Cloud **Data Files API** to a connection in your Qlik tenant — where an analyst app can chart Talend + Qlik observability trends side by side. See [qlik-export.md](./qlik-export.md).

---

## See also

- [observability.md](./observability.md) — Prometheus/Grafana/Loki stack
- [business-metrics.md](./business-metrics.md) — Talend business metrics
- [qlik-export.md](./qlik-export.md) — Prometheus → QVD bridge
- [clients.md](./clients.md) — connecting an MCP client
- [configuration.md](./configuration.md) — tenants, presets, env vars
