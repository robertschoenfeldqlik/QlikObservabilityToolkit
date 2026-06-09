/**
 * Single source of truth for the package version and name. Reads
 * package.json at module load. We keep this in src/ (not generated) so dev
 * builds don't need a codegen step.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// dist/version.js -> ../package.json ; src/version.ts (via tsx) -> ../package.json
const pkgPath = join(__dirname, "..", "package.json");

let pkg: { name: string; version: string };
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string; version: string };
} catch {
  pkg = { name: "talend-tmc-mcp", version: "0.0.0-unknown" };
}

export const PKG_NAME = pkg.name;
export const PKG_VERSION = pkg.version;
