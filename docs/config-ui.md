# Web config page

`npm run config-ui` starts a small local web server (Node's built-in `http`,
no extra deps) that serves a browser-based version of the setup wizard.
Same config file, same validation, just a friendlier UI.

## Launch

```bash
npm run config-ui
```

Output:

```
Qlik Observability Toolkit — Configuration UI
  http://127.0.0.1:8788/
  Press Ctrl-C to stop.
```

Your default browser opens automatically. Press **Ctrl-C** (or click "Shut down UI"
in the page) when done.

## What's on the page

| Panel | What it does |
| --- | --- |
| **Region** | Dropdown of all five regions. Pre-selected to the existing config or `us`. |
| **Personal Access Token** | Password-style input with show/hide. Blank = keep the existing token. |
| **Where to store the token** | Radio buttons: config file (default) or OS keyring. Keyring option is disabled with a reason if the platform backend isn't available. See [pat-storage.md](./pat-storage.md). |
| **APIs to load** | Checkbox grid for all 20 TMC APIs. Quick buttons: *Select all*, *Clear*, *Core* (orchestration + observability + logs). Blank = all 20. |
| **HTTP timeout** | Numeric input (milliseconds). |
| **Test connection** | Hits `GET /orchestration/environments` against the chosen region with the entered PAT. Reports 200/401/403 with a human-readable explanation. |
| **Save** | Writes the same JSON config that `npm run setup` produces. |
| **Delete config** | Removes the config file entirely (with confirmation). |
| **Shut down UI** | Stops the local web server. |

The footer always shows the resolved config path and whether one exists yet.

## Security

- Server binds to **127.0.0.1 only**. Connections from any other interface
  are rejected with HTTP 403.
- The PAT is **never sent to the browser**. The "current token" display only
  shows a `••••` hint with the last 4 characters of the stored token.
- The config file is `chmod 600` on POSIX.
- No CSRF token is used — localhost binding is the boundary.

> **Don't override `TMC_CONFIG_HOST` to bind to `0.0.0.0`** unless you fully
> understand the implications. The server doesn't authenticate callers
> beyond the localhost check; binding to other interfaces exposes
> PAT-writing endpoints to your network.

## Environment overrides

| Var | Default | Effect |
| --- | --- | --- |
| `TMC_CONFIG_PORT` | `8788` | Starting port. Auto-increments up to 10 times on `EADDRINUSE`. |
| `TMC_CONFIG_HOST` | `127.0.0.1` | Don't change. |
| `TMC_CONFIG_NO_OPEN` | unset | Set to `1` to skip the auto-open browser step (useful for SSH / WSL). |

## Wizard vs. web page vs. env vars

All three set the same `config.json`. Pick whichever you prefer:

| Method | When to use |
| --- | --- |
| `npm run setup` (CLI wizard) | Terminal-only environments, SSH sessions, CI pipelines. Supports `--pat=` / `--region=` for fully unattended runs. |
| `npm run config-ui` (this page) | Local dev machine, you want to see the full API grid and pick easily. |
| Env vars (`TMC_PAT`, `TMC_REGION`) | The MCP client (Claude Desktop, Claude Code) is already setting env in its config JSON. |

The MCP server reads env vars first, then the config file — so it doesn't
matter which tool wrote the file as long as one of the sources is set.

## How it works

A single Node.js process exposes:

| Endpoint | Method | Behavior |
| --- | --- | --- |
| `/` | GET | Returns the HTML page (inline, no static files). |
| `/api/config` | GET | Returns a snapshot: path, regions, available APIs, current values (PAT redacted). |
| `/api/config` | POST | Saves the config. If `pat` is empty, falls back to the existing token on disk. |
| `/api/config` | DELETE | Removes the config file. |
| `/api/validate` | POST | Calls `GET /orchestration/environments` against the requested region. Returns 401/403/200 with a message. |
| `/api/shutdown` | POST | Stops the server. |

No frameworks, no client-side build step. The HTML / CSS / JS lives inline
in [scripts/config-server.ts](../scripts/config-server.ts).

## Troubleshooting

**Browser doesn't open automatically**
Some environments (WSL, headless servers, locked-down Windows) refuse the
auto-open call. Copy the URL from the terminal manually. Use
`TMC_CONFIG_NO_OPEN=1` to silence the attempt.

**`EADDRINUSE` even after the port-bump loop**
Something else is hogging ports 8788–8797. Override with
`TMC_CONFIG_PORT=9000 npm run config-ui`.

**Saved successfully but the MCP server still complains**
You probably need to restart the MCP server (or your MCP client). The
server reads the config file at startup only.

**Forgot to test the connection and got 401 later**
Re-run the UI and click *Test connection* before saving. Or just run the
[CLI wizard](./setup-wizard.md), which validates every time.

**Worried about exposing the PAT in the browser**
The PAT you paste is sent to the server (over localhost only) and stored
to disk. The browser never *receives* a PAT back from the server — only the
last-4 hint. View the network tab in your browser to confirm.

**Want the full picture of where the PAT ends up?**
See [pat-storage.md](./pat-storage.md) — it traces the token through every
layer of the system (env, config file, memory, wire, logs, Docker).
