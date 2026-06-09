<!-- markdownlint-disable MD013 -->
<div align="center">

# Qlik Observability Toolkit

**One-stop observability for Talend Cloud, Talend Remote Engines, and Qlik Cloud — with MCP integration for Claude and a bridge into Qlik Sense apps.**

[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF)](.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-009845)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)
[![Python](https://img.shields.io/badge/python-3.12-3776AB)](python/requirements.txt)
[![Tests](https://img.shields.io/badge/tests-71_passing-009845)](#-development--testing)

</div>

---

## What's in the box

A complete, production-shaped observability stack for **Talend Cloud + Talend Remote Engine + Qlik Cloud**, deployable on Docker Compose, minikube, or EKS, and wired into Claude through MCP. Designed for organizations that run Talend pipelines and want their pipeline health visible in Grafana **and** their Qlik Sense analysts able to correlate it with business data.

| Layer | What it does |
|---|---|
| **MCP server** ([src/](src/)) | Auto-generates 315 MCP tools from Talend Cloud's published OpenAPI specs. Every tool routes by tenant. Restartable to one of four observability presets. Includes a `tmc_list_environments` meta-tool so the model can discover configured tenants. |
| **Python exporters** ([python/](python/)) | 4 exporters that emit Prometheus metrics: TMC business (tasks/plans/executions), Remote Engine job logs (multi-source on one /metrics endpoint), Qlik Cloud platform (apps/reloads/audits/quotas), and Prometheus→QVD (lands time-series in Qlik Cloud for analyst BI). |
| **Observability stack** ([docker-compose.observability.yml](docker-compose.observability.yml)) | Prometheus + Loki + Promtail + Grafana, all pre-provisioned with two dashboards and the right scrape targets. Profile-gated so you opt into exporters individually. |
| **Configuration UI** ([scripts/config-server.ts](scripts/config-server.ts)) | Local web UI bound to `127.0.0.1`. Manages N Talend tenants + N Qlik tenants, controls Python exporters via `docker compose`, triggers QVD uploads, publishes data products, picks themes (light/dark/high-contrast), reveals stored tokens on demand. |
| **Kubernetes deployment** ([deploy/k8s/](deploy/k8s/)) | Kustomize with `base/` + `overlays/{minikube,eks}/`. EKS overlay includes ALB Ingress, gp3 storage, IRSA, and external-secrets pulling from AWS Secrets Manager. |

---

## Quickstart

### 1. Set up credentials

```bash
git clone https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit.git
cd QlikObservabilityToolkit
npm install
npm run fetch-specs     # pull Talend Cloud OpenAPI specs
npm run build
npm run config-ui       # opens http://127.0.0.1:8788 in your browser
```

In the UI:
1. **Talend Cloud** tab → add one or more tenants (PAT, region, optional custom URL).
2. **Qlik Cloud** tab → add one or more tenants (tenant URL, API key, Data Files connection ID).
3. (Optional) **About** → enable encryption at rest, pick your theme.

### 2. Stand up the observability stack

```bash
docker compose -f docker-compose.observability.yml --profile all up -d
```

Opens:
- Grafana → http://localhost:3000 (admin / admin) — pre-loaded with two dashboards
- Prometheus → http://localhost:9090
- Loki → http://localhost:3100
- MCP `/metrics` → http://localhost:9464/metrics

### 3. Wire the MCP server into Claude

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "qlik-observability": {
      "command": "node",
      "args": ["/path/to/QlikObservabilityToolkit/dist/index.js"]
    }
  }
}
```

Then ask Claude:
> List my configured Talend environments.

It will call `tmc_list_environments` and show every tenant. Then:
> Show me failed executions from the dev-eu tenant in the last hour.

It will call the right Talend tool with `tenant: "dev-eu"`.

---

## Architecture

```
        Talend Cloud tenants                 Qlik Cloud tenants
        (multiple PATs)                      (multiple API keys)
              │                                    │
              ▼                                    ▼
    ┌──────────────────┐               ┌─────────────────────┐
    │  MCP server      │               │  Python exporters   │
    │  (observability  │  /metrics─┐   │  - business         │
    │   preset, ~9     │           │   │  - engine-logs (N→1)│  /metrics
    │   tools per      │           │   │  - qlik-obs         │ ────┐
    │   tenant)        │           │   │  - qvd-exporter     │     │
    └──────────────────┘           │   └─────────┬───────────┘     │
                                   │             │                 │
                                   └─────►  Prometheus  ◄──────────┘
                                                │
                                  ┌─────────────┼─────────────┐
                                  ▼             ▼             ▼
                              Grafana         Loki        Qlik Sense
                          (2 dashboards) (structured     Cloud app
                                          JSON logs)    (QVD-driven
                                                         trend/BI)
                                                            ▲
                                                            │ pyqvd + Data Files API
                                                  Prometheus → QVD → Qlik Cloud
                                                       (qvd-exporter)
```

There's a 5-slide PowerPoint version too: [`Talend-TMC-MCP-Architecture-Qlik.pptx`](Talend-TMC-MCP-Architecture-Qlik.pptx) (built on the Qlik corporate template).

---

## Documentation

| Topic | Doc |
|---|---|
| Where every doc lives | [docs/README.md](docs/README.md) |
| Install & first boot | [docs/installation.md](docs/installation.md) |
| Setup wizard (CLI) | [docs/setup-wizard.md](docs/setup-wizard.md) |
| Config UI (web, multi-tenant) | [docs/config-ui.md](docs/config-ui.md) |
| Env vars + config file reference | [docs/configuration.md](docs/configuration.md) |
| **PAT / API-key storage end-to-end (encryption, keyring)** | [docs/pat-storage.md](docs/pat-storage.md) |
| Claude Desktop / Code / MCP Inspector wiring | [docs/clients.md](docs/clients.md) |
| Docker image build / run / healthcheck | [docs/docker.md](docs/docker.md) |
| Kubernetes (minikube + EKS) | [docs/k8s.md](docs/k8s.md) |
| Logging, retries, signals, exit codes | [docs/operations.md](docs/operations.md) |
| Prometheus `/metrics` + Grafana dashboards + Loki | [docs/observability.md](docs/observability.md) |
| Python exporters (business + engine + qlik-obs) | [docs/business-metrics.md](docs/business-metrics.md) |
| Prometheus → Qlik Cloud QVD pipeline | [docs/qlik-export.md](docs/qlik-export.md) |
| OpenAPI → MCP wiring internals | [docs/architecture.md](docs/architecture.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Security scans (Trivy, npm audit) | [docs/security-scans.md](docs/security-scans.md) |
| Hacking on the code | [docs/development.md](docs/development.md) |
| **Master index of every external reference** | [HELP.md](HELP.md) |

---

## Security posture

| What | How |
|---|---|
| **Secrets at rest** | AES-256-GCM with a master key from the OS keyring (auto-generated) or `TMC_MASTER_PASSPHRASE`. Plaintext configs migrate on opt-in. See [src/encryption.ts](src/encryption.ts). |
| **Secrets in transit** | TLS to Talend + Qlik (system trust store). Bearer tokens never proxied back to MCP clients. |
| **Secrets in logs** | Multi-layer redactor: known-secret field names + `Bearer …` + `tcp_…` patterns. See [src/logger.ts](src/logger.ts). |
| **OS keyring backend** | macOS Keychain / Windows Credential Manager / libsecret. Per-tenant accounts (`talend:<id>`, `qlik:<id>`). |
| **UI binding** | `127.0.0.1` only. Server explicitly rejects non-loopback `remoteAddress` even if `TMC_CONFIG_HOST` is overridden. |
| **Audit trail** | Every "reveal stored token" UI action logs to stderr with timestamp + tenant id. |
| **Container hardening** | Non-root `node` user, `dumb-init` PID 1, no bundled npm in runtime, multi-arch images (amd64+arm64). |
| **CI scans** | npm audit + Trivy (image vuln + secret + Dockerfile misconfig) gate every PR on HIGH/CRITICAL. See [docs/security-scans.md](docs/security-scans.md). |

---

## Multi-tenancy in one paragraph

The config file (`config.json`) is a list of Talend tenants (each with its own PAT, region, optional URL override) and a list of Qlik tenants (each with its own API key, tenant URL, optional Data Files connection ID). One tenant per service is the **default** — the MCP server picks it up at startup and the Python exporters use it for single-tenant operations. **Every MCP tool also accepts an optional `tenant` parameter** that overrides the default per call. The Python exporters that need multi-tenant fan-out (business + qlik-obs) iterate every configured tenant and tag every metric with a `tenant` label. There's also a `remoteEngines[]` array for Talend Remote Engines (multiple log directories fed into a single `/metrics` endpoint with an `engine` label per source).

---

## npm scripts

| Script | What it does |
|---|---|
| `npm run setup` | Interactive CLI wizard (single-tenant flow). |
| `npm run config-ui` | Browser-based multi-tenant UI on `127.0.0.1:8788`. |
| `npm run fetch-specs` | Download all 20 Talend OpenAPI specs into `specs/`. |
| `npm run build` | Compile TypeScript → `dist/`. |
| `npm start` | Run the compiled MCP server. |
| `npm run dev` | Run the server straight from TypeScript. |
| `npm test` | Run the `node:test` suite (71 tests). |
| `npm run lint` / `format` / `check` | ESLint / Prettier / full quality gate. |
| `npm run docs` | Regenerate the per-API doc reference. |
| `npm run docker:build` | Build `talend-tmc-mcp:latest`. |
| `npm run docker:build:multiarch` | Buildx for `linux/amd64` + `linux/arm64`. |
| `npm run docker:run` | One-shot `docker run` with `--env-file .env`. |

---

## Layout

```
QlikObservabilityToolkit/
├── src/                          # MCP server (TypeScript)
│   ├── index.ts                  #   entrypoint, multi-tenant dispatch
│   ├── tool-generator.ts         #   OpenAPI → MCP tool descriptors
│   ├── http-client.ts            #   per-call retry, jitter, Retry-After
│   ├── credential-store.ts       #   multi-tenant + keyring + encryption
│   ├── encryption.ts             #   AES-256-GCM at-rest
│   ├── config.ts                 #   v2 schema (multi-tenant)
│   ├── logger.ts                 #   JSON logging + redaction
│   ├── metrics.ts                #   prom-client registry
│   ├── metrics-server.ts         #   /metrics + /health HTTP
│   ├── spec-loader.ts            #   spec cache + presets
│   └── apis.ts                   #   region + API lists
├── python/                       # Python exporters
│   ├── exporters/
│   │   ├── business_exporter.py
│   │   ├── engine_log_scraper.py
│   │   ├── qlik_obs_exporter.py
│   │   └── qvd_exporter.py
│   └── common/                   #   shared tmc + qlik clients, tenants loader, logging
├── scripts/                      # tsx-based dev/ops scripts
│   ├── config-server.ts          #   the UI server
│   ├── setup.ts                  #   CLI wizard
│   ├── build-deck.mjs            #   PowerPoint builder
│   ├── apply-pptx-template.mjs   #   .potx → .pptx merger
│   └── ...
├── tests/                        # node:test unit + integration tests
├── specs/                        # cached Talend OpenAPI 3.0 specs
├── deploy/                       # ops artifacts
│   ├── prometheus.yml
│   ├── loki-config.yml
│   ├── promtail-config.yml
│   ├── grafana/{datasources,dashboards}/
│   ├── sample-engine-logs/       #   fixture for the engine scraper
│   ├── sample-config/            #   empty config for container mounts
│   └── k8s/                      #   Kustomize base + overlays
│       ├── base/
│       └── overlays/{minikube,eks}/
├── docs/                         # human-curated documentation
│   └── api-reference/            #   auto-generated per-API tool catalog
├── .github/workflows/ci.yml      # CI: lint, test, build, smoke, Trivy
├── docker-compose.observability.yml
├── Dockerfile                    # multi-stage, alpine, non-root, dumb-init
├── HELP.md                       # every external doc reference
├── Talend-TMC-MCP-Architecture.pptx       # standalone deck
└── Talend-TMC-MCP-Architecture-Qlik.pptx  # with Qlik corporate template
```

---

## Development & testing

```bash
npm install
npm run fetch-specs
npm run check    # lint + format:check + test + build
```

71 tests covering:
- OpenAPI → MCP tool generation (naming, `$ref` resolution, multi-tenant injection)
- HTTP client (retry, jitter, Retry-After, error classification, multi-tenant routing)
- Credential store (file + keychain + encryption migration)
- Logger redaction (Bearer, `tcp_…`, known-secret keys)
- Metrics + metrics server (/metrics + /health)
- Multi-tenant snapshot + default-tenant switching
- **AES-256-GCM at-rest** (round-trip, tamper detection, plaintext back-compat)

End-to-end smoke tests:
- `scripts/smoke-test.ts` — generic boot + tools/list round-trip
- `scripts/smoke-test-multitenant.ts` — 9-check suite for multi-tenant routing + meta-tool

---

## License

MIT — see [LICENSE](LICENSE).

External docs referenced throughout: see [HELP.md](HELP.md).
