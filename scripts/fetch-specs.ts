#!/usr/bin/env tsx
/**
 * Download all Talend Cloud OpenAPI specs into ./specs/.
 * Run: npm run fetch-specs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TMC_APIS, TMC_API_VERSION_DEFAULT, specUrl, type TmcApi } from "../src/apis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(__dirname, "..", "specs");
const VERSION = process.env.TMC_API_VERSION ?? TMC_API_VERSION_DEFAULT;

async function fetchSpec(api: TmcApi): Promise<void> {
  const url = specUrl(api, VERSION);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${api}: HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const path = join(SPECS_DIR, `${api}.json`);
  await writeFile(path, JSON.stringify(json, null, 2), "utf8");
  const opCount = countOperations(json);
  console.log(`  ${api.padEnd(32)}  ${String(opCount).padStart(3)} ops  -> ${path}`);
}

function countOperations(spec: any): number {
  if (!spec?.paths) return 0;
  let n = 0;
  for (const path of Object.values(spec.paths) as any[]) {
    for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
      if (path[method]) n++;
    }
  }
  return n;
}

async function main() {
  await mkdir(SPECS_DIR, { recursive: true });
  console.log(`Downloading ${TMC_APIS.length} Talend Cloud OpenAPI specs (version ${VERSION}) ...`);
  console.log();

  const results = await Promise.allSettled(TMC_APIS.map((api) => fetchSpec(api)));

  const failed = results.map((r, i) => ({ r, api: TMC_APIS[i] })).filter(({ r }) => r.status === "rejected");

  console.log();
  if (failed.length === 0) {
    console.log(`All ${TMC_APIS.length} specs downloaded successfully.`);
  } else {
    console.error(`${failed.length} spec(s) failed to download:`);
    for (const { r, api } of failed) {
      if (r.status === "rejected") {
        console.error(`  ${api}: ${r.reason}`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
