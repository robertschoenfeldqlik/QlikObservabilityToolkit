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

import { TMC_APIS, TMC_REGIONS, type TmcApi, type TmcRegion } from "../src/apis.js";
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
    if (method === "GET" && url === "/") return send(res, 200, PAGE_HTML, "text/html; charset=utf-8");

    if (method === "GET" && url === "/api/config") {
      const snap = await snapshotConfig();
      return sendJson(res, 200, {
        ...snap,
        regions: Object.entries(TMC_REGIONS).map(([region, baseUrl]) => ({ region, baseUrl })),
        availableApis: TMC_APIS,
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

// ---------------------------------------------------------------------------
// HTML — Qlik dev-portal palette: #009845 green / #006580 teal / #19416C deep
// blue / #F6F7F8 light bg / Inter font.
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Qlik Observability Toolkit — Configuration</title>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  :root,
  [data-theme="qlik-light"] {
    --bg: #F6F7F8;
    --panel: #FFFFFF;
    --border: #E1E4E8;
    --text: #1F2328;
    --muted: #545659;
    --muted-2: #A9B3B6;
    --accent: #009845;            /* Qlik green */
    --accent-fg: #FFFFFF;
    --accent-dark: #007a37;
    --teal: #006580;
    --teal-bright: #10CFC9;
    --deep-blue: #19416C;
    --purple: #93579C;
    --ok: #009845;
    --warn: #B8860B;
    --err: #C82828;
    --code-bg: #F6F7F8;
    --input-bg: #FFFFFF;
    --status-ok-bg: #e8f7ec;
    --status-ok-fg: #0a5e2b;
    --status-ok-border: #b5e1c1;
    --status-warn-bg: #fff8c5;
    --status-warn-fg: #7d4e00;
    --status-warn-border: #f0d97a;
    --status-err-bg: #fbe9e9;
    --status-err-fg: #82071e;
    --status-err-border: #f5b6b6;
    --storage-selected-bg: #f0fbf4;
    --danger-border: #f5d1d1;
    --danger-hover: #fff0f0;
  }
  [data-theme="qlik-dark"] {
    --bg: #1B2128;
    --panel: #2D3543;
    --border: #3D4654;
    --text: #F6F7F8;
    --muted: #A9B3B6;
    --muted-2: #7d8a8e;
    --accent: #10CFC9;
    --accent-fg: #1B2128;
    --accent-dark: #0aa8a3;
    --teal: #006580;
    --teal-bright: #10CFC9;
    --deep-blue: #19416C;
    --purple: #93579C;
    --ok: #10CFC9;
    --warn: #E8B842;
    --err: #FF6B6B;
    --code-bg: #1B2128;
    --input-bg: #1B2128;
    --status-ok-bg: #0d3a36;
    --status-ok-fg: #7df1ec;
    --status-ok-border: #1c6661;
    --status-warn-bg: #3d2e0a;
    --status-warn-fg: #ffd97a;
    --status-warn-border: #7a5b14;
    --status-err-bg: #3d1414;
    --status-err-fg: #ff9a9a;
    --status-err-border: #7a2424;
    --storage-selected-bg: #1d3c3a;
    --danger-border: #5a2828;
    --danger-hover: #3d1414;
  }
  [data-theme="high-contrast"] {
    --bg: #000000;
    --panel: #1A1A1A;
    --border: #FFFFFF;
    --text: #FFFFFF;
    --muted: #FFFFFF;
    --muted-2: #FFFFFF;
    --accent: #00FF66;
    --accent-fg: #000000;
    --accent-dark: #00CC52;
    --teal: #00FFFF;
    --teal-bright: #00FFFF;
    --deep-blue: #0000FF;
    --purple: #FF00FF;
    --ok: #00FF66;
    --warn: #FFFF00;
    --err: #FF3333;
    --code-bg: #000000;
    --input-bg: #000000;
    --status-ok-bg: #000000;
    --status-ok-fg: #00FF66;
    --status-ok-border: #00FF66;
    --status-warn-bg: #000000;
    --status-warn-fg: #FFFF00;
    --status-warn-border: #FFFF00;
    --status-err-bg: #000000;
    --status-err-fg: #FF3333;
    --status-err-border: #FF3333;
    --storage-selected-bg: #000000;
    --danger-border: #FF3333;
    --danger-hover: #1A0000;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  header.app {
    background: linear-gradient(135deg, var(--teal) 0%, var(--deep-blue) 100%);
    color: white;
    padding: 18px 32px;
  }
  header.app h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  header.app .sub { margin-top: 2px; opacity: .85; font-size: 13px; }
  main { max-width: 1100px; margin: 0 auto; padding: 0 24px 80px; }

  /* Tabs */
  .tabs { display: flex; gap: 0; margin: 24px 0 0; border-bottom: 1px solid var(--border); }
  .tab {
    padding: 12px 18px; border: none; background: none; cursor: pointer; font-family: inherit;
    font-size: 14px; font-weight: 500; color: var(--muted); border-bottom: 3px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-panel { display: none; padding: 24px 0; }
  .tab-panel.active { display: block; }

  h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
  h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  p.lead { color: var(--muted); margin: 0 0 16px; font-size: 14px; }
  code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }

  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px 22px; margin-bottom: 16px;
  }
  .tenant-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px 18px; margin-bottom: 12px; transition: border-color .1s;
  }
  .tenant-card.default { border-left: 3px solid var(--accent); }
  .tenant-card .top { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .tenant-card .top h3 { margin: 0; text-transform: none; letter-spacing: 0; color: var(--text); font-size: 15px; }
  .tenant-card .tag {
    display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 99px;
    background: var(--accent); color: white; font-weight: 500;
  }
  .tenant-card .tag.muted { background: var(--code-bg); color: var(--muted); }
  .tenant-card .meta { color: var(--muted); font-size: 13px; }
  .tenant-card .actions { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .tenant-card .actions .spacer { flex: 1; }

  label.field { display: block; font-weight: 500; margin: 10px 0 4px; font-size: 13px; }
  .hint { color: var(--muted); font-size: 12.5px; margin: 4px 0 8px; }
  input[type=text], input[type=password], input[type=number], input[type=url], select, textarea {
    width: 100%; padding: 9px 11px; font-size: 14px; border: 1px solid var(--border);
    border-radius: 6px; background: var(--input-bg); font-family: inherit; color: var(--text);
  }
  input:focus, select:focus, textarea:focus {
    outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent);
  }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }

  button {
    padding: 8px 14px; font-size: 13px; font-weight: 500; border-radius: 6px;
    border: 1px solid var(--border); background: var(--panel); cursor: pointer; font-family: inherit;
    color: var(--text); transition: background .1s, border-color .1s;
  }
  button:hover { background: var(--code-bg); }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  button.primary:hover { background: var(--accent-dark); border-color: var(--accent-dark); }
  button.subtle { color: var(--muted); }
  button.danger { color: var(--err); border-color: var(--danger-border); }
  button.danger:hover { background: var(--danger-hover); }
  button:disabled { opacity: .55; cursor: not-allowed; }

  .status {
    padding: 11px 14px; border-radius: 6px; margin-top: 14px; font-size: 13.5px;
    display: none; white-space: pre-wrap; word-break: break-word; line-height: 1.45;
  }
  .status.show { display: block; }
  .status.ok   { background: var(--status-ok-bg); color: var(--status-ok-fg); border: 1px solid var(--status-ok-border); }
  .status.warn { background: var(--status-warn-bg); color: var(--status-warn-fg); border: 1px solid var(--status-warn-border); }
  .status.err  { background: var(--status-err-bg); color: var(--status-err-fg); border: 1px solid var(--status-err-border); }

  .empty {
    text-align: center; padding: 36px 18px; color: var(--muted);
    border: 1px dashed var(--border); border-radius: 8px; background: var(--panel);
  }

  .apis-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 4px 14px; margin-top: 8px;
  }
  .apis-grid label { font-weight: normal; font-size: 13px; display: flex; align-items: center; gap: 8px; cursor: pointer; margin: 0; }
  .apis-controls { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }

  .storage-options { display: flex; flex-direction: column; gap: 8px; }
  .storage-opt {
    display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px;
    border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: normal;
  }
  .storage-opt:has(input:checked) { border-color: var(--accent); background: var(--storage-selected-bg); }
  .storage-opt.disabled { opacity: .55; cursor: not-allowed; }
  .storage-opt input { margin-top: 3px; }
  .storage-title { font-weight: 600; font-size: 13.5px; }

  .form-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
  .form-actions .spacer { flex: 1; }

  /* Modal */
  .modal-bg {
    position: fixed; inset: 0; background: rgba(20, 30, 45, .45);
    display: none; align-items: flex-start; justify-content: center; z-index: 100;
    padding: 60px 24px 24px;
  }
  .modal-bg.show { display: flex; }
  .modal {
    background: var(--panel); color: var(--text); border-radius: 10px; width: 100%; max-width: 720px;
    box-shadow: 0 10px 30px rgba(0,0,0,.18); max-height: calc(100vh - 80px); overflow-y: auto;
  }
  .modal header { padding: 20px 24px 0; }
  .modal header h2 { margin: 0; font-size: 18px; }
  .modal .body { padding: 12px 24px 24px; }
  .modal .close { float: right; background: none; border: none; font-size: 22px; cursor: pointer; color: var(--muted); padding: 0; margin-top: -4px; }

  /* Exporters */
  .exp-grid { display: grid; gap: 12px; }
  .exp-card { display: grid; grid-template-columns: 1fr auto; gap: 12px 18px; padding: 14px 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); align-items: center; }
  .exp-card .name { font-weight: 600; font-size: 14px; }
  .exp-card .desc { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  .exp-card .pill {
    display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 11px; font-weight: 500; margin-top: 4px;
  }
  .pill.running  { background: var(--status-ok-bg); color: var(--status-ok-fg); }
  .pill.stopped  { background: var(--status-err-bg); color: var(--status-err-fg); }
  .pill.missing  { background: var(--code-bg); color: var(--muted); }
  .pill.unknown  { background: var(--status-warn-bg); color: var(--status-warn-fg); }
  .exp-card .controls { display: flex; gap: 6px; }
  .exp-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }

  /* Data Products */
  .dp-table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .dp-table th, .dp-table td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .dp-table th { background: var(--code-bg); font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  .dp-table tr:last-child td { border-bottom: none; }
  .dp-table td.actions { white-space: nowrap; text-align: right; }
  .dp-table td.actions button { margin-left: 6px; }
  .dp-table td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }

  /* Theme picker */
  .theme-picker { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 8px; }
  .theme-card {
    display: block; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px;
    cursor: pointer; background: var(--panel); transition: border-color .1s, background .1s;
  }
  .theme-card:hover { border-color: var(--accent); }
  .theme-card:has(input:checked) { border-color: var(--accent); background: var(--storage-selected-bg); }
  .theme-card input { margin-right: 8px; }
  .theme-card .swatch-row { display: flex; gap: 4px; margin-top: 8px; }
  .theme-card .swatch {
    width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--border);
  }
  .theme-card .theme-name { font-weight: 600; font-size: 13.5px; display: inline-block; vertical-align: middle; }
  .theme-card .theme-desc { color: var(--muted); font-size: 12px; margin-top: 4px; }

  /* Reveal token button */
  .reveal-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; margin-left: 4px;
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--panel); color: var(--muted); cursor: pointer;
    vertical-align: middle; line-height: 1; font-size: 12px;
  }
  .reveal-btn:hover { background: var(--code-bg); color: var(--text); }
  .reveal-btn svg { width: 12px; height: 12px; display: block; }
  .revealed-token {
    display: inline-block; max-width: 100%; word-break: break-all;
    background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
    font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    border: 1px dashed var(--accent);
  }
