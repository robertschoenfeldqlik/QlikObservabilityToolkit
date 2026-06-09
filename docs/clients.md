# Connecting an MCP client

This server speaks MCP over **stdio**, so any client that supports MCP stdio
servers can use it. The three most common clients are documented below.

## Claude Desktop

`claude_desktop_config.json` lives at:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Add a `talend-tmc` entry to `mcpServers`:

```json
{
  "mcpServers": {
    "talend-tmc": {
      "command": "node",
      "args": ["C:/Claude/TMC MPC/dist/index.js"]
    }
  }
}
```

**Either** rely on `npm run setup` (the server picks up the config file
automatically) **or** pass credentials via env in this JSON:

```json
{
  "mcpServers": {
    "talend-tmc": {
      "command": "node",
      "args": ["C:/Claude/TMC MPC/dist/index.js"],
      "env": {
        "TMC_PAT": "tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx",
        "TMC_REGION": "us",
        "TMC_APIS": "orchestration,observability-metrics"
      }
    }
  }
}
```

Restart Claude Desktop. The `talend-tmc` server should appear in the tools
menu (the hammer/wrench icon, depending on version) with the loaded tools
underneath.

### Tips

- Always use forward slashes in JSON paths, even on Windows — JSON treats
  `\` as an escape character.
- If you trimmed the API set with `TMC_APIS`, only those tools will show up
  for Claude to call.
- To temporarily disable the server, set `"disabled": true` on the server
  entry or comment it out.

## Claude Code

CLI:

```bash
claude mcp add talend-tmc -- node "C:/Claude/TMC MPC/dist/index.js"
```

Then, if you didn't run the setup wizard, attach env via the JSON config at
`~/.claude.json` (the global one) or `.mcp.json` (project-local):

```json
{
  "mcpServers": {
    "talend-tmc": {
      "command": "node",
      "args": ["C:/Claude/TMC MPC/dist/index.js"],
      "env": {
        "TMC_PAT": "tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx",
        "TMC_REGION": "us"
      }
    }
  }
}
```

Verify:

```bash
claude mcp list
# should show: talend-tmc  Connected
```

Inside a Claude Code session you can ask:

> List my Talend tasks

Claude will pick `orchestration__getAvailableTasks` (or similar) and call it.

## MCP Inspector

Useful for interactive debugging without involving Claude:

```bash
npx @modelcontextprotocol/inspector node "C:/Claude/TMC MPC/dist/index.js"
```

Set `TMC_PAT` / `TMC_REGION` in the Inspector's "Environment Variables" pane
before connecting, or rely on the config file written by `npm run setup`.

Once connected, you can:

- Browse all 315 tools (filter by `orchestration__`, `dataset__`, etc.)
- See each tool's JSON Schema
- Call a tool with arbitrary arguments
- Inspect raw JSON-RPC traffic

## Other clients

Any client that supports the MCP stdio transport works. The server:

- Speaks JSON-RPC 2.0 over stdio
- Implements `initialize`, `tools/list`, `tools/call`
- Writes logs to **stderr** (stdout is the protocol)
- Honors `Server` capabilities: `{ "tools": {} }`

There are no resources, prompts, sampling, or notifications implemented — only tools.

## Sanity-checking the connection

If the client reports "server connected" but you can't see tools, try this
from a regular terminal first:

```bash
TMC_PAT=<your-pat> TMC_REGION=us node "C:/Claude/TMC MPC/dist/index.js"
```

You should see one line on stderr:

```
Loaded 20 Talend API spec(s), exposing 315 tools. Region: us (https://api.us.cloud.talend.com).
```

…and then the process should block waiting for JSON-RPC on stdin. Press
`Ctrl-C` to exit. If you see an error instead, fix that before re-trying through the client.

For deeper diagnosis see [troubleshooting.md](./troubleshooting.md).
