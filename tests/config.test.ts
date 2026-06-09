import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidApi } from "../src/config.js";

test("isValidApi accepts known TMC API slugs", () => {
  assert.equal(isValidApi("orchestration"), true);
  assert.equal(isValidApi("scim-v2"), true);
  assert.equal(isValidApi("dynamic-engine-environments"), true);
});

test("isValidApi rejects unknown slugs", () => {
  assert.equal(isValidApi("bogus"), false);
  assert.equal(isValidApi(""), false);
  assert.equal(isValidApi("orchestration_v2"), false);
});
