# Qlik Observability Toolkit — Documentation

An [MCP](https://modelcontextprotocol.io) server that exposes the **Talend
Cloud (TMC) REST API** as 315 strongly-typed tools, auto-generated from the
upstream OpenAPI 3.0 specs at <https://talend.qlik.dev/apis/>.

## Where to start

| If you want to… | Read |
| --- | --- |
| Install and run the server | [installation.md](./installation.md) |
| Set up your PAT and region (CLI wizard) | [setup-wizard.md](./setup-wizard.md) |
| Set up your PAT and region (web UI) | [config-ui.md](./config-ui.md) |
| Understand exactly how the PAT is stored end-to-end | [pat-storage.md](./pat-storage.md) |
| Wire the server into Claude Desktop / Claude Code | [clients.md](./clients.md) |
| Run the server as a Docker container | [docker.md](./docker.md) |
| Deploy the full stack on Kubernetes (minikube or EKS) | [k8s.md](./k8s.md) |
| See every tool, grouped by API | [api-reference/](./api-reference/README.md) |
| Route MCP calls to a specific tenant + list tenants | See "Multi-tenant routing" below |
| Drive common Talend workflows from Claude | [usage-examples.md](./usage-examples.md) |
| Tweak settings, env vars, or region | [configuration.md](./configuration.md) |
| Understand how the OpenAPI → MCP wiring works | [architecture.md](./architecture.md) |
| Tune logging, retries, signals, exit codes | [operations.md](./operations.md) |
| Scrape metrics into Prometheus + Grafana, ship logs to Loki | [observability.md](./observability.md) |
| Pull Talend business + Remote Engine job metrics into Prometheus | [business-metrics.md](./business-metrics.md) |
| Land Prometheus time-series into a Qlik Sense Cloud app as a QVD | [qlik-export.md](./qlik-export.md) |
| Fix something that's broken | [troubleshooting.md](./troubleshooting.md) |
| See / re-run security scans (Trivy, npm audit) | [security-scans.md](./security-scans.md) |
| Hack on the server, refresh specs, add features | [development.md](./development.md) |

## TL;DR

```bash
npm install
npm run fetch-specs       # download OpenAPI specs from Talend
npm run build
npm run setup             # interactive PAT + region setup (CLI)
# OR
npm run config-ui         # browser-based config page (localhost:8788)
node dist/index.js        # speaks MCP over stdio
```

## Project layout

```
TMC MPC/
├── src/                  TypeScript sources
│   ├── index.ts          MCP server entrypoint
│   ├── tool-generator.ts OpenAPI operation → MCP tool descriptor
│   ├── http-client.ts    fetch() client with PAT auth + region routing
│   ├── config.ts         on-disk config file loader
│   ├── spec-loader.ts    reads cached specs from specs/
│   ├── apis.ts           list of 20 TMC APIs + region endpoints
│   └── openapi-types.ts  minimal OpenAPI 3.0 type defs
├── scripts/              dev/ops scripts (run with `tsx`)
│   ├── setup.ts          interactive PAT/region wizard
│   ├── fetch-specs.ts    pulls OpenAPI specs into specs/
│   ├── gen-docs.ts       regenerates docs/api-reference/*.md
│   ├── list-tools.ts     prints every generated tool
│   └── smoke-test.ts     boots the server + tools/list round-trip
├── specs/                cached OpenAPI 3.0 JSON (20 files)
├── docs/                 you are here
└── dist/                 compiled output (gitignored)
```

## Multi-tenant routing

Every generated tool has an optional **`tenant`** parameter (string). Pass
the `id` of any configured Talend tenant to target it; omit to use the
default tenant.

There's also a built-in meta-tool, **`tmc_list_environments`**, that
returns every configured Talend + Qlik tenant — ids, labels, regions,
URL overrides, default flags, and credential-set status (but never the
secret itself). Use it to discover valid `tenant` IDs before calling
other tools.

```
tools/call name=tmc_list_environments  →  { talendTenants: [...], qlikTenants: [...] }
tools/call name=orchestration__getAvailableTasks  args={ "tenant": "dev-eu" }
```

Add / edit / delete tenants in the [config UI](./config-ui.md) or via
the [setup wizard](./setup-wizard.md). The MCP server reads them at
startup; restart to pick up changes.

## Status

- **MCP SDK:** `@modelcontextprotocol/sdk` ≥ 1.29
- **Talend API version:** `2021-03` (default — override via `TMC_API_VERSION`)
- **Tool count:** 315 across 20 APIs (verified by smoke test)
- **Auth:** Personal Access Token (Bearer header). Service-account OAuth flow not yet implemented — see [development.md](./development.md#future-work).
