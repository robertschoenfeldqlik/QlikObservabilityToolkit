import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TMC_APIS, type TmcApi } from "./apis.js";
import type { OpenApiSpec } from "./openapi-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/spec-loader.js -> ../specs ; src/spec-loader.ts (via tsx) -> ../specs as well
const SPECS_DIR = join(__dirname, "..", "specs");

export interface LoadedSpec {
  api: TmcApi;
  spec: OpenApiSpec;
}

export async function loadSpecs(apis: readonly TmcApi[] = TMC_APIS): Promise<LoadedSpec[]> {
  const out: LoadedSpec[] = [];
  const errors: string[] = [];
  for (const api of apis) {
    try {
      const path = join(SPECS_DIR, `${api}.json`);
      const raw = await readFile(path, "utf8");
      const spec = JSON.parse(raw) as OpenApiSpec;
      out.push({ api, spec });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`  ${api}: ${msg}`);
    }
  }
  if (out.length === 0) {
    throw new Error(
      `No specs could be loaded from ${SPECS_DIR}. Run \`npm run fetch-specs\` first.\n${errors.join("\n")}`,
    );
  }
  if (errors.length > 0) {
    // Soft warning to stderr — stdio MCP transport uses stdout, so stderr is safe.
    console.error(`Warning: ${errors.length} spec(s) could not be loaded:\n${errors.join("\n")}`);
  }
  return out;
}

export function parseApiList(env: string | undefined): TmcApi[] | undefined {
  if (!env || !env.trim()) return undefined;
  const wanted = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (wanted.length === 0) return undefined;
  const valid = new Set<string>(TMC_APIS);
  const bad = wanted.filter((w) => !valid.has(w));
  if (bad.length > 0) {
    throw new Error(`TMC_APIS contains unknown values: ${bad.join(", ")}. Valid: ${TMC_APIS.join(", ")}`);
  }
  return wanted as TmcApi[];
}

/**
 * Named bundles of APIs for common use cases. Spares the user from having to
 * memorize which slugs go together for a given workflow.
 */
// The Qlik Observability Toolkit deliberately ships observability-scoped
// presets only. `observability` is the default tool surface; `logging` adds
// audit-logs (identity events) for teams that want them. Non-observability
// loadouts (orchestration, the full 20-API surface) are intentionally not
// offered as presets — a power user can still pass an explicit TMC_APIS list,
// but the product's named bundles all reflect observability.
export const TMC_API_PRESETS: Record<string, TmcApi[]> = {
  // PURE observability — just the three endpoint families that emit data
  // about runs/jobs/metrics. Drops audit-logs (which contains
  // identity-management events you may not want exposed to the model).
  // This is the default preset and the recommended one for the stack sidecar.
  observability: ["observability-metrics", "execution-logs", "execution-history-search"],

  // Observability + audit identity events.
  logging: ["observability-metrics", "execution-logs", "execution-history-search", "audit-logs"],
};

export function parseApiPreset(env: string | undefined): TmcApi[] | undefined {
  if (!env || !env.trim()) return undefined;
  const key = env.trim().toLowerCase();
  const preset = TMC_API_PRESETS[key];
  if (!preset) {
    throw new Error(
      `TMC_APIS_PRESET="${env}" is invalid. Expected one of: ${Object.keys(TMC_API_PRESETS).join(", ")}`,
    );
  }
  return [...preset];
}
