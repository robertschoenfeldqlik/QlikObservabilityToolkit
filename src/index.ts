#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TMC_REGIONS, type TmcApi, type TmcRegion } from "./apis.js";
import {
  configPath,
  defaultTalendTenant,
  loadConfigFile,
  type TalendTenant,
  type TmcFileConfig,
} from "./config.js";
import { loadPat, loadTalendPat, snapshotConfig } from "./credential-store.js";
import { TmcCallError, TmcClient, type CallResult } from "./http-client.js";
import { createLogger, type Logger } from "./logger.js";
import { setServerInfo } from "./metrics.js";
import { startMetricsServer, type MetricsServerHandle } from "./metrics-server.js";
import { loadSpecs, parseApiList, parseApiPreset } from "./spec-loader.js";
import { generateToolsForSpec, type ToolDescriptor } from "./tool-generator.js";
import { PKG_NAME, PKG_VERSION } from "./version.js";

const SHUTDOWN_DRAIN_MS = Number(process.env.TMC_SHUTDOWN_DRAIN_MS ?? 5_000);

/**
 * Reserved tool name for the meta-tool that lists configured environments
 * (Talend + Qlik tenants). Returns the same snapshot the config UI shows,
 * minus the secrets. Listed alongside the auto-generated TMC tools.
 */
const META_LIST_ENVIRONMENTS = "tmc_list_environments";

