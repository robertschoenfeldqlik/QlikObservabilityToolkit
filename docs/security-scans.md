# Security scans

Status of the npm-audit and Trivy gates that run on every CI build.

## Snapshot

| Scanner | Target | Severity gate | Result |
| --- | --- | --- | --- |
| `npm audit` | runtime deps (`--omit=dev`) | any vuln fails | **0 vulnerabilities** |
| `npm audit` | full tree (incl. dev) | `--audit-level=high` fails | **0 vulnerabilities** |
| Trivy image | `talend-tmc-mcp:latest` (vuln + secret) | HIGH / CRITICAL fails | **clean** (with [.trivyignore](../.trivyignore)) |
| Trivy fs | repo (misconfig + secret) | HIGH / CRITICAL fails | **clean** (with [.trivyignore](../.trivyignore)) |

## How to run locally

### npm audit

```bash
# Production deps only — what actually ships
npm audit --omit=dev

# Full tree, fail on high+critical
npm audit --audit-level=high
```

### Trivy (image)

If you have `trivy` on your PATH:

```bash
trivy image --severity HIGH,CRITICAL --ignorefile .trivyignore --exit-code 1 talend-tmc-mcp:latest
```

If not, run it via Docker (no install needed):

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:/work:ro" \
  aquasec/trivy:latest image \
  --severity HIGH,CRITICAL \
  --ignorefile /work/.trivyignore \
  --exit-code 1 \
  talend-tmc-mcp:latest
```

On Windows / PowerShell, the Docker socket mount uses a double slash:

```powershell
docker run --rm `
  -v //var/run/docker.sock:/var/run/docker.sock `
  -v "${PWD}:/work:ro" `
  aquasec/trivy:latest image `
  --severity HIGH,CRITICAL `
  --ignorefile /work/.trivyignore `
  --exit-code 1 `
  talend-tmc-mcp:latest
```

### Trivy (filesystem — misconfig + secret)

```bash
docker run --rm -v "$PWD:/work:ro" aquasec/trivy:latest \
  fs --scanners misconfig,secret \
     --severity HIGH,CRITICAL \
     --ignorefile /work/.trivyignore \
     --exit-code 1 \
     /work
```

## What was found, what we did

### `picomatch@4.0.3` — HIGH (CVE-2026-33671)
**Where:** bundled `npm` CLI inside the `node:22-alpine` base image, at
`/usr/local/lib/node_modules/npm/...`. Not in our app's `node_modules`.
**Reachable from runtime?** No. The MCP server runs `node dist/index.js`
and never shells out to `npm`.
**Fix:** Strip the bundled `npm` (and yarn) from the runtime stage of the
[Dockerfile](../Dockerfile). We use `npm` at build time only; the runtime
container doesn't need it.

### `jwt-token` finding in `specs/oauth.json:131` — MEDIUM (false positive)
**Where:** Talend's published OAuth OpenAPI spec includes an `example`
value for the `access_token` response. The example string is the
canonical jwt.io demo token (`sub: "1234567890"`, `name: "John Doe"`,
`iat: 1516239022`) — a well-known public sample, not a credential.
**Fix:** Suppressed in [.trivyignore](../.trivyignore) with a comment
explaining the rationale. The suppression is scoped to that specific
finding ID and is the only entry in the ignore file.

## CI integration

The [`trivy`](../.github/workflows/ci.yml) job in CI runs after the
lint/test/build matrix:

- Builds a local image (`talend-tmc-mcp:ci`).
- Trivy image scan (`vuln,secret`), HIGH/CRITICAL gated, `.trivyignore` applied.
- Trivy filesystem scan (`misconfig,secret`) on the repo, HIGH/CRITICAL gated.
- Either scan finding an unfiltered HIGH/CRITICAL fails the build.

Dependabot keeps base image and npm deps fresh
([.github/dependabot.yml](../.github/dependabot.yml)).

## Why the ignorefile is short

We deliberately keep [`.trivyignore`](../.trivyignore) minimal. Every entry needs:

- A clear reason (one comment block per suppression).
- A scope as narrow as the scanner supports.
- A re-review every time we refresh specs or bump the base image.

If you find yourself adding more than a handful of entries, prefer
upgrading or removing the offending dependency over ignoring its finding.

## Manual review cadence

- **Weekly**: Dependabot PRs land; review and merge after CI green.
- **On every Talend spec refresh** (`npm run fetch-specs`): re-run Trivy
  in case Talend added new example tokens or secret-shaped strings.
- **On every base-image bump**: re-run Trivy; bundled-npm CVEs come and go.
