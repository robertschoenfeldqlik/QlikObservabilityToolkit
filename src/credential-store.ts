/**
 * Pluggable credential storage — now multi-tenant.
 *
 * Backends per tenant:
 *   "file"     → secret lives in config.json under the tenant's record
 *   "keychain" → secret lives in the OS credential manager under the
 *                service "talend-tmc-mcp" with the account name
 *                "talend:<tenantId>" or "qlik:<tenantId>"
 *
 * The keychain backend is opt-in per tenant. When unavailable (alpine
 * without libsecret, headless Linux, etc.) the file backend is the safe
 * default. `probeKeychain()` reports availability with a human reason.
 *
 * Migration: legacy single-PAT configs (v1) are read transparently by
 * `loadConfigFile()` in config.ts. The first time the UI saves, the file
 * is rewritten in v2 shape.
 */
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TmcApi, TmcRegion } from "./apis.js";
import {
  configPath,
  loadConfigFile,
  type QlikTenant,
  type TalendTenant,
  type TmcFileConfig,
} from "./config.js";
import {
  decryptValue,
  encryptValue,
  ensureMasterKey,
  isEncrypted,
  isEncryptionAvailable,
} from "./encryption.js";

export type PatStorage = "file" | "keychain";

const KEYCHAIN_SERVICE = "talend-tmc-mcp";
/** Legacy single-tenant keychain account name; consulted on migration only. */
const LEGACY_KEYCHAIN_ACCOUNT = "default";

const TALEND_ACCOUNT_PREFIX = "talend:";
const QLIK_ACCOUNT_PREFIX = "qlik:";

/** Result of probing the keyring backend at runtime. */
export interface KeychainProbe {
  available: boolean;
  /** Human-readable reason if unavailable. */
  reason?: string;
  /** OS-level backend name shown in diagnostics. */
  backend?: string;
}

let _cachedProbe: KeychainProbe | null = null;

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<unknown>;
}
interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
}

