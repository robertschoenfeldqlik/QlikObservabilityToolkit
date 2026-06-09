/**
 * Tiny structured logger. No deps.
 *
 * - Levels: debug < info < warn < error. Default = info; override with LOG_LEVEL.
 * - Output: stderr only (stdio MCP reserves stdout for JSON-RPC).
 * - Format: JSON in production (NODE_ENV=production or LOG_FORMAT=json),
 *           pretty in dev (LOG_FORMAT=pretty).
 * - Redacts: any `pat`, `token`, `authorization` keys and the Bearer-token
 *   payload anywhere in stringified values.
 *
 * Why roll our own instead of pino/winston: this stays a zero-dep MCP server.
 * The redactor matters more than fanciness — leaking a PAT to a shared log
 * stream is the #1 risk for this class of project.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set([
  "pat",
  "token",
  "access_token",
  "accessToken",
  "authorization",
  "Authorization",
  "client_secret",
  "clientSecret",
  "x-api-key",
]);

const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]+/g;
// Tokens that LOOK like Talend PATs (tcp_xxxxxxxx...) — redact even when not behind a known key.
const PAT_RE = /\btcp_[A-Za-z0-9_-]{8,}\b/g;

const REDACTED = "[REDACTED]";

export interface LoggerOptions {
  level?: LogLevel;
  format?: "json" | "pretty";
  /** Extra fields merged into every log line. */
  base?: Record<string, unknown>;
}

export class Logger {
  private level: number;
  private format: "json" | "pretty";
  private base: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    const envLevel = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
    const lvl = (opts.level ?? envLevel ?? "info") as LogLevel;
    this.level = LEVELS[lvl] ?? LEVELS.info;

    const envFormat = process.env.LOG_FORMAT?.toLowerCase();
    const isProd = process.env.NODE_ENV === "production";
    this.format = (opts.format ?? envFormat ?? (isProd ? "json" : "pretty")) as "json" | "pretty";

    this.base = { ...opts.base };
  }

  child(extra: Record<string, unknown>): Logger {
    return new Logger({ level: this.levelName(), format: this.format, base: { ...this.base, ...extra } });
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.log("error", msg, fields);
  }

  private levelName(): LogLevel {
    for (const k of Object.keys(LEVELS) as LogLevel[]) {
      if (LEVELS[k] === this.level) return k;
    }
    return "info";
  }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < this.level) return;
    const merged: Record<string, unknown> = { ...this.base, ...fields };
    const safe = redact(merged) as Record<string, unknown>;
    if (this.format === "json") {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...safe,
      });
      process.stderr.write(line + "\n");
    } else {
      const fieldsStr = Object.keys(safe).length ? " " + JSON.stringify(safe) : "";
      const colored = pretty(level, msg);
      process.stderr.write(`${new Date().toISOString()} ${colored}${fieldsStr}\n`);
    }
  }
}

function pretty(level: LogLevel, msg: string): string {
  const labels: Record<LogLevel, string> = {
    debug: "DEBUG",
    info: "INFO ",
    warn: "WARN ",
    error: "ERROR",
  };
  return `[${labels[level]}] ${msg}`;
}

/**
 * Walk an object/array tree, replacing known-secret keys with [REDACTED]
 * and scrubbing Bearer tokens / PAT-shaped strings out of any other string
 * values. Avoids mutating the input.
 */
export function redact(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return input;
}

function redactString(s: string): string {
  return s.replace(BEARER_RE, "Bearer " + REDACTED).replace(PAT_RE, REDACTED);
}

// Default singleton — most call sites just import this. The MCP server can
// swap in a configured instance via createLogger() at startup.
export const logger = new Logger();

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(opts);
}
