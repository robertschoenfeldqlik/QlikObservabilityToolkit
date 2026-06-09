# Setup wizard

`npm run setup` walks you through credentials interactively and writes a JSON
config file the MCP server reads on startup. It's the easiest path for most
users; for CI/scripted installs, use the non-interactive flags at the bottom.

> Prefer a browser-based UI? Run `npm run config-ui` instead — see
> [config-ui.md](./config-ui.md). It uses the same config file.
>
> Want to know exactly where the token ends up? See
> [pat-storage.md](./pat-storage.md).

## Generate a Personal Access Token

1. Sign in to the Talend Cloud Portal.
2. Click your avatar → **Profile preferences**.
3. **Personal Access Tokens** → **+ Add token**.
4. Give it a name (e.g. `claude-tmc-mcp`), pick an expiry, copy the value.

PATs inherit your user's permissions, so a read-only user gets a read-only token.
For full TMC management from Claude, use an admin or service-management user.

## Run the wizard

```bash
npm run setup
```

You'll see a session like this:

```
Qlik Observability Toolkit — Setup

This wizard writes credentials to:
  C:\Users\you\AppData\Roaming\talend-tmc-mcp\config.json
The MCP server reads this on startup. TMC_PAT / TMC_REGION / TMC_APIS
env vars still take precedence when set.

Available regions:
  1. eu       -> https://api.eu.cloud.talend.com
  2. us       -> https://api.us.cloud.talend.com
  3. ap       -> https://api.ap.cloud.talend.com
  4. au       -> https://api.au.cloud.talend.com
  5. us-west  -> https://api.us-west.cloud.talend.com
Select region [name or 1-5] (default us): 2

Generate a token at: Talend Cloud Portal -> Profile Preferences ->
                     Personal Access Tokens -> + Add token
Paste your token below. Input is hidden — you won't see characters.

Personal Access Token: ****************************

Optional: comma-separated list of APIs to enable (blank = all 20).
Examples: orchestration,observability-metrics,execution-logs
Valid:    orchestration, dataset, connections, audit-logs, ...
APIs (blank for all): 

Validating PAT against https://api.us.cloud.talend.com ...
Validated against https://api.us.cloud.talend.com (HTTP 200).

Config saved to: C:\Users\you\AppData\Roaming\talend-tmc-mcp\config.json
Next:
  npm run build      # compile if you haven't
  node dist/index.js # run the MCP server
```

### What each prompt does

1. **Region** — pick where your Talend tenant lives. Wrong region = 401s. You can type the name (`us`) or the number (`2`).
2. **Personal Access Token** — input is masked with `*`. Backspace works. Ctrl-C cancels without saving.
3. **APIs** — optional. Leaving it blank loads all 20. Useful narrowing: `orchestration,observability-metrics,execution-logs` for "run tasks and watch them."
4. **Validation** — the wizard makes one live call (`GET /orchestration/environments`) to confirm:
   - **HTTP 200** → token works, config saved.
   - **HTTP 401** → token rejected. Re-check the token; the wizard offers to save anyway.
   - **HTTP 403** → token authenticated but lacks orchestration read scope. The token is *valid* but probably needs role adjustments.
   - **Network error** → check connectivity / proxy.

## Re-running

Run `npm run setup` again at any time to update region, rotate the PAT, or
change the API filter. The wizard pre-fills defaults from the existing config.

## Inspect or remove the config

```bash
npm run config-path           # prints the resolved path
type "$(npm run config-path --silent)"   # PowerShell: dump the file
```

To remove credentials, just delete the file:

```bash
# Windows PowerShell
Remove-Item "$env:APPDATA\talend-tmc-mcp\config.json"
```

## Non-interactive setup (CI, scripted installs)

Pass flags after `--`:

```bash
npm run setup -- \
  --pat="tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx" \
  --region=us \
  --apis=orchestration,observability-metrics \
  --no-verify
```

Flags:

| Flag | What it does |
| --- | --- |
| `--pat=<token>` | Personal Access Token. Required for non-interactive mode. |
| `--region=<r>` | One of the five regions. Required for non-interactive mode. |
| `--apis=<csv|all>` | API filter. `all` or omit = all 20. |
| `--cred-store=<store>` | `file` (default) or `keychain` (OS credential manager — see [pat-storage.md](./pat-storage.md)). |
| `--no-verify` | Skip the live HTTP check. Useful when CI doesn't have outbound access. |
| `--print-path` | Print the resolved config path and exit. |
| `--help` | Show usage. |

`--pat` and `--region` must be passed together — passing only one is an error.

## Why a wizard instead of just env vars?

- Env vars need to be re-exported every shell session unless you put them in a
  profile, which spreads secrets across dotfiles.
- Claude Desktop's MCP JSON ends up storing the PAT in plaintext anyway; a
  single shared config file is usually safer and easier to rotate.
- The validation step catches typos and wrong-region mistakes before you wire
  the server into a client and start getting confusing 401s.

You can still skip the wizard entirely and configure via env — see
[configuration.md](./configuration.md).