</style>
<script>
  // Apply persisted theme BEFORE any rendering to avoid a flash.
  (function() {
    try {
      var t = localStorage.getItem("tmc-mcp-theme") || "qlik-light";
      if (t !== "qlik-light" && t !== "qlik-dark" && t !== "high-contrast") t = "qlik-light";
      document.documentElement.setAttribute("data-theme", t);
    } catch (_) {
      document.documentElement.setAttribute("data-theme", "qlik-light");
    }
  })();
</script>
</head>
<body>
<header class="app">
  <h1>Qlik Observability Toolkit — Configuration</h1>
  <div class="sub">Multi-tenant config for Talend Cloud + Qlik Cloud, with Python exporter control. Bound to <code style="background:rgba(255,255,255,.15);color:white;">127.0.0.1</code> only.</div>
</header>

<main>
  <div class="tabs">
    <button class="tab active" data-tab="talend">Talend Cloud</button>
    <button class="tab" data-tab="qlik">Qlik Cloud</button>
    <button class="tab" data-tab="data-products">Data Products</button>
    <button class="tab" data-tab="exporters">Exporters</button>
    <button class="tab" data-tab="about">About</button>
  </div>

  <div id="tab-talend" class="tab-panel active">
    <p class="lead">Multiple Talend Cloud tenants. Pick one as the default — that's what the MCP server uses on startup, and what single-tenant Python exporters use unless explicitly told otherwise.</p>
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
      <button class="primary" id="addTalend">+ Add Talend tenant</button>
      <div class="hint" style="margin: 0;">PATs are stored either in the local config file (chmod 600) or in the OS keyring.</div>
    </div>
    <div id="talendList"></div>
  </div>

  <div id="tab-qlik" class="tab-panel">
    <p class="lead">Multiple Qlik Cloud tenants. Used by the QVD exporter (data upload) and the Qlik observability exporter (apps, reloads, audit). The default tenant is the one the QVD exporter targets.</p>
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
      <button class="primary" id="addQlik">+ Add Qlik tenant</button>
      <div class="hint" style="margin: 0;">API keys can be stored in the local config file or in the OS keyring.</div>
    </div>
    <div id="qlikList"></div>
  </div>

  <div id="tab-data-products" class="tab-panel">
    <p class="lead">Browse QVD files in a Qlik tenant's Data Files connection, trigger an immediate exporter run, or publish a QVD as a curated entry in the Qlik Cloud Hub catalog.</p>
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap;">
      <label class="field" style="margin: 0;">Qlik tenant:</label>
      <select id="dpTenantSelect" style="width: auto; min-width: 220px;"></select>
      <button id="dpRefresh">Refresh files</button>
      <button class="primary" id="dpUploadNow" title="Runs the qvd-exporter container immediately">Upload now</button>
    </div>
    <div id="dpConnNote" class="hint" style="margin: 0 0 12px;"></div>
    <div id="dpList"></div>
  </div>

  <div id="tab-exporters" class="tab-panel">
    <h2 style="margin-top:0;">Local Python exporters (Docker)</h2>
    <p class="lead" style="margin-top:4px;">Start, stop, and monitor the Python exporters that run via <code>docker compose</code>.</p>
    <div class="form-actions" style="margin-top: 0; margin-bottom: 14px;">
      <button id="refreshExporters">Refresh status</button>
    </div>
    <div id="exporterList" class="exp-grid"></div>

    <h2 style="margin-top:32px;">Registered extractor agents</h2>
    <p class="lead" style="margin-top:4px;">
      Headless <code>qlik-engine-extractor</code> agents running on Talend Remote
      Engine hosts. Agents heartbeat to <code>POST /api/extractors/register</code>
      every 30s. Stale = no heartbeat in <span id="staleAfterSpan">5</span> minutes.
    </p>
    <div class="form-actions" style="margin-top: 0; margin-bottom: 14px;">
      <button id="refreshAgents">Refresh agents</button>
      <span class="hint" style="align-self:center;">Install on an engine host: <code>npm i -g qlik-engine-extractor</code></span>
    </div>
    <div id="agentList" class="exp-grid"></div>
  </div>

  <div id="tab-about" class="tab-panel">
    <div class="panel">
      <h2>Appearance</h2>
      <p class="hint" style="margin: 0 0 10px;">Choose a theme. Persisted in this browser only.</p>
      <div class="theme-picker" id="theme-picker">
        <label class="theme-card">
          <input type="radio" name="theme" value="qlik-light" />
          <span class="theme-name">Qlik light</span>
          <div class="theme-desc">Default — green on white.</div>
          <div class="swatch-row">
            <span class="swatch" style="background:#F6F7F8;" title="bg"></span>
            <span class="swatch" style="background:#009845;" title="accent"></span>
            <span class="swatch" style="background:#1F2328;" title="text"></span>
          </div>
        </label>
        <label class="theme-card">
          <input type="radio" name="theme" value="qlik-dark" />
          <span class="theme-name">Qlik dark</span>
          <div class="theme-desc">Cyan accent on slate.</div>
          <div class="swatch-row">
            <span class="swatch" style="background:#1B2128;" title="bg"></span>
            <span class="swatch" style="background:#10CFC9;" title="accent"></span>
            <span class="swatch" style="background:#F6F7F8;" title="text"></span>
          </div>
        </label>
        <label class="theme-card">
          <input type="radio" name="theme" value="high-contrast" />
          <span class="theme-name">High contrast</span>
          <div class="theme-desc">Maximum legibility.</div>
          <div class="swatch-row">
            <span class="swatch" style="background:#000000;" title="bg"></span>
            <span class="swatch" style="background:#00FF66;" title="accent"></span>
            <span class="swatch" style="background:#FFFFFF;" title="text"></span>
          </div>
        </label>
      </div>
    </div>
    <div class="panel">
      <h2>About this UI</h2>
      <p>This config page is served by <code>npm run config-ui</code>. It reads + writes the same config file the MCP server consumes on startup. Server: stdio MCP, scoped to logging/observability endpoints when run from the observability stack.</p>
      <p class="hint" style="margin-top: 14px;">Config file location: <code id="aboutPath">…</code></p>
      <p class="hint">OS keyring: <span id="aboutKeychain">…</span></p>
      <div class="form-actions" style="margin-top: 14px;">
        <button class="danger" id="deleteAll">Delete all credentials</button>
        <div class="spacer"></div>
        <button id="shutdownBtn">Shut down UI</button>
      </div>
    </div>
    <div class="panel">
      <h2>Help</h2>
      <p>Master index of every external doc this project uses: see <code>HELP.md</code> in the repo root.</p>
    </div>
  </div>

  <div id="status" class="status"></div>
