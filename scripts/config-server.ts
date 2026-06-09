#!/usr/bin/env tsx
/**
 * Local web-based config page — v2 (multi-tenant).
 *
 *   npm run config-ui
 *
 * Spins up a tiny HTTP server bound to 127.0.0.1, serves a single-page UI
 * for managing multiple Talend Cloud tenants and multiple Qlik Cloud
 * tenants, plus a control panel for the Python exporters (Docker-aware).
 *
 * Auto-opens the default browser unless TMC_CONFIG_NO_OPEN=1.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /                           — HTML page
 *   GET  /api/config                 — full snapshot (no raw secrets)
 *   POST /api/talend-tenants         — create/update a Talend tenant
 *   DELETE /api/talend-tenants/{id}  — delete a Talend tenant
 *   POST /api/talend-tenants/default — set default Talend tenant
 *   POST /api/talend-tenants/{id}/test — round-trip the tenant's PAT
 *   POST /api/qlik-tenants           — create/update a Qlik tenant
 *   DELETE /api/qlik-tenants/{id}    — delete a Qlik tenant
 *   POST /api/qlik-tenants/default   — set default Qlik tenant
 *   POST /api/qlik-tenants/{id}/test — round-trip the tenant's API key
 *   DELETE /api/config               — nuke all tenants from file + keychain
 *   GET  /api/exporters              — list containers + status
 *   POST /api/exporters/{name}/start — `docker compose --profile X up -d`
 *   POST /api/exporters/{name}/stop  — `docker compose stop X`
 *   POST /api/shutdown               — stop this UI server
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TMC_REGIONS, type TmcApi, type TmcRegion } from "../src/apis.js";
import { TMC_API_PRESETS } from "../src/spec-loader.js";
import { isValidApi, loadConfigFile, type QlikTenant } from "../src/config.js";
import {
  deleteCredentials,
  deleteQlikTenant,
  deleteTalendTenant,
  loadQlikApiKey,
  loadTalendPat,
  saveQlikTenant,
  saveTalendTenant,
  setDefaultQlik,
  setDefaultTalend,
  snapshotConfig,
  type PatStorage,
} from "../src/credential-store.js";

const execAsync = promisify(exec);

const PORT_DEFAULT = Number(process.env.TMC_CONFIG_PORT ?? 8788);
const HOST = process.env.TMC_CONFIG_HOST ?? "127.0.0.1";
const AUTO_OPEN = process.env.TMC_CONFIG_NO_OPEN !== "1";

// ---------------------------------------------------------------------------
// Static console assets — the "Signal" design-system UI lives in console.html
// + console.css next to this file; brand logos/icons under deploy/assets/.
// Read once at startup; served by the routes below.
// ---------------------------------------------------------------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_DIR = join(REPO_ROOT, "deploy", "assets");
const CONSOLE_HTML = readFileSync(join(SCRIPT_DIR, "console.html"), "utf8");
const CONSOLE_CSS = readFileSync(join(SCRIPT_DIR, "console.css"), "utf8");
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateTalend(
  pat: string,
  region: TmcRegion,
  urlOverride?: string,
): Promise<{ ok: boolean; status?: number; message: string }> {
  const base = urlOverride?.replace(/\/+$/, "") ?? TMC_REGIONS[region];
  const url = `${base}/orchestration/environments`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return { ok: false, status: 401, message: "HTTP 401 — token rejected." };
    }
    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        message:
          "HTTP 403 — token authenticated but lacks orchestration read scope. Token may still be valid.",
      };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: `HTTP ${res.status} ${res.statusText}` };
    }
    return { ok: true, status: res.status, message: `OK — works against ${base}` };
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function validateQlik(
  apiKey: string,
  tenantUrl: string,
): Promise<{ ok: boolean; status?: number; message: string }> {
  const base = tenantUrl.replace(/\/+$/, "");
  const url = `${base}/api/v1/users/me`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, status: 401, message: "HTTP 401 — API key rejected." };
    if (res.status === 403) return { ok: false, status: 403, message: "HTTP 403 — key lacks permissions." };
    if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status} ${res.statusText}` };
    const body = (await res.json().catch(() => ({}))) as { name?: string; email?: string };
    return {
      ok: true,
      status: res.status,
      message: `OK — authenticated as ${body.email ?? body.name ?? "unknown user"}`,
    };
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Registered extractor agents
//
// The `qlik-engine-extractor` npm package — installed on each Talend Remote
// Engine host — heartbeats here every 30s. We track the most recent payload
// per agent in memory (keyed by hostname). Agents that haven't checked in
// within STALE_AFTER_MS are flagged stale; the UI surfaces them anyway with
// a warning pill so operators know to investigate.
// ---------------------------------------------------------------------------

interface ExtractorDiagnostic {
  source_name: string;
  dir: string;
  verdict: string;
  logging_enabled: boolean;
  file_count: number;
  detail: string;
}

interface ExtractorAgentHeartbeat {
  hostname: string;
  ip?: string;
  platform?: string;
  user?: string;
  metricsUrl?: string;
  sources?: Array<{ name: string; dir: string }>;
  agentVersion?: string;
  ts?: string;
  diagnostics?: ExtractorDiagnostic[];
}

interface RegisteredAgent extends ExtractorAgentHeartbeat {
  firstSeen: number; // epoch ms
  lastSeen: number;
  stale: boolean;
  lastMetricsScrape?: { ok: boolean; ts: number; sampleCount: number; error?: string };
}

const STALE_AFTER_MS = Number(process.env.TMC_AGENT_STALE_MS ?? 5 * 60 * 1000);
const registeredAgents = new Map<string, RegisteredAgent>();

function normalizeHeartbeat(raw: unknown): ExtractorAgentHeartbeat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hostname = typeof r.hostname === "string" ? r.hostname.trim() : "";
  if (!hostname) return null;
  const sources: Array<{ name: string; dir: string }> = [];
  if (Array.isArray(r.sources)) {
    for (const s of r.sources) {
      if (s && typeof s === "object") {
        const so = s as Record<string, unknown>;
        sources.push({
          name: String(so.name ?? ""),
          dir: String(so.dir ?? ""),
        });
      }
    }
  }
  const diagnostics: ExtractorDiagnostic[] = [];
  if (Array.isArray(r.diagnostics)) {
    for (const d of r.diagnostics) {
      if (d && typeof d === "object") {
        const o = d as Record<string, unknown>;
        diagnostics.push({
          source_name: String(o.source_name ?? ""),
          dir: String(o.dir ?? ""),
          verdict: String(o.verdict ?? "unknown"),
          logging_enabled: !!o.logging_enabled,
          file_count: Number(o.file_count ?? 0),
          detail: String(o.detail ?? ""),
        });
      }
    }
  }
  return {
    hostname,
    ip: typeof r.ip === "string" ? r.ip : undefined,
    platform: typeof r.platform === "string" ? r.platform : undefined,
    user: typeof r.user === "string" ? r.user : undefined,
    metricsUrl: typeof r.metricsUrl === "string" ? r.metricsUrl : undefined,
    sources,
    agentVersion: typeof r.agentVersion === "string" ? r.agentVersion : undefined,
    ts: typeof r.ts === "string" ? r.ts : undefined,
    diagnostics,
  };
}

// Restrict server-side metrics probing to http(s) so a registered agent's
// metricsUrl can't coerce the control plane into fetching file:// or other
// schemes. Host is intentionally not pinned to loopback: agents may expose
// /metrics on their own LAN address, but scheme is the SSRF-relevant lever.
function isProbeableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function probeAgentMetrics(url: string | undefined) {
  if (!url) return undefined;
  if (!isProbeableUrl(url)) {
    return { ok: false, ts: Date.now(), sampleCount: 0, error: "unsupported metricsUrl scheme" };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    const body = res.ok ? await res.text() : "";
    const sampleCount = body.split("\n").filter((l) => l && !l.startsWith("#")).length;
    return {
      ok: res.ok,
      ts: Date.now(),
      sampleCount,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, ts: Date.now(), sampleCount: 0, error: String(err) };
  }
}

function listRegisteredAgents(): RegisteredAgent[] {
  const now = Date.now();
  return [...registeredAgents.values()]
    .map((a) => ({ ...a, stale: now - a.lastSeen > STALE_AFTER_MS }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// ---------------------------------------------------------------------------
// Docker exporter control
// ---------------------------------------------------------------------------

const COMPOSE_FILE = process.env.TMC_COMPOSE_FILE ?? "docker-compose.observability.yml";

interface ExporterMeta {
  service: string; // docker compose service name
  profile: string; // compose profile to start it with
  label: string;
  port: number; // /metrics port (host-side)
  description: string;
}

const EXPORTERS: ExporterMeta[] = [
  {
    service: "business-exporter",
    profile: "business",
    label: "Business exporter",
    port: 9465,
    description: "Polls TMC for task/plan/execution metrics.",
  },
  {
    service: "engine-log-scraper",
    profile: "engine",
    label: "Remote Engine log scraper",
    port: 9466,
    description: "Tails Talend Remote Engine JSON logs.",
  },
  {
    service: "qvd-exporter",
    profile: "qlik",
    label: "Qlik QVD exporter",
    port: 9467,
    description: "Prometheus → QVD → Qlik Cloud Data Files.",
  },
  {
    service: "qlik-obs-exporter",
    profile: "qlik-obs",
    label: "Qlik observability exporter",
    port: 9468,
    description: "Polls Qlik Cloud platform APIs (apps, reloads, audit, quota).",
  },
];

interface ExporterStatus extends ExporterMeta {
  state: "running" | "stopped" | "missing" | "unknown";
  lastMetricsScrape?: { ok: boolean; ts: number; sampleCount: number; error?: string };
}

async function dockerPs(): Promise<Record<string, string>> {
  try {
    const { stdout } = await execAsync(`docker compose -f "${COMPOSE_FILE}" ps --format json --all`);
    const map: Record<string, string> = {};
    // `docker compose ps --format json` emits one JSON object per line.
    for (const line of stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      try {
        const obj = JSON.parse(line) as { Service?: string; State?: string };
        if (obj.Service && obj.State) map[obj.Service] = obj.State;
      } catch {
        // ignore non-JSON lines
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function exporterStatuses(): Promise<ExporterStatus[]> {
  const ps = await dockerPs();
  const out: ExporterStatus[] = [];
  for (const meta of EXPORTERS) {
    const state = ps[meta.service];
    const status: ExporterStatus = {
      ...meta,
      state: state === "running" ? "running" : state ? "stopped" : "missing",
    };
    if (status.state === "running") {
      try {
        const res = await fetch(`http://127.0.0.1:${meta.port}/metrics`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const body = await res.text();
          const sampleCount = body.split("\n").filter((l) => l && !l.startsWith("#")).length;
          status.lastMetricsScrape = { ok: true, ts: Date.now(), sampleCount };
        } else {
          status.lastMetricsScrape = {
            ok: false,
            ts: Date.now(),
            sampleCount: 0,
            error: `HTTP ${res.status}`,
          };
        }
      } catch (err) {
        status.lastMetricsScrape = { ok: false, ts: Date.now(), sampleCount: 0, error: String(err) };
      }
    }
    out.push(status);
  }
  return out;
}

async function startExporter(meta: ExporterMeta): Promise<void> {
  await execAsync(`docker compose -f "${COMPOSE_FILE}" --profile ${meta.profile} up -d ${meta.service}`, {
    maxBuffer: 4 * 1024 * 1024,
  });
}
async function stopExporter(meta: ExporterMeta): Promise<void> {
  await execAsync(`docker compose -f "${COMPOSE_FILE}" stop ${meta.service}`);
}

// ---------------------------------------------------------------------------
// Data Products — proxy helpers for Qlik Cloud Data Files + Catalog Items
// ---------------------------------------------------------------------------

interface QlikDataFile {
  id: string;
  name: string;
  size?: number;
  createdDate?: string;
  modifiedDate?: string;
  ownerId?: string;
  connectionId?: string;
}

interface QlikCatalogItem {
  id: string;
  name: string;
  resourceType?: string;
  description?: string;
  spaceId?: string;
  ownerId?: string;
}

/**
 * Look up a Qlik tenant by id (or default) and fetch its API key. Throws
 * with a clear message when the tenant or key is missing — callers should
 * catch and convert to a 4xx response.
 */
