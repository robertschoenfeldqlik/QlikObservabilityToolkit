# Configuration

The server has two configuration sources, in this precedence order:

1. **Environment variables** (highest priority)
2. **Config file** written by `npm run setup`
3. **Built-in defaults** (lowest priority)

Env vars always win when both are present — this matches typical Claude
Desktop / Claude Code workflows where you set credentials in the MCP server
JSON config.

## Settings reference

| Name | Env var | Config-file key | Default | Required | Description |
| --- | --- | --- | --- | --- | --- |
| Personal Access Token | `TMC_PAT` | `pat` | — | ✔ (one of) | Bearer token sent as `Authorization: Bearer <PAT>` on every request. |
| Region | `TMC_REGION` | `region` | `us` | ✔ (one of) | One of `us`, `eu`, `ap`, `au`, `us-west`. Selects the base URL. |
| API filter | `TMC_APIS` | `apis` | (all 20) | — | Comma-separated subset, e.g. `orchestration,observability-metrics`. |
| API version | `TMC_API_VERSION` | — | `2021-03` | — | OpenAPI spec version segment (read at fetch/load time). |
| HTTP timeout (ms) | `TMC_TIMEOUT_MS` | `timeoutMs` | `60000` | — | Per-request timeout. |
| PAT storage backend | `TMC_CRED_STORE` | `patStorage` | `file` | — | `file` (plaintext in config.json) or `keychain` (OS credential manager). See [pat-storage.md](./pat-storage.md). |

"Required (one of)" means PAT and region must come from *either* env vars *or*
the config file, but not necessarily both.

## Region endpoints

| Region | Base URL |
| --- | --- |
| `us` | `https://api.us.cloud.talend.com` |
| `eu` | `https://api.eu.cloud.talend.com` |
| `ap` | `https://api.ap.cloud.talend.com` |
| `au` | `https://api.au.cloud.talend.com` |
| `us-west` | `https://api.us-west.cloud.talend.com` |

Pick the region your Talend Cloud tenant lives in — a PAT issued in one region
will return 401 against another.

## Config file format

```json
{
  "pat": "tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "region": "us",
  "apis": ["orchestration", "observability-metrics"],
  "timeoutMs": 60000,
  "patStorage": "file"
}
```

When `patStorage` is `"keychain"`, the `pat` field is absent — the token is
stored in the OS credential manager (macOS Keychain, Windows Credential
Manager, libsecret on Linux). See [pat-storage.md](./pat-storage.md).

Location:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\talend-tmc-mcp\config.json` |
| macOS / Linux | `$XDG_CONFIG_HOME/talend-tmc-mcp/config.json` (defaults to `~/.config/talend-tmc-mcp/config.json`) |

Run `npm run config-path` to print the resolved path on your system. The
wizard creates the parent directory and `chmod 600`s the file on POSIX.

## TMC_APIS — trimming the tool surface

315 tools is a lot of context for the model to consider. If your usage is
narrow (e.g. just running tasks and reading metrics), turn off APIs you don't
need:

```bash
# PowerShell
$env:TMC_APIS = "orchestration,observability-metrics,execution-logs"

# bash
export TMC_APIS="orchestration,observability-metrics,execution-logs"
```

Valid values:

```
orchestration              dataset                  connections
audit-logs                 observability-metrics    execution-logs
execution-history-search   identities-management    service-accounts
workspace-permissions      sso-role-mapping         ip-allowlist
oauth                      scim-v2                  seats-and-subscription
sharing                    processing               crawler
dynamic-engine             dynamic-engine-environments
```

See [api-reference/README.md](./api-reference/README.md) for tool counts per API.

## Precedence examples

| Env var set? | Config file set? | Effective value |
| --- | --- | --- |
| `TMC_REGION=eu` | `{ "region": "us" }` | `eu` (env wins) |
| — | `{ "region": "us" }` | `us` (file wins) |
| — | — | `us` (default) |
| `TMC_PAT=abc` | `{ "pat": "xyz" }` | `abc` (env wins) |
| — | `{ "pat": "xyz" }` | `xyz` |
| — | — | startup error |

## Logging

The server logs to **stderr only** — stdout is reserved for the MCP JSON-RPC
transport. Don't pipe stdout anywhere you'll be tempted to grep.

A normal boot prints one stderr line like:

```
Loaded 20 Talend API spec(s), exposing 315 tools. Region: us (https://api.us.cloud.talend.com).
```

Errors are written to stderr with an `ERROR:` prefix and a non-zero exit.

## Security notes

For the full trace of where the PAT lives (sources → memory → wire → logs)
and the threat model, see **[pat-storage.md](./pat-storage.md)**.

Short version:

- The config file holds your PAT in plaintext. Treat it like an SSH key. The
  setup wizard `chmod 600`s it on POSIX; Windows ACLs are not adjusted.
- Don't commit `config.json` to source control. It lives outside the repo, so
  this only matters if you copy it in.
- PATs can be revoked from the Talend Cloud Portal at any time — do this
  immediately if you suspect a leak.
- Env vars are visible to other processes running as your user. For shared
  hosts, the config file is a slightly safer location than `~/.bashrc`.
