/**
 * Encryption at rest for file-backed secrets (PATs, Qlik API keys, master keys).
 *
 * Format:
 *   enc:v1:<base64-iv>:<base64-ciphertext>:<base64-authtag>
 *
 * Algorithm: AES-256-GCM with a 96-bit random IV per ciphertext. The master
 * key is 32 bytes; the auth tag is 16 bytes. Encryption is authenticated so
 * tampering with the on-disk JSON gets caught (decrypt() throws).
 *
 * Master key sources, in order:
 *   1. TMC_MASTER_PASSPHRASE env var (PBKDF2-derived, 200k iterations, SHA-256,
 *      static project salt — see SALT below). Set to a strong passphrase
 *      shared across machines if you need the same encrypted file to decrypt
 *      in multiple places.
 *   2. OS keyring entry SERVICE="talend-tmc-mcp" ACCOUNT="__master_key__".
 *      The key is base64-encoded 32 random bytes. Auto-generated on first
 *      `enableEncryption()` call when the keyring is available.
 *
 * If neither source is available, `isEncryptionAvailable()` returns false and
 * the credential store falls back to plaintext file storage (i.e. the
 * pre-encryption behavior, so nothing breaks for users who can't or won't
 * opt in). Existing plaintext entries in the config file remain readable —
 * `decryptValue()` is a no-op for non-`enc:v1:` strings.
 *
 * Why no PEM/JWK: the keys here only protect a local JSON file from
 * casual filesystem access. Heavy crypto-key plumbing would add complexity
 * without a meaningful security upgrade.
 */
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_DIGEST = "sha256";
/** Project-scoped salt. NOT secret — used to make the derived key project-specific. */
const SALT = Buffer.from("tmc-mcp-encryption-v1-salt", "utf8");

const MASTER_KEY_ACCOUNT = "__master_key__";
const KEYCHAIN_SERVICE = "talend-tmc-mcp";

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<unknown>;
}
interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
}

async function loadKeyringModule(): Promise<KeyringModule | null> {
  try {
    const mod = (await import("@napi-rs/keyring")) as KeyringModule;
    return mod?.AsyncEntry ? mod : null;
  } catch {
    return null;
  }
}

let _cachedKey: Buffer | null = null;
let _cachedSource: "env" | "keyring" | null = null;

/**
 * Reset cached master key. Used by tests to swap key sources between cases.
 * NOT a "lock the wallet" — the next call will read the key again.
 */
export function _resetEncryptionCache() {
  _cachedKey = null;
  _cachedSource = null;
}

/**
 * Find a master key WITHOUT generating one. Returns null if no key is
 * available. Read-only — safe to call repeatedly.
 */
export async function getMasterKey(): Promise<{ key: Buffer; source: "env" | "keyring" } | null> {
  if (_cachedKey) return { key: _cachedKey, source: _cachedSource! };
  const env = process.env.TMC_MASTER_PASSPHRASE;
  if (env && env.length >= 8) {
    const key = pbkdf2Sync(env, SALT, PBKDF2_ITERATIONS, KEY_LEN, PBKDF2_DIGEST);
    _cachedKey = key;
    _cachedSource = "env";
    return { key, source: "env" };
  }
  const mod = await loadKeyringModule();
  if (mod) {
    try {
      const entry = new mod.AsyncEntry(KEYCHAIN_SERVICE, MASTER_KEY_ACCOUNT);
      const raw = await entry.getPassword();
      if (raw) {
        const key = Buffer.from(raw, "base64");
        if (key.length === KEY_LEN) {
          _cachedKey = key;
          _cachedSource = "keyring";
          return { key, source: "keyring" };
        }
      }
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Ensure a master key exists. If a passphrase env var is set, just derive
 * from it. Otherwise, if the keyring is available, generate 32 random bytes
 * and store them. Returns the key + the source it came from. Throws when
 * neither source is reachable.
 */
export async function ensureMasterKey(): Promise<{ key: Buffer; source: "env" | "keyring" }> {
  const existing = await getMasterKey();
  if (existing) return existing;
  const mod = await loadKeyringModule();
  if (!mod) {
    throw new Error(
      "Cannot enable encryption at rest: no OS keyring backend and no TMC_MASTER_PASSPHRASE set.",
    );
  }
  const key = randomBytes(KEY_LEN);
  const entry = new mod.AsyncEntry(KEYCHAIN_SERVICE, MASTER_KEY_ACCOUNT);
  await entry.setPassword(key.toString("base64"));
  _cachedKey = key;
  _cachedSource = "keyring";
  return { key, source: "keyring" };
}

/**
 * True when a master key is currently available (env or keyring). Doesn't
 * generate one — call `ensureMasterKey()` if you want to bootstrap it.
 */
export async function isEncryptionAvailable(): Promise<boolean> {
  const got = await getMasterKey();
  return got !== null;
}

/** Drop the master key from the OS keyring. Plaintext fallbacks still work. */
export async function deleteMasterKey(): Promise<void> {
  _cachedKey = null;
  _cachedSource = null;
  const mod = await loadKeyringModule();
  if (!mod) return;
  try {
    const entry = new mod.AsyncEntry(KEYCHAIN_SERVICE, MASTER_KEY_ACCOUNT);
    await entry.deletePassword().catch(() => undefined);
  } catch {
    // best-effort
  }
}

/**
 * Returns true when the value is in the `enc:v1:...` encoded ciphertext form.
 * The credential store uses this to detect already-encrypted values when
 * roundtripping the file.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext string with the cached/loaded master key. Throws when
 * no master key is available. Returns a self-describing `enc:v1:...` string.
 */
export async function encryptValue(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("encryptValue: empty plaintext");
  const got = await getMasterKey();
  if (!got) throw new Error("encryptValue: no master key available");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", got.key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX.replace(/:$/, ""),
    iv.toString("base64"),
    ct.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a value. If the input doesn't look like ciphertext (`enc:v1:...`),
 * returns it unchanged — this lets the credential store call decryptValue()
 * unconditionally during loads and gracefully handle pre-encryption configs.
 */
export async function decryptValue(value: string | null | undefined): Promise<string | null> {
  if (value == null) return null;
  if (!isEncrypted(value)) return value;
  const parts = value.split(":");
  // enc:v1:<iv>:<ct>:<tag> → 5 parts
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error(`decryptValue: unrecognized envelope (parts=${parts.length})`);
  }
  const got = await getMasterKey();
  if (!got) {
    throw new Error(
      "decryptValue: encrypted value found but no master key available. " +
        "Set TMC_MASTER_PASSPHRASE or ensure the OS keyring has the master key entry.",
    );
  }
  const iv = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  const tag = Buffer.from(parts[4]!, "base64");
  if (iv.length !== IV_LEN) throw new Error(`decryptValue: bad IV length ${iv.length}`);
  if (tag.length !== TAG_LEN) throw new Error(`decryptValue: bad tag length ${tag.length}`);
  const decipher = createDecipheriv("aes-256-gcm", got.key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    // GCM auth tag mismatch → tampering OR wrong key.
    throw new Error(
      `decryptValue: authentication failed. Either the config file was tampered with or the ` +
        `master key changed. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
