# Help references

Single index of every external doc this project relies on. Sorted by
topic so you can find the right canonical source without re-searching.

> If you're reading the local docs, every page below is also linked from
> the spot where the corresponding feature is implemented or documented.
> This file is the master index.

## Talend Cloud (TMC)

| Topic | URL |
| --- | --- |
| Talend Cloud REST API catalog (all 20 APIs) | <https://talend.qlik.dev/apis/> |
| Orchestration API (Tasks / Plans / Schedules / Workspaces / etc.) | <https://talend.qlik.dev/apis/orchestration/2021-03/> |
| Observability Metrics API | <https://talend.qlik.dev/apis/observability-metrics/2021-03/> |
| Execution Logs API | <https://talend.qlik.dev/apis/execution-logs/2021-03/> |
| Execution History Search API | <https://talend.qlik.dev/apis/execution-history-search/2021-03/> |
| Audit Logs API | <https://talend.qlik.dev/apis/audit-logs/2021-03/> |
| SCIM v2 API | <https://talend.qlik.dev/apis/scim-v2/2021-03/> |
| Identities Management API | <https://talend.qlik.dev/apis/identities-management/2021-03/> |
| Service Accounts API (OAuth client-credentials) | <https://talend.qlik.dev/apis/service-accounts/2021-03/> |
| Connections / Datasets / Crawler | <https://talend.qlik.dev/apis/> (linked from the index) |
| **Remote Engine job-management logs (Linux)** | <https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/job-management-logs> |
| Remote Engine for Linux user guide | <https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/> |
| Personal Access Tokens (how to create one) | Talend Cloud Portal → Profile Preferences → Personal Access Tokens |

## Qlik Cloud

| Topic | URL |
| --- | --- |
| Qlik Cloud Platform Services API index (qlik.dev) | <https://qlik.dev/apis/> |
| **Data Files API** (where the QVD exporter uploads) | <https://qlik.dev/apis/rest/data-files/> |
| Apps API (qlik observability exporter source) | <https://qlik.dev/apis/rest/apps/> |
| Reloads API | <https://qlik.dev/apis/rest/reloads/> |
| Audit events API | <https://qlik.dev/apis/rest/audit/> |
| Quota API | <https://qlik.dev/apis/rest/quotas/> |
| Users API | <https://qlik.dev/apis/rest/users/> |
| **API key authentication** | <https://qlik.dev/authenticate/api-key/manage-api-keys/> |
| OAuth M2M (service-account style) | <https://qlik.dev/authenticate/oauth/> |
| Data connections — create + manage (UI palette reference) | <https://qlik.dev/manage/data-connections/create-data-connections/> |
| Tenant region URLs | <https://qlik.dev/manage/platform-operations/configure-and-administer-a-tenant/about-tenant-regions/> |
| **QVD file format** | <https://qlikcommunity.qlikgeek.com/t5/qlik-cloud-help/qvd-files/m-p/2058821> |
| Qlik load-script syntax | <https://help.qlik.com/en-US/sense/August2024/Subsystems/Hub/Content/Sense_Hub/Scripting/ScriptSyntax.htm> |

## Model Context Protocol (MCP)

| Topic | URL |
| --- | --- |
| MCP spec | <https://modelcontextprotocol.io/specification> |
| MCP TypeScript SDK | <https://github.com/modelcontextprotocol/typescript-sdk> |
| MCP Inspector (debug a server interactively) | <https://github.com/modelcontextprotocol/inspector> |
| MCP best practices | <https://modelcontextprotocol.io/docs/concepts/architecture> |
| Claude Desktop MCP integration | <https://modelcontextprotocol.io/quickstart/user> |
| Claude Code MCP integration | <https://docs.claude.com/en/docs/claude-code/mcp> |

## Observability stack

| Topic | URL |
| --- | --- |
| Prometheus — metric naming conventions | <https://prometheus.io/docs/practices/naming/> |
| Prometheus — query language (PromQL) | <https://prometheus.io/docs/prometheus/latest/querying/basics/> |
| Prometheus — histograms & summaries | <https://prometheus.io/docs/practices/histograms/> |
| `prom-client` (Node.js Prometheus client) | <https://github.com/siimon/prom-client> |
| `prometheus_client` (Python) | <https://github.com/prometheus/client_python> |
| Grafana provisioning (datasources + dashboards) | <https://grafana.com/docs/grafana/latest/administration/provisioning/> |
| Grafana dashboard JSON model | <https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/view-dashboard-json-model/> |
| Loki — single-binary deployment | <https://grafana.com/docs/loki/latest/setup/install/> |
| Loki — LogQL | <https://grafana.com/docs/loki/latest/query/> |
| Promtail — Docker service discovery | <https://grafana.com/docs/loki/latest/send-data/promtail/configuration/#docker_sd_config> |
| Promtail — pipeline stages (json / labels / structured_metadata) | <https://grafana.com/docs/loki/latest/send-data/promtail/stages/> |

