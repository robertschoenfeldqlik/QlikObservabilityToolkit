#!/usr/bin/env tsx
/**
 * Interactive setup wizard.
 *
 *   npm run setup
 *
 * Prompts for region + Personal Access Token (input is masked), optionally
 * narrows the loaded API list, validates the token against Talend Cloud, and
 * writes a config file the MCP server reads on startup. Environment variables
 * still take precedence at runtime.
 *
 * Flags:
 *   --no-verify       Skip the live HTTP check.
 *   --print-path      Print the config-file path and exit.
 */
import readline from "node:readline";

import { TMC_APIS, TMC_REGIONS, type TmcApi, type TmcRegion } from "../src/apis.js";
import { configPath, isValidApi, loadConfigFile } from "../src/config.js";
import { probeKeychain, saveCredentials, type PatStorage } from "../src/credential-store.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => !a.includes("=")));

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const KEY_CTRL_C = String.fromCharCode(0x03);
const KEY_CTRL_D = String.fromCharCode(0x04);
const KEY_BACKSPACE = String.fromCharCode(0x08);
const KEY_DEL = String.fromCharCode(0x7f);
const _KEY_ESC = String.fromCharCode(0x1b);
const KEY_SPACE = String.fromCharCode(0x20);

async function main() {
  if (flags.has("--print-path")) {
    console.log(configPath());
    return;
  }
  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }

  const path = configPath();
  console.log("Talend TMC MCP — Setup\n");
  console.log("This wizard writes credentials to:");
  console.log(`  ${path}`);
  console.log("The MCP server reads this on startup. TMC_PAT / TMC_REGION / TMC_APIS");
  console.log("env vars still take precedence when set.\n");

  const existing = (await loadConfigFile()) ?? {};
  const keychain = await probeKeychain();

  const patFlag = flagValue("pat");
  const regionFlag = flagValue("region");
  const apisFlag = flagValue("apis");
  const credStoreFlag = flagValue("cred-store");

  let region: TmcRegion;
  let pat: string;
  let apis: TmcApi[] | undefined;
  let storage: PatStorage;

  // Non-interactive path: --pat=... and --region=... (and optional --apis=, --cred-store=).
  // Lets the wizard run unattended (CI, smoke tests, scripted installs).
  if (patFlag !== undefined && regionFlag !== undefined) {
    if (!(regionFlag in TMC_REGIONS)) {
      throw new Error(
        `--region=${regionFlag} is invalid. Expected one of: ${Object.keys(TMC_REGIONS).join(", ")}`,
      );
    }
    region = regionFlag as TmcRegion;
    pat = patFlag.trim();
    if (!pat) throw new Error("--pat is empty.");
    apis = apisFlag !== undefined ? parseApisFlag(apisFlag) : existing.apis;
    storage = parseCredStoreFlag(credStoreFlag, existing.patStorage, keychain.available);
    if (storage === "keychain" && !keychain.available) {
      throw new Error(`--cred-store=keychain requested but keyring unavailable: ${keychain.reason}`);
    }
    console.log(
      `Non-interactive: region=${region}, storage=${storage}, apis=${apis ? apis.join(",") : "(all)"}`,
    );
  } else if (patFlag !== undefined || regionFlag !== undefined) {
    throw new Error("--pat and --region must be provided together for non-interactive mode.");
  } else {
    // Interactive: share a single readline across all line prompts.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      region = await askRegion(rl, existing.region);
      storage = await askStorage(rl, existing.patStorage, keychain);
      pat = await askPat(rl);
      apis = await askApis(rl, existing.apis);
    } finally {
      rl.close();
    }
  }

  if (!flags.has("--no-verify")) {
    const result = await validatePat(pat, region);
    if (!result.ok) {
      console.error(`\nValidation failed: ${result.reason}`);
      const proceed = await askYesNo("Save anyway?", false);
      if (!proceed) {
        console.error("Aborted. No config written.");
        process.exit(1);
      }
    } else {
      console.log(`\nValidated against ${TMC_REGIONS[region]} (HTTP ${result.status}).`);
    }
  } else {
    console.log("\n(--no-verify) Skipping live validation.");
  }

  const saved = await saveCredentials({ pat, region, storage, apis });

  console.log(`\nConfig saved to: ${saved.path}`);
  console.log(
    `PAT stored in:   ${saved.storage === "keychain" ? `OS keyring (${keychain.backend ?? "keyring"})` : `the config file (plaintext, 0600)`}`,
  );
  console.log("\nNext:");
  console.log("  npm run build      # compile if you haven't");
  console.log("  node dist/index.js # run the MCP server");
}

function parseCredStoreFlag(
  flag: string | undefined,
  current: PatStorage | undefined,
  keychainAvailable: boolean,
): PatStorage {
  if (flag === "file" || flag === "keychain") return flag;
  if (flag !== undefined) {
    throw new Error(`--cred-store=${flag} is invalid. Expected "file" or "keychain".`);
  }
  return current ?? (keychainAvailable ? "file" : "file");
}

async function askStorage(
  rl: readline.Interface,
  current: PatStorage | undefined,
  keychain: Awaited<ReturnType<typeof probeKeychain>>,
): Promise<PatStorage> {
  console.log("\nWhere should the PAT be stored?");
  console.log(
    `  1. file     - plaintext in config.json (chmod 600 on POSIX) ${current === "file" ? "(current)" : ""}`,
  );
  if (keychain.available) {
    console.log(
      `  2. keychain - ${keychain.backend ?? "OS keyring"} ${current === "keychain" ? "(current)" : ""}`,
    );
  } else {
    console.log(`  2. keychain - unavailable: ${keychain.reason ?? "no backend"}`);
  }
  const defaultStorage: PatStorage = current ?? "file";
  const answer = await ask(rl, `Select storage [1=file, 2=keychain] (default ${defaultStorage}): `);
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return defaultStorage;
  if (trimmed === "1" || trimmed === "file") return "file";
  if (trimmed === "2" || trimmed === "keychain") {
    if (!keychain.available) {
      throw new Error(`Cannot select keychain: ${keychain.reason ?? "backend unavailable"}`);
    }
    return "keychain";
  }
  throw new Error(`Invalid selection "${answer}".`);
}

