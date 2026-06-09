# How the Personal Access Token is stored

A complete trace of what happens to your Talend PAT after you paste it in,
from "press Enter" to "request hits Talend." Read this before deploying to a
shared host or shipping the image to a registry.

## TL;DR

```
                +-----------+   +--------------+   +----------------+   +---------------------+
  setup wizard  |           |   |              |   |                |   |                     |
  config UI     | env var   |   | config file  |   | OS keyring     |   | MCP client JSON     |
  CI / docker   | TMC_PAT   |   | config.json  |   | (Keychain etc.)|   | claude_desktop, etc.|
                +-----+-----+   +------+-------+   +-------+--------+   +-----------+---------+
                      |                |                   |                        |
                      |                +---------+---------+                        |
                      v                          v                                  v
                +---------------------------------------------------------------------+
                |   talend-tmc-mcp process startup                                   |
                |   precedence: env > credential store (file | keychain)             |
                +---------------------------------+----------------------------------+
                                                  |
                                                  v
                +---------------------------------------------------------------------+
                |   in-memory (TmcClient.pat — private field)                        |
                |   not logged, not echoed, never persisted                          |
                +---------------------------------+----------------------------------+
                                                  |
                                                  v   `Authorization: Bearer <pat>`  (TLS)
                +---------------------------------------------------------------------+
                |   api.<region>.cloud.talend.com                                    |
                +---------------------------------------------------------------------+
```

Three things the server never does:

1. **Never writes the PAT to disk on its own.** The setup wizard and the
   config web UI write it; the MCP server only reads.
2. **Never sends the PAT over MCP back to the client.** The client supplied
   it; sending it back would just be a leak vector.
3. **Never logs the PAT.** A redactor runs over every structured-log payload
   and scrubs the value (see [Logging & redaction](#logging--redaction)).

## Sources

Three ways the PAT arrives at the running process. Precedence: env > file.

### 1. Environment variable (`TMC_PAT`)

Highest priority. Used by:

- Claude Desktop / Claude Code's `mcpServers.*.env.TMC_PAT` block.
- `docker run -e TMC_PAT=...` or `--env-file .env`.
- CI / shell exports.

Lives only in the process environment. Visible to anything that can read
`/proc/<pid>/environ` (Linux) or the parent shell's variable table — i.e.
**your own user on your own machine, plus any child process you spawn**.

### 2. Config file (`config.json`)

Read when `TMC_PAT` is unset. Written by `npm run setup` or the config UI.

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\talend-tmc-mcp\config.json` |
| macOS | `~/Library/Application Support/talend-tmc-mcp/config.json` (or `~/.config/...` if you set `XDG_CONFIG_HOME`) |
| Linux | `$XDG_CONFIG_HOME/talend-tmc-mcp/config.json` (defaults to `~/.config/talend-tmc-mcp/config.json`) |

Run `npm run config-path` to print the resolved path on your system.

**Format** — plain JSON, no encryption:

```json
{
  "pat": "tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "region": "us",
  "apis": ["orchestration", "observability-metrics"],
  "timeoutMs": 60000
}
```

**File permissions**:

- POSIX (macOS / Linux): `chmod 600` — owner read/write only. Set by
  the setup wizard and config UI after writing.
- Windows: `chmod` is a no-op; the file inherits NTFS ACLs from
  `%APPDATA%`, which is per-user by default. The wizard *tries* `chmod` and
  ignores the error. If your `%APPDATA%` is shared (rare — e.g. roaming
  profiles on shared workstations), tighten ACLs manually:
  ```powershell
  icacls "$env:APPDATA\talend-tmc-mcp\config.json" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
  ```

### 3. Claude Desktop / Claude Code JSON

When you wire the server into a client, you have two choices:

```jsonc
// (a) env in client config — file in plaintext at:
//     Win: %APPDATA%\Claude\claude_desktop_config.json
//     mac: ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "talend-tmc": {
      "command": "node",
      "args": ["C:/Claude/TMC MPC/dist/index.js"],
      "env": { "TMC_PAT": "tcp_xxx", "TMC_REGION": "us" }
    }
  }
}