## Python libraries

| Topic | URL |
| --- | --- |
| `pyqvd` — read/write QVD from Python | <https://pypi.org/project/pyqvd/> |
| `pyqvd` source / API reference | <https://github.com/MuellerConstantin/PyQvd> |
| `pandas` | <https://pandas.pydata.org/docs/> |
| `httpx` | <https://www.python-httpx.org/> |
| `structlog` (used for JSON logging) | <https://www.structlog.org/> |
| `PyYAML` | <https://pyyaml.org/wiki/PyYAMLDocumentation> |

## Container / build / security

| Topic | URL |
| --- | --- |
| Docker `HEALTHCHECK` reference | <https://docs.docker.com/reference/dockerfile/#healthcheck> |
| `dumb-init` (PID-1 signal forwarder) | <https://github.com/Yelp/dumb-init> |
| `tini` (alternate PID-1) | <https://github.com/krallin/tini> |
| Docker buildx (multi-arch) | <https://docs.docker.com/build/building/multi-platform/> |
| Trivy — image scanning | <https://trivy.dev/latest/docs/target/container_image/> |
| Trivy — secret scanner ignore IDs | <https://trivy.dev/latest/docs/scanner/secret/> |
| `npm audit` | <https://docs.npmjs.com/cli/v10/commands/npm-audit> |
| GitHub Actions `trivy-action` | <https://github.com/aquasecurity/trivy-action> |
| Dependabot config | <https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file> |

## OS keyring (PAT storage backend)

| Topic | URL |
| --- | --- |
| `@napi-rs/keyring` — Node binding to the system keyring | <https://github.com/Brooooooklyn/keyring-node> |
| macOS Keychain Services overview | <https://developer.apple.com/documentation/security/keychain_services> |
| Windows Credential Manager overview | <https://learn.microsoft.com/en-us/windows/win32/api/wincred/> |
| libsecret / Secret Service (Linux) | <https://wiki.gnome.org/Projects/Libsecret> |

## Other

| Topic | URL |
| --- | --- |
| `jwt.io` canonical demo token (the false-positive scanned in `specs/oauth.json`) | <https://jwt.io/> |
| Keep a Changelog format | <https://keepachangelog.com/en/1.1.0/> |
| Semantic Versioning | <https://semver.org/spec/v2.0.0.html> |
| MIT License (text used in [LICENSE](LICENSE)) | <https://opensource.org/license/mit/> |
| sysexits exit codes (78 = `EX_CONFIG`) | <https://man.freebsd.org/cgi/man.cgi?query=sysexits> |

## In-repo docs

| Doc | Topic |
| --- | --- |
| [docs/README.md](docs/README.md) | Index of all in-repo docs |
| [docs/installation.md](docs/installation.md) | Prerequisites + first boot |
| [docs/setup-wizard.md](docs/setup-wizard.md) | CLI setup wizard |
| [docs/config-ui.md](docs/config-ui.md) | Browser-based config page |
| [docs/configuration.md](docs/configuration.md) | Env vars and config file reference |
| [docs/pat-storage.md](docs/pat-storage.md) | Where the PAT lives end-to-end |
| [docs/clients.md](docs/clients.md) | Claude Desktop / Code / MCP Inspector wiring |
| [docs/docker.md](docs/docker.md) | Image build, multi-arch, healthcheck |
| [docs/operations.md](docs/operations.md) | Logging, retries, signals, exit codes |
| [docs/observability.md](docs/observability.md) | Prometheus + Loki + Grafana stack |
| [docs/business-metrics.md](docs/business-metrics.md) | Python exporters |
| [docs/qlik-export.md](docs/qlik-export.md) | Prometheus → QVD → Qlik Cloud |
| [docs/security-scans.md](docs/security-scans.md) | npm audit + Trivy results |
| [docs/architecture.md](docs/architecture.md) | OpenAPI → MCP tool wiring |
| [docs/development.md](docs/development.md) | Hacking on the code |
| [docs/troubleshooting.md](docs/troubleshooting.md) | What to check when something breaks |
| [docs/api-reference/](docs/api-reference/README.md) | Auto-generated per-API tool catalog |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting policy |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev workflow |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
