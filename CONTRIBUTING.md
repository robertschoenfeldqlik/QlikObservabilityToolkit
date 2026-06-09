# Contributing

Thanks for being here. Quick rules of the road:

## Dev setup

```bash
npm install
npm run fetch-specs   # download OpenAPI specs
npm run build
npm test
```

You'll want a real Talend PAT (or a dummy one + `--no-verify`) to run the
setup wizard end-to-end. The smoke test (`npx tsx scripts/smoke-test.ts`) only
needs a placeholder.

## What we're not looking for

- Drive-by formatting PRs. Prettier is the source of truth — `npm run format` and `npm run lint:fix` should keep everything quiet.
- New runtime dependencies. The MCP server has exactly one (`@modelcontextprotocol/sdk`). If you have a strong case for another, open an issue first.
- Service-account OAuth without env-driven discovery. We'll add it — see [docs/development.md](docs/development.md#future-work) — but the design needs to flow through both the wizard and the web UI.

## What we love

- Bug reports with a failing test case attached.
- Spec-churn fixes: if Talend renames an operation and a tool name moves, drop a note in [docs/usage-examples.md](docs/usage-examples.md) and tweak [tests/tool-generator.test.ts](tests/tool-generator.test.ts).
- Better retry / error-mapping logic. Production reliability is the area we lean into hardest.

## Workflow

1. Fork → branch off `main`.
2. `npm run check` must pass locally before you open a PR:
   - `npm run lint`
   - `npm run format:check`
   - `npm test`
   - `npm run build`
3. Add or update tests for the behavior you're changing. If you're touching the OpenAPI → MCP translation in [src/tool-generator.ts](src/tool-generator.ts), a test in [tests/tool-generator.test.ts](tests/tool-generator.test.ts) is mandatory — that file is where every spec-churn regression lives.
4. PR description: include the *why* and any non-obvious tradeoffs.

## Code style

- Strict TypeScript (`strict: true`). Don't `// @ts-ignore` — fix the type.
- Comments explain *why*, not *what*. The code says what; the comment says why-this-not-the-obvious-thing.
- Stderr for logs, stdout for protocol. Inside `src/`, never `console.log` — use the logger from [src/logger.ts](src/logger.ts). Inside `scripts/`, stdout is fine (those don't run as MCP servers).
- Errors carry context (`requestId`, `attempts`, the offending tool name).

## Releasing

Maintainers only:

1. Bump `version` in `package.json` (semver).
2. Tag: `git tag v1.x.y && git push --tags`.
3. CI publishes the Docker image to the registry.
4. Update [CHANGELOG.md](CHANGELOG.md) (create if missing — keep "Keep a Changelog" format).

## License

By contributing, you agree your work is licensed under the MIT License
([LICENSE](LICENSE)).
