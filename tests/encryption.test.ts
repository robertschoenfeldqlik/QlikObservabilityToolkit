import { test } from "node:test";
import assert from "node:assert/strict";

import {
  _resetEncryptionCache,
  decryptValue,
  encryptValue,
  ensureMasterKey,
  isEncrypted,
  isEncryptionAvailable,
} from "../src/encryption.js";

// Tests use the passphrase source so we don't depend on the OS keyring.
// _resetEncryptionCache between cases that change env.
test("setup: passphrase source", () => {
  process.env.TMC_MASTER_PASSPHRASE = "correct-horse-battery-staple-test-only";
  _resetEncryptionCache();
});

test("isEncryptionAvailable() true when passphrase set", async () => {
  assert.equal(await isEncryptionAvailable(), true);
});

test("encrypt / decrypt round-trip with ASCII", async () => {
  const out = await encryptValue("tcp_test_token_12345");
  assert.ok(isEncrypted(out), "encrypt output must be enc:v1:... shape");
  assert.match(out, /^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  const back = await decryptValue(out);
  assert.equal(back, "tcp_test_token_12345");
});

test("encrypt produces different ciphertext for the same plaintext (IV is fresh)", async () => {
  const a = await encryptValue("same");
  const b = await encryptValue("same");
  assert.notEqual(a, b, "fresh IV each call");
  assert.equal(await decryptValue(a), "same");
  assert.equal(await decryptValue(b), "same");
});

test("decryptValue passes plaintext through unchanged", async () => {
  assert.equal(await decryptValue("tcp_raw_token"), "tcp_raw_token");
  assert.equal(await decryptValue(null), null);
});

test("tampered ciphertext fails authentication", async () => {
  const ct = await encryptValue("important-secret");
  // Flip a single byte in the ciphertext portion (index 3 in the colon-split list).
  const parts = ct.split(":");
  const tamperedCt = Buffer.from(parts[3]!, "base64");
  tamperedCt[0] = tamperedCt[0]! ^ 0x01;
  parts[3] = tamperedCt.toString("base64");
  const tampered = parts.join(":");
  await assert.rejects(() => decryptValue(tampered), /authentication failed/);
});

test("wrong key fails authentication", async () => {
  const ct = await encryptValue("under-key-A");
  // Swap the master key to "B" and try to decrypt.
  process.env.TMC_MASTER_PASSPHRASE = "completely-different-passphrase-here";
  _resetEncryptionCache();
  await assert.rejects(() => decryptValue(ct), /authentication failed/);
  // Put the original back so subsequent tests work.
  process.env.TMC_MASTER_PASSPHRASE = "correct-horse-battery-staple-test-only";
  _resetEncryptionCache();
});

test("envelope shape: enc:v1:<iv>:<ct>:<tag> — exactly 5 colon parts", async () => {
  const ct = await encryptValue("envelope-test");
  const parts = ct.split(":");
  assert.equal(parts.length, 5);
  assert.equal(parts[0], "enc");
  assert.equal(parts[1], "v1");
  const iv = Buffer.from(parts[2]!, "base64");
  assert.equal(iv.length, 12, "IV must be 96 bits");
  const tag = Buffer.from(parts[4]!, "base64");
  assert.equal(tag.length, 16, "GCM tag is 128 bits");
});

test("malformed envelope rejected with parseable error", async () => {
  await assert.rejects(() => decryptValue("enc:v1:not-enough-parts"), /unrecognized envelope/);
});

test("encryptValue throws on empty plaintext", async () => {
  await assert.rejects(() => encryptValue(""), /empty plaintext/);
});

test("isEncrypted() recognises only enc:v1: prefix", () => {
  assert.equal(isEncrypted("enc:v1:abc:def:ghi"), true);
  assert.equal(isEncrypted("enc:v2:abc"), false);
  assert.equal(isEncrypted("tcp_real_token"), false);
  assert.equal(isEncrypted(""), false);
  assert.equal(isEncrypted(null), false);
});

test("ensureMasterKey returns the passphrase-derived key", async () => {
  const got = await ensureMasterKey();
  assert.equal(got.source, "env");
  assert.equal(got.key.length, 32);
});

test("integration: saveTalendTenant encrypts the PAT on disk when a master key is present", async () => {
  const { mkdtemp, readFile, rm, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tempDir = await mkdtemp(join(tmpdir(), "tmc-mcp-enc-"));
  process.env.APPDATA = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
  await mkdir(tempDir + "/talend-tmc-mcp", { recursive: true });

  process.env.TMC_MASTER_PASSPHRASE = "encrypt-on-disk-test-passphrase-123";
  _resetEncryptionCache();

  const { saveTalendTenant, loadTalendPat, snapshotConfig } = await import("../src/credential-store.js");
  const { configPath } = await import("../src/config.js");

  await saveTalendTenant({
    id: "enc-test",
    label: "Encryption integration test",
    region: "us",
    patStorage: "file",
    pat: "tcp_should_be_encrypted_on_disk_999",
    makeDefault: true,
  });

  // The on-disk JSON must NOT contain the plaintext token.
  const raw = await readFile(configPath(), "utf8");
  assert.doesNotMatch(raw, /tcp_should_be_encrypted_on_disk_999/);
  assert.match(raw, /"pat":\s*"enc:v1:/);

  // But loadTalendPat must return the original plaintext (transparent decrypt).
  assert.equal(await loadTalendPat("enc-test"), "tcp_should_be_encrypted_on_disk_999");

  // Snapshot reflects encryption status.
  const snap = await snapshotConfig();
  assert.equal(snap.encryptionAtRest.available, true);
  assert.equal(snap.encryptionAtRest.keySource, "env");
  assert.equal(snap.encryptionAtRest.fileSecretCount, 1);
  assert.equal(snap.encryptionAtRest.encryptedSecretCount, 1);

  await rm(tempDir, { recursive: true, force: true });
});

test("integration: enableEncryptionAtRest migrates existing plaintext secrets", async () => {
  const { mkdtemp, readFile, rm, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tempDir = await mkdtemp(join(tmpdir(), "tmc-mcp-enc-mig-"));
  process.env.APPDATA = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
  await mkdir(tempDir + "/talend-tmc-mcp", { recursive: true });

  // Pre-existing plaintext config (encryption was OFF when this was written).
  delete process.env.TMC_MASTER_PASSPHRASE;
  _resetEncryptionCache();

  const { configPath } = await import("../src/config.js");
  await writeFile(
    configPath(),
    JSON.stringify({
      schemaVersion: 2,
      defaultTalendId: "old",
      talendTenants: [
        { id: "old", label: "Old plaintext", region: "us", pat: "tcp_old_plaintext_token_abcd", patStorage: "file" },
      ],
    }),
    "utf8",
  );

  // Turn on encryption + migrate.
  process.env.TMC_MASTER_PASSPHRASE = "migration-passphrase-test";
  _resetEncryptionCache();
  const { enableEncryptionAtRest, loadTalendPat } = await import("../src/credential-store.js");
  const result = await enableEncryptionAtRest();
  assert.equal(result.rewritten, 1);
  assert.equal(result.source, "env");

  // On disk: now encrypted.
  const raw = await readFile(configPath(), "utf8");
  assert.doesNotMatch(raw, /tcp_old_plaintext_token_abcd/);
  assert.match(raw, /"pat":\s*"enc:v1:/);

  // Reads still return the original plaintext.
  assert.equal(await loadTalendPat("old"), "tcp_old_plaintext_token_abcd");

  await rm(tempDir, { recursive: true, force: true });
});

test("teardown: clear passphrase env so other tests don't inherit it", () => {
  delete process.env.TMC_MASTER_PASSPHRASE;
  _resetEncryptionCache();
});
