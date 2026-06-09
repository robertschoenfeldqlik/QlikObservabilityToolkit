# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue in this MCP server, **please do
not open a public GitHub issue**. Instead:

1. Email the maintainer at the address listed in `package.json` (`bugs.url` /
   `author`) with subject prefix `[SECURITY]`.
2. Include:
   - A description of the issue and its impact.
   - Steps to reproduce (proof-of-concept welcome but not required).
   - Affected versions (output of `npm ls talend-tmc-mcp`).
   - Your suggested remediation, if any.

You should receive an initial acknowledgement within **5 business days**.
We'll work with you on a coordinated disclosure timeline; the default
embargo is 90 days from acknowledgement.

## In scope

- Anything that leaks Personal Access Tokens (PATs) into logs, error messages,
  network traffic, image layers, or tool responses.
- Anything that lets an MCP client read or write files outside the project
  working directory.
- The local config UI binding to anything other than `127.0.0.1`, or
  responding to non-loopback origins.
- Server-side request forgery (SSRF) — i.e. tricking the server into
  hitting an arbitrary URL.
- Privilege escalation in the Docker image (e.g. dropping out of the
  `node` user).
- Any path where a malicious tool argument triggers RCE.

## Out of scope

- Vulnerabilities in upstream Talend Cloud APIs themselves — report those to
  Talend / Qlik directly.
- DoS via legitimate API usage (rate-limiting is Talend's concern).
- Issues that require local administrator access or physical access to the
  user's machine.
- Reports about features the server doesn't have (we don't implement
  OAuth client-credentials, sampling, resources, etc. — yet).

## Supported versions

| Version | Security fixes |
| --- | --- |
| 1.x (latest minor) | ✅ |
| 0.x | ❌ — please upgrade |

We follow semver. Patches go to the latest minor; we'll backport critical
fixes one minor on request.

## How PAT storage works

See [docs/pat-storage.md](docs/pat-storage.md) for a complete trace — sources,
at-rest storage, in-memory handling, logging redaction, Docker handling,
rotation, and threat model.

## Hardening notes (what's already in place)

- The server reads PATs from env vars or a mode-`600` config file. Both are
  redacted from log output via the `redact()` helper (any key matching
  `pat` / `token` / `Authorization`, plus inline `Bearer …` and `tcp_…`
  patterns inside string values).
- The config-web-UI binds to `127.0.0.1` and rejects connections from any
  other `remoteAddress` even if the host is changed by env.
- The Docker image runs as the non-root `node` user under `dumb-init`. Build
  args do not bake the PAT into image layers.
- HTTP retries include jittered exponential backoff to avoid stampede on
  recovering APIs.
- `npm audit` is run as part of CI; releases require 0 critical/high
  advisories.

## Dependency security

Reduced surface area is deliberate:

- 1 runtime dependency (`@modelcontextprotocol/sdk`) + 1 *optional* (`@napi-rs/keyring`).
- All scripts (setup, config-server, doc-gen, smoke-test) use Node's
  built-in `http`, `fs`, `readline`, and `child_process`.

When a dependency hits CVSS ≥ 7.0 we'll publish a patch release within 7
days of public disclosure.

## Scan results

CI runs `npm audit` and Trivy on every push/PR. See
[docs/security-scans.md](docs/security-scans.md) for the current status,
local-reproduction commands, and the rationale for every entry in
[`.trivyignore`](.trivyignore).
