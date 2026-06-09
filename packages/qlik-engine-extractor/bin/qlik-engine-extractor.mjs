#!/usr/bin/env node
/**
 * qlik-engine-extractor — headless Talend Remote Engine log scraper.
 *
 *   npm install -g qlik-engine-extractor
 *   qlik-engine-extractor --help
 *
 * Subcommands:
 *   bootstrap [--auto]              Create a Python venv next to the package
 *                                   and install requirements. `--auto` skips
 *                                   when Python isn't present (used by postinstall).
 *   run                             Run the scraper in the foreground.
 *   install --service [--user=NAME] Generate + enable a systemd unit on Linux
 *                                   so the scraper runs on boot. Root or sudo
 *                                   typically required.
 *   uninstall --service             Stop + disable the systemd unit.
 *   heartbeat [--once]              Register with the central control plane
 *                                   (TMC_CONTROL_PLANE_URL) and send heartbeats
 *                                   every 30s. Pass --once for one-shot.
 *   status                          Print current scraper PID + last metrics scrape.
 *   config                          Print the resolved source list + env defaults.
 *
 * Headless by design: this agent has no UI of its own. All operator
 * monitoring happens in the central Qlik Observability Toolkit UI by way
 * of the heartbeat endpoint (POST /api/extractors/register).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { hostname, platform, networkInterfaces, userInfo } from "node:os";
import { request } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PY_ROOT = join(PKG_ROOT, "python");
const VENV_DIR = join(PKG_ROOT, ".venv");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = parseFlags(argv.slice(1));

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

function pythonExe() {
  // Prefer the venv interpreter when it exists; fall back to system Python.
  const venvPy =
    platform() === "win32"
      ? join(VENV_DIR, "Scripts", "python.exe")
      : join(VENV_DIR, "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  return process.env.PYTHON || (platform() === "win32" ? "python" : "python3");
}

function findSystemPython() {
  for (const exe of platform() === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(exe, ["--version"], { stdio: "pipe" });
    if (r.status === 0) return exe;
  }
  return null;
}

// ----------------------------------------------------------------------------

function help() {
  process.stdout.write(`qlik-engine-extractor — headless Talend Remote Engine log scraper

Commands:
  bootstrap [--auto]               Set up the Python venv + install deps.
  run                              Run the scraper in the foreground.
  install --service [--user=NAME]  Generate + enable a systemd service.
  uninstall --service              Stop + disable the systemd service.
  heartbeat [--once]               Register + send heartbeats to the central UI.
                                   Set TMC_CONTROL_PLANE_URL=http://... first.
  status                           Print runtime status.
  config                           Print resolved configuration.
  help                             This help.

Environment (forwarded to the scraper):
  TALEND_ENGINE_SOURCES   "name:dir,name:dir,..." — multi-source list
  TALEND_ENGINE_LOG_DIR   Single-source dir (legacy fallback)
  TALEND_ENGINE_LOG_GLOB  Globs inside the dir (default *.log:*.json)
  TMC_EXPORTER_PORT       Bind port for /metrics (default 9466)
  TMC_EXPORTER_HOST       Bind host (default 0.0.0.0)
  TMC_CONFIG_PATH         Path to a shared config.json with remoteEngines[]
  TMC_CONTROL_PLANE_URL   Central UI URL for heartbeat registration

See https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit
`);
}

// ----------------------------------------------------------------------------
// bootstrap — create venv + install deps. --auto silently skips if no Python.
// ----------------------------------------------------------------------------
function bootstrap({ auto = false } = {}) {
  const py = findSystemPython();
  if (!py) {
    const msg =
      "Python 3.10+ not found on PATH. Install Python before running the extractor.";
    if (auto) {
      console.error(`[qlik-engine-extractor] bootstrap skipped (auto): ${msg}`);
      return 0;
    }
    console.error(msg);
    return 1;
  }
  if (!existsSync(VENV_DIR)) {
    console.log(`[qlik-engine-extractor] creating venv at ${VENV_DIR}`);
    const r = spawnSync(py, ["-m", "venv", VENV_DIR], { stdio: "inherit" });
    if (r.status !== 0) {
      if (auto) {
        console.error("[qlik-engine-extractor] venv creation failed (auto, continuing).");
        return 0;
      }
      return r.status ?? 1;
    }
  }
  const pip =
    platform() === "win32" ? join(VENV_DIR, "Scripts", "pip.exe") : join(VENV_DIR, "bin", "pip");
  const reqs = join(PY_ROOT, "requirements.txt");
  console.log(`[qlik-engine-extractor] installing ${reqs}`);
  const r = spawnSync(pip, ["install", "--quiet", "--upgrade", "pip"], { stdio: "inherit" });
  if (r.status !== 0 && !auto) return r.status ?? 1;
  const r2 = spawnSync(pip, ["install", "--quiet", "-r", reqs], { stdio: "inherit" });
  if (r2.status !== 0 && !auto) return r2.status ?? 1;
  console.log(`[qlik-engine-extractor] ready. Run: qlik-engine-extractor run`);
  return 0;
}

// ----------------------------------------------------------------------------
// run — exec the Python scraper. We don't fork-and-monitor; whatever spawned
// us (systemd, foreground shell) is the supervisor.
// ----------------------------------------------------------------------------
function run() {
  const py = pythonExe();
  const script = join(PY_ROOT, "exporters", "engine_log_scraper.py");
  if (!existsSync(script)) {
    console.error(`engine_log_scraper.py not found at ${script}`);
    return 1;
  }
  const env = { ...process.env };
  // Default to LOG_FORMAT=json so the central UI's Loki picks up our lines cleanly.
  if (!env.LOG_FORMAT) env.LOG_FORMAT = "json";
  // Headless: never spawn a UI. The scraper doesn't anyway, but make it explicit.
  env.TMC_EXPORTER_HEADLESS = "1";
  const child = spawn(py, [script], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ----------------------------------------------------------------------------
// install --service — write a systemd unit pointing at `qlik-engine-extractor run`.
// ----------------------------------------------------------------------------
function installService() {
  if (platform() !== "linux") {
    console.error("install --service is Linux-only (systemd).");
    return 1;
  }
  const tplPath = join(PKG_ROOT, "templates", "qlik-engine-extractor.service");
  const tpl = readFileSync(tplPath, "utf8");
  const user = flags.user || userInfo().username;
  const filled = tpl
    .replace(/@USER@/g, user)
    .replace(/@EXEC@/g, process.argv[0])
    .replace(/@SCRIPT@/g, fileURLToPath(import.meta.url));
  const unitPath = "/etc/systemd/system/qlik-engine-extractor.service";
  console.log(`[qlik-engine-extractor] writing ${unitPath}`);
  try {
    writeFileSync(unitPath, filled);
    chmodSync(unitPath, 0o644);
  } catch (err) {
    console.error(`Failed to write unit (run with sudo?): ${err?.message ?? err}`);
    return 1;
  }
  for (const args of [["daemon-reload"], ["enable", "qlik-engine-extractor"], ["start", "qlik-engine-extractor"]]) {
    const r = spawnSync("systemctl", args, { stdio: "inherit" });
    if (r.status !== 0) return r.status ?? 1;
  }
  console.log("[qlik-engine-extractor] service installed + started.");
  return 0;
}

async function uninstallService() {
  if (platform() !== "linux") return 1;
  spawnSync("systemctl", ["stop", "qlik-engine-extractor"], { stdio: "inherit" });
  spawnSync("systemctl", ["disable", "qlik-engine-extractor"], { stdio: "inherit" });
  const unitPath = "/etc/systemd/system/qlik-engine-extractor.service";
  try {
    if (existsSync(unitPath)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(unitPath);
    }
  } catch {
    /* best effort */
  }
  spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
  console.log("[qlik-engine-extractor] service removed.");
  return 0;
}