async function resolveQlikTenant(
  tenantId: string | undefined,
): Promise<{ tenant: QlikTenant; apiKey: string }> {
  const cfg = await loadConfigFile().catch(() => null);
  if (!cfg) throw new Error("No config file — add a Qlik tenant first.");
  const list = cfg.qlikTenants ?? [];
  if (!list.length) throw new Error("No Qlik tenants configured.");
  const wantId = tenantId?.trim() || cfg.defaultQlikId;
  const tenant = wantId ? list.find((t) => t.id === wantId) : list[0];
  if (!tenant) throw new Error(`Unknown Qlik tenant "${tenantId ?? ""}".`);
  const apiKey = await loadQlikApiKey(tenant.id);
  if (!apiKey) throw new Error(`No API key stored for Qlik tenant "${tenant.id}".`);
  return { tenant, apiKey };
}

/** Generic JSON fetch against a Qlik tenant with an AbortController timeout. */
async function qlikFetch<T>(
  tenantUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; body: T | null; raw: string }> {
  const base = tenantUrl.replace(/\/+$/, "");
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    const raw = await res.text();
    let body: T | null = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as T;
      } catch {
        body = null;
      }
    }
    return { ok: res.ok, status: res.status, body, raw };
  } finally {
    clearTimeout(timer);
  }
}

