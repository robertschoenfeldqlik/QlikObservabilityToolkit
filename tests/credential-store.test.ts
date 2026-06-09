import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We have to set the redirect env BEFORE importing the modules, since they
// resolve configPath() at call time but use process.env on each call. The
// config.ts implementation prefers process.env.APPDATA on win32 and
// XDG_CONFIG_HOME on POSIX; we hijack both so saves land in a tempdir.

let tempDir: string;

test("setup: redirect config dir to tempdir", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tmc-mcp-test-"));
  process.env.APPDATA = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
  // Also wipe any TMC_CRED_STORE override that might be inherited.
  delete process.env.TMC_CRED_STORE;
});

test("file backend roundtrip: save -> load -> snapshot", async () => {
  const { saveCredentials, loadPat, snapshotCredentials } = await import("../src/credential-store.js");

  await saveCredentials({
    pat: "tcp_filetest_1234",
    region: "eu",
    storage: "file",
    apis: ["orchestration"],
  });

  const pat = await loadPat();
  assert.equal(pat, "tcp_filetest_1234");

  const snap = await snapshotCredentials();
  assert.equal(snap.patStorage, "file");
  assert.equal(snap.patSet, true);
  assert.equal(snap.patHint, "••••1234");
  assert.equal(snap.region, "eu");
  assert.deepEqual(snap.apis, ["orchestration"]);
});

test("file backend: PAT lands in the v2 tenants[] entry", async () => {
  const { configPath } = await import("../src/config.js");
  const raw = JSON.parse(await readFile(configPath(), "utf8"));
  // Schema is now multi-tenant; the legacy save targets the "default" tenant.
  assert.equal(raw.schemaVersion, 2);
  assert.ok(Array.isArray(raw.talendTenants));
  const t = raw.talendTenants.find((x: { id: string }) => x.id === "default");
  assert.ok(t, "default tenant must exist");
  assert.equal(t.pat, "tcp_filetest_1234");
  assert.equal(t.patStorage, "file");
  assert.equal(raw.defaultTalendId, "default");
});

test("file backend: empty pat=null with no existing PAT throws", async () => {
  // Wipe the config dir first
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const { saveCredentials } = await import("../src/credential-store.js");
  await assert.rejects(
    () => saveCredentials({ pat: null, region: "us", storage: "file" }),
    /No existing PAT to keep/,
  );
});

test("file backend: pat=null keeps the existing token", async () => {
  const { saveCredentials, loadPat } = await import("../src/credential-store.js");
  await saveCredentials({ pat: "tcp_original_4321", region: "us", storage: "file" });

  // Now update region only, no pat
  await saveCredentials({ pat: null, region: "eu", storage: "file" });
  const pat = await loadPat();
  assert.equal(pat, "tcp_original_4321");
});

test("file backend: deleteCredentials removes the file", async () => {
  const { deleteCredentials, snapshotCredentials } = await import("../src/credential-store.js");
  const { configPath } = await import("../src/config.js");

  await deleteCredentials();
  await assert.rejects(() => access(configPath()), /ENOENT/);

  // Snapshot still works on a missing file — it just shows nothing configured.
  const snap = await snapshotCredentials();
  assert.equal(snap.patSet, false);
  assert.equal(snap.patStorage, "file");
});

test("file backend: legacy v1 configs are migrated to v2 on read", async () => {
  const { configPath, loadConfigFile } = await import("../src/config.js");
  await mkdir(tempDir + "/talend-tmc-mcp", { recursive: true });
  // Hand-write a config in the OLD v1 format (single pat at top level).
  await writeFile(configPath(), JSON.stringify({ pat: "tcp_legacy_abcd", region: "us" }, null, 2), "utf8");

  // loadConfigFile() returns a NORMALIZED v2 shape — v1 fields synthesized
  // into a single tenant named "default".
  const cfg = await loadConfigFile();
  assert.equal(cfg?.schemaVersion, 2);
  assert.equal(cfg?.talendTenants?.length, 1);
  assert.equal(cfg?.talendTenants?.[0]?.pat, "tcp_legacy_abcd");
  assert.equal(cfg?.talendTenants?.[0]?.region, "us");
  assert.equal(cfg?.defaultTalendId, "default");

  const { loadPat, snapshotCredentials } = await import("../src/credential-store.js");
  const pat = await loadPat();
  assert.equal(pat, "tcp_legacy_abcd");

  const snap = await snapshotCredentials();
  assert.equal(snap.patStorage, "file");
});