async function loadKeyringModule(): Promise<KeyringModule | { error: Error }> {
  try {
    const mod = (await import("@napi-rs/keyring")) as KeyringModule;
    if (!mod?.AsyncEntry) return { error: new Error("@napi-rs/keyring loaded but AsyncEntry is missing") };
    return mod;
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function probeKeychain(): Promise<KeychainProbe> {
  if (_cachedProbe) return _cachedProbe;
  const mod = await loadKeyringModule();
  if ("error" in mod) {
    _cachedProbe = { available: false, reason: `keyring native module unavailable: ${mod.error.message}` };
    return _cachedProbe;
  }
  try {
    const sentinel = "__tmc-mcp-probe__";
    const entry = new mod.AsyncEntry(KEYCHAIN_SERVICE, sentinel);
    await entry.setPassword("probe");
    const got = await entry.getPassword();
    await entry.deletePassword().catch(() => undefined);
    if (got !== "probe") {
      _cachedProbe = { available: false, reason: "keyring round-trip returned wrong value" };
      return _cachedProbe;
    }
    _cachedProbe = { available: true, backend: detectBackendName() };
    return _cachedProbe;
  } catch (err) {
    _cachedProbe = {
      available: false,
      reason: `keyring probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return _cachedProbe;
  }
}

export function _resetKeychainProbe() {
  _cachedProbe = null;
}

function detectBackendName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS Keychain";
    case "win32":
      return "Windows Credential Manager";
    case "linux":
      return "libsecret (Secret Service)";
    default:
      return `OS keyring (${process.platform})`;
  }
}

// ---------------------------------------------------------------------------
// Multi-tenant primitives
// ---------------------------------------------------------------------------

async function keychainGet(account: string): Promise<string | null> {
  const probe = await probeKeychain();
  if (!probe.available) {
    throw new Error(`OS keyring unavailable: ${probe.reason}`);
  }
  const mod = (await loadKeyringModule()) as KeyringModule;
  const entry = new mod.AsyncEntry(KEYCHAIN_SERVICE, account);
  try {
    const v = await entry.getPassword();
    return v ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no.*entry|not found|noentry/i.test(msg)) return null;
    throw new Error(`Failed to read keyring entry "${account}": ${msg}`);
  }
}

async function keychainSet(account: string, secret: string): Promise<void> {
  const probe = await probeKeychain();
  if (!probe.available) {
    throw new Error(`Cannot save to OS keyring: ${probe.reason}. Use storage="file" instead.`);
  }
  const mod = (await loadKeyringModule()) as KeyringModule;
  await new mod.AsyncEntry(KEYCHAIN_SERVICE, account).setPassword(secret);
}

async function keychainDelete(account: string): Promise<void> {
  const probe = await probeKeychain();
  if (!probe.available) return; // best-effort
  const mod = (await loadKeyringModule()) as KeyringModule;
  await new mod.AsyncEntry(KEYCHAIN_SERVICE, account).deletePassword().catch(() => undefined);
}

const talendAccount = (id: string) => `${TALEND_ACCOUNT_PREFIX}${id}`;
const qlikAccount = (id: string) => `${QLIK_ACCOUNT_PREFIX}${id}`;

// ---------------------------------------------------------------------------
// Public API — reads
// ---------------------------------------------------------------------------

/** Read the PAT for a specific Talend tenant. */
export async function loadTalendPat(tenantId: string): Promise<string | null> {
  const cfg = await loadConfigFile().catch(() => null);
  const tenant = cfg?.talendTenants?.find((t) => t.id === tenantId);
  if (!tenant) return null;
  return readTalendSecret(tenant);
}

/** Read the API key for a specific Qlik tenant. */
export async function loadQlikApiKey(tenantId: string): Promise<string | null> {
  const cfg = await loadConfigFile().catch(() => null);
  const tenant = cfg?.qlikTenants?.find((t) => t.id === tenantId);
  if (!tenant) return null;
  return readQlikSecret(tenant);
}

/** Back-compat single-tenant accessor — returns the default Talend tenant's PAT. */
export async function loadPat(): Promise<string | null> {
  const cfg = await loadConfigFile().catch(() => null);
  if (!cfg) return null;
  const defaultId = cfg.defaultTalendId;
  if (defaultId) {
    const tenant = cfg.talendTenants?.find((t) => t.id === defaultId);
    if (tenant) return readTalendSecret(tenant);
  }
  // No tenants configured yet, but a legacy keychain entry might still exist
  // from a v1 install that has been wiped in the file.
  if ((cfg.patStorage ?? "file") === "keychain") {
    return keychainGet(LEGACY_KEYCHAIN_ACCOUNT).catch(() => null);
  }
  return cfg.pat ?? null;
}

async function readTalendSecret(t: TalendTenant): Promise<string | null> {
  if ((t.patStorage ?? "file") === "keychain") {
    return keychainGet(talendAccount(t.id));
  }
  // File-backed: may be plaintext (legacy / no encryption) or enc:v1:... (encrypted at rest).
  // decryptValue() handles both — passes plaintext through unchanged.
  return await decryptValue(t.pat ?? null);
}

async function readQlikSecret(t: QlikTenant): Promise<string | null> {
  if ((t.apiKeyStorage ?? "file") === "keychain") {
    return keychainGet(qlikAccount(t.id));
  }
  return await decryptValue(t.apiKey ?? null);
}

/**
 * Encrypt a secret if encryption at rest is available (keyring master key or
 * TMC_MASTER_PASSPHRASE env). Otherwise return the plaintext unchanged. We
 * intentionally never auto-bootstrap the keyring master key here — that's
 * `enableEncryptionAtRest()`'s job. This keeps the default "just works"
 * behavior for users who haven't opted into encryption.
 */
async function maybeEncryptForFile(plaintext: string): Promise<string> {
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already an envelope
  if (!(await isEncryptionAvailable())) return plaintext;
  return await encryptValue(plaintext);
}

/**
 * Turn on encryption at rest. Bootstraps a master key in the OS keyring
 * (generated random 32 bytes) if needed, then re-writes the config file
 * with every file-backed secret encrypted in place. Subsequent saves
 * automatically encrypt because isEncryptionAvailable() now returns true.
 *
 * Set TMC_MASTER_PASSPHRASE before calling if you'd rather a passphrase-
 * derived key — it takes precedence over the keyring source.
 */
export async function enableEncryptionAtRest(): Promise<{ source: "env" | "keyring"; rewritten: number }> {
  const got = await ensureMasterKey();
  const cfg = await loadConfigFile().catch(() => null);
  if (!cfg) return { source: got.source, rewritten: 0 };

  let rewritten = 0;
  for (const t of cfg.talendTenants ?? []) {
    if (t.pat && !isEncrypted(t.pat)) {
      t.pat = await encryptValue(t.pat);
      rewritten++;
    }
  }
  for (const t of cfg.qlikTenants ?? []) {
    if (t.apiKey && !isEncrypted(t.apiKey)) {
      t.apiKey = await encryptValue(t.apiKey);
      rewritten++;
    }
  }
  // Legacy v1 single PAT, if anyone's still carrying it inline.
  if (cfg.pat && !isEncrypted(cfg.pat)) {
    cfg.pat = await encryptValue(cfg.pat);
    rewritten++;
  }
  if (rewritten > 0) {
    cfg.schemaVersion = 2;
    await writeConfigFile(cfg);
  }
  return { source: got.source, rewritten };
}

/**
 * Roll the master key. Re-encrypts every file-backed secret with the new
 * key, then atomically writes the file. Caller is responsible for putting
 * the new passphrase into TMC_MASTER_PASSPHRASE (or rotating the keyring
 * entry) BEFORE calling — we decrypt with the OLD key and encrypt with the
 * CURRENT key, so the cache must reflect the new key by call time.
 */
export async function reencryptAllSecrets(): Promise<{ rewritten: number }> {
  const cfg = await loadConfigFile().catch(() => null);
  if (!cfg) return { rewritten: 0 };
  let rewritten = 0;
  for (const t of cfg.talendTenants ?? []) {
    if (t.pat) {
      // decryptValue handles plaintext too; encryptValue requires a master key.
      const plain = await decryptValue(t.pat);
      if (plain) {
        t.pat = await encryptValue(plain);
        rewritten++;
      }
    }
  }
  for (const t of cfg.qlikTenants ?? []) {
    if (t.apiKey) {
      const plain = await decryptValue(t.apiKey);
      if (plain) {
        t.apiKey = await encryptValue(plain);
        rewritten++;
      }
    }
  }
  if (rewritten > 0) await writeConfigFile(cfg);
  return { rewritten };
}

// ---------------------------------------------------------------------------
// Snapshots — what the UI / wizard read. Never include the full secret.
// ---------------------------------------------------------------------------

export interface TalendTenantSnapshot {
  id: string;
  label: string;
  region: TmcRegion;
  urlOverride?: string;
  apis: TmcApi[];
  timeoutMs?: number;
  patStorage: PatStorage;
  patSet: boolean;
  patHint: string | null;
  isDefault: boolean;
}

export interface QlikTenantSnapshot {
  id: string;
  label: string;
  tenantUrl: string;
  connectionId?: string;
  timeoutMs?: number;
  apiKeyStorage: PatStorage;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  isDefault: boolean;
}

export interface ConfigSnapshot {
  configPath: string;
  hasConfig: boolean;
  schemaVersion: 2;
  talendTenants: TalendTenantSnapshot[];
  qlikTenants: QlikTenantSnapshot[];
  defaultTalendId?: string;
  defaultQlikId?: string;
  keychain: KeychainProbe;
  /** Whether secret values written to the config file are AES-256-GCM encrypted. */
  encryptionAtRest: {
    available: boolean;
    /** Where the master key would come from. "env" = TMC_MASTER_PASSPHRASE; "keyring" = OS credential manager; null = not configured. */
    keySource: "env" | "keyring" | null;
    /** Count of secrets currently encrypted on disk (informational). */
    encryptedSecretCount: number;
    /** Total file-backed secrets (informational — encryptedSecretCount / total = adoption). */
    fileSecretCount: number;
  };
}

export async function snapshotConfig(): Promise<ConfigSnapshot> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? null;
  const keychain = await probeKeychain();

  const talendTenants: TalendTenantSnapshot[] = await Promise.all(
    (cfg?.talendTenants ?? []).map(async (t) => {
      const pat = await readTalendSecret(t).catch(() => null);
      return {
        id: t.id,
        label: t.label,
        region: t.region,
        urlOverride: t.urlOverride,
        apis: t.apis ?? [],
        timeoutMs: t.timeoutMs,
        patStorage: (t.patStorage ?? "file") as PatStorage,
        patSet: !!pat,
        patHint: pat ? `••••${pat.slice(-4)}` : null,
        isDefault: t.id === cfg?.defaultTalendId,
      };
    }),
  );

  const qlikTenants: QlikTenantSnapshot[] = await Promise.all(
    (cfg?.qlikTenants ?? []).map(async (t) => {
      const key = await readQlikSecret(t).catch(() => null);
      return {
        id: t.id,
        label: t.label,
        tenantUrl: t.tenantUrl,
        connectionId: t.connectionId,
        timeoutMs: t.timeoutMs,
        apiKeyStorage: (t.apiKeyStorage ?? "file") as PatStorage,
        apiKeySet: !!key,
        apiKeyHint: key ? `••••${key.slice(-4)}` : null,
        isDefault: t.id === cfg?.defaultQlikId,
      };
    }),
  );

  // Encryption-at-rest status — counts file-backed secrets that are currently
  // stored as `enc:v1:...` envelopes versus plaintext.
  let encryptedCount = 0;
  let fileCount = 0;
  for (const t of cfg?.talendTenants ?? []) {
    if ((t.patStorage ?? "file") === "file" && t.pat) {
      fileCount++;
      if (isEncrypted(t.pat)) encryptedCount++;
    }
  }
  for (const t of cfg?.qlikTenants ?? []) {
    if ((t.apiKeyStorage ?? "file") === "file" && t.apiKey) {
      fileCount++;
      if (isEncrypted(t.apiKey)) encryptedCount++;
    }
  }
  const encAvailable = await isEncryptionAvailable();
  const keySource: "env" | "keyring" | null = !encAvailable
    ? null
    : process.env.TMC_MASTER_PASSPHRASE
      ? "env"
      : "keyring";

  return {
    configPath: configPath(),
    hasConfig: cfg !== null,
    schemaVersion: 2,
    talendTenants,
    qlikTenants,
    defaultTalendId: cfg?.defaultTalendId,
    defaultQlikId: cfg?.defaultQlikId,
    keychain,
    encryptionAtRest: {
      available: encAvailable,
      keySource,
      encryptedSecretCount: encryptedCount,
      fileSecretCount: fileCount,
    },
  };
}

/** Legacy single-tenant snapshot used by older UI code. Default tenant only. */
export interface CredentialSnapshot {
  region?: TmcRegion;
  apis?: TmcApi[];
  timeoutMs?: number;
  patStorage: PatStorage;
  patSet: boolean;
  patHint: string | null;
}

export async function snapshotCredentials(): Promise<CredentialSnapshot> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  const t =
    (cfg.talendTenants ?? []).find((x) => x.id === cfg.defaultTalendId) ?? (cfg.talendTenants ?? [])[0];
  let pat: string | null = null;
  try {
    pat = t ? await readTalendSecret(t) : null;
  } catch {
    pat = null;
  }
  return {
    region: t?.region,
    apis: t?.apis,
    timeoutMs: t?.timeoutMs,
    patStorage: (t?.patStorage ?? "file") as PatStorage,
    patSet: !!pat,
    patHint: pat ? `••••${pat.slice(-4)}` : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SaveTalendTenantInput {
  id: string;
  label: string;
  region: TmcRegion;
  urlOverride?: string;
  apis?: TmcApi[];
  timeoutMs?: number;
  patStorage: PatStorage;
  /** New PAT value; pass null to keep the existing token (region/label-only edits). */
  pat: string | null;
  /** Mark this tenant as the new default. */
  makeDefault?: boolean;
}

export interface SaveQlikTenantInput {
  id: string;
  label: string;
  tenantUrl: string;
  connectionId?: string;
  timeoutMs?: number;
  apiKeyStorage: PatStorage;
  /** New API key value; pass null to keep the existing one. */
  apiKey: string | null;
  makeDefault?: boolean;
}

export async function saveTalendTenant(input: SaveTalendTenantInput): Promise<{ path: string }> {
  if (!input.id || !input.id.trim()) throw new Error("tenant id is required");
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  cfg.talendTenants = cfg.talendTenants ?? [];
  const idx = cfg.talendTenants.findIndex((t) => t.id === input.id);
  const existing = idx >= 0 ? cfg.talendTenants[idx]! : undefined;

  // Resolve the effective PAT: explicit value wins, else keep the existing one.
  let effectivePat = input.pat;
  if (effectivePat === null) {
    if (!existing) throw new Error(`No existing PAT to keep for tenant "${input.id}".`);
    effectivePat = await readTalendSecret(existing);
    if (!effectivePat) throw new Error(`No existing PAT to keep for tenant "${input.id}".`);
  }
  effectivePat = effectivePat.trim();
  if (!effectivePat) throw new Error("PAT may not be empty.");

  // Migration between backends — write to new place first, delete old after.
  const previousStorage = existing?.patStorage ?? "file";
  if (input.patStorage === "keychain") {
    await keychainSet(talendAccount(input.id), effectivePat);
  }

  const next: TalendTenant = {
    id: input.id,
    label: input.label || input.id,
    region: input.region,
    patStorage: input.patStorage,
  };
  if (input.urlOverride && input.urlOverride.trim()) next.urlOverride = input.urlOverride.trim();
  if (input.apis && input.apis.length > 0) next.apis = input.apis;
  if (input.timeoutMs !== undefined) next.timeoutMs = input.timeoutMs;
  if (input.patStorage === "file") {
    // Encrypt at rest when a master key is available; no-op otherwise so
    // users who haven't opted in still see plaintext (and migrate later).
    next.pat = await maybeEncryptForFile(effectivePat);
  }

  if (idx >= 0) cfg.talendTenants[idx] = next;
  else cfg.talendTenants.push(next);

  if (input.makeDefault || !cfg.defaultTalendId) cfg.defaultTalendId = input.id;
  cfg.schemaVersion = 2;

  await writeConfigFile(cfg);

  if (previousStorage === "keychain" && input.patStorage === "file") {
    await keychainDelete(talendAccount(input.id));
  }
  return { path: configPath() };
}

export async function saveQlikTenant(input: SaveQlikTenantInput): Promise<{ path: string }> {
  if (!input.id || !input.id.trim()) throw new Error("tenant id is required");
  if (!input.tenantUrl || !input.tenantUrl.trim()) throw new Error("tenantUrl is required");
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  cfg.qlikTenants = cfg.qlikTenants ?? [];
  const idx = cfg.qlikTenants.findIndex((t) => t.id === input.id);
  const existing = idx >= 0 ? cfg.qlikTenants[idx]! : undefined;

  let effectiveKey = input.apiKey;
  if (effectiveKey === null) {
    if (!existing) throw new Error(`No existing API key to keep for tenant "${input.id}".`);
    effectiveKey = await readQlikSecret(existing);
    if (!effectiveKey) throw new Error(`No existing API key to keep for tenant "${input.id}".`);
  }
  effectiveKey = effectiveKey.trim();
  if (!effectiveKey) throw new Error("API key may not be empty.");

  const previousStorage = existing?.apiKeyStorage ?? "file";
  if (input.apiKeyStorage === "keychain") {
    await keychainSet(qlikAccount(input.id), effectiveKey);
  }

  const next: QlikTenant = {
    id: input.id,
    label: input.label || input.id,
    tenantUrl: input.tenantUrl.replace(/\/+$/, ""),
    apiKeyStorage: input.apiKeyStorage,
  };
  if (input.connectionId && input.connectionId.trim()) next.connectionId = input.connectionId.trim();
  if (input.timeoutMs !== undefined) next.timeoutMs = input.timeoutMs;
  if (input.apiKeyStorage === "file") next.apiKey = await maybeEncryptForFile(effectiveKey);

  if (idx >= 0) cfg.qlikTenants[idx] = next;
  else cfg.qlikTenants.push(next);

  if (input.makeDefault || !cfg.defaultQlikId) cfg.defaultQlikId = input.id;
  cfg.schemaVersion = 2;

  await writeConfigFile(cfg);

  if (previousStorage === "keychain" && input.apiKeyStorage === "file") {
    await keychainDelete(qlikAccount(input.id));
  }
  return { path: configPath() };
}

export async function deleteTalendTenant(id: string): Promise<{ path: string }> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  cfg.talendTenants = (cfg.talendTenants ?? []).filter((t) => t.id !== id);
  if (cfg.defaultTalendId === id) cfg.defaultTalendId = cfg.talendTenants[0]?.id;
  cfg.schemaVersion = 2;
  await writeConfigFile(cfg);
  await keychainDelete(talendAccount(id));
  return { path: configPath() };
}

export async function deleteQlikTenant(id: string): Promise<{ path: string }> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  cfg.qlikTenants = (cfg.qlikTenants ?? []).filter((t) => t.id !== id);
  if (cfg.defaultQlikId === id) cfg.defaultQlikId = cfg.qlikTenants[0]?.id;
  cfg.schemaVersion = 2;
  await writeConfigFile(cfg);
  await keychainDelete(qlikAccount(id));
  return { path: configPath() };
}

export async function setDefaultTalend(id: string): Promise<void> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  if (!(cfg.talendTenants ?? []).some((t) => t.id === id)) {
    throw new Error(`No Talend tenant with id "${id}".`);
  }
  cfg.defaultTalendId = id;
  cfg.schemaVersion = 2;
  await writeConfigFile(cfg);
}

export async function setDefaultQlik(id: string): Promise<void> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? {};
  if (!(cfg.qlikTenants ?? []).some((t) => t.id === id)) {
    throw new Error(`No Qlik tenant with id "${id}".`);
  }
  cfg.defaultQlikId = id;
  cfg.schemaVersion = 2;
  await writeConfigFile(cfg);
}

export async function deleteCredentials(): Promise<{ path: string }> {
  const cfg = (await loadConfigFile().catch(() => null)) ?? null;
  // Clear all known keychain entries first.
  for (const t of cfg?.talendTenants ?? []) await keychainDelete(talendAccount(t.id));
  for (const t of cfg?.qlikTenants ?? []) await keychainDelete(qlikAccount(t.id));
  await keychainDelete(LEGACY_KEYCHAIN_ACCOUNT);

  const path = configPath();
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { path };
}

// ---------------------------------------------------------------------------
// Legacy single-tenant save — preserved so older UI/wizard code still works
// during the transition. Treats input as the "default" tenant.
// ---------------------------------------------------------------------------

export interface SaveInput {
  pat: string | null;
  storage: PatStorage;
  region: TmcRegion;
  apis?: TmcApi[];
  timeoutMs?: number;
}

export async function saveCredentials(input: SaveInput): Promise<{ path: string; storage: PatStorage }> {
  await saveTalendTenant({
    id: "default",
    label: "Default",
    region: input.region,
    apis: input.apis,
    timeoutMs: input.timeoutMs,
    patStorage: input.storage,
    pat: input.pat,
    makeDefault: true,
  });
  return { path: configPath(), storage: input.storage };
}

// ---------------------------------------------------------------------------
// File I/O helper — writes the config with sensible permissions.
// ---------------------------------------------------------------------------

async function writeConfigFile(cfg: TmcFileConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  // Strip undefined keys for a clean file.
  const cleaned: TmcFileConfig = JSON.parse(JSON.stringify(cfg));
  await writeFile(path, JSON.stringify(cleaned, null, 2), "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // Best-effort on Windows.
  }
  await readFile(path, "utf8");
}
