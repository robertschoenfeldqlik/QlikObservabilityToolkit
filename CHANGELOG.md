# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **MCP per-tool `tenant` parameter** — every auto-generated tool now accepts an optional `tenant` (string) input. Routes the call to the matching configured Talend tenant. Omit to use the default tenant. Per-tenant `TmcClient` instances cached on first use (and warmed for the default at startup).
- **`tmc_list_environments` meta-tool** — first-class MCP tool that returns the full snapshot of Talend + Qlik tenants (ids, labels, regions, URL overrides, default flags, API filters) so the model can discover valid `tenant` IDs before calling other tools.
- **MCP observability preset enforced** — `TMC_APIS_PRESET=observability` (default in observability mode) loads just `observability-metrics` + `execution-logs` + `execution-history-search`. Tool surface drops from 315 → 9 auto-generated tools + the meta-tool.
- **Data Products tab** in the config UI — per Qlik tenant: lists the QVD files currently in the configured Data Files connection, trigger an immediate QVD export, optionally publish a curated catalog entry via Qlik `POST /api/v1/items` (`resourceType=qvd`), delete files. New endpoints: `GET /api/data-products`, `POST /api/data-products/upload-now`, `POST /api/data-products/publish`, `DELETE /api/data-products/{fileName}`.
- **Kubernetes deployment** ([deploy/k8s/](deploy/k8s/)) — Kustomize layout with `base/` + `overlays/minikube/` + `overlays/eks/`. Deploys MCP server, all 4 Python exporters, Prometheus, Loki, Promtail (DaemonSet using `kubernetes_sd_configs` + `/var/log/pods` — CRI-compatible, works on EKS containerd), Grafana with both dashboards via configMapGenerator. EKS overlay covers ALB Ingress, gp3 storage class, IRSA annotations, and external-secrets pulling from AWS Secrets Manager. 22 manifest files, 2,280 LOC, documented in [docs/k8s.md](docs/k8s.md).
- **Parallel build via subagents** — k8s manifests and Data Products UI built concurrently by background agents.