// (b) no env — relies on the server reading the OS config file written by setup.
//     Token only lives in one place.
{
  "mcpServers": {
    "talend-tmc": {
      "command": "node",
      "args": ["C:/Claude/TMC MPC/dist/index.js"]
    }
  }
}
```

(b) is the cleaner posture — one PAT in one file with `0600` perms. (a) is
fine on single-user machines but means the token is duplicated in the
client's JSON.

## At runtime (in memory)

Once read, the PAT lives in **one place**: `TmcClient`'s private `pat`
field. It is:

- Embedded in the `Authorization: Bearer <pat>` header on every outbound HTTPS request.
- Never sent in URLs, query strings, or anywhere outside that header.
- Never returned to the MCP client. Tool responses contain Talend's reply, not the request you sent.
- Not stored on any other field of any other object.

The MCP transport itself runs over stdio with the parent process (the
client). The PAT is not in any stdio payload — only in outbound HTTPS to Talend.

## In transit

Every region endpoint is HTTPS:

- `api.us.cloud.talend.com`
- `api.eu.cloud.talend.com`
- `api.ap.cloud.talend.com`
- `api.au.cloud.talend.com`
- `api.us-west.cloud.talend.com`

Node's `fetch` uses the system trust store + TLS 1.2/1.3 by default. If
you're behind a corporate proxy that does TLS interception, set
`NODE_EXTRA_CA_CERTS` so verification succeeds — don't set
`NODE_TLS_REJECT_UNAUTHORIZED=0`, which would silently mask attacks.

## Logging & redaction

Logger output (stderr only — never stdout, which is the MCP transport) is
scrubbed by [src/logger.ts](../src/logger.ts) before it's written.

Three layers of redaction:

1. **Field-name match.** Any object key in any log payload matching this
   set becomes `[REDACTED]`:
   ```
   pat, token, accessToken, access_token,
   authorization, Authorization,
   client_secret, clientSecret, x-api-key
   ```
2. **Bearer pattern.** Any `Bearer …` substring in any string value gets the
   token portion replaced: `Bearer [REDACTED]`.
3. **Talend PAT shape.** Any `tcp_[A-Za-z0-9_-]{8,}` token anywhere in any
   string value is replaced with `[REDACTED]`. Catches leaks from inside
   stack traces, upstream error messages, etc.

Redaction is recursive — arrays and nested objects are walked. Tested in
[tests/logger.test.ts](../tests/logger.test.ts).

What is **not** redacted:

- The MCP tool *response* that goes back to the client. It contains
  Talend's API JSON, which doesn't normally include the PAT (Talend
  doesn't echo your token back). If Talend ever did, the client would
  see it — but the client supplied the PAT in the first place, so this
  isn't a new exposure.
- The error message in `TmcCallError` contains the *URL* of the failed
  request. That URL has no token in it (the token is in the header).
- Filenames in stack traces (which include `talend-tmc-mcp` but no secret data).

## Docker

The image is built **without** the PAT — there is no `ARG TMC_PAT` and the
Dockerfile does not embed credentials at any layer. `docker history` shows
no token.

At runtime, two options ([docs/docker.md](./docker.md)):

### (a) Env vars

```bash
docker run -i --rm -e TMC_PAT=tcp_xxx -e TMC_REGION=us talend-tmc-mcp
```

The token is visible to:

- `docker inspect <container>` (`Config.Env`) — anyone who can call the Docker API.
- The container's `/proc/1/environ` from inside the container.
- The shell history if you typed it on the command line. Prefer `--env-file`.

### (b) Mounted config

```bash
docker run -i --rm \
  -v "$env:APPDATA\talend-tmc-mcp:/home/node/.config/talend-tmc-mcp:ro" \
  talend-tmc-mcp
