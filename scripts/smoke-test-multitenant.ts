#!/usr/bin/env tsx
/**
 * Multi-tenant smoke test.
 *
 * Spawns the compiled MCP server (reading the config file the test driver
 * planted on disk before invoking us) and exercises:
 *
 *   1. initialize handshake
 *   2. tools/list — confirms ALL tools have a `tenant` parameter + the
 *      tmc_list_environments meta-tool is registered
 *   3. tools/call name=tmc_list_environments — confirms the snapshot comes
 *      back with the expected tenants
 *   4. tools/call with an explicit `tenant` arg that doesn't exist — confirms
 *      the dispatcher returns a tenant-not-found error
 *
 * Does NOT make any upstream HTTP calls.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "dist", "index.js");

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (b) => (stderr += b.toString()));

let buffer = "";
const responses = new Map<number, unknown>();
child.stdout.on("data", (b) => {
  buffer += b.toString();
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number") responses.set(msg.id, msg);
    } catch {
      /* skip */
    }
  }
});

function send(obj: unknown) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function waitFor(id: number, timeoutMs = 8000): Promise<{ result?: unknown; error?: unknown }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const got = responses.get(id);
      if (got) {
        clearInterval(tick);
        resolve(got as { result?: unknown; error?: unknown });
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`Timeout waiting for response id=${id}. stderr:\n${stderr}`));
      }
    }, 50);
  });
}

(async () => {
  let failed = 0;
  const check = (label: string, ok: boolean, detail?: string) => {
    if (ok) console.log(`  ✓ ${label}`);
    else {
      failed++;
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-mt", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const initR = (await waitFor(1)) as { result: { serverInfo: { name: string; version: string } } };
    check(
      "initialize",
      !!initR.result?.serverInfo?.name,
      initR.result?.serverInfo?.name ? undefined : "no serverInfo",
    );

    // tools/list
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listR = (await waitFor(2)) as {
      result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };
    };
    const ts = listR.result?.tools ?? [];
    check("tools/list returned > 0", ts.length > 0, `got ${ts.length}`);
    check(
      "tmc_list_environments is present",
      ts.some((t) => t.name === "tmc_list_environments"),
    );
    const noTenant = ts.filter(
      (t) =>
        t.name !== "tmc_list_environments" && !(t.inputSchema?.properties as Record<string, unknown>)?.tenant,
    );
    check(
      "every TMC tool has a `tenant` parameter",
      noTenant.length === 0,
      noTenant.length
        ? `${noTenant.length} missing: ${noTenant
            .slice(0, 3)
            .map((t) => t.name)
            .join(", ")}`
        : undefined,
    );

    // Call the meta-tool
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tmc_list_environments", arguments: {} },
    });
    const metaR = (await waitFor(3)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const metaText = metaR.result?.content?.[0]?.text ?? "";
    let snap: {
      talendTenants: Array<{ id: string; isDefault: boolean }>;
      qlikTenants: Array<{ id: string }>;
    } | null = null;
    try {
      snap = JSON.parse(metaText);
    } catch {
      snap = null;
    }
    check("meta-tool returned parseable JSON", !!snap);
    if (snap) {
      const talendIds = snap.talendTenants.map((t) => t.id).sort();
      check(
        "meta-tool listed expected Talend tenants",
        JSON.stringify(talendIds) === JSON.stringify(["dev-eu", "private", "prod-us"]),
        `got ${JSON.stringify(talendIds)}`,
      );
      check(
        "meta-tool listed expected Qlik tenants",
        snap.qlikTenants.some((t) => t.id === "qlik-prod"),
      );
      check(
        "default Talend tenant flagged",
        snap.talendTenants.some((t) => t.id === "prod-us" && t.isDefault),
      );
    }

    // Call a tool with an unknown tenant
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: ts.find((t) => t.name !== "tmc_list_environments")?.name,
        arguments: { tenant: "does-not-exist" },
      },
    });
    const bogusR = (await waitFor(4)) as {
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    check(
      "unknown tenant returns isError + helpful message",
      bogusR.result?.isError &&
        /does-not-exist|tmc_list_environments/i.test(bogusR.result.content[0]?.text ?? ""),
      bogusR.result?.content?.[0]?.text?.slice(0, 80),
    );

    console.log(`\nstderr (last 400 chars): ${stderr.slice(-400)}`);
    console.log(`\nResult: ${failed === 0 ? "ALL PASS ✓" : `${failed} FAIL`}`);
    child.kill();
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error("smoke test crashed:", err);
    child.kill();
    process.exit(1);
  }
})();
