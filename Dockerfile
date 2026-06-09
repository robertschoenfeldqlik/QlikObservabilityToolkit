# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Qlik Observability Toolkit server.
#
# Stage 1 (builder): install all deps, fetch the upstream OpenAPI specs,
# and compile TypeScript.
# Stage 2 (runtime): copy only what's needed to run — production deps,
# compiled JS, and the cached specs.
#
# Build (single-arch, current platform):
#   docker build -t talend-tmc-mcp .
# Build a different Talend API version:
#   docker build --build-arg TMC_API_VERSION=2021-09 -t talend-tmc-mcp:2021-09 .
# Build multi-arch (requires buildx — see docs/docker.md):
#   docker buildx build --platform linux/amd64,linux/arm64 -t talend-tmc-mcp:1.0.0 .
# Run (stdio MCP — for use from Claude Desktop / Claude Code):
#   docker run -i --rm -e TMC_PAT=tcp_xxx -e TMC_REGION=us talend-tmc-mcp
#
# See docs/docker.md for full wiring instructions.

ARG NODE_IMAGE=node:22-alpine

# ---------- Builder ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# Install ALL deps (incl. typescript, tsx) for the build.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Bring source in. .dockerignore keeps node_modules/dist/etc out.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Pull fresh OpenAPI specs into specs/, then compile.
# Build arg lets you target a different API version without editing files.
ARG TMC_API_VERSION=2021-03
ENV TMC_API_VERSION=${TMC_API_VERSION}
RUN npm run fetch-specs && npm run build


# ---------- Runtime ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Install only production deps. dumb-init reaps zombies and forwards signals
# when the MCP client (or `docker stop`) sends SIGTERM.
RUN apk add --no-cache dumb-init

COPY package.json package-lock.json ./
# Install prod deps, then strip npm itself from the image. We use npm at build
# time only — `node dist/index.js` doesn't shell out. Removing the bundled npm
# avoids HIGH-severity CVEs in npm's own transitive deps that Trivy/Snyk would
# otherwise flag, even though they're unreachable from our runtime code path.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/bin/npm /usr/local/bin/npx \
              /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
              /root/.npm

# Copy compiled output + cached specs from the builder.
COPY --from=builder /app/dist   ./dist
COPY --from=builder /app/specs  ./specs

# Run as a non-root user. The `node` user is built into the official image.
# Its home is /home/node — that's where the config file is looked up by
# default ($XDG_CONFIG_HOME defaults to ~/.config).
RUN mkdir -p /home/node/.config/talend-tmc-mcp \
    && chown -R node:node /home/node/.config
USER node

ENV NODE_ENV=production
ENV TMC_REGION=us
ENV LOG_FORMAT=json
# Don't auto-open browsers from inside containers if anyone runs the UI.
ENV TMC_CONFIG_NO_OPEN=1

# Healthcheck: confirm the binary boots and can read its specs. Uses a dummy
# PAT and pipes a single `initialize` request — proves the server registers
# tools and exits cleanly. Doesn't touch the network.
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "const{spawn}=require('child_process'); \
    const c=spawn('node',['dist/index.js'],{env:{...process.env,TMC_PAT:'health',TMC_REGION:'us'},stdio:['pipe','pipe','pipe']}); \
    let ok=false; \
    c.stdout.on('data',d=>{try{const m=JSON.parse(d.toString().split('\\n')[0]);if(m.result&&m.result.protocolVersion)ok=true;}catch(_){}}); \
    c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'hc',version:'0'}}})+'\\n'); \
    setTimeout(()=>{c.kill();process.exit(ok?0:1);},5000);" \
  || exit 1

# stdio MCP — nothing to EXPOSE for the default entrypoint.
ENTRYPOINT ["dumb-init", "--", "node", "dist/index.js"]

# Image labels for `docker inspect` / registry metadata.
LABEL org.opencontainers.image.title="Qlik Observability Toolkit Server"
LABEL org.opencontainers.image.description="MCP server exposing the Talend Cloud REST API as 315 tools, auto-generated from OpenAPI specs."
LABEL org.opencontainers.image.source="https://github.com/<owner>/<repo>"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="Qlik Observability Toolkit contributors"
