# Docker

The server can run as a stdio MCP container. Claude Desktop / Claude Code
invoke `docker run -i --rm ...` instead of `node`, and the MCP transport
flows over the container's stdin/stdout.

- **Image size:** ~180 MB (`node:22-alpine` + production deps + 20 cached specs)
- **Auth:** PAT via env var, or via a mounted config file
- **Network:** outbound only to `api.<region>.cloud.talend.com`; no inbound ports needed

## Build

```bash
npm run docker:build
# or directly:
docker build -t talend-tmc-mcp .
```

Multi-stage build:
1. **builder** — `npm ci` (full deps), `npm run fetch-specs`, `npm run build`.
2. **runtime** — copies `dist/` + `specs/` plus `npm ci --omit=dev`.

The result runs as the non-root `node` user with `dumb-init` as PID 1 (proper signal forwarding for `docker stop`).

### Target a different Talend API version

```bash
docker build --build-arg TMC_API_VERSION=2021-09 -t talend-tmc-mcp:2021-09 .
```

The build arg is read both at spec-fetch time (URL path) and baked into the image.

### Multi-arch (amd64 + arm64)

```bash
docker buildx create --use     # first time only
npm run docker:build:multiarch
# or:
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t talend-tmc-mcp:1.0.0 \
  --push \
  .
```

`--push` is required for multi-arch builds because Docker can't load a
multi-platform image into the local daemon. Drop `--push` and add
`--output type=docker,name=talend-tmc-mcp:local` to test a single arch
locally.

The published CI image (`ghcr.io/<owner>/talend-tmc-mcp`) is built for both
`linux/amd64` and `linux/arm64` — Docker pulls the right manifest per host.

### Healthcheck

The runtime image ships a `HEALTHCHECK` that:

1. Spawns `node dist/index.js` with a dummy PAT.
2. Sends an `initialize` JSON-RPC message.
3. Asserts the server responds with a valid `protocolVersion` within 5s.
4. Kills the child.

`docker ps` shows the result:

```
CONTAINER ID   IMAGE              STATUS                    NAMES
4f8d2c1a3e7b   talend-tmc-mcp     Up 2 minutes (healthy)    talend-tmc-mcp
```

The check never talks to Talend — it verifies the container is *bootable*,
which is what k8s / Swarm / Compose actually want.

## Run

### Quick test (boot only)

```bash
docker run -i --rm -e TMC_PAT=dummy -e TMC_REGION=us talend-tmc-mcp
```

The server prints one stderr line and then blocks on stdin waiting for
JSON-RPC. Press `Ctrl-C` to exit.

### End-to-end smoke test via JSON-RPC

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| docker run -i --rm -e TMC_PAT=dummy -e TMC_REGION=us talend-tmc-mcp
```

Expected: `tools/list` returns 9 tools (the default `observability` preset's 8 tools plus the `tmc_list_environments` meta-tool).

## Configuration

> For the complete picture of where the PAT lives at each stage, see
> [pat-storage.md](./pat-storage.md). The Docker-specific section there
> covers env vs mounted-file tradeoffs in more depth.

Two options, mirroring the host setup:

### A) Env vars (simplest)

Pass with `-e`:

```bash
docker run -i --rm \
  -e TMC_PAT=tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx \
  -e TMC_REGION=us \
  -e TMC_APIS=orchestration,observability-metrics \
  talend-tmc-mcp
```

Or use an env file:

```bash
docker run -i --rm --env-file .env talend-tmc-mcp
```

With a project-local `.env`:

```
TMC_PAT=tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx
TMC_REGION=us
TMC_APIS=orchestration,observability-metrics
```

> Don't bake the PAT into the image. Build args are visible in image history.
> Env at run time keeps the secret out of layers.

### B) Mounted config file

Run `npm run setup` (or `npm run config-ui`) on the **host** to produce a
config file, then mount the directory read-only into the container at the
expected XDG path:

| Host OS | Host path | Container mount |
| --- | --- | --- |
| Windows | `%APPDATA%\talend-tmc-mcp` | `/home/node/.config/talend-tmc-mcp` |
| macOS | `~/Library/Application Support/talend-tmc-mcp` (manual) or `~/.config/talend-tmc-mcp` | `/home/node/.config/talend-tmc-mcp` |
| Linux | `~/.config/talend-tmc-mcp` | `/home/node/.config/talend-tmc-mcp` |

Example (Windows PowerShell):

```powershell
docker run -i --rm `
  -v "$env:APPDATA\talend-tmc-mcp:/home/node/.config/talend-tmc-mcp:ro" `
  talend-tmc-mcp
```

Example (bash):

```bash
docker run -i --rm \
  -v "$HOME/.config/talend-tmc-mcp:/home/node/.config/talend-tmc-mcp:ro" \
  talend-tmc-mcp
