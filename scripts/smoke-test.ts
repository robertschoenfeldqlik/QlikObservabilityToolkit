#!/usr/bin/env tsx
/**
 * Spawn the built MCP server and send it a tools/list request over stdio.
 * Confirms: server boots, registers tools, responds to JSON-RPC.
 * Does NOT touch the live Talend API.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "dist", "index.js");

// By default, pass env vars through unmodified so the server uses the config
// file written by `npm run setup`. Set SMOKE_FORCE_ENV=1 to inject a dummy PAT
// (useful for testing the env-vars-only path).
const env: NodeJS.ProcessEnv = { ...process.env };
if (process.env.SMOKE_FORCE_ENV === "1") {
  env.TMC_PAT = env.TMC_PAT ?? "dummy-pat-for-smoke-test";
  env.TMC_REGION = env.TMC_REGION ?? "us";
}

const child = spawn(process.execPath, [SERVER], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (b) => (stderr += b.toString()));

let buffer = "";
let resolved = false;
const TIMEOUT_MS = 10_000;
const timer = setTimeout(() => {
  if (!resolved) {
    console.error("TIMEOUT waiting for response. stderr:", stderr);
    child.kill();
    process.exit(1);
  }
}, TIMEOUT_MS);

child.stdout.on("data", (b) => {
  buffer += b.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 2 && msg.result?.tools) {
      resolved = true;
      clearTimeout(timer);
      console.log(`stderr: ${stderr.trim()}`);
      console.log(`tools/list returned ${msg.result.tools.length} tools`);
      console.log(`First tool: ${msg.result.tools[0].name}`);
      console.log(`  description: ${msg.result.tools[0].description.slice(0, 100)}...`);
      console.log(`  required: ${JSON.stringify(msg.result.tools[0].inputSchema.required ?? [])}`);
      console.log(`  annotations: ${JSON.stringify(msg.result.tools[0].annotations)}`);
      child.kill();
      process.exit(0);
    }
  }
});

function send(obj: any) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