interface QlikDataFilesResponse {
  data?: QlikDataFile[];
}

/** List QVD files in the tenant's configured Data Files connection. */
async function listDataFiles(
  tenant: QlikTenant,
  apiKey: string,
): Promise<{ ok: boolean; files: QlikDataFile[]; message?: string }> {
  if (!tenant.connectionId) {
    return { ok: false, files: [], message: "This Qlik tenant has no Data Files connection ID configured." };
  }
  const path = `/api/v1/data-files?connectionId=${encodeURIComponent(tenant.connectionId)}&limit=100`;
  const r = await qlikFetch<QlikDataFilesResponse>(tenant.tenantUrl, apiKey, path);
  if (!r.ok) {
    return { ok: false, files: [], message: `Qlik returned HTTP ${r.status}: ${r.raw.slice(0, 200)}` };
  }
  const files = Array.isArray(r.body?.data) ? r.body!.data! : [];
  return { ok: true, files };
}

/** Resolve a data-file id by name within the tenant's connection. */
async function findDataFileIdByName(
  tenant: QlikTenant,
  apiKey: string,
  fileName: string,
): Promise<string | null> {
  const r = await listDataFiles(tenant, apiKey);
  if (!r.ok) return null;
  const hit = r.files.find((f) => f.name === fileName);
  return hit?.id ?? null;
}