```

The token lives only in the host config file. `:ro` mounts read-only so a
compromised container can't tamper with it. The container's `/proc/1/environ`
does not contain the PAT.

### Claude Desktop + Docker

The pattern in [docs/docker.md](./docker.md) uses Docker's pass-through env:

```json
{
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "TMC_PAT", "-e", "TMC_REGION", "talend-tmc-mcp"],
  "env": { "TMC_PAT": "tcp_xxx", "TMC_REGION": "us" }
}
```

`"-e", "TMC_PAT"` (no `=value`) makes Docker forward the variable from its
own environment, which Claude Desktop sets via the `env` block. This keeps
the PAT out of the `args` array — useful when a process listing might
expose `args` but not env.

## Rotation

Tokens compromise; rotate them.

1. **Issue a new PAT** in the Talend Cloud Portal → Profile preferences →
   Personal Access Tokens → + Add token. Give it a different name (e.g.
   `claude-tmc-mcp-2026-Q3`) so you can track usage.
2. **Update the server's source of truth** with one of:
   - `npm run setup` and paste the new token, OR
   - `npm run config-ui` → enter new token → Save, OR
   - update the env var in the client / Docker invocation.
3. **Restart the MCP server** (or the MCP client, which spawns the server).
   The server reads the PAT once at startup.
4. **Revoke the old PAT** in the portal. Don't skip this step — leaked
   tokens stay valid until you do.
5. (Optional) Check Talend's audit log for any activity from the old token
   between issuance and revocation.

## Threat model

What this design defends against:

| Threat | Defense |
| --- | --- |
| Token leaking into log files | Multi-layer redactor in [logger.ts](../src/logger.ts) |
| Token in `docker history` / image layers | No build arg; no `ENV` with the token; multi-stage discards builder layer |
| Token in stack traces or error messages | Redactor pattern catches `tcp_…` and `Bearer …` anywhere in strings |
| Token sent to anyone but Talend | Only place it's used is `Authorization` header on outbound HTTPS |
| Token leaked via MCP tool response | Server never echoes input back; Talend doesn't echo PAT |
| Other users on a shared host reading the config | `chmod 600` on POSIX; NTFS per-user ACLs on Windows |
| Token tampered with at rest | Mounted read-only inside Docker (`:ro`) |
| Token captured in transit | HTTPS to Talend; system trust store enforced |
| Token survives compromise without owner noticing | Rotation procedure (above); Talend audit log |

What this design does **not** defend against:

| Threat | Why not |
| --- | --- |
| Local malware running as your user | A user-level attacker can read your env, your APPDATA, your Docker daemon, your memory. OS-keyring storage doesn't help here — keyrings unlock with the user's session. |
| Anyone with `root` / `Administrator` | Same — root reads everything. |
| Compromised Talend itself | Out of scope; rotate immediately if Talend announces a breach. |
| Memory dumps of the running process | The PAT is in plain `string` memory. Heap-scanning malware would find it. No language-level mitigation is meaningful here. |
| Network observer between you and Talend (with valid trusted CA) | TLS-intercepting proxies CAN see Bearer tokens. If you operate in such an environment, treat the proxy as a trusted endpoint and rotate any token used through it. |

## Hardening checklist

If you're running this on a shared host or a server, in order of value:

- [ ] Confirm `npm run config-path`'s output is `chmod 600` and owned by your user (`ls -la`).
- [ ] Don't put the PAT in shell history. Use `npm run setup` (masked input) or `--env-file` for Docker.
- [ ] Use option (b) above for Claude Desktop — config file only, no `env` block in the JSON.
- [ ] In Docker, prefer mounted `:ro` config over `-e TMC_PAT`. If you must use `-e`, use `--env-file` not inline.
- [ ] Set `LOG_LEVEL=info` (default). `debug` may include more upstream payload context — still redacted, but more bytes to grep.
- [ ] If your aggregator stores stderr, confirm the redactor's output looks scrubbed by tailing logs through a tool call.
- [ ] Rotate PATs on a schedule (90 days is a reasonable starting point) — Talend lets you set expiry at creation time.
- [ ] Per-user, per-purpose tokens. If you have automation *and* interactive use, use two PATs so revoking one doesn't blast the other.
- [ ] Keep the host updated. `npm audit` on every release; renovate the Docker base image weekly via Dependabot (already configured).

## OS keyring backend

The PAT can also be stored in the platform's **native credential manager**:

| OS | Backend |
| --- | --- |
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | libsecret (gnome-keyring, KWallet, KeePassXC's Secret Service…) |

When this backend is selected, `config.json` keeps **region / apis / timeoutMs**
but **does not contain the PAT** — instead it carries `"patStorage": "keychain"`
as a marker. The PAT lives under service name `talend-tmc-mcp` /
account `default` in the OS store.

### Selecting the backend

Three ways, in precedence order:

1. **`TMC_CRED_STORE` env var** — `file` or `keychain`. Overrides everything.
2. **`patStorage` field** in `config.json` — written by the setup wizard or config UI.
3. Default = `file`.

### Setup

Both interactive flows can save to either backend:

```bash
# CLI wizard — adds a "where to store?" prompt
npm run setup

