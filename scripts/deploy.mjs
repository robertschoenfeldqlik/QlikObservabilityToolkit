#!/usr/bin/env node
/**
 * Unified deploy CLI — one entrypoint for docker / minikube / EKS.
 *
 *   npm run deploy -- --target docker   [--profile all|business|engine|qlik|qlik-obs]
 *   npm run deploy -- --target minikube
 *   npm run deploy -- --target eks      [--registry <ecr-uri>]
 *   npm run deploy -- --target docker --down       # tear it down
 *
 * Wraps the existing docker-compose / kubectl invocations behind one
 * command. Pre-flights prerequisites so failures are obvious early
 * (kubectl context, minikube status, docker socket, ECR login, etc).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const args = parseFlags(process.argv.slice(2));

function parseFlags(a) {
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const arg = a[i].slice(2);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out[arg.slice(0, eq)] = arg.slice(eq + 1);
    } else {
      const next = a[i + 1];
      if (next && !next.startsWith("--")) {
        out[arg] = next;
        i++;
      } else out[arg] = true;
    }
  }
  return out;
}

function usage(extra = "") {
  process.stderr.write(
    (extra ? `${extra}\n\n` : "") +
      `Usage:\n  npm run deploy -- --target {docker|minikube|eks} [options]\n\n` +
      `Options:\n` +
      `  --profile <name>      Compose profile (all|business|engine|qlik|qlik-obs). docker only.\n` +
      `  --down                Tear down instead of bring up.\n` +
      `  --registry <uri>      ECR/registry URI prefix. EKS only.\n` +
      `  --skip-build          Skip image build (use existing tags).\n` +
      `  --namespace <ns>      Override the k8s namespace (default talend-tmc-mcp).\n`,
  );
}

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "pipe" });
  return r.status === 0;
}

function run(cmd, argv, opts = {}) {
  process.stdout.write(`\n[deploy] $ ${cmd} ${argv.join(" ")}\n`);
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
  return r.status ?? 1;
}

async function runStream(cmd, argv, opts = {}) {
  process.stdout.write(`\n[deploy] $ ${cmd} ${argv.join(" ")}\n`);
  return new Promise((resolveP) => {
    const c = spawn(cmd, argv, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
    c.on("exit", (code) => resolveP(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------
async function deployDocker() {
  if (!which("docker")) return die("docker not found on PATH. Install Docker first.");
  const compose = "docker-compose.observability.yml";
  if (!existsSync(join(REPO_ROOT, compose))) return die(`${compose} not found.`);
  const profile = args.profile || "all";

  if (args.down) {
    return run("docker", ["compose", "-f", compose, "--profile", "all", "down", "-v"]);
  }

  const env = { ...process.env };
  // Mirror the docs: TMC_PAT must be set for the MCP server container.
  if (!env.TMC_PAT) {
    process.stdout.write(
      "[deploy] warning: TMC_PAT not set in env. The MCP server will use the placeholder. " +
        "Set TMC_PAT=tcp_... before deploying for real.\n",
    );
  }
  if (!args["skip-build"]) {
    // Build under the SAME profile we're about to bring up. `docker compose
    // build` without a profile skips profiled services, which would leave
    // the shared Python exporter image stale for the profiled exporters.
    const buildRc = await runStream("docker", ["compose", "-f", compose, "--profile", profile, "build"], {
      env,
    });
    if (buildRc !== 0) return buildRc;
  }
  return await runStream("docker", ["compose", "-f", compose, "--profile", profile, "up", "-d"], { env });
}

// ---------------------------------------------------------------------------
// minikube
// ---------------------------------------------------------------------------
async function deployMinikube() {
  if (!which("kubectl")) return die("kubectl not found on PATH.");
  if (!which("minikube")) return die("minikube not found on PATH. Install minikube first.");

  // Pre-flight: minikube running?
  const status = spawnSync("minikube", ["status", "-o", "json"], { stdio: "pipe" });
  if (status.status !== 0) {
    process.stdout.write("[deploy] minikube not running — starting...\n");
    const rc = await runStream("minikube", ["start", "--addons=ingress"]);
    if (rc !== 0) return rc;
  }

  if (args.down) {
    return run("kubectl", ["delete", "-k", "deploy/k8s/overlays/minikube"]);
  }

  // Build images inside minikube's docker daemon so the cluster can pull them.
  if (!args["skip-build"]) {
    process.stdout.write("[deploy] building images into minikube docker env\n");
    const eval_ = spawnSync("minikube", ["docker-env", "--shell=bash"], { stdio: "pipe" });
    if (eval_.status !== 0) return die("minikube docker-env failed");
    // We can't `eval` inside Node — instead invoke docker via the DOCKER_HOST/CERT env it prints.
    const envOverride = {};
    for (const line of String(eval_.stdout).split("\n")) {
      const m = line.match(/^export (\w+)="(.+)"$/);
      if (m) envOverride[m[1]] = m[2];
    }
    const env = { ...process.env, ...envOverride };
    const rc1 = await runStream("docker", ["build", "-t", "talend-tmc-mcp:latest", "."], { env });
    if (rc1 !== 0) return rc1;
    const rc2 = await runStream("docker", ["build", "-t", "talend-tmc-python-exporters:obs", "./python"], {
      env,
    });
    if (rc2 !== 0) return rc2;
  }

  return await runStream("kubectl", ["apply", "-k", "deploy/k8s/overlays/minikube"]);
}

// ---------------------------------------------------------------------------
// EKS
// ---------------------------------------------------------------------------
async function deployEks() {
  if (!which("kubectl")) return die("kubectl not found on PATH.");
  if (!which("aws")) return die("aws CLI not found on PATH.");

  // Confirm kubectl context isn't pointing at minikube/something local.
  const ctx = spawnSync("kubectl", ["config", "current-context"], { stdio: "pipe" });
  const ctxName = String(ctx.stdout || "").trim();
  process.stdout.write(`[deploy] current kubectl context: ${ctxName || "<unset>"}\n`);
  if (!ctxName)
    return die("kubectl context is unset. Run `aws eks update-kubeconfig --name <cluster>` first.");
  if (/minikube|docker-desktop|kind-/.test(ctxName)) {
    return die(`Refusing to deploy EKS overlay to non-EKS context "${ctxName}". Switch context first.`);
  }

  if (args.down) {
    return run("kubectl", ["delete", "-k", "deploy/k8s/overlays/eks"]);
  }

  if (!args.registry) {
    process.stdout.write(
      "[deploy] warning: --registry not set. The EKS overlay defaults reference " +
        "`<account>.dkr.ecr.<region>.amazonaws.com/...`. Either pass --registry " +
        "or edit deploy/k8s/overlays/eks/kustomization.yaml manually.\n",
    );
  }
  if (!args["skip-build"] && args.registry) {
    // Build + push both images to ECR.
    process.stdout.write(`[deploy] building + pushing images to ${args.registry}\n`);
    const mcpTag = `${args.registry}/talend-tmc-mcp:latest`;
    const pyTag = `${args.registry}/talend-tmc-python-exporters:obs`;
    const rc1 = await runStream("docker", ["build", "-t", mcpTag, "."]);
    if (rc1 !== 0) return rc1;
    const rc2 = await runStream("docker", ["build", "-t", pyTag, "./python"]);
    if (rc2 !== 0) return rc2;
    const rc3 = await runStream("docker", ["push", mcpTag]);
    if (rc3 !== 0) return rc3;
    const rc4 = await runStream("docker", ["push", pyTag]);
    if (rc4 !== 0) return rc4;
  }

  return await runStream("kubectl", ["apply", "-k", "deploy/k8s/overlays/eks"]);
}

function die(msg) {
  process.stderr.write(`[deploy] ${msg}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
const target = args.target;
if (!target) {
  usage("--target is required");
  process.exit(2);
}

let exitCode = 0;
try {
  if (target === "docker") exitCode = await deployDocker();
  else if (target === "minikube") exitCode = await deployMinikube();
  else if (target === "eks") exitCode = await deployEks();
  else {
    usage(`Unknown target: ${target}`);
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(`[deploy] failed: ${err?.message ?? err}\n`);
  exitCode = 1;
}
process.exit(exitCode);