</main>

<!-- Modal shared by Talend + Qlik forms -->
<div id="modalBg" class="modal-bg">
  <div class="modal" id="modal"></div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const setStatus = (kind, text) => { statusEl.textContent = text; statusEl.className = "status show " + kind; };
const clearStatus = () => { statusEl.className = "status"; statusEl.textContent = ""; };

let _snap = null;
async function loadSnapshot() {
  // Re-rendering replaces the card DOM, which orphans any open reveal timers.
  // Clear them so we don't leak setTimeouts and don't try to update detached nodes.
  if (typeof _revealTimers !== "undefined") {
    _revealTimers.forEach((t) => clearTimeout(t));
    _revealTimers.clear();
  }
  const r = await fetch("/api/config");
  _snap = await r.json();
  renderTalend();
  renderQlik();
  renderAbout();
  return _snap;
}

function renderTalend() {
  const root = $("talendList");
  if (!_snap.talendTenants.length) {
    root.innerHTML = '<div class="empty">No Talend tenants configured yet. Click <b>+ Add Talend tenant</b> to start.</div>';
    return;
  }
  root.innerHTML = _snap.talendTenants.map(t => \`
    <div class="tenant-card \${t.isDefault ? "default" : ""}">
      <div class="top">
        <h3>\${esc(t.label)}</h3>
        \${t.isDefault ? '<span class="tag">default</span>' : ''}
        <span class="tag muted">\${esc(t.region)}</span>
        \${t.urlOverride ? \`<span class="tag muted">custom URL</span>\` : ''}
      </div>
      <div class="meta">
        ID: <code>\${esc(t.id)}</code>
        &nbsp;·&nbsp; URL: <code>\${esc(t.urlOverride || baseUrlForRegion(t.region))}</code>
        &nbsp;·&nbsp; Token: \${t.patSet
          ? \`<span class="token-slot" data-token-kind="talend" data-token-id="\${esc(t.id)}"><span class="token-hint">\${esc(t.patHint)}</span> (\${esc(t.patStorage)})</span>\${revealButtonHtml("talend", t.id)}\`
          : '<span style="color:var(--err)">not set</span>'}
        &nbsp;·&nbsp; APIs: \${t.apis.length ? esc(t.apis.join(", ")) : '<i>all</i>'}
      </div>
      <div class="actions">
        \${!t.isDefault ? \`<button data-act="default-talend" data-id="\${esc(t.id)}">Make default</button>\` : ''}
        <button data-act="edit-talend" data-id="\${esc(t.id)}">Edit</button>
        <div class="spacer"></div>
        <button class="danger" data-act="delete-talend" data-id="\${esc(t.id)}">Delete</button>
      </div>
    </div>
  \`).join("");
}

function renderQlik() {
  const root = $("qlikList");
  if (!_snap.qlikTenants.length) {
    root.innerHTML = '<div class="empty">No Qlik tenants configured yet. Click <b>+ Add Qlik tenant</b> to start.</div>';
    return;
  }
  root.innerHTML = _snap.qlikTenants.map(t => \`
    <div class="tenant-card \${t.isDefault ? "default" : ""}">
      <div class="top">
        <h3>\${esc(t.label)}</h3>
        \${t.isDefault ? '<span class="tag">default</span>' : ''}
      </div>
      <div class="meta">
        ID: <code>\${esc(t.id)}</code>
        &nbsp;·&nbsp; URL: <code>\${esc(t.tenantUrl)}</code>
        &nbsp;·&nbsp; API key: \${t.apiKeySet
          ? \`<span class="token-slot" data-token-kind="qlik" data-token-id="\${esc(t.id)}"><span class="token-hint">\${esc(t.apiKeyHint)}</span> (\${esc(t.apiKeyStorage)})</span>\${revealButtonHtml("qlik", t.id)}\`
          : '<span style="color:var(--err)">not set</span>'}
        \${t.connectionId ? \`&nbsp;·&nbsp; Connection: <code>\${esc(t.connectionId)}</code>\` : ''}
      </div>
      <div class="actions">
        \${!t.isDefault ? \`<button data-act="default-qlik" data-id="\${esc(t.id)}">Make default</button>\` : ''}
        <button data-act="edit-qlik" data-id="\${esc(t.id)}">Edit</button>
        <div class="spacer"></div>
        <button class="danger" data-act="delete-qlik" data-id="\${esc(t.id)}">Delete</button>
      </div>
    </div>
  \`).join("");
}

function renderAbout() {
  $("aboutPath").textContent = _snap.configPath;
  const kc = _snap.keychain;
  $("aboutKeychain").textContent = kc.available ? \`available (\${kc.backend})\` : \`unavailable — \${kc.reason || "no backend"}\`;
}

function baseUrlForRegion(region) {
  const r = _snap.regions.find(x => x.region === region);
  return r ? r.baseUrl : "";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ----- Token reveal -----
const EYE_OPEN_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_CLOSED_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5"/><path d="M3 12l10-8"/></svg>';

function revealButtonHtml(kind, id) {
  return '<button class="reveal-btn" data-act="reveal-token" data-kind="' + esc(kind) + '" data-id="' + esc(id) + '" data-state="hidden" title="Reveal stored token">' + EYE_OPEN_SVG + '</button>';
}

// Track auto-hide timers per slot so navigation/re-renders can cancel them.
const _revealTimers = new Map();
function _clearRevealTimer(key) {
  const t = _revealTimers.get(key);
  if (t) { clearTimeout(t); _revealTimers.delete(key); }
}

function _hideRevealedToken(slot, originalHtml, btn) {
  if (!slot || !btn) return;
  slot.innerHTML = originalHtml;
  btn.dataset.state = "hidden";
  btn.innerHTML = EYE_OPEN_SVG;
  btn.title = "Reveal stored token";
  const key = btn.dataset.kind + ":" + btn.dataset.id;
  _clearRevealTimer(key);
}

async function _handleRevealClick(btn) {
  const kind = btn.dataset.kind;
  const id = btn.dataset.id;
  const slot = btn.parentElement && btn.parentElement.querySelector('.token-slot[data-token-kind="' + kind + '"][data-token-id="' + CSS.escape(id) + '"]');
  if (!slot) return;
  const key = kind + ":" + id;
  if (btn.dataset.state === "shown") {
    _hideRevealedToken(slot, slot.dataset.originalHtml || "", btn);
    return;
  }
  btn.disabled = true;
  try {
    const path = kind === "talend" ? "/api/talend-tenants/" : "/api/qlik-tenants/";
    const r = await fetch(path + encodeURIComponent(id) + "/reveal");
    const j = await r.json();
    if (!r.ok || j.error) {
      setStatus("err", j.error || ("HTTP " + r.status));
      return;
    }
    const token = kind === "talend" ? j.pat : j.apiKey;
    if (!token) { setStatus("err", "Empty token returned."); return; }
    slot.dataset.originalHtml = slot.innerHTML;
    slot.innerHTML = '<code class="revealed-token">' + esc(token) + '</code>';
    btn.dataset.state = "shown";
    btn.innerHTML = EYE_CLOSED_SVG;
    btn.title = "Hide token";
    _clearRevealTimer(key);
    const timer = setTimeout(() => _hideRevealedToken(slot, slot.dataset.originalHtml || "", btn), 30_000);
    _revealTimers.set(key, timer);
  } catch (err) {
    setStatus("err", "Reveal failed: " + (err && err.message ? err.message : String(err)));
  } finally {
    btn.disabled = false;
  }
}

// Hide all revealed tokens — used on tab change and tab visibility change.
function hideAllRevealedTokens() {
  document.querySelectorAll('.reveal-btn[data-state="shown"]').forEach(btn => {
    const slot = btn.parentElement && btn.parentElement.querySelector('.token-slot[data-token-kind="' + btn.dataset.kind + '"]');
    if (slot) _hideRevealedToken(slot, slot.dataset.originalHtml || "", btn);
  });
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act='reveal-token']");
  if (btn) _handleRevealClick(btn);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) hideAllRevealedTokens();
});

// ----- Theme picker -----
const VALID_THEMES = ["qlik-light", "qlik-dark", "high-contrast"];
function getStoredTheme() {
  try {
    const t = localStorage.getItem("tmc-mcp-theme") || "qlik-light";
    return VALID_THEMES.indexOf(t) >= 0 ? t : "qlik-light";
  } catch (_) { return "qlik-light"; }
}
function applyTheme(t) {
  if (VALID_THEMES.indexOf(t) < 0) t = "qlik-light";
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("tmc-mcp-theme", t); } catch (_) {}
}
function initThemePicker() {
  const current = getStoredTheme();
  const radios = document.querySelectorAll('#theme-picker input[name="theme"]');
  radios.forEach(r => {
    r.checked = (r.value === current);
    r.addEventListener("change", () => { if (r.checked) applyTheme(r.value); });
  });
}

// Tab switching
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  hideAllRevealedTokens();  // safety: hide any revealed tokens before leaving the tab
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  if (btn.dataset.tab === "exporters") { loadExporters(); loadAgents(); }
  if (btn.dataset.tab === "about") initThemePicker();
}));

// Card action dispatch
document.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  if (act === "edit-talend")   openTalendForm(_snap.talendTenants.find(t => t.id === id));
  if (act === "edit-qlik")     openQlikForm(_snap.qlikTenants.find(t => t.id === id));
  if (act === "delete-talend") deleteTalend(id);
  if (act === "delete-qlik")   deleteQlik(id);
  if (act === "default-talend") { await fetch("/api/talend-tenants/default", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({id}) }); await loadSnapshot(); }
  if (act === "default-qlik")   { await fetch("/api/qlik-tenants/default",   { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({id}) }); await loadSnapshot(); }
});

$("addTalend").addEventListener("click", () => openTalendForm(null));
$("addQlik").addEventListener("click", () => openQlikForm(null));

async function deleteTalend(id) {
  if (!confirm("Delete Talend tenant '" + id + "'? Its PAT will be removed from the keyring too.")) return;
  const r = await fetch("/api/talend-tenants/" + encodeURIComponent(id), { method: "DELETE" });
  const j = await r.json();
  if (j.ok) { setStatus("ok", "Deleted " + id + "."); await loadSnapshot(); }
  else setStatus("err", j.message);
}
async function deleteQlik(id) {
  if (!confirm("Delete Qlik tenant '" + id + "'?")) return;
  const r = await fetch("/api/qlik-tenants/" + encodeURIComponent(id), { method: "DELETE" });
  const j = await r.json();
  if (j.ok) { setStatus("ok", "Deleted " + id + "."); await loadSnapshot(); }
  else setStatus("err", j.message);
}

// ----- Talend form -----
function openTalendForm(existing) {
  const isNew = !existing;
  const regions = _snap.regions.map(r => r.region);
  const kc = _snap.keychain;
  $("modal").innerHTML = \`
    <header><button class="close" onclick="closeModal()">×</button><h2>\${isNew ? "New Talend tenant" : "Edit Talend tenant: " + esc(existing.label)}</h2></header>
    <div class="body">
      <div class="row">
        <div>
          <label class="field">Tenant ID</label>
          <input type="text" id="t_id" value="\${isNew ? "" : esc(existing.id)}" \${isNew ? "" : "readonly"} placeholder="prod-us" />
          <div class="hint">Stable identifier. Cannot change after creation.</div>
        </div>
        <div>
          <label class="field">Label</label>
          <input type="text" id="t_label" value="\${isNew ? "" : esc(existing.label)}" placeholder="Production (US)" />
        </div>
      </div>
      <div class="row">
        <div>
          <label class="field">Region</label>
          <select id="t_region">\${regions.map(r => \`<option value="\${r}" \${(!isNew && existing.region === r) ? "selected" : ""}>\${r} — \${baseUrlForRegion(r)}</option>\`).join("")}</select>
        </div>
        <div>
          <label class="field">Custom URL (optional)</label>
          <input type="url" id="t_url" value="\${isNew ? "" : esc(existing.urlOverride || "")}" placeholder="https://api.internal.example.com" />
          <div class="hint">Overrides the region's default base URL. Leave blank for the standard Talend regional endpoint.</div>
        </div>
      </div>
      <label class="field">Personal Access Token</label>
      <input type="password" id="t_pat" placeholder="\${isNew || !existing.patSet ? "tcp_..." : "(keep existing — paste a new token to replace)"}" />
      <div class="hint">\${isNew || !existing.patSet ? "Generate at Talend Cloud Portal → Profile preferences → Personal Access Tokens." : "Currently stored: " + esc(existing.patHint) + " (" + existing.patStorage + ")"}</div>

      <label class="field">Where to store it</label>
      <div class="storage-options">
        <label class="storage-opt"><input type="radio" name="t_storage" value="file" \${isNew || existing.patStorage === "file" ? "checked" : ""}/><div><div class="storage-title">Config file</div><div class="hint" style="margin:0">Plaintext in the config JSON, chmod 600 on POSIX.</div></div></label>
        <label class="storage-opt \${kc.available ? "" : "disabled"}"><input type="radio" name="t_storage" value="keychain" \${(!isNew && existing.patStorage === "keychain") ? "checked" : ""} \${kc.available ? "" : "disabled"}/><div><div class="storage-title">OS keyring \${kc.available ? "" : "<i>(unavailable)</i>"}</div><div class="hint" style="margin:0">\${kc.available ? esc(kc.backend) : esc(kc.reason || "no backend")}</div></div></label>
      </div>

      <label class="field" style="margin-top:14px;">APIs to expose to the MCP server <span style="font-weight:normal;color:var(--muted);">(blank = all)</span></label>
      <div class="apis-controls">
        <button type="button" onclick="apisAll()">Select all</button>
        <button type="button" onclick="apisNone()">Clear</button>
        <button type="button" onclick="apisObservability()">Observability only</button>
      </div>
      <div class="apis-grid" id="t_apis"></div>

      <label class="field" style="margin-top:14px;">Timeout (ms)</label>
      <input type="number" id="t_timeout" min="1000" step="1000" value="\${isNew ? 60000 : (existing.timeoutMs || 60000)}" />

      <label style="display:flex;gap:8px;align-items:center;margin-top:14px;font-weight:normal;">
        <input type="checkbox" id="t_default" \${isNew ? "checked" : (existing.isDefault ? "checked disabled" : "")} />
        Make this the default Talend tenant
      </label>

      <div class="form-actions">
        <button type="button" id="testBtn">Test connection</button>
        <button type="button" class="primary" id="saveBtn">Save</button>
        <div class="spacer"></div>
        <button type="button" onclick="closeModal()">Cancel</button>
      </div>
      <div id="modalStatus" class="status"></div>
    </div>
  \`;
  // Render API checkboxes
  const grid = $("t_apis");
  const currentApis = new Set(isNew ? [] : existing.apis);
  grid.innerHTML = _snap.availableApis.map(a => \`<label><input type="checkbox" value="\${a}" \${currentApis.has(a) ? "checked" : ""}/> \${a}</label>\`).join("");
  showModal();

  $("testBtn").addEventListener("click", testTalend);
  $("saveBtn").addEventListener("click", () => saveTalend(isNew, existing));
}
function apisAll()  { document.querySelectorAll("#t_apis input").forEach(cb => cb.checked = true); }
function apisNone() { document.querySelectorAll("#t_apis input").forEach(cb => cb.checked = false); }
function apisObservability() {
  const set = new Set(["observability-metrics","execution-logs","execution-history-search"]);
  document.querySelectorAll("#t_apis input").forEach(cb => cb.checked = set.has(cb.value));
}
function selectedTalendApis() {
  return [...document.querySelectorAll("#t_apis input:checked")].map(cb => cb.value);
}

async function testTalend() {
  const pat = $("t_pat").value.trim();
  if (!pat) { setModalStatus("err", "Paste a PAT to test."); return; }
  setModalStatus("warn", "Testing...");
  const r = await fetch("/api/talend-tenants/x/test", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ pat, region: $("t_region").value, urlOverride: $("t_url").value.trim() || undefined }) });
  const j = await r.json();
  setModalStatus(j.ok ? "ok" : "err", j.message);
}

async function saveTalend(isNew, existing) {
  const id = $("t_id").value.trim();
  if (!id) { setModalStatus("err", "Tenant ID required."); return; }
  const body = {
    id,
    label: $("t_label").value.trim() || id,
    region: $("t_region").value,
    urlOverride: $("t_url").value.trim() || undefined,
    pat: $("t_pat").value.trim() || (isNew ? "" : null),  // null = keep existing
    patStorage: document.querySelector('input[name=t_storage]:checked').value,
    apis: selectedTalendApis(),
    timeoutMs: Number($("t_timeout").value),
    makeDefault: $("t_default").checked,
  };
  if (isNew && !body.pat) { setModalStatus("err", "PAT required for new tenant."); return; }
  const r = await fetch("/api/talend-tenants", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) return setModalStatus("err", j.message);
  closeModal();
  setStatus("ok", "Saved Talend tenant '" + id + "'.");
  await loadSnapshot();
}

// ----- Qlik form -----
function openQlikForm(existing) {
  const isNew = !existing;
  const kc = _snap.keychain;
  $("modal").innerHTML = \`
    <header><button class="close" onclick="closeModal()">×</button><h2>\${isNew ? "New Qlik Cloud tenant" : "Edit Qlik tenant: " + esc(existing.label)}</h2></header>
    <div class="body">
      <div class="row">
        <div>
          <label class="field">Tenant ID</label>
          <input type="text" id="q_id" value="\${isNew ? "" : esc(existing.id)}" \${isNew ? "" : "readonly"} placeholder="prod" />
          <div class="hint">Stable identifier. Cannot change after creation.</div>
        </div>
        <div>
          <label class="field">Label</label>
          <input type="text" id="q_label" value="\${isNew ? "" : esc(existing.label)}" placeholder="Production tenant" />
        </div>
      </div>
      <label class="field">Tenant URL</label>
      <input type="url" id="q_url" value="\${isNew ? "" : esc(existing.tenantUrl)}" placeholder="https://your-tenant.us.qlikcloud.com" />
      <div class="hint">From the Qlik Cloud Hub URL, without trailing slash. Region is encoded in the URL itself (.us, .eu, .ap, etc).</div>

      <label class="field">API key</label>
      <input type="password" id="q_key" placeholder="\${isNew || !existing.apiKeySet ? "eyJhbGc..." : "(keep existing — paste a new key to replace)"}" />
      <div class="hint">Qlik Cloud Hub → Profile → Settings → API keys → Generate new key.</div>

      <label class="field">Where to store it</label>
      <div class="storage-options">
        <label class="storage-opt"><input type="radio" name="q_storage" value="file" \${isNew || existing.apiKeyStorage === "file" ? "checked" : ""}/><div><div class="storage-title">Config file</div><div class="hint" style="margin:0">Plaintext in the config JSON, chmod 600 on POSIX.</div></div></label>
        <label class="storage-opt \${kc.available ? "" : "disabled"}"><input type="radio" name="q_storage" value="keychain" \${(!isNew && existing.apiKeyStorage === "keychain") ? "checked" : ""} \${kc.available ? "" : "disabled"}/><div><div class="storage-title">OS keyring \${kc.available ? "" : "<i>(unavailable)</i>"}</div><div class="hint" style="margin:0">\${kc.available ? esc(kc.backend) : esc(kc.reason || "no backend")}</div></div></label>
      </div>

      <label class="field" style="margin-top:14px;">Data Files connection ID (optional)</label>
      <input type="text" id="q_conn" value="\${isNew ? "" : esc(existing.connectionId || "")}" placeholder="11111111-2222-3333-4444-..." />
      <div class="hint">Required for the QVD exporter to upload. Find via the Qlik Cloud Hub → Catalog → connection details.</div>

      <label class="field" style="margin-top:14px;">Timeout (ms)</label>
      <input type="number" id="q_timeout" min="1000" step="1000" value="\${isNew ? 60000 : (existing.timeoutMs || 60000)}" />

      <label style="display:flex;gap:8px;align-items:center;margin-top:14px;font-weight:normal;">
        <input type="checkbox" id="q_default" \${isNew ? "checked" : (existing.isDefault ? "checked disabled" : "")}/>
        Make this the default Qlik tenant
      </label>

      <div class="form-actions">
        <button type="button" id="qTestBtn">Test connection</button>
        <button type="button" class="primary" id="qSaveBtn">Save</button>
        <div class="spacer"></div>
        <button type="button" onclick="closeModal()">Cancel</button>
      </div>
      <div id="modalStatus" class="status"></div>
    </div>
  \`;
  showModal();
  $("qTestBtn").addEventListener("click", testQlik);
  $("qSaveBtn").addEventListener("click", () => saveQlik(isNew, existing));
}

async function testQlik() {
  const apiKey = $("q_key").value.trim();
  const tenantUrl = $("q_url").value.trim();
  if (!apiKey || !tenantUrl) { setModalStatus("err", "Tenant URL + API key required."); return; }
  setModalStatus("warn", "Testing...");
  const r = await fetch("/api/qlik-tenants/x/test", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ apiKey, tenantUrl }) });
  const j = await r.json();
  setModalStatus(j.ok ? "ok" : "err", j.message);
}

async function saveQlik(isNew, existing) {
  const id = $("q_id").value.trim();
  if (!id) { setModalStatus("err", "Tenant ID required."); return; }
  const body = {
    id,
    label: $("q_label").value.trim() || id,
    tenantUrl: $("q_url").value.trim(),
    apiKey: $("q_key").value.trim() || (isNew ? "" : null),
    apiKeyStorage: document.querySelector('input[name=q_storage]:checked').value,
    connectionId: $("q_conn").value.trim() || undefined,
    timeoutMs: Number($("q_timeout").value),
    makeDefault: $("q_default").checked,
  };
  if (isNew && !body.apiKey) { setModalStatus("err", "API key required for new tenant."); return; }
  const r = await fetch("/api/qlik-tenants", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) return setModalStatus("err", j.message);
  closeModal();
  setStatus("ok", "Saved Qlik tenant '" + id + "'.");
  await loadSnapshot();
}

// ----- Modal helpers -----
function showModal() { $("modalBg").classList.add("show"); }
function closeModal() { $("modalBg").classList.remove("show"); }
$("modalBg").addEventListener("click", (e) => { if (e.target === $("modalBg")) closeModal(); });
function setModalStatus(kind, text) {
  const s = $("modalStatus"); if (!s) return;
  s.className = "status show " + kind; s.textContent = text;
}

// ----- Exporters tab -----
async function loadExporters() {
  const r = await fetch("/api/exporters");
  const j = await r.json();
  const root = $("exporterList");
  root.innerHTML = j.exporters.map(e => \`
    <div class="exp-card">
      <div>
        <div class="name">\${esc(e.label)}</div>
        <div class="desc">\${esc(e.description)}</div>
        <div class="exp-meta">service <code>\${esc(e.service)}</code> &nbsp;·&nbsp; profile <code>\${esc(e.profile)}</code> &nbsp;·&nbsp; metrics on <code>:\${e.port}</code></div>
        <span class="pill \${e.state}">\${e.state}</span>
        \${e.lastMetricsScrape ? (e.lastMetricsScrape.ok
          ? \`<span class="exp-meta">&nbsp;\${e.lastMetricsScrape.sampleCount} active series</span>\`
          : \`<span class="exp-meta" style="color:var(--err)">&nbsp;scrape error: \${esc(e.lastMetricsScrape.error || "")}</span>\`) : ""}
      </div>
      <div class="controls">
        \${e.state === "running"
          ? \`<button data-act="stop-exporter" data-svc="\${esc(e.service)}">Stop</button>\`
          : \`<button class="primary" data-act="start-exporter" data-svc="\${esc(e.service)}">Start</button>\`}
      </div>
    </div>
  \`).join("");
  $("refreshExporters").onclick = loadExporters;
}

// ---- Registered extractor agents -----------------------------------------
async function loadAgents() {
  const root = $("agentList");
  if (!root) return;
  const r = await fetch("/api/extractors");
  const j = await r.json();
  $("staleAfterSpan").textContent = Math.round((j.staleAfterMs || 300000) / 60000);
  if (!j.agents.length) {
    root.innerHTML = '<div class="empty">No extractor agents have registered yet. On a Talend Remote Engine host run <code>npm i -g qlik-engine-extractor</code> then <code>TMC_CONTROL_PLANE_URL=' + window.location.origin + ' qlik-engine-extractor heartbeat</code>.</div>';
    $("refreshAgents").onclick = loadAgents;
    return;
  }
  const fmtAgo = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  };
  // Per-source preflight verdicts (pickup-path + logging-enabled). Each gets
  // a coloured pill so a misconfigured engine is obvious at a glance.
  const verdictPill = (v) => {
    const map = {
      ok: ["running", "logging ON"],
      no_path: ["stopped", "pickup path missing"],
      no_files: ["stopped", "no log files"],
      stale: ["unknown", "logs stale"],
      no_job_status: ["stopped", "job logging OFF"],
    };
    // Only the five known verdicts render a styled label. An unrecognized
    // verdict (e.g. a malicious/buggy heartbeat) renders as an escaped
    // literal under the neutral "unknown" class — never as raw HTML.
    const known = map[v];
    const cls = known ? known[0] : "unknown";
    const label = known ? known[1] : esc(String(v));
    return \`<span class="pill \${cls}" style="vertical-align:middle;">\${label}</span>\`;
  };
  window.renderDiagnostics = (diags) => {
    if (!diags || !diags.length) return "";
    const rows = diags.map(d =>
      \`<div class="exp-meta">diagnostic <code>\${esc(d.source_name)}</code> \${verdictPill(d.verdict)} <span style="color:var(--muted)">\${esc(d.detail || "")}</span></div>\`
    ).join("");
    return rows;
  };
  root.innerHTML = j.agents.map(a => \`
    <div class="exp-card">
      <div>
        <div class="name">\${esc(a.hostname)} \${a.stale ? '<span class="pill stopped" style="vertical-align:middle;">stale</span>' : '<span class="pill running" style="vertical-align:middle;">live</span>'}</div>
        <div class="desc">\${esc(a.platform || "?")} · \${esc(a.user || "?")}@\${esc(a.ip || "?")} · agent v\${esc(a.agentVersion || "?")}</div>
        <div class="exp-meta">last seen <b>\${fmtAgo(a.lastSeen)}</b> · first seen \${fmtAgo(a.firstSeen)}</div>
        <div class="exp-meta">metrics: <code>\${esc(a.metricsUrl || "?")}</code>\${a.lastMetricsScrape ? (a.lastMetricsScrape.ok
          ? \` · <b>\${a.lastMetricsScrape.sampleCount}</b> series\`
          : \` · <span style="color:var(--err)">scrape error: \${esc(a.lastMetricsScrape.error||"")}</span>\`) : ""}</div>
        <div class="exp-meta">sources: \${a.sources && a.sources.length ? a.sources.map(s => \`<code>\${esc(s.name)}</code>=<code>\${esc(s.dir)}</code>\`).join(", ") : "<i>none configured</i>"}</div>
        \${renderDiagnostics(a.diagnostics)}
      </div>
      <div class="controls">
        <button data-act="forget-agent" data-host="\${esc(a.hostname)}" class="danger">Forget</button>
      </div>
    </div>
  \`).join("");
  $("refreshAgents").onclick = loadAgents;
}

document.addEventListener("click", async (e) => {
  const tgt = e.target.closest("[data-act='forget-agent']");
  if (!tgt) return;
  const host = tgt.dataset.host;
  if (!confirm("Forget agent '" + host + "'? It will reappear at the next heartbeat.")) return;
  await fetch("/api/extractors/" + encodeURIComponent(host), { method: "DELETE" });
  await loadAgents();
});

document.addEventListener("click", async (e) => {
  const tgt = e.target.closest("[data-act='start-exporter'], [data-act='stop-exporter']");
  if (!tgt) return;
  const svc = tgt.dataset.svc;
  const isStart = tgt.dataset.act === "start-exporter";
  tgt.disabled = true; tgt.textContent = isStart ? "Starting..." : "Stopping...";
  setStatus("warn", \`\${isStart ? "Starting" : "Stopping"} \${svc} ...\`);
  const r = await fetch(\`/api/exporters/\${encodeURIComponent(svc)}/\${isStart ? "start" : "stop"}\`, { method: "POST" });
  const j = await r.json();
  if (j.ok) { setStatus("ok", \`\${svc}: \${isStart ? "started" : "stopped"}.\`); await loadExporters(); }
  else setStatus("err", j.message);
});

$("deleteAll").addEventListener("click", async () => {
  if (!confirm("Delete ALL credentials (Talend + Qlik, file + keychain)? Cannot be undone.")) return;
  const r = await fetch("/api/config", { method: "DELETE" });
  const j = await r.json();
  setStatus(j.ok ? "ok" : "err", j.ok ? "Deleted " + j.path : j.message);
  await loadSnapshot();
});

$("shutdownBtn").addEventListener("click", async () => {
  await fetch("/api/shutdown", { method: "POST" });
  setStatus("ok", "Server stopped. Close this tab.");
});

// ----- Data Products tab -----
function renderDpTenants() {
  const sel = $("dpTenantSelect");
  if (!sel) return;
  if (!_snap.qlikTenants.length) {
    sel.innerHTML = '<option value="">(no Qlik tenants configured)</option>';
    sel.disabled = true;
    return;
  }
  const defaultId = _snap.defaultQlikId || _snap.qlikTenants[0].id;
  sel.disabled = false;
  sel.innerHTML = _snap.qlikTenants.map(t =>
    \`<option value="\${esc(t.id)}" \${t.id === defaultId ? "selected" : ""}>\${esc(t.label)} \${t.isDefault ? "(default)" : ""}</option>\`
  ).join("");
}

function currentDpTenantId() {
  const sel = $("dpTenantSelect");
  return sel && sel.value ? sel.value : "";
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const units = ["B","KB","MB","GB","TB"];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + units[i];
}
function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

async function loadDataProducts() {
  const tid = currentDpTenantId();
  const list = $("dpList");
  const note = $("dpConnNote");
  if (!tid) {
    list.innerHTML = '<div class="empty">Configure a Qlik tenant first on the Qlik Cloud tab.</div>';
    note.textContent = "";
    return;
  }
  list.innerHTML = '<div class="empty">Loading…</div>';
  const r = await fetch("/api/data-products?qlik=" + encodeURIComponent(tid));
  const j = await r.json();
  if (!j.ok) {
    list.innerHTML = '<div class="empty" style="color:var(--err)">' + esc(j.message || "Failed to load.") + '</div>';
    note.textContent = "";
    return;
  }
  note.innerHTML = j.connectionId
    ? "Connection: <code>" + esc(j.connectionId) + "</code> · " + j.files.length + " file(s)"
    : "";
  if (!j.files.length) {
    list.innerHTML = '<div class="empty">No QVD files yet. Use <b>Upload now</b> to run the exporter.</div>';
    return;
  }
  list.innerHTML =
    '<table class="dp-table"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>' +
    j.files.map(f => \`
      <tr>
        <td><code>\${esc(f.name)}</code></td>
        <td class="num">\${fmtBytes(f.size)}</td>
        <td>\${esc(fmtDate(f.modifiedDate || f.createdDate))}</td>
        <td class="actions">
          <button data-act="dp-publish" data-file="\${esc(f.name)}">Publish as data product</button>
          <button class="danger" data-act="dp-delete" data-file="\${esc(f.name)}">Delete</button>
        </td>
      </tr>
    \`).join("") +
    '</tbody></table>';
}

function openPublishForm(fileName) {
  $("modal").innerHTML = \`
    <header><button class="close" onclick="closeModal()">×</button><h2>Publish data product</h2></header>
    <div class="body">
      <p class="hint">Registers <code>\${esc(fileName)}</code> as a curated entry in the Qlik Cloud Hub catalog. The QVD file itself stays in the Data Files connection.</p>
      <label class="field">Display name</label>
      <input type="text" id="dp_name" value="\${esc(fileName.replace(/\\.qvd$/i, ""))}" />
      <label class="field">Description</label>
      <textarea id="dp_desc" rows="3" placeholder="Short description shown in the Qlik Cloud Hub catalog."></textarea>
      <div class="form-actions">
        <button type="button" class="primary" id="dpPublishBtn">Publish</button>
        <div class="spacer"></div>
        <button type="button" onclick="closeModal()">Cancel</button>
      </div>
      <div id="modalStatus" class="status"></div>
    </div>
  \`;
  showModal();
  $("dpPublishBtn").addEventListener("click", async () => {
    const tid = currentDpTenantId();
    const body = {
      fileName,
      displayName: $("dp_name").value.trim() || fileName,
      description: $("dp_desc").value.trim(),
    };
    setModalStatus("warn", "Publishing…");
    const r = await fetch("/api/data-products/publish?qlik=" + encodeURIComponent(tid), {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) {
      closeModal();
      setStatus("ok", "Published '" + body.displayName + "' (item " + (j.item && j.item.id ? j.item.id : "?") + ").");
      await loadDataProducts();
    } else {
      setModalStatus("err", j.message || "Publish failed.");
    }
  });
}

document.addEventListener("click", async (e) => {
  const pub = e.target.closest("[data-act='dp-publish']");
  const del = e.target.closest("[data-act='dp-delete']");
  if (pub) {
    openPublishForm(pub.dataset.file);
    return;
  }
  if (del) {
    const fileName = del.dataset.file;
    if (!confirm("Delete QVD file '" + fileName + "' from the Qlik Data Files connection? This cannot be undone.")) return;
    const tid = currentDpTenantId();
    const r = await fetch("/api/data-products/" + encodeURIComponent(fileName) + "?qlik=" + encodeURIComponent(tid), { method: "DELETE" });
    const j = await r.json();
    if (j.ok) { setStatus("ok", "Deleted " + fileName + "."); await loadDataProducts(); }
    else setStatus("err", j.message || "Delete failed.");
  }
});

document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "dpTenantSelect") loadDataProducts();
});

document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  if (btn.dataset.tab === "data-products") {
    renderDpTenants();
    loadDataProducts();
  }
}));

$("dpRefresh").addEventListener("click", loadDataProducts);
$("dpUploadNow").addEventListener("click", async () => {
  const tid = currentDpTenantId();
  if (!tid) { setStatus("err", "Pick a Qlik tenant first."); return; }
  const btn = $("dpUploadNow");
  btn.disabled = true; btn.textContent = "Starting…";
  setStatus("warn", "Triggering QVD exporter run…");
  try {
    const r = await fetch("/api/data-products/upload-now?qlik=" + encodeURIComponent(tid), { method: "POST" });
    const j = await r.json();
    if (j.ok) setStatus("ok", j.message || "QVD exporter run triggered.");
    else setStatus("err", j.message || "Failed to start exporter.");
  } finally {
    btn.disabled = false; btn.textContent = "Upload now";
  }
});

loadSnapshot().then(() => { renderDpTenants(); initThemePicker(); }).catch(err => setStatus("err", "Failed to load config: " + err.message));
</script>
</body>
</html>
`;