async function main() {
  const log = createLogger({ base: { service: PKG_NAME, version: PKG_VERSION } });

  const fileConfig = await loadConfigFile().catch((err: unknown) => {
    log.warn("config file unreadable, falling back to env vars", { err: errMsg(err) });
    return null;
  });

  // -------------------------------------------------------------------------
  // Tenant set
  //
  // Old behavior: single tenant from (env > file). Still supported — when
  // TMC_PAT is set or only one tenant exists, the legacy fast path runs.
  //
  // New behavior: every configured Talend tenant gets its own TmcClient. The
  // tool dispatcher resolves the right client by reading args.tenant (which
  // the tool-generator injects into every tool's inputSchema). Omit
  // args.tenant to fall through to the default tenant.
  // -------------------------------------------------------------------------

  const tenants: TalendTenant[] = [...(fileConfig?.talendTenants ?? [])];
  let defaultTenantId: string | undefined;

  if (process.env.TMC_PAT) {
    // Env-var single-tenant override. Materializes a synthetic "env" tenant
    // that wins precedence; the file's tenants are still exposed by id so the
    // model can target them explicitly if it wants.
    const envRegion = (process.env.TMC_REGION ?? "us").trim() as TmcRegion;
    if (!(envRegion in TMC_REGIONS)) {
      log.error("invalid region", { region: envRegion, valid: Object.keys(TMC_REGIONS) });
      process.exit(78);
    }
    tenants.unshift({
      id: "env",
      label: "Env-var override",
      region: envRegion,
      pat: process.env.TMC_PAT,
      patStorage: "file",
    });
    defaultTenantId = "env";
  } else {
    const dflt = defaultTalendTenant(fileConfig);
    defaultTenantId = dflt?.id;
  }

  if (tenants.length === 0) {
    log.error("no Talend tenants configured", { configPath: configPath() });
    process.stderr.write(
      `\nFix: run \`npm run setup\` (or \`npm run config-ui\`) to add at least one Talend tenant, ` +
        `or set TMC_PAT + TMC_REGION in the environment.\n`,
    );
    process.exit(78);
  }

  const timeoutMs = parseOptionalPositiveInt(process.env.TMC_TIMEOUT_MS, fileConfig?.timeoutMs);
  if (timeoutMs === "invalid") {
    log.error("TMC_TIMEOUT_MS not a positive number", { value: process.env.TMC_TIMEOUT_MS });
    process.exit(78);
  }

  const maxRetries = parseOptionalPositiveInt(process.env.TMC_MAX_RETRIES, undefined);
  if (maxRetries === "invalid") {
    log.error("TMC_MAX_RETRIES not a non-negative number", { value: process.env.TMC_MAX_RETRIES });
    process.exit(78);
  }

  let apiFilter: TmcApi[] | undefined;
  try {
    if (process.env.TMC_APIS !== undefined) {
      apiFilter = parseApiList(process.env.TMC_APIS);
    } else if (process.env.TMC_APIS_PRESET !== undefined) {
      apiFilter = parseApiPreset(process.env.TMC_APIS_PRESET);
    } else if (fileConfig?.apis && fileConfig.apis.length > 0) {
      apiFilter = fileConfig.apis;
    } else {
      // Qlik Observability Toolkit: observability is the default tool surface.
      // With nothing configured we load just the observability APIs rather than
      // all 20 TMC products. Power users can still opt into a wider surface via
      // TMC_APIS / TMC_APIS_PRESET, but the out-of-the-box product is scoped to
      // read-only observability (metrics, execution logs, execution history).
      apiFilter = parseApiPreset("observability");
    }
  } catch (err) {
    log.error("invalid TMC_APIS / TMC_APIS_PRESET", { err: errMsg(err) });
    process.exit(78);
  }

  const specs = await loadSpecs(apiFilter);
  const tools: ToolDescriptor[] = [];
  const toolIndex = new Map<string, ToolDescriptor>();
  for (const { api, spec } of specs) {
    for (const tool of generateToolsForSpec(api, spec)) {
      tools.push(tool);
      toolIndex.set(tool.name, tool);
    }
  }

  // -------------------------------------------------------------------------
  // Per-tenant TmcClient cache
  //
  // Created lazily on first use. Cached for the process lifetime — a tenant's
  // credentials don't rotate mid-session in the common case, and rebuilding
  // would just churn the underlying fetch keep-alive pool. To pick up a token
  // rotation, restart the MCP server.
  // -------------------------------------------------------------------------
  const clients = new Map<string, TmcClient>();

  async function clientForTenant(
    tenantId: string,
  ): Promise<{ client: TmcClient; tenant: TalendTenant } | null> {
    const t = tenants.find((x) => x.id === tenantId);
    if (!t) return null;
    const existing = clients.get(t.id);
    if (existing) return { client: existing, tenant: t };

    // Resolve the secret. For "env" the PAT is inline; for everyone else, ask
    // the credential store (which knows about keychain backends).
    let pat: string | null = t.pat ?? null;
    if (!pat) {
      pat = t.id === "env" ? (process.env.TMC_PAT ?? null) : await loadTalendPat(t.id).catch(() => null);
    }
    if (!pat) {
      throw new Error(`No PAT available for tenant "${t.id}".`);
    }

    // Per-tenant timeout / API filter override fall back to globals.
    const perTenantTimeout = t.timeoutMs ?? (typeof timeoutMs === "number" ? timeoutMs : undefined);

    const client = new TmcClient({
      pat,
      region: t.region,
      timeoutMs: perTenantTimeout,
      maxRetries: typeof maxRetries === "number" ? maxRetries : undefined,
      logger: log.child({ tenant: t.id }),
    });
    // URL override: monkey-patch the baseUrl after construction. The class
    // sets baseUrl from TMC_REGIONS; if a tenant defines a custom URL we
    // swap it in. This keeps the constructor signature untouched.
    if (t.urlOverride) {
      (client as unknown as { baseUrl: string }).baseUrl = t.urlOverride.replace(/\/+$/, "");
    }
    clients.set(t.id, client);
    return { client, tenant: t };
  }

  // Eager-warm the default tenant so we surface obvious errors at startup
  // instead of on the first tool call. We DON'T pre-build clients for every
  // tenant — that would force resolving every keychain entry up front.
  if (defaultTenantId) {
    try {
      const got = await clientForTenant(defaultTenantId);
      if (!got) {
        log.error("default tenant not found in tenants list", { defaultTenantId });
        process.exit(78);
      }
    } catch (err) {
      log.error("failed to initialize default tenant", {
        defaultTenantId,
        err: errMsg(err),
      });
      process.exit(78);
    }
  }

  const defaultTenant = tenants.find((t) => t.id === defaultTenantId);
  const defaultBaseUrl =
    defaultTenant?.urlOverride ?? (defaultTenant ? TMC_REGIONS[defaultTenant.region] : "");

  log.info("server starting", {
    specs: specs.length,
    tools: tools.length,
    tenants: tenants.length,
    defaultTenant: defaultTenantId,
    defaultRegion: defaultTenant?.region,
    defaultBaseUrl,
    timeoutMs: timeoutMs ?? 60_000,
    maxRetries: maxRetries ?? 3,
  });

  setServerInfo({
    region: defaultTenant?.region ?? "us",
    tools: tools.length + 1, // +1 for the meta-tool
    specs: specs.length,
  });

  // Track in-flight calls so we can drain on shutdown.
  const inFlight = new Set<Promise<unknown>>();
  let shuttingDown = false;
  let ready = false;

  let metricsServer: MetricsServerHandle | undefined;
  const metricsPort = parseOptionalPositiveInt(process.env.TMC_METRICS_PORT, undefined);
  if (metricsPort === "invalid") {
    log.error("TMC_METRICS_PORT not a positive number", { value: process.env.TMC_METRICS_PORT });
    process.exit(78);
  }
  if (typeof metricsPort === "number" && metricsPort > 0) {
    try {
      metricsServer = await startMetricsServer({
        port: metricsPort,
        host: process.env.TMC_METRICS_HOST,
        logger: log,
        isReady: () => ready && !shuttingDown,
      });
    } catch (err) {
      log.error("metrics server failed to start", { port: metricsPort, err: errMsg(err) });
      process.exit(1);
    }
  }

  const server = new Server({ name: PKG_NAME, version: PKG_VERSION }, { capabilities: { tools: {} } });

  // -------------------------------------------------------------------------
  // Tool listing — auto-generated TMC tools + the meta-tool
  // -------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const out: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }> = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      annotations: annotationsFor(t),
    }));
    out.push({
      name: META_LIST_ENVIRONMENTS,
      description:
        "List every configured Talend Cloud and Qlik Cloud tenant (their IDs, labels, regions, " +
        "URLs, default flags, API filters). Use the returned `id` values to target a specific " +
        'tenant by passing `tenant: "<id>"` to any TMC tool.',
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    return { tools: out };
  });

  // -------------------------------------------------------------------------
  // Tool dispatch
  // -------------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (shuttingDown) {
      return {
        isError: true,
        content: [{ type: "text", text: "Server is shutting down; refusing new tool calls." }],
      };
    }
    const { name, arguments: argsRaw } = req.params;
    const args = (argsRaw ?? {}) as Record<string, unknown>;

    // Meta-tool: list environments. Cheap, no upstream call.
    if (name === META_LIST_ENVIRONMENTS) {
      return wrapMeta(handleListEnvironments(log));
    }

    const tool = toolIndex.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    // Multi-tenant routing. args.tenant (if set) picks which TmcClient
    // services this call. Default tenant otherwise.
    const requestedTenantId = (typeof args.tenant === "string" && args.tenant.trim()) || defaultTenantId;
    if (!requestedTenantId) {
      return {
        isError: true,
        content: [{ type: "text", text: 'No default Talend tenant configured. Pass `tenant: "<id>"`.' }],
      };
    }

    // Strip the tenant key before the args reach the HTTP client — it's a
    // routing concern, not an API parameter.
    const callArgs = { ...args };
    delete callArgs.tenant;

    const work = (async () => {
      let resolved: Awaited<ReturnType<typeof clientForTenant>>;
      try {
        resolved = await clientForTenant(requestedTenantId);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Tenant "${requestedTenantId}" lookup failed: ${errMsg(err)}` }],
        };
      }
      if (!resolved) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown tenant "${requestedTenantId}". Use ${META_LIST_ENVIRONMENTS} to list valid IDs.`,
            },
          ],
        };
      }
      try {
        const result = await resolved.client.call(tool, callArgs);
        return {
          isError: !result.ok,
          content: [{ type: "text", text: formatResult(name, resolved.tenant.id, result) }],
        };
      } catch (err) {
        const isOurError = err instanceof TmcCallError;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: isOurError
                ? `Tool ${name} failed [tenant=${resolved.tenant.id} requestId=${err.requestId} attempts=${err.attempts}]: ${err.message}`
                : `Tool ${name} failed [tenant=${resolved.tenant.id}]: ${errMsg(err)}`,
            },
          ],
        };
      }
    })();

    inFlight.add(work);
    try {
      return await work;
    } finally {
      inFlight.delete(work);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  ready = true;

  // ---- Graceful shutdown ----------------------------------------------------
  const shutdown = (signal: NodeJS.Signals | "exit", code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown initiated", { signal, inFlight: inFlight.size, drainMs: SHUTDOWN_DRAIN_MS });

    const drain = Promise.allSettled([...inFlight]);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref());

    void Promise.race([drain.then(() => undefined), timeout]).then(async () => {
      try {
        await server.close();
      } catch (err) {
        log.warn("server.close threw", { err: errMsg(err) });
      }
      if (metricsServer) {
        try {
          await metricsServer.close();
        } catch (err) {
          log.warn("metrics server close threw", { err: errMsg(err) });
        }
      }
      log.info("shutdown complete", { exitCode: code, remaining: inFlight.size });
      process.exit(code);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.stdin.on("close", () => shutdown("exit", 0));
  process.on("unhandledRejection", (reason) => log.error("unhandledRejection", { err: errMsg(reason) }));
  process.on("uncaughtException", (err) =>
    log.error("uncaughtException", { err: errMsg(err), stack: err?.stack }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function annotationsFor(t: ToolDescriptor) {
  return {
    readOnlyHint: t.method === "get",
    destructiveHint: t.method === "delete",
    idempotentHint: t.method === "get" || t.method === "put" || t.method === "delete",
  };
}

const MAX_RESULT_BYTES = Number(process.env.TMC_MAX_RESULT_BYTES ?? 256 * 1024); // 256 KiB

function formatResult(toolName: string, tenantId: string, r: CallResult): string {
  const retryStr = r.attempts > 0 ? `${r.attempts} retr${r.attempts === 1 ? "y" : "ies"} · ` : "";
  const head = `HTTP ${r.status} ${r.statusText} · ${retryStr}${r.durationMs}ms · tenant=${tenantId} · req=${r.requestId} · tool=${toolName}`;
  const body = r.parsedBody !== undefined ? JSON.stringify(r.parsedBody, null, 2) : (r.body ?? "");
  if (!body) return head;
  if (body.length <= MAX_RESULT_BYTES) return `${head}\n\n${body}`;
  return `${head}\n\n${body.slice(0, MAX_RESULT_BYTES)}\n\n[truncated: ${body.length - MAX_RESULT_BYTES} more bytes]`;
}

async function handleListEnvironments(log: Logger): Promise<string> {
  try {
    const snap = await snapshotConfig();
    const slim = {
      configPath: snap.configPath,
      defaultTalendId: snap.defaultTalendId,
      defaultQlikId: snap.defaultQlikId,
      talendTenants: snap.talendTenants.map((t) => ({
        id: t.id,
        label: t.label,
        region: t.region,
        urlOverride: t.urlOverride ?? null,
        apis: t.apis,
        timeoutMs: t.timeoutMs ?? null,
        patSet: t.patSet,
        patStorage: t.patStorage,
        isDefault: t.isDefault,
      })),
      qlikTenants: snap.qlikTenants.map((t) => ({
        id: t.id,
        label: t.label,
        tenantUrl: t.tenantUrl,
        connectionId: t.connectionId ?? null,
        apiKeySet: t.apiKeySet,
        apiKeyStorage: t.apiKeyStorage,
        isDefault: t.isDefault,
      })),
    };
    return JSON.stringify(slim, null, 2);
  } catch (err) {
    log.error("list-environments failed", { err: errMsg(err) });
    return JSON.stringify({ error: errMsg(err) });
  }
}

function wrapMeta(p: Promise<string>) {
  return p.then((text) => ({
    isError: false,
    content: [{ type: "text", text }],
  }));
}

function parseOptionalPositiveInt(
  envVal: string | undefined,
  fallback: number | undefined,
): number | undefined | "invalid" {
  if (envVal !== undefined) {
    const n = Number(envVal);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return n;
  }
  return fallback;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Silence unused import warnings if the legacy single-tenant code path is gone.
void loadPat;
void ({} as TmcFileConfig);

main().catch((err) => {
  process.stderr.write(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