# Non-interactive
npm run setup -- --pat=tcp_xxx --region=us --cred-store=keychain

# Web UI
npm run config-ui    # the page shows availability and lets you pick
```

The wizard probes the keyring at startup. If unavailable, only `file` is offered.

### Availability requirements

- **macOS / Windows**: works out of the box (Keychain / Credential Manager are always running).
- **Linux**: needs a running Secret Service implementation:
  ```bash
  # GNOME (most desktop distros)
  sudo apt install gnome-keyring libsecret-1-0
  # KDE
  sudo apt install kwallet5
  ```
  Headless servers / SSH-only sessions usually don't have this and should
  stick with the file backend.
- **Docker (alpine)**: the prebuilt binary loads, but no keyring service runs in
  containers. **Use env vars or mounted file inside Docker**, not keychain.
  The `npm install` step uses `optionalDependencies` so the native package
  failing to install does not break the image.

### Migration between backends

Both directions are atomic — the new backend gets the PAT before the old
one is cleaned up, so a crash mid-migration leaves the token recoverable.

```bash
# Already configured with file backend; want to move to keychain:
npm run setup -- --cred-store=keychain --pat=tcp_xxx --region=us
# (paste the same PAT; the wizard moves region/apis to the file and the PAT to the keyring)

# Or move back to file:
npm run setup -- --cred-store=file --pat=tcp_xxx --region=us
```

In the web UI, just change the radio button and click Save.

### What this defends against (beyond file mode)

| Concern | File mode | Keychain mode |
| --- | --- | --- |
| Compliance: "no plaintext credentials on disk" | ❌ | ✅ (the OS handles storage; encrypted at rest on macOS/Windows) |
| Backup tools that snapshot `%APPDATA%` | leaks the file | doesn't include the keychain |
| Forensic disk imaging | finds the PAT in JSON | requires the user session to unlock the keyring |
| Local malware running as your user | reads either | reads either (keyring is unlocked while you're logged in) |
| `root` / `Administrator` | reads either | reads either |

The honest take: keychain is **mildly** stronger against backups, snapshots,
and "no plaintext on disk" policies. It's **not** stronger against
same-user malware.

### Disabling the optional dependency

If you can't use it (corporate npm mirror blocks native modules, alpine
without libsecret, etc.), install with:

```bash
npm install --omit=optional
```

The file backend is unaffected. Any attempt to set `TMC_CRED_STORE=keychain`
will fail with a clear error rather than silently falling back.