### Added
- **Multi-tenant config** — v2 schema supporting N Talend tenants and N Qlik tenants in one file. Each tenant has its own ID, label, URL override, credential storage backend (file or OS keyring), and optional per-tenant API/timeout config. One tenant per service is the "default" used by the MCP server and single-tenant exporter flows. Legacy v1 configs auto-migrate transparently on read.
- **Config UI redesigned** ([scripts/config-server.ts](scripts/config-server.ts)) — tabbed multi-tenant interface (Talend Cloud / Qlik Cloud / Exporters / About) styled with the Qlik dev-portal palette (#009845 / #006580 / #19416C / Inter font). Add / edit / delete tenants, switch defaults, test connections against `/orchestration/environments` (Talend) and `/api/v1/users/me` (Qlik).
- **Python exporter control panel** — UI tab lists every Python exporter with live state from `docker compose ps`, plus active series count from `/metrics`. Start / Stop buttons fire `docker compose --profile X up -d / stop`.
- **Qlik Cloud observability exporter** ([python/exporters/qlik_obs_exporter.py](python/exporters/qlik_obs_exporter.py)) — polls Qlik Cloud platform APIs (apps, reloads, audits, quotas) for every configured tenant and emits `qlik_apps_total`, `qlik_reloads_total{status, app_id, space_id}`, `qlik_reload_duration_seconds`, `qlik_audit_events_total`, `qlik_quotas`. Each metric tagged with the `tenant` label.
- **Shared multi-tenant loader** ([python/common/tenants.py](python/common/tenants.py)) — reads the same v2 config file the UI writes. Soft-imports `keyring` so file-backed tenants work even when the native lib isn't installed.
- **MCP `observability` preset** — pure read-only: `observability-metrics`, `execution-logs`, `execution-history-search`. Drops `audit-logs` (identity events). The observability compose now uses this preset by default — tool surface drops from 315 → 9.
- **HELP.md** — master index of every external doc reference (Talend, Qlik, MCP, Prometheus, Loki, Grafana, prom-client, pyqvd, keyring, Trivy, etc.) at the project root.
- **PowerPoint architecture deck** — `Qlik-Observability-Toolkit-Architecture.pptx` (standalone, 186 KB) and `Qlik-Observability-Toolkit-Architecture-Qlik.pptx` (with the Qlik corporate template applied — 37 layouts + 29 media files, 3.8 MB). 5 slides: Cover, end-to-end architecture diagram, multi-tenant model, MCP presets + UI tabs, references. Built via [scripts/build-deck.mjs](scripts/build-deck.mjs); template applied via [scripts/apply-pptx-template.mjs](scripts/apply-pptx-template.mjs).

### Added
- **Three Python exporters** under [`python/`](python/), shipping as a single Docker image (`talend-tmc-python-exporters`):
  - **business-exporter** polls TMC Orchestration + Observability + Execution-History to emit `talend_tasks_total`, `talend_plans_total`, `talend_executions_total{status,workspace,environment}`, `talend_execution_duration_seconds` and friends.
  - **engine-log-scraper** tails Talend Remote Engine JSON logs on Linux (per [Qlik's docs](https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/job-management-logs)) and exposes `talend_engine_jobs_(started|succeeded|failed|terminated)_total`, `talend_engine_job_attempts`, `talend_engine_rejected_rows`, `talend_engine_last_event_timestamp`, etc.
  - **qvd-exporter** queries Prometheus on a schedule, writes long-form `(Timestamp, Metric, labels..., Value)` rows to a Qlik QVD via `pyqvd`, and uploads to Qlik Cloud via the Data Files API. Built specifically so analysts can pull DevOps/server/app performance data into a Qlik Sense app for deep BI / correlation / historical trend analysis.
- **Two new Grafana dashboards**: "Qlik Observability Toolkit" (server/infra, already existed) and "Talend TMC Business + Engine" (new). The latter has rows for TMC inventory + runs, Remote Engine job lifecycle, and QVD export health.
- **`TMC_APIS_PRESET=logging`** shortcut on the MCP server. The observability compose now uses it by default, trimming the tool surface to ~10 read-only logging/observability/audit tools instead of all 315.
- New docs: [docs/business-metrics.md](docs/business-metrics.md), [docs/qlik-export.md](docs/qlik-export.md).
- Compose profiles `business`, `engine`, `qlik`, `all` for opt-in exporter startup.

### Added
- **Prometheus metrics endpoint** at `GET /metrics` and a `/health` readiness probe — opt in with `TMC_METRICS_PORT`. Exposes counters/histograms for tool calls, retries, in-flight, upstream HTTP status, plus default Node.js process/eventloop/heap metrics.
- **Observability stack** in [`docker-compose.observability.yml`](docker-compose.observability.yml) — Prometheus + Loki + Promtail + Grafana, all pre-provisioned. Pre-built Grafana dashboard at [`deploy/grafana/dashboards/tmc-mcp.json`](deploy/grafana/dashboards/tmc-mcp.json) with overview stats, latency percentiles, retry breakdown, process health, and a live Loki log stream.
- **Promtail pipeline** parses the structured JSON logs and promotes `level` / `tool` to Loki labels, with `requestId` carried as searchable structured metadata. Grafana's Loki datasource has a derived-field link on `requestId` for one-click trace-from-metric-to-logs.
- New [docs/observability.md](docs/observability.md) — metric reference, PromQL recipes, dashboard tour.

### Added
- **Saved confirmation screen** in the config web UI — after Save succeeds, the form is replaced with a clear card showing storage backend, masked PAT hint, region, APIs, timeout, file path, timestamp, and next-step instructions. "Edit configuration" returns to the form.
- **Trivy + npm audit gates** wired into CI (image vuln + secret + Dockerfile misconfig + fs secret scans). HIGH/CRITICAL fails the build. See [docs/security-scans.md](docs/security-scans.md).
- [`.trivyignore`](.trivyignore) with one scoped suppression (the jwt.io demo token embedded in Talend's published OAuth OpenAPI spec).

### Changed
- Runtime Docker image strips the bundled `npm` CLI after build-time install. Cuts off a class of HIGH findings (npm's own transitive deps) that aren't reachable from `node dist/index.js`.

### Added
- **OS keyring backend** for PAT storage (macOS Keychain, Windows Credential Manager, libsecret on Linux).
  - New `TMC_CRED_STORE=file|keychain` env var.
  - `patStorage` field in `config.json` carries the choice (legacy configs without the field stay on `file`).
  - Setup wizard adds a "where to store?" prompt and `--cred-store=` non-interactive flag.
  - Config UI adds radio buttons; greys out the keyring option with a reason when the platform backend isn't available.
  - Migration between backends is atomic — the new store gets the PAT before the old one is cleaned up.
  - `@napi-rs/keyring` declared as `optionalDependency`; install with `--omit=optional` to skip the native module entirely (file backend still works).

## [1.0.0] - 2026-05-13

First production release.

### Added
- MCP server wrapping all 20 Talend Cloud API products — 315 auto-generated tools.
- Personal Access Token authentication (env var or config file).
- CLI setup wizard (`npm run setup`) with interactive masked input and non-interactive flags.
- Browser-based config page (`npm run config-ui`) bound to `127.0.0.1`.
- Multi-stage Docker image (alpine, non-root, ~180 MB, multi-arch).
- Structured JSON logging with automatic PAT redaction (`src/logger.ts`).
- HTTP retry with exponential backoff + jitter; honors `Retry-After`.
- Graceful shutdown on SIGTERM/SIGINT, drains in-flight tool calls.
- Per-call `requestId` surfaced in logs and tool responses for correlation.
- Result-size cap (256 KiB default, configurable) to keep the MCP transport responsive.
- Unit tests with `node:test`; 29 tests cover tool generation, $ref resolution, HTTP retry/error paths, and PAT redaction.
- ESLint + Prettier configs; `npm run check` runs lint + format + test + build.
- LICENSE (MIT), SECURITY.md, CONTRIBUTING.md.
- GitHub Actions CI workflow (lint, test, build, Docker build).

### Fixed
- SCIM v2 schemas with a property literally named `$ref` were previously silently dropped. Now preserved correctly.
- `parseApiList("")` returns `undefined` instead of `[]` so an empty `TMC_APIS` env var doesn't disable all APIs.

### Security
- PAT-shaped strings (`tcp_…`) and `Bearer …` tokens are redacted from log output everywhere.
- Config file written with `0600` permissions on POSIX.
- Config web UI rejects non-loopback connections regardless of bind host.
