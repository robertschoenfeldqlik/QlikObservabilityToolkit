import { test } from "node:test";
import assert from "node:assert/strict";

import { Logger, redact } from "../src/logger.js";

test("redact() replaces known-secret keys with [REDACTED]", () => {
  const out = redact({
    pat: "tcp_secrethereshould",
    token: "raw",
    accessToken: "raw",
    Authorization: "Bearer abc.def",
    safe: "leave me alone",
  }) as Record<string, unknown>;

  assert.equal(out.pat, "[REDACTED]");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.accessToken, "[REDACTED]");
  assert.equal(out.Authorization, "[REDACTED]");
  assert.equal(out.safe, "leave me alone");
});

test("redact() scrubs Bearer tokens inside arbitrary string values", () => {
  const out = redact({ description: "header was Bearer abc.def.ghi-xyz" }) as Record<string, unknown>;
  assert.match(out.description as string, /Bearer \[REDACTED\]/);
});

test("redact() scrubs PAT-looking strings even when not behind a known key", () => {
  const out = redact({ note: "leaked: tcp_abcdef012345 in error message" }) as Record<string, unknown>;
  assert.match(out.note as string, /\[REDACTED\]/);
  assert.doesNotMatch(out.note as string, /tcp_abcdef012345/);
});

test("redact() walks arrays and nested objects", () => {
  const out = redact({ list: [{ pat: "x" }, { ok: "y" }] }) as { list: Array<Record<string, unknown>> };
  assert.equal(out.list[0].pat, "[REDACTED]");
  assert.equal(out.list[1].ok, "y");
});

test("Logger respects level filtering", () => {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: typeof orig }).write = ((s: string) => {
    chunks.push(s);
    return true;
  }) as typeof orig;
  try {
    const log = new Logger({ level: "warn", format: "json" });
    log.debug("nope");
    log.info("nope");
    log.warn("yep");
    log.error("yep");
  } finally {
    (process.stderr as { write: typeof orig }).write = orig;
  }
  assert.equal(chunks.length, 2);
  for (const c of chunks) {
    assert.match(c, /yep/);
  }
});

test("Logger child() merges base fields", () => {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: typeof orig }).write = ((s: string) => {
    chunks.push(s);
    return true;
  }) as typeof orig;
  try {
    const parent = new Logger({ level: "debug", format: "json", base: { service: "tmc" } });
    const child = parent.child({ requestId: "abc" });
    child.info("hello");
  } finally {
    (process.stderr as { write: typeof orig }).write = orig;
  }
  const parsed = JSON.parse(chunks[0]);
  assert.equal(parsed.service, "tmc");
  assert.equal(parsed.requestId, "abc");
  assert.equal(parsed.msg, "hello");
});
