import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApiList, parseApiPreset, TMC_API_PRESETS } from "../src/spec-loader.js";

test("parseApiList returns undefined for empty/missing input", () => {
  assert.equal(parseApiList(undefined), undefined);
  assert.equal(parseApiList(""), undefined);
  assert.equal(parseApiList("   "), undefined);
});

test("parseApiList trims and returns valid APIs", () => {
  const result = parseApiList("orchestration,  dataset , connections");
  assert.deepEqual(result, ["orchestration", "dataset", "connections"]);
});

test("parseApiList throws on unknown API names", () => {
  assert.throws(() => parseApiList("orchestration,bogus,dataset"), /TMC_APIS contains unknown values: bogus/);
});

test("parseApiPreset returns undefined for empty/missing input", () => {
  assert.equal(parseApiPreset(undefined), undefined);
  assert.equal(parseApiPreset(""), undefined);
});

test("parseApiPreset returns the logging bundle", () => {
  const out = parseApiPreset("logging");
  assert.deepEqual(out?.sort(), [...TMC_API_PRESETS.logging].sort());
  // Sanity: should be < the full 20-API set.
  assert.ok(out && out.length > 0 && out.length < 20);
});

test("parseApiPreset is case-insensitive", () => {
  assert.deepEqual(parseApiPreset("LOGGING"), parseApiPreset("logging"));
});

test("parseApiPreset throws on unknown preset name", () => {
  assert.throws(() => parseApiPreset("nope"), /TMC_APIS_PRESET="nope" is invalid/);
});