/**
 * Trigger the QVD exporter docker service: `up -d` ensures it exists/is
 * created (idempotent), then `restart` forces it to wake immediately
 * regardless of its internal polling interval.
 */
async function triggerQvdExporter(): Promise<void> {
  await execAsync(`docker compose -f "${COMPOSE_FILE}" --profile qlik up -d qvd-exporter`, {
    maxBuffer: 4 * 1024 * 1024,
  });
  await execAsync(`docker compose -f "${COMPOSE_FILE}" restart qvd-exporter`, {
    maxBuffer: 4 * 1024 * 1024,
  });
}

interface PublishBody {
  fileName?: string;
  displayName?: string;
  description?: string;
}

function parsePublishBody(raw: unknown): { fileName: string; displayName: string; description: string } {
  if (!raw || typeof raw !== "object") throw new Error("Body must be a JSON object.");
  const b = raw as PublishBody;
  const fileName = (b.fileName ?? "").trim();
  if (!fileName) throw new Error("fileName is required");
  const displayName = (b.displayName ?? fileName).trim();
  const description = (b.description ?? "").trim();
  return { fileName, displayName, description };
}

/**
 * Publish a QVD as a data-product catalog entry.
 *
 * NOTE: Qlik's public catalog API for QVD resources is partially documented
 * (the items API has many resourceType variants — qvd is supported in the
 * Qlik Cloud Hub UI but the request schema is not stable across releases).
 * We POST to /api/v1/items with the most-likely shape. If Qlik rejects
 * with a 4xx schema error we surface the response body so the user can
 * adjust. The fallback works for the common case: a curated catalog entry
 * pointing at a known QVD file in the tenant's Data Files connection.
 */