function parseApisFlag(value: string): TmcApi[] | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") return undefined;
  const items = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = items.filter((s) => !isValidApi(s));
  if (bad.length) {
    throw new Error(`Unknown API name(s) in --apis: ${bad.join(", ")}`);
  }
  return items as TmcApi[];
}

function printHelp() {
  console.log(`Talend TMC MCP — Setup

Usage:
  npm run setup                              # interactive wizard
  npm run setup -- --pat=<TOKEN> --region=<R>  # non-interactive
  npm run setup -- --print-path              # print config file location
  npm run setup -- --help

Flags:
  --pat=<token>          Personal Access Token (required for non-interactive).
  --region=<r>           One of: ${Object.keys(TMC_REGIONS).join(", ")}.
  --apis=<csv|all>       Comma-separated APIs; "all" or omit for all 20.
  --cred-store=<store>   "file" (default) or "keychain" (OS credential manager).
  --no-verify            Skip the live HTTP check against Talend.
  --print-path           Print the resolved config file path and exit.
`);
}

interface ValidationResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

async function validatePat(pat: string, region: TmcRegion): Promise<ValidationResult> {
  const url = `${TMC_REGIONS[region]}/orchestration/environments`;
  console.log(`\nValidating PAT against ${TMC_REGIONS[region]} ...`);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/json" },
    });
    if (res.status === 401) {
      return { ok: false, status: 401, reason: "HTTP 401 Unauthorized — token rejected." };
    }
    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        reason:
          "HTTP 403 Forbidden — token authenticated but lacks orchestration read scope. Token may be valid; check role/permissions.",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: `HTTP ${res.status} ${res.statusText} — unexpected response.`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function askRegion(rl: readline.Interface, current?: TmcRegion): Promise<TmcRegion> {
  const regions = Object.keys(TMC_REGIONS) as TmcRegion[];
  console.log("Available regions:");
  regions.forEach((r, i) => {
    const marker = r === current ? " (current)" : "";
    console.log(`  ${i + 1}. ${r.padEnd(8)} -> ${TMC_REGIONS[r]}${marker}`);
  });
  const defaultStr: TmcRegion = current ?? "us";
  const answer = await ask(rl, `Select region [name or 1-${regions.length}] (default ${defaultStr}): `);
  const trimmed = answer.trim();
  if (!trimmed) return defaultStr;
  const idx = Number(trimmed);
  if (Number.isInteger(idx) && idx >= 1 && idx <= regions.length) {
    return regions[idx - 1];
  }
  if ((regions as string[]).includes(trimmed)) {
    return trimmed as TmcRegion;
  }
  throw new Error(`Invalid region "${trimmed}". Expected name or 1-${regions.length}.`);
}

async function askApis(rl: readline.Interface, current?: TmcApi[]): Promise<TmcApi[] | undefined> {
  console.log("\nOptional: comma-separated list of APIs to enable (blank = all 20).");
  console.log("Examples: orchestration,observability-metrics,execution-logs");
  console.log(`Valid:    ${TMC_APIS.join(", ")}`);
  const defaultStr = current?.join(",") ?? "";
  const promptText = defaultStr
    ? `APIs (blank to keep "${defaultStr}", "all" to reset): `
    : "APIs (blank for all): ";
  const answer = await ask(rl, promptText);
  const trimmed = answer.trim();
  if (!trimmed) return current;
  if (trimmed.toLowerCase() === "all") return undefined;
  const items = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = items.filter((s) => !isValidApi(s));
  if (bad.length) {
    throw new Error(`Unknown API name(s): ${bad.join(", ")}`);
  }
  return items as TmcApi[];
}

async function askPat(rl: readline.Interface): Promise<string> {
  console.log("\nGenerate a token at: Talend Cloud Portal -> Profile Preferences ->");
  console.log("                     Personal Access Tokens -> + Add token");

  if (!process.stdin.isTTY) {
    console.log("(Non-TTY stdin: input will NOT be masked.)");
    const v = (await ask(rl, "Personal Access Token: ")).trim();
    if (!v) throw new Error("PAT is required.");
    return v;
  }

  // TTY path: pause the shared readline, drive stdin in raw mode for masking,
  // then resume. The shared rl resumes reading the same stdin afterwards.
  console.log("Paste your token below. Input is hidden — you won't see characters.\n");
  rl.pause();
  try {
    return await readMaskedFromTty();
  } finally {
    rl.resume();
  }
}

function readMaskedFromTty(): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write("Personal Access Token: ");
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";

    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.removeListener("data", onData);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write("\n");
          const v = buf.trim();
          if (!v) return reject(new Error("PAT is required."));
          return resolve(v);
        }
        if (ch === KEY_CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          return reject(new Error("Cancelled (Ctrl-C)."));
        }
        if (ch === KEY_CTRL_D) {
          if (buf.length === 0) {
            cleanup();
            process.stdout.write("\n");
            return reject(new Error("Cancelled (EOF)."));
          }
          continue;
        }
        if (ch === KEY_DEL || ch === KEY_BACKSPACE) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        // Accept any printable byte (PATs are typically base64/hex).
        if (ch >= KEY_SPACE) {
          buf += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, `${question} ${hint}: `);
    const t = answer.trim().toLowerCase();
    if (!t) return defaultYes;
    return t.startsWith("y");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
