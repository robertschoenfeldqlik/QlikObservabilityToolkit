# Development

## Toolchain

| Tool | Why |
| --- | --- |
| `typescript` | Source language; strict mode is on. |
| `tsx` | Run `.ts` files directly for scripts; no separate build step needed. |
| `@modelcontextprotocol/sdk` | The MCP `Server` and stdio transport. |
| `rimraf` | Cross-platform `rm -rf` for the `clean` script. |

No bundler, no test framework yet — the smoke test is hand-rolled.

## Common tasks

```bash
npm install          # one-time
npm run fetch-specs  # refresh specs from talend.qlik.dev
npm run build        # tsc → dist/
npm run dev          # run directly via tsx (no build step)
npm run docs         # regenerate docs/api-reference/*.md
npm run list-tools   # dump every generated tool name + route
npm run setup        # interactive PAT/region wizard
npm run clean        # rm -rf dist/
```

## Project layout (developer-oriented)

```
src/
├── index.ts              entrypoint; wires Server, ListTools, CallTool
├── apis.ts               canonical region + API list
├── config.ts             config-file loader
├── http-client.ts        fetch() + path/query/header/body assembly
├── openapi-types.ts      OpenAPI 3.0 type defs (minimal)
├── spec-loader.ts        reads specs/<api>.json
└── tool-generator.ts     operation → ToolDescriptor

scripts/
├── fetch-specs.ts        downloads upstream specs
├── gen-docs.ts           auto-generates docs/api-reference/*.md
├── list-tools.ts         diagnostic
├── setup.ts              interactive wizard (uses readline + raw mode)
└── smoke-test.ts         spawns dist/index.js and round-trips tools/list

specs/                    cached OpenAPI 3.0 JSON
docs/                     human guides + auto-gen reference
dist/                     compiled output (gitignored)
```

## Refreshing specs

Talend rolls minor spec updates every few months — new operations, fixed
`operationId`s, renamed properties. To pull the latest:

```bash
npm run fetch-specs
npm run docs           # regenerate the markdown reference
npm run build
```

The generator is resilient to spec churn — the only thing that ever broke us
was the SCIM `$ref` property edge case in [tool-generator.ts](../src/tool-generator.ts).

To target a different API version (default `2021-03`):

```bash
TMC_API_VERSION=2021-09 npm run fetch-specs
```

The version applies to all 20 APIs uniformly — there's no per-API version override yet.

## Adding an env var

1. Add the env var lookup in [src/index.ts](../src/index.ts), close to the
   other env reads at the top of `main()`.
2. Add a fallback to the config file via [src/config.ts](../src/config.ts) if
   it makes sense to persist.
3. Update the [configuration.md](./configuration.md) table.
4. Update [.env.example](../.env.example).
5. If the setup wizard should prompt for it, edit [scripts/setup.ts](../scripts/setup.ts).

## Adding a new authentication mode

Right now `TmcClient` only takes a PAT and shoves it into a `Bearer` header.
To add service-account OAuth client-credentials:

1. Add a discriminated union to `TmcClientOptions`: `{ kind: "pat"; pat: string } | { kind: "oauth"; clientId, clientSecret }`.
2. In `TmcClient.call`, before every fetch, check if a token is cached and
   non-expired; otherwise hit `POST /oauth/token` against the region's base URL
   to mint one.
3. Wire it in [src/index.ts](../src/index.ts) — detect which credentials are
   present (env vars or config file) and instantiate the right client.
4. Extend the setup wizard with a "PAT or service account?" prompt.
5. Document in [configuration.md](./configuration.md) and [setup-wizard.md](./setup-wizard.md).

## Debugging a single tool

The fastest loop is via `tsx`:

```bash
npx tsx --eval "
import { TmcClient } from './src/http-client.ts';
import { loadSpecs } from './src/spec-loader.ts';
import { generateToolsForSpec } from './src/tool-generator.ts';

const specs = await loadSpecs(['orchestration']);
const [{ api, spec }] = specs;
const tools = generateToolsForSpec(api, spec);
const tool = tools.find(t => t.name === 'orchestration__getAvailableWorkspaces');
const c = new TmcClient({ pat: process.env.TMC_PAT!, region: 'us' });
console.log(await c.call(tool!, {}));
"
```

Or use the MCP Inspector (see [clients.md](./clients.md#mcp-inspector)) and
call tools interactively.

## Smoke test

```bash
npm run build
npx tsx scripts/smoke-test.ts
```

This:
1. Spawns `dist/index.js` with the current env (or config-file credentials).
2. Sends `initialize` + `notifications/initialized` + `tools/list` JSON-RPC.
3. Asserts the response contains a `tools` array.
4. Prints the first tool's metadata.

Set `SMOKE_FORCE_ENV=1` to override credentials with a dummy PAT (won't hit
the network — only useful to confirm the server boots).

## Adding tests

There's no formal test suite. If you add one, things worth covering:

- `tool-generator.ts`:
  - Each spec under `specs/` should produce a non-empty descriptor array.
  - Tool names match `^[A-Za-z0-9_-]+$` and are ≤ 64 chars.
  - No name collisions within an API.
  - `$ref` cycles don't crash.
  - The SCIM `$ref`-property regression case.
- `http-client.ts`:
  - URL building for path/query/array-query params (mock `fetch`).
  - Body content-type handling for the 3 modes.
- `config.ts`:
  - Path resolution per OS (`process.platform = "win32"` vs `"linux"`).
  - ENOENT vs malformed JSON behavior.
- `spec-loader.ts`:
  - `TMC_APIS` filter trims correctly, errors on unknown names.

`vitest` would be the natural pick if you wanted ESM-friendly tests.

## Style

- **Strict TypeScript.** `tsconfig.json` has `strict: true`. Don't suppress —
  fix the type.
- **No comments that restate the code.** Reserve comments for the *why* of
  non-obvious bits (e.g. the SCIM workaround in `tool-generator.ts`).
- **Stderr for logs, stdout for protocol.** Never `console.log` from
  `src/` code — only `console.error`. Scripts under `scripts/` are fine to
  use stdout since they're not MCP transports.

## Future work

- **Service-account OAuth** (see above).
- **Pagination helpers.** Optional wrapper tools that auto-paginate the
  `*Available*` listing endpoints.
- **Response size limits.** Some endpoints can return MB of JSON; consider
  truncating with a hint to filter.
- **Operation aliases.** Friendlier names like `orchestration_listTasks` in
  addition to the verbose generated names.
- **Per-API version overrides** (instead of one `TMC_API_VERSION` global).
- **OpenAPI ↔ TypeScript type generation** so we get compile-time checking on body shapes.

## Release

There's no published npm package yet. To use this from outside the repo, the
simplest path is:

```bash
npm run build
# point your client at C:/path/to/repo/dist/index.js
```

If you want to publish:

1. Bump `version` in `package.json`.
2. Make sure `bin` and `main` point at `dist/index.js`.
3. `npm publish` (with `--access public` for scoped packages).
4. Users can then `npx talend-tmc-mcp` once published.
