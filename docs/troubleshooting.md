# Troubleshooting

## Boot-time errors

### `ERROR: No Personal Access Token found.`

Neither `TMC_PAT` is set nor a config file exists. Run `npm run setup` or
export `TMC_PAT`. Full details in [setup-wizard.md](./setup-wizard.md).

### `ERROR: region="xyz" is invalid.`

`TMC_REGION` or the config file's `region` field isn't one of `us`, `eu`,
`ap`, `au`, `us-west`. Pick the region your Talend Cloud tenant lives in
(visible in the Portal URL — `eu.cloud.talend.com` ⇒ `eu`).

### `No specs could be loaded from .../specs.`

Run `npm run fetch-specs`. It downloads 20 JSON files from
`https://talend.qlik.dev/apis/<api>/2021-03/openapi30.json`. No auth needed.

If the fetch itself fails:
- Corporate proxy: set `HTTPS_PROXY` env var before re-running.
- `talend.qlik.dev` blocked: confirm with `curl https://talend.qlik.dev/`.
- Cert error on Windows behind a TLS-intercepting proxy: set
  `NODE_EXTRA_CA_CERTS=path\to\corporate-ca.pem`.

### `TMC_APIS contains unknown values: xyz`

Typo. See the valid list in [configuration.md](./configuration.md#tmc_apis--trimming-the-tool-surface).
Note: hyphens, not underscores — it's `observability-metrics`, not
`observability_metrics`.

### `Failed to read <path>/config.json`

The file exists but isn't valid JSON. Most common cause is a half-written
config from an interrupted setup. Delete it and re-run `npm run setup`:

```bash
# Windows PowerShell
Remove-Item "$env:APPDATA\talend-tmc-mcp\config.json"
npm run setup
```

## Runtime errors (tool calls)

### `HTTP 401 Unauthorized`

The PAT was rejected. Possibilities:

| Cause | Check |
| --- | --- |
| Token expired or revoked | Talend Cloud Portal → Profile preferences → Personal Access Tokens. |
| Token belongs to a different region | A `us`-region token won't work against `eu`. Regenerate in the right tenant. |
| Typo on paste | Run `npm run setup` again; the wizard's validation step catches this. |
| `TMC_PAT` env var overriding a working config file | Unset env: `Remove-Item env:TMC_PAT`. |

### `HTTP 403 Forbidden`

Token authenticates but the user lacks permission for that operation. The
PAT inherits its user's roles, so the fix is in the Talend Portal (Identity
Management → user/role assignments), not in this server.

### `HTTP 404 Not Found`

Two flavors:

- **Whole route is 404** → the API isn't enabled for your tenant (e.g. SCIM
  often requires a separate license). Check the Talend Portal subscription.
- **Specific resource is 404** → the ID you passed doesn't exist or is in a
  different workspace. List first, then act.

### `HTTP 429 Too Many Requests`

Talend rate-limited you. The server doesn't retry — wait a minute and try
again. If it's persistent, you may need to batch fewer calls per minute.

### `Tool <name> failed: HTTP request failed for ... ECONNRESET`

Network blip. Usually transient — retry. If it persists:
- Test connectivity: `curl https://api.us.cloud.talend.com/orchestration/environments -H "Authorization: Bearer $TMC_PAT"`
- Bump `TMC_TIMEOUT_MS` if requests are timing out on huge payloads.

### `Tool <name> failed: AbortError`

Hit the request timeout. Either the call is slow (large list, complex
promotion analysis) or there's a network problem. Bump `TMC_TIMEOUT_MS`:

```bash
# PowerShell
$env:TMC_TIMEOUT_MS = "180000"   # 3 minutes
```

### `Unknown tool: <name>`

The tool name in the call doesn't match any loaded tool. Causes:

| Cause | Check |
| --- | --- |
| You set `TMC_APIS` to exclude the API the tool belongs to | Unset `TMC_APIS` or add it back. |
| Specs are out of date and Talend renamed the operation | `npm run fetch-specs && npm run build`. |
| Typo in the client | Browse `npm run list-tools` for the exact name. |

## Client-side issues

### Client says "server connected" but no tools show up

Usually the client is filtering or sorting tools strangely.

1. Confirm boot from a terminal first:
   ```bash
   TMC_PAT=... TMC_REGION=us node "C:/Claude/TMC MPC/dist/index.js"
   ```
   Look for `Loaded 20 Talend API spec(s), exposing 315 tools.` on stderr.
   If that's missing, the client's env wiring is the problem.
2. If your client supports an MCP inspector / debug pane, check `tools/list`
   response — it should have 315 entries.

### Claude doesn't pick the right tool

- **Too many tools to choose from.** Trim with `TMC_APIS` (see [configuration.md](./configuration.md)).
- **Ugly auto-generated names.** A few operations lack `operationId` in the
  spec, so they get names like
  `orchestration__post_orchestration_executables_promotions_promoti_2`. Their
  descriptions still include the HTTP route and summary, so Claude usually
  finds them — but you can hint with "use the POST promotions tool" or pass
  the exact name.

### Server starts but `tools/call` hangs forever

The HTTP request might be hitting an unresolvable host (DNS failure that
doesn't fast-fail). Set `TMC_TIMEOUT_MS=10000` and try again — you'll get a
proper error within 10 seconds instead of waiting on the default 60s.

## Setup wizard issues

### Wizard prompts only once then hangs (when piping input)

Node's `readline` doesn't reliably support sequential `question()` calls on
piped (non-TTY) stdin. Use the **non-interactive flags** for automation:

```bash
npm run setup -- --pat=tcp_xxx --region=us --no-verify
```

The interactive flow works fine in a real terminal.

### `(Non-TTY stdin: input will NOT be masked.)`

This is a warning, not an error. You're not running the wizard from a real
terminal (e.g. you piped input, or you're running through a managed shell
that doesn't expose `isTTY`). The PAT will still be saved correctly; it
just won't be masked while you type.

### Wizard validation says HTTP 403 but my PAT is fine

The wizard validates by calling `GET /orchestration/environments`. If your
token has no orchestration scope, you'll see 403 even though the token works
for other endpoints. The wizard offers "Save anyway?" — answer yes; calls to
endpoints in your actual scope will work.

## Build / TypeScript

### `error TS2307: Cannot find module './apis.js'`

You haven't built yet. Run `npm run build`. The `.js` extensions in import
paths are correct for ESM — TypeScript leaves them alone and Node resolves
`./apis.js` to `./apis.ts` at compile time.

### `Cannot find module '@modelcontextprotocol/sdk/...'`

Re-run `npm install`. If still broken, delete `node_modules` and
`package-lock.json`, then `npm install` from scratch.

## Last-resort checklist

If nothing in this doc applies and the server still won't behave:

1. `npm run clean && npm install && npm run build`
2. `npm run fetch-specs` (in case cached specs are corrupt)
3. `npm run docs` (regenerate reference — won't fix runtime, but confirms generator works)
4. Run the smoke test: `npx tsx scripts/smoke-test.ts`
5. If the smoke test passes but the client doesn't see tools, the issue is
   in the client's MCP config — not this server.

If you've hit something this guide should cover, edit it and add a section.