async function publishDataProduct(
  tenant: QlikTenant,
  apiKey: string,
  body: { fileName: string; displayName: string; description: string },
): Promise<{ ok: boolean; item?: QlikCatalogItem; message?: string; status?: number }> {
  // Look up the data file id so we can attach it as resourceId.
  const fileId = await findDataFileIdByName(tenant, apiKey, body.fileName);
  if (!fileId) {
    return { ok: false, message: `No data file named "${body.fileName}" in this connection.` };
  }
  const payload = {
    name: body.displayName,
    description: body.description,
    resourceType: "qvd" as const,
    resourceId: fileId,
    resourceAttributes: {
      connectionId: tenant.connectionId,
      fileName: body.fileName,
    },
    spaceId: undefined as string | undefined,
  };
  const r = await qlikFetch<QlikCatalogItem>(tenant.tenantUrl, apiKey, "/api/v1/items", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      message: `Qlik /api/v1/items returned HTTP ${r.status}: ${r.raw.slice(0, 400)}`,
    };
  }
  return { ok: true, item: r.body ?? undefined };
}

/** Delete a QVD file from the tenant's Data Files connection by name. */
async function deleteDataFile(
  tenant: QlikTenant,
  apiKey: string,
  fileName: string,
): Promise<{ ok: boolean; message?: string; status?: number }> {
  const id = await findDataFileIdByName(tenant, apiKey, fileName);
  if (!id) return { ok: false, message: `No data file named "${fileName}" in this connection.` };
  const r = await qlikFetch<unknown>(
    tenant.tenantUrl,
    apiKey,
    `/api/v1/data-files/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!r.ok) {
    return { ok: false, status: r.status, message: `Qlik returned HTTP ${r.status}: ${r.raw.slice(0, 200)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(new Error("Invalid JSON: " + (err as Error).message));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function send(res: http.ServerResponse, status: number, body: string, contentType: string) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Talend input parsing
// ---------------------------------------------------------------------------

interface TalendSaveBody {
  id?: string;
  label?: string;
  region?: string;
  urlOverride?: string;
  pat?: string;
  patStorage?: string;
  apis?: unknown;
  timeoutMs?: unknown;
  makeDefault?: boolean;
}

function parseTalendSave(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Body must be a JSON object.");
  const b = raw as TalendSaveBody;
  const id = (b.id ?? "").trim();
  if (!id) throw new Error("id is required");
  if (!b.region || typeof b.region !== "string" || !(b.region in TMC_REGIONS)) {
    throw new Error(`region must be one of: ${Object.keys(TMC_REGIONS).join(", ")}`);
  }
  const patStorage: PatStorage = b.patStorage === "keychain" ? "keychain" : "file";
  const patRaw = typeof b.pat === "string" ? b.pat.trim() : "";
  let apis: TmcApi[] | undefined;
  if (Array.isArray(b.apis) && b.apis.length > 0) {
    const bad = b.apis.filter((a) => typeof a !== "string" || !isValidApi(a as string));
    if (bad.length) throw new Error(`Unknown API(s): ${bad.join(", ")}`);
    apis = b.apis as TmcApi[];
  }
  let timeoutMs: number | undefined;
  if (b.timeoutMs !== undefined && b.timeoutMs !== null && b.timeoutMs !== "") {
    const n = Number(b.timeoutMs);
    if (!Number.isFinite(n) || n <= 0) throw new Error("timeoutMs must be a positive number.");
    timeoutMs = n;
  }
  return {
    id,
    label: (b.label ?? id).trim(),
    region: b.region as TmcRegion,
    urlOverride: b.urlOverride?.trim() || undefined,
    pat: patRaw === "" ? null : patRaw,
    patStorage,
    apis,
    timeoutMs,
    makeDefault: !!b.makeDefault,
  };
}

interface QlikSaveBody {
  id?: string;
  label?: string;
  tenantUrl?: string;
  apiKey?: string;
  apiKeyStorage?: string;
  connectionId?: string;
  timeoutMs?: unknown;
  makeDefault?: boolean;
  observability?: boolean;
}

function parseQlikSave(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Body must be a JSON object.");
  const b = raw as QlikSaveBody;
  const id = (b.id ?? "").trim();
  if (!id) throw new Error("id is required");
  const tenantUrl = (b.tenantUrl ?? "").trim();
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!/^https?:\/\//.test(tenantUrl)) throw new Error("tenantUrl must be http(s)://...");
  const apiKeyStorage: PatStorage = b.apiKeyStorage === "keychain" ? "keychain" : "file";
  const apiKeyRaw = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
  let timeoutMs: number | undefined;
  if (b.timeoutMs !== undefined && b.timeoutMs !== null && b.timeoutMs !== "") {
    const n = Number(b.timeoutMs);
    if (!Number.isFinite(n) || n <= 0) throw new Error("timeoutMs must be a positive number.");
    timeoutMs = n;
  }
  return {
    id,
    label: (b.label ?? id).trim(),
    tenantUrl,
    apiKey: apiKeyRaw === "" ? null : apiKeyRaw,
    apiKeyStorage,
    connectionId: b.connectionId?.trim() || undefined,
    timeoutMs,
    makeDefault: !!b.makeDefault,
    observability: b.observability !== false,
  };
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse, shutdown: () => void) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const remote = req.socket.remoteAddress ?? "";
  if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
    return send(res, 403, "Forbidden: localhost only", "text/plain");
  }

  // CSRF guard: a malicious web page the operator visits could otherwise drive
  // this loopback control plane via a cross-origin "simple" POST (the browser
  // sends the request even though it can't read the response). Browsers always
  // attach an Origin header to cross-origin state-changing requests, so for any
  // mutating method we require the Origin (when present) to be loopback. Non-
  // browser clients (the extractor agent, curl) omit Origin and are allowed.
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      let host: string;
      try {
        host = new URL(origin).hostname;
      } catch {
        return send(res, 403, "Forbidden: bad Origin", "text/plain");
      }
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        return send(res, 403, "Forbidden: cross-origin request rejected", "text/plain");
      }
    }
  }

  try {
    if (method === "GET" && (url === "/" || url === "/index.html"))
      return send(res, 200, CONSOLE_HTML, "text/html; charset=utf-8");
    if (method === "GET" && url === "/console.css")
      return send(res, 200, CONSOLE_CSS, "text/css; charset=utf-8");
    // Brand assets (logos + icons) for the console, with a traversal guard.
    if (method === "GET" && url.startsWith("/assets/")) {
      const rel = decodeURIComponent(url.slice("/assets/".length).split("?")[0]);
      const abs = join(ASSETS_DIR, rel);
      if (!abs.startsWith(ASSETS_DIR)) return send(res, 403, "Forbidden", "text/plain");
      try {
        const buf = readFileSync(abs);
        res.writeHead(200, {
          "Content-Type": ASSET_CONTENT_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": buf.length,
          "Cache-Control": "max-age=3600",
        });
        return res.end(buf);
      } catch {
        return send(res, 404, "Not found", "text/plain");
      }
    }

    if (method === "GET" && url === "/api/config") {
      const snap = await snapshotConfig();
      return sendJson(res, 200, {
        ...snap,
        regions: Object.entries(TMC_REGIONS).map(([region, baseUrl]) => ({ region, baseUrl })),
        // Observability Toolkit: the UI only offers the observability API
        // families. The MCP server defaults to these too.
        availableApis: TMC_API_PRESETS.observability,
      });
    }

    // Talend tenants
    if (method === "POST" && url === "/api/talend-tenants") {
      const input = parseTalendSave(await readBody(req));
      const r = await saveTalendTenant(input);
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (method === "DELETE" && url.startsWith("/api/talend-tenants/")) {
      const id = decodeURIComponent(url.split("/").pop()!);
      const r = await deleteTalendTenant(id);
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (method === "POST" && url === "/api/talend-tenants/default") {
      const body = (await readBody(req)) as { id?: string };
      if (!body.id) throw new Error("id is required");
      await setDefaultTalend(body.id);
      return sendJson(res, 200, { ok: true });
    }
    {
      const m = url.match(/^\/api\/talend-tenants\/([^/]+)\/test$/);
      if (m && method === "POST") {
        const body = (await readBody(req)) as { pat?: string; region?: string; urlOverride?: string };
        if (!body.pat) return sendJson(res, 400, { ok: false, message: "pat is required" });
        if (!body.region || !(body.region in TMC_REGIONS))
          return sendJson(res, 400, { ok: false, message: "region is required" });
        const r = await validateTalend(body.pat, body.region as TmcRegion, body.urlOverride);
        return sendJson(res, 200, r);
      }
    }
    {
      const m = url.match(/^\/api\/talend-tenants\/([^/]+)\/reveal$/);
      if (m && method === "GET") {
        const id = decodeURIComponent(m[1]!);
        try {
          const pat = await loadTalendPat(id);
          if (!pat) return sendJson(res, 404, { error: `No PAT stored for Talend tenant "${id}".` });
          console.error(`[audit] tenant ${id} token revealed at ${new Date().toISOString()}`);
          return sendJson(res, 200, { pat });
        } catch (err) {
          return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Qlik tenants
    if (method === "POST" && url === "/api/qlik-tenants") {
      const input = parseQlikSave(await readBody(req));
      const r = await saveQlikTenant(input);
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (method === "DELETE" && url.startsWith("/api/qlik-tenants/")) {
      const id = decodeURIComponent(url.split("/").pop()!);
      const r = await deleteQlikTenant(id);
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (method === "POST" && url === "/api/qlik-tenants/default") {
      const body = (await readBody(req)) as { id?: string };
      if (!body.id) throw new Error("id is required");
      await setDefaultQlik(body.id);
      return sendJson(res, 200, { ok: true });
    }
    {
      const m = url.match(/^\/api\/qlik-tenants\/([^/]+)\/test$/);
      if (m && method === "POST") {
        const body = (await readBody(req)) as { apiKey?: string; tenantUrl?: string };
        if (!body.apiKey) return sendJson(res, 400, { ok: false, message: "apiKey is required" });
        if (!body.tenantUrl) return sendJson(res, 400, { ok: false, message: "tenantUrl is required" });
        const r = await validateQlik(body.apiKey, body.tenantUrl);
        return sendJson(res, 200, r);
      }
    }
    {
      const m = url.match(/^\/api\/qlik-tenants\/([^/]+)\/reveal$/);
      if (m && method === "GET") {
        const id = decodeURIComponent(m[1]!);
        try {
          const apiKey = await loadQlikApiKey(id);
          if (!apiKey) return sendJson(res, 404, { error: `No API key stored for Qlik tenant "${id}".` });
          console.error(`[audit] tenant ${id} token revealed at ${new Date().toISOString()}`);
          return sendJson(res, 200, { apiKey });
        } catch (err) {
          return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Nuke
    if (method === "DELETE" && url === "/api/config") {
      const r = await deleteCredentials();
      return sendJson(res, 200, { ok: true, ...r });
    }

    // Data Products — list QVD files for a Qlik tenant
    {
      const parsed = new URL(url, "http://x");
      const qlikId = parsed.searchParams.get("qlik") ?? undefined;

      if (method === "GET" && parsed.pathname === "/api/data-products") {
        try {
          const { tenant, apiKey } = await resolveQlikTenant(qlikId);
          const r = await listDataFiles(tenant, apiKey);
          return sendJson(res, r.ok ? 200 : 502, {
            ok: r.ok,
            tenantId: tenant.id,
            connectionId: tenant.connectionId ?? null,
            files: r.files,
            message: r.message,
          });
        } catch (err) {
          return sendJson(res, 400, { ok: false, message: err instanceof Error ? err.message : String(err) });
        }
      }

      if (method === "POST" && parsed.pathname === "/api/data-products/upload-now") {
        try {
          // Resolve the tenant just to validate the request — the exporter
          // itself picks up the default Qlik tenant from the config file.
          await resolveQlikTenant(qlikId);
          await triggerQvdExporter();
          return sendJson(res, 200, { ok: true, message: "QVD exporter run triggered" });
        } catch (err) {
          return sendJson(res, 500, {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (method === "POST" && parsed.pathname === "/api/data-products/publish") {
        try {
          const body = parsePublishBody(await readBody(req));
          const { tenant, apiKey } = await resolveQlikTenant(qlikId);
          const r = await publishDataProduct(tenant, apiKey, body);
          return sendJson(res, r.ok ? 200 : r.status && r.status >= 400 ? r.status : 502, r);
        } catch (err) {
          return sendJson(res, 400, { ok: false, message: err instanceof Error ? err.message : String(err) });
        }
      }

      if (method === "DELETE" && parsed.pathname.startsWith("/api/data-products/")) {
        try {
          const fileName = decodeURIComponent(parsed.pathname.slice("/api/data-products/".length));
          if (!fileName) throw new Error("fileName is required in URL path.");
          const { tenant, apiKey } = await resolveQlikTenant(qlikId);
          const r = await deleteDataFile(tenant, apiKey, fileName);
          return sendJson(res, r.ok ? 200 : r.status && r.status >= 400 ? r.status : 502, r);
        } catch (err) {
          return sendJson(res, 400, { ok: false, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Exporters
    if (method === "GET" && url === "/api/exporters") {
      const list = await exporterStatuses();
      return sendJson(res, 200, { exporters: list, composeFile: COMPOSE_FILE });
    }
    {
      const startMatch = url.match(/^\/api\/exporters\/([^/]+)\/start$/);
      const stopMatch = url.match(/^\/api\/exporters\/([^/]+)\/stop$/);
      if ((startMatch || stopMatch) && method === "POST") {
        const name = decodeURIComponent((startMatch ?? stopMatch)![1]!);
        const meta = EXPORTERS.find((e) => e.service === name);
        if (!meta) return sendJson(res, 404, { ok: false, message: `Unknown exporter "${name}"` });
        try {
          if (startMatch) await startExporter(meta);
          else await stopExporter(meta);
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 500, {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Registered extractor agents (qlik-engine-extractor npm package).
    // Agents POST a heartbeat here every 30s. localhost-only check happens above.
    if (method === "POST" && url === "/api/extractors/register") {
      const body = normalizeHeartbeat(await readBody(req));
      if (!body) return sendJson(res, 400, { ok: false, message: "hostname is required" });
      const now = Date.now();
      const existing = registeredAgents.get(body.hostname);
      const lastMetricsScrape = await probeAgentMetrics(body.metricsUrl);
      const agent: RegisteredAgent = {
        ...body,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        stale: false,
        lastMetricsScrape,
      };
      registeredAgents.set(body.hostname, agent);
      return sendJson(res, 200, { ok: true, registered: agent });
    }
    if (method === "GET" && url === "/api/extractors") {
      return sendJson(res, 200, { agents: listRegisteredAgents(), staleAfterMs: STALE_AFTER_MS });
    }
    {
      const m = url.match(/^\/api\/extractors\/([^/]+)$/);
      if (m && method === "DELETE") {
        const host = decodeURIComponent(m[1]!);
        const had = registeredAgents.delete(host);
        return sendJson(res, 200, { ok: true, removed: had });
      }
    }

    // Shutdown
    if (method === "POST" && url === "/api/shutdown") {
      sendJson(res, 200, { ok: true });
      setTimeout(shutdown, 100);
      return;
    }

    return send(res, 404, "Not Found", "text/plain");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sendJson(res, 400, { ok: false, message: msg });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function listenWithFallback(server: http.Server, startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, HOST);
      });
      return port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`Could not bind any port in range ${startPort}-${startPort + maxAttempts - 1}.`);
}

function openInBrowser(url: string) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // best-effort
  }
}

async function main() {
  const shutdown = () => {
    console.log("\nShutting down config UI.");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  const server = http.createServer((req, res) => handle(req, res, shutdown));
  const port = await listenWithFallback(server, PORT_DEFAULT);
  const url = `http://${HOST}:${port}/`;
  console.log("Qlik Observability Toolkit — Configuration UI");
  if (port !== PORT_DEFAULT) {
    console.log(
      `  NOTE: port ${PORT_DEFAULT} was already in use (a previous instance may still be running) —` +
        ` started on ${port} instead. Open the URL below, not :${PORT_DEFAULT}.`,
    );
  }
  console.log(`  ${url}`);
  console.log("  Press Ctrl-C to stop.\n");
  if (AUTO_OPEN) openInBrowser(url);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
