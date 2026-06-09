import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { TMC_APIS, type TmcApi, type TmcRegion } from "./apis.js";

// ---------------------------------------------------------------------------
// Multi-tenant config (v2)
// ---------------------------------------------------------------------------
//
// v1 was single-tenant: { pat, region, apis, ... }. v2 supports an array of
// Talend tenants and an array of Qlik Cloud tenants, each addressable by an
// `id`. One tenant per service can be flagged as the "default" — that's the
// one the MCP server uses, and the one exporters use unless they're explicitly
// asked to iterate all of them.
//
// loadConfigFile() returns a TmcFileConfig in NORMALIZED v2 shape — v1
// configs are migrated transparently. Callers don't need to branch.

/** A single Talend Cloud tenant. */
export interface TalendTenant {
  /** Stable identifier; surfaces as the `tenant` label in Prometheus. */
  id: string;
  /** Human-readable name shown in the UI. */
  label: string;
  /** Region slug — `us`, `eu`, `ap`, `au`, `us-west`. */
  region: TmcRegion;
  /**
   * Optional URL override. When set, takes precedence over the region's
   * default base URL. Useful for private cloud deployments.
   */
  urlOverride?: string;
  /** Personal Access Token (Bearer header). Redacted in logs. */
  pat?: string;
  /** Where the PAT lives: file (here) or keychain (under id-suffixed account). */
  patStorage?: "file" | "keychain";
  /** Per-tenant API subset; falls back to top-level `apis` when absent. */
  apis?: TmcApi[];
  /** Per-tenant request timeout. */
  timeoutMs?: number;
}

/** A single Qlik Cloud tenant. */
export interface QlikTenant {
  id: string;
  label: string;
  /** Tenant URL, e.g. `https://your-tenant.us.qlikcloud.com`. */
  tenantUrl: string;
  /** Qlik Cloud API key (Bearer header). Redacted in logs. */
  apiKey?: string;
  apiKeyStorage?: "file" | "keychain";
  /** Data Files connection ID (where QVD uploads land). */
  connectionId?: string;
  /** Optional per-tenant timeout. */
  timeoutMs?: number;
}

export interface TmcFileConfig {
  /** Schema version. 2 = multi-tenant. Older files are auto-upgraded. */
  schemaVersion?: 2;
  /** Array of configured Talend tenants. May be empty if not configured yet. */
  talendTenants?: TalendTenant[];
  /** Array of configured Qlik tenants. */
  qlikTenants?: QlikTenant[];
  /** id of the default Talend tenant — what the MCP server uses on startup. */
  defaultTalendId?: string;
  /** id of the default Qlik tenant — what single-tenant exporters use. */
  defaultQlikId?: string;

  // ---- v1 fields, retained for read-only back-compat ----
  /** @deprecated v1 single-PAT field. Migrated to talendTenants[0] on read. */
  pat?: string;
  /** @deprecated v1 single-region field. */
  region?: TmcRegion;
  /** @deprecated v1 single-API-filter field. */
  apis?: TmcApi[];
  /** @deprecated v1 single-timeout field. */
  timeoutMs?: number;
  /** @deprecated v1 storage marker. */
  patStorage?: "file" | "keychain";
}

/**
 * Resolve the on-disk config location. We follow the conventional spot per OS:
 *   Windows: %APPDATA%\talend-tmc-mcp\config.json
 *   macOS/Linux: $XDG_CONFIG_HOME/talend-tmc-mcp/config.json (falls back to ~/.config/...)
 */
export function configPath(): string {
  if (platform() === "win32") {
    const base = process.env.APPDATA ?? homedir();
    return join(base, "talend-tmc-mcp", "config.json");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "talend-tmc-mcp", "config.json");
}

/**
 * Load the config file. Returns a NORMALIZED v2 shape regardless of what was
 * on disk — v1 configs are migrated in-memory so callers don't branch.
 * Returns `null` when the file doesn't exist; throws on parse errors so the
 * user knows their config is broken.
 */
export async function loadConfigFile(): Promise<TmcFileConfig | null> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return migrate(parsed as TmcFileConfig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Failed to read ${configPath()}: ${(err as Error).message}`);
  }
}

/**
 * Upgrade a v1 config in-memory. The v1→v2 mapping is: the single (pat,
 * region, apis, timeoutMs) becomes the first and only Talend tenant, marked
 * as default. We do NOT rewrite the file here — that's the wizard / UI's job
 * the next time the user saves. Reading old files stays purely additive.
 */
export function migrate(cfg: TmcFileConfig): TmcFileConfig {
  if (cfg.schemaVersion === 2 && Array.isArray(cfg.talendTenants)) return cfg;

  const out: TmcFileConfig = {
    ...cfg,
    schemaVersion: 2,
    talendTenants: Array.isArray(cfg.talendTenants) ? cfg.talendTenants : [],
    qlikTenants: Array.isArray(cfg.qlikTenants) ? cfg.qlikTenants : [],
  };

  if ((cfg.pat || cfg.region) && (!out.talendTenants || out.talendTenants.length === 0)) {
    const tenant: TalendTenant = {
      id: "default",
      label: "Default",
      region: (cfg.region ?? "us") as TmcRegion,
      patStorage: cfg.patStorage,
    };
    if (cfg.pat) tenant.pat = cfg.pat;
    if (cfg.apis && cfg.apis.length > 0) tenant.apis = cfg.apis;
    if (cfg.timeoutMs !== undefined) tenant.timeoutMs = cfg.timeoutMs;
    out.talendTenants = [tenant];
    out.defaultTalendId = "default";
  } else if (out.talendTenants && out.talendTenants.length > 0 && !out.defaultTalendId) {
    out.defaultTalendId = out.talendTenants[0]!.id;
  }

  if (out.qlikTenants && out.qlikTenants.length > 0 && !out.defaultQlikId) {
    out.defaultQlikId = out.qlikTenants[0]!.id;
  }

  return out;
}

/** Find the default Talend tenant. Returns `undefined` when none configured. */
export function defaultTalendTenant(cfg: TmcFileConfig | null | undefined): TalendTenant | undefined {
  if (!cfg?.talendTenants?.length) return undefined;
  if (cfg.defaultTalendId) {
    const hit = cfg.talendTenants.find((t) => t.id === cfg.defaultTalendId);
    if (hit) return hit;
  }
  return cfg.talendTenants[0];
}

/** Find the default Qlik tenant. */
export function defaultQlikTenant(cfg: TmcFileConfig | null | undefined): QlikTenant | undefined {
  if (!cfg?.qlikTenants?.length) return undefined;
  if (cfg.defaultQlikId) {
    const hit = cfg.qlikTenants.find((t) => t.id === cfg.defaultQlikId);
    if (hit) return hit;
  }
  return cfg.qlikTenants[0];
}

export function isValidApi(name: string): name is TmcApi {
  return (TMC_APIS as readonly string[]).includes(name);
}