```

Env vars still take precedence — combine both if you want defaults on disk
and overrides at runtime.

## Claude Desktop

Edit `claude_desktop_config.json` (see [clients.md](./clients.md#claude-desktop)):

```json
{
  "mcpServers": {
    "talend-tmc": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "TMC_PAT",
        "-e", "TMC_REGION",
        "talend-tmc-mcp"
      ],
      "env": {
        "TMC_PAT": "tcp_xxxxxxxxxxxxxxxxxxxxxxxxxx",
        "TMC_REGION": "us"
      }
    }
  }
}
```

Note: `"-e", "TMC_PAT"` *without* a value tells Docker to pass through the
env var from the host. Claude Desktop's `env` block sets those host vars
before invoking `docker run`. This keeps the PAT out of the `args` array
(which is what shows up in process listings).

Or mount a config file directory and skip env entirely:

```json
{
  "mcpServers": {
    "talend-tmc": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "C:/Users/<you>/AppData/Roaming/talend-tmc-mcp:/home/node/.config/talend-tmc-mcp:ro",
        "talend-tmc-mcp"
      ]
    }
  }
}
```

Restart Claude Desktop. Docker Desktop must be running.

## Claude Code

```bash
claude mcp add talend-tmc -- docker run -i --rm \
  -e TMC_PAT=tcp_xxx \
  -e TMC_REGION=us \
  talend-tmc-mcp
```

Verify:

```bash
claude mcp list
# talend-tmc  Connected
```

## docker-compose

[`docker-compose.yml`](../docker-compose.yml) ships as a starting point.
Useful if you're driving the image from your own MCP gateway. Day-to-day
Claude Desktop / Code usage is simpler with plain `docker run`.

```bash
# Build via compose (also rebuilds when source changes)
docker compose build

# One-shot boot check
echo '' | docker compose run --rm tmc-mcp
```

## Config UI inside Docker (not recommended)

The `npm run config-ui` page binds to 127.0.0.1 *inside* the container and
explicitly rejects non-loopback connections. To expose it from the host
you'd have to:

1. Override `TMC_CONFIG_HOST=0.0.0.0`.
2. Patch the localhost-only allowlist check in [scripts/config-server.ts](../scripts/config-server.ts).
3. Publish the port.

This would expose PAT-writing endpoints on a network interface. **Don't do
this in shared environments.** Instead, run `npm run config-ui` on the host
and mount the resulting config file.

If you understand the risk and want it anyway, the host-side wizard or
config UI is the right tool — generate the file on the host once, then
mount it read-only.

## Image hygiene

- Multi-stage keeps build tools out of the runtime layer.
- `npm ci --omit=dev` in the runtime stage drops `typescript`, `tsx`, `rimraf`, `@types/node`.
- `npm cache clean --force` after install shrinks the image by ~30 MB.
- Specs are cached at build time so the runtime container needs no network until the first tool call.
- Runs as user `node` (UID 1000), not root.
- Entrypoint is `dumb-init` so SIGTERM from `docker stop` cleanly stops the Node process.

## Updating

When Talend publishes spec changes:

```bash
docker build --no-cache -t talend-tmc-mcp .
```

`--no-cache` is necessary because Docker won't re-run `npm run fetch-specs`
on its own (the build step has no input that changed).

Or scope the bust:

```bash
docker build --build-arg CACHEBUST=$(date +%s) -t talend-tmc-mcp .
```

…after adding `ARG CACHEBUST` plus an unused `RUN echo $CACHEBUST` right
before the fetch line in the Dockerfile.

## Troubleshooting

**`Cannot connect to the Docker daemon`**
Docker Desktop isn't running (Windows / macOS), or the user isn't in the
`docker` group (Linux). Start it / `sudo usermod -aG docker $USER && newgrp docker`.

**`401 Unauthorized` from inside the container but the same PAT works on the host**
Region mismatch (`TMC_REGION` env not set; container defaults to `us`).

**`No such file or directory: dist/index.js`**
Builder stage failed but you reused a cached layer. `docker build --no-cache`.

**Claude Desktop shows the server but no tools**
The container exited before MCP handshake completed. Check container logs:
```bash
docker logs $(docker ps -lq)
```

**stdio hangs**
You forgot `-i` on `docker run`. Without `-i`, stdin is closed immediately
and the server exits as soon as the client tries to write `initialize`.

**Image too big**
- Confirm `.dockerignore` is excluding `node_modules`, `dist`, `specs`,
  `docs`. The build context size is printed at the start of `docker build`.
- Confirm you're using the alpine base. `docker image inspect talend-tmc-mcp | grep Architecture` should show alpine indicators.
