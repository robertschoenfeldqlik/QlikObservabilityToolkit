#!/usr/bin/env tsx
/**
 * Diagnostic: load every spec, generate tools, and print one line per tool.
 * Run: npm run list-tools
 */
import { loadSpecs, parseApiList } from "../src/spec-loader.js";
import { generateToolsForSpec } from "../src/tool-generator.js";

async function main() {
  const apiFilter = parseApiList(process.env.TMC_APIS);
  const specs = await loadSpecs(apiFilter);
  let total = 0;
  for (const { api, spec } of specs) {
    const tools = generateToolsForSpec(api, spec);
    console.log(`\n=== ${api} (${tools.length} tools) ===`);
    for (const t of tools) {
      console.log(`  ${t.method.toUpperCase().padEnd(6)} ${t.pathTemplate.padEnd(60)}  ${t.name}`);
    }
    total += tools.length;
  }
  console.log(`\nTotal: ${total} tools across ${specs.length} APIs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