// ----------------------------------------------------------------------------
// heartbeat — register this agent with the central control plane.
// ----------------------------------------------------------------------------
function pickPrimaryIp() {
  const nets = networkInterfaces();
  for (const ifaceName of Object.keys(nets)) {
    for (const iface of nets[ifaceName] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function buildHeartbeatPayload() {
  return {
    hostname: hostname(),
    ip: pickPrimaryIp(),
    platform: platform(),
    user: userInfo().username,
    metricsUrl: `http://${pickPrimaryIp()}:${process.env.TMC_EXPORTER_PORT || 9466}/metrics`,
    sources: parseSources(),
    agentVersion: readPackageVersion(),
    ts: new Date().toISOString(),
  };
}

function parseSources() {
  const raw = process.env.TALEND_ENGINE_SOURCES || "";
  if (raw) {
    return raw.split(",").map((s) => {
      const [name, dir] = s.split(":");
      return { name: (name || "").trim(), dir: (dir || "").trim() };
    });
  }
  if (process.env.TALEND_ENGINE_LOG_DIR) {
    return [{ name: "default", dir: process.env.TALEND_ENGINE_LOG_DIR }];
  }
  return [];
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(err);
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: buf });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function heartbeat({ once = false } = {}) {
  const url = process.env.TMC_CONTROL_PLANE_URL;
  if (!url) {
    console.error("Set TMC_CONTROL_PLANE_URL=http://<central-ui-host>:8788 first.");
    return 1;
  }
  const endpoint = url.replace(/\/+$/, "") + "/api/extractors/register";
  const send = async () => {
    try {
      const r = await postJson(endpoint, buildHeartbeatPayload());
      console.log(`[heartbeat] OK ${r.status}`);
    } catch (err) {
      console.error(`[heartbeat] failed: ${err.message}`);
    }
  };
  await send();
  if (once) return 0;
  const intervalMs = Number(process.env.TMC_HEARTBEAT_INTERVAL_MS || 30_000);
  setInterval(send, intervalMs).unref?.();
  // Keep the process alive — we want this in the foreground (run under systemd
  // alongside the scraper, or as a sibling unit).
  return await new Promise(() => {});
}

// ----------------------------------------------------------------------------
// status / config — read-only introspection
// ----------------------------------------------------------------------------
async function status() {
  const port = process.env.TMC_EXPORTER_PORT || 9466;
  process.stdout.write(`metrics endpoint expected: http://127.0.0.1:${port}/metrics\n`);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/metrics", method: "GET" },
        (r) => {
          let buf = "";
          r.on("data", (c) => (buf += c));
          r.on("end", () => resolve({ status: r.statusCode, body: buf }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (res.status === 200) {
      const series = res.body.split("\n").filter((l) => l && !l.startsWith("#")).length;
      process.stdout.write(`status: UP — ${series} active series\n`);
    } else {
      process.stdout.write(`status: HTTP ${res.status}\n`);
    }
  } catch (err) {
    process.stdout.write(`status: DOWN (${err.message})\n`);
  }
}

function config() {
  process.stdout.write(JSON.stringify(buildHeartbeatPayload(), null, 2) + "\n");
}

// ----------------------------------------------------------------------------
// dispatch
// ----------------------------------------------------------------------------
switch (cmd) {
  case "bootstrap":
    process.exit(bootstrap({ auto: !!flags.auto }));
    break;
  case "run":
    run();
    break;
  case "install":
    if (flags.service) process.exit(installService());
    else { help(); process.exit(2); }
    break;
  case "uninstall":
    if (flags.service) {
      // top-level await wrapper
      uninstallService().then((c) => process.exit(c));
    } else { help(); process.exit(2); }
    break;
  case "heartbeat":
    heartbeat({ once: !!flags.once }).then((c) => process.exit(c ?? 0));
    break;
  case "status":
    status();
    break;
  case "config":
    config();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(2);
}
