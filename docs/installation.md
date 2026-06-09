# Installation

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 18 | 20 LTS or 22 LTS recommended. `node --version` to check. |
| npm | ≥ 9 | Bundled with Node. |
| Talend Cloud account | — | With a PAT scope that covers the APIs you want to use. |
| OS | Windows / macOS / Linux | All paths in this doc assume Windows; macOS/Linux work identically with forward slashes. |

## Install

```bash
git clone <this repo>          # or copy the directory
cd "TMC MPC"
npm install
```

This pulls one runtime dependency (`@modelcontextprotocol/sdk`) and a small
dev set (`typescript`, `tsx`, `rimraf`, `@types/node`).

## Fetch the OpenAPI specs

The server reads cached OpenAPI specs from `specs/`. Populate that directory
the first time, and any time Talend publishes spec changes:

```bash
npm run fetch-specs
```

It downloads 20 JSON files (~3 MB total) from
`https://talend.qlik.dev/apis/<api>/2021-03/openapi30.json`. No auth is needed
for the docs site — these are public specs.

Override the API version if you need to target a non-default release:

```bash
# PowerShell
$env:TMC_API_VERSION="2021-09"; npm run fetch-specs

# bash
TMC_API_VERSION=2021-09 npm run fetch-specs
```

## Build

```bash
npm run build
```

Compiles TypeScript into `dist/`. The MCP entrypoint is `dist/index.js`.

For development you can skip the build and run directly:

```bash
npm run dev
```

## Configure credentials

Two options:

1. **Setup wizard (recommended):** `npm run setup` — see [setup-wizard.md](./setup-wizard.md).
2. **Environment variables:** export `TMC_PAT` and `TMC_REGION` — see [configuration.md](./configuration.md).

## Verify

Run the smoke test — it boots the server and confirms `tools/list` returns the default 9 tools (the `observability` preset's 8 tools plus the `tmc_list_environments` meta-tool):

```bash
npm run build
npx tsx scripts/smoke-test.ts
```

Expected output:

```
stderr: Loaded 3 Talend API spec(s), exposing 8 tools. Region: us (https://api.us.cloud.talend.com).
tools/list returned 9 tools
First tool: observability_metrics__get_monitoring_observability_executions_e
```

If you see `ERROR: No Personal Access Token found`, your credentials aren't
configured yet — run `npm run setup` or set `TMC_PAT`.

## Next

- Hook the server into a client → [clients.md](./clients.md)
- Browse the tool catalog → [api-reference/](./api-reference/README.md)
- Read about how the generator works → [architecture.md](./architecture.md)