test("probeKeychain returns either available=true OR a reason string", async () => {
  const { probeKeychain, _resetKeychainProbe } = await import("../src/credential-store.js");
  _resetKeychainProbe();
  const r = await probeKeychain();
  // Don't assert availability — depends on test host. We just assert the shape.
  if (r.available) {
    assert.ok(r.backend, "available probe must include a backend name");
  } else {
    assert.ok(r.reason && r.reason.length > 0, "unavailable probe must include a reason");
  }
});

test("saveCredentials rejects empty PAT", async () => {
  const { saveCredentials } = await import("../src/credential-store.js");
  await assert.rejects(
    () => saveCredentials({ pat: "   ", region: "us", storage: "file" }),
    /PAT may not be empty/,
  );
});

test("multi-tenant: saveTalendTenant adds multiple tenants and tracks default", async () => {
  // Fresh dir
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const { saveTalendTenant, snapshotConfig, loadTalendPat, setDefaultTalend } =
    await import("../src/credential-store.js");

  await saveTalendTenant({
    id: "prod-us",
    label: "Production (US)",
    region: "us",
    patStorage: "file",
    pat: "tcp_prod_us_1111",
    makeDefault: true,
  });
  await saveTalendTenant({
    id: "dev-eu",
    label: "Dev (EU)",
    region: "eu",
    patStorage: "file",
    pat: "tcp_dev_eu_2222",
  });
  await saveTalendTenant({
    id: "private",
    label: "Private cloud",
    region: "us",
    urlOverride: "https://api.internal.example.com",
    patStorage: "file",
    pat: "tcp_private_3333",
  });

  const snap = await snapshotConfig();
  assert.equal(snap.talendTenants.length, 3);
  assert.equal(snap.defaultTalendId, "prod-us");
  const prod = snap.talendTenants.find((t) => t.id === "prod-us")!;
  assert.equal(prod.patSet, true);
  assert.equal(prod.patHint, "••••1111");
  assert.equal(prod.region, "us");
  const priv = snap.talendTenants.find((t) => t.id === "private")!;
  assert.equal(priv.urlOverride, "https://api.internal.example.com");

  // Loading PATs by id works
  assert.equal(await loadTalendPat("prod-us"), "tcp_prod_us_1111");
  assert.equal(await loadTalendPat("dev-eu"), "tcp_dev_eu_2222");
  assert.equal(await loadTalendPat("nope"), null);

  // Switch the default
  await setDefaultTalend("dev-eu");
  const snap2 = await snapshotConfig();
  assert.equal(snap2.defaultTalendId, "dev-eu");
});

test("multi-tenant: saveQlikTenant works alongside Talend tenants", async () => {
  const { saveQlikTenant, snapshotConfig, loadQlikApiKey, deleteQlikTenant } =
    await import("../src/credential-store.js");

  await saveQlikTenant({
    id: "qlik-us",
    label: "Qlik (US)",
    tenantUrl: "https://example.us.qlikcloud.com",
    connectionId: "11111111-2222-3333-4444-555555555555",
    apiKeyStorage: "file",
    apiKey: "eyJtest.qlik.key1",
    makeDefault: true,
  });
  await saveQlikTenant({
    id: "qlik-eu",
    label: "Qlik (EU)",
    tenantUrl: "https://example.eu.qlikcloud.com/", // trailing slash should be stripped
    apiKeyStorage: "file",
    apiKey: "eyJtest.qlik.key2",
  });

  const snap = await snapshotConfig();
  assert.equal(snap.qlikTenants.length, 2);
  assert.equal(snap.defaultQlikId, "qlik-us");
  const eu = snap.qlikTenants.find((t) => t.id === "qlik-eu")!;
  assert.equal(eu.tenantUrl, "https://example.eu.qlikcloud.com", "trailing slash trimmed");
  assert.equal(eu.apiKeySet, true);
  assert.equal(eu.apiKeyHint, "••••key2");
  assert.equal(await loadQlikApiKey("qlik-us"), "eyJtest.qlik.key1");

  await deleteQlikTenant("qlik-eu");
  const snap2 = await snapshotConfig();
  assert.equal(snap2.qlikTenants.length, 1);
});

test("multi-tenant: pat=null keeps the existing token per tenant", async () => {
  const { saveTalendTenant, loadTalendPat } = await import("../src/credential-store.js");
  // dev-eu was created above with tcp_dev_eu_2222 — update its region without retyping.
  await saveTalendTenant({
    id: "dev-eu",
    label: "Dev (EU) — relabeled",
    region: "ap",
    patStorage: "file",
    pat: null, // keep
  });
  assert.equal(await loadTalendPat("dev-eu"), "tcp_dev_eu_2222");
});

test("teardown: clean tempdir", async () => {
  await rm(tempDir, { recursive: true, force: true });
});
