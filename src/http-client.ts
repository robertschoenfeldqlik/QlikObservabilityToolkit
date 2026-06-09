import { TMC_REGIONS, type TmcRegion } from "./apis.js";
import { createLogger, type Logger } from "./logger.js";
import { recordRetry, recordToolCall, toolInFlight } from "./metrics.js";
import type { ToolDescriptor } from "./tool-generator.js";

export interface TmcClientOptions {
  /** Bearer token: a Talend PAT, or a Qlik Cloud API key when `baseUrl` is set. */
  pat: string;
  /** Talend region (resolves the base URL). Optional when `baseUrl` is supplied. */
  region?: TmcRegion;
  /** Explicit base URL (e.g. a Qlik tenant URL). When set, `region` is only a metrics label. */
  baseUrl?: string;
  /** Overrides the Prometheus `region` label. Defaults to `region`, else "custom". */
  regionLabel?: string;
  timeoutMs?: number;
  /** Maximum retry attempts on 429 / 5xx / transient network errors. Default 3 (so up to 4 total tries). */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff. Default 250. Actual delay = base * 2^attempt + jitter. */
  retryBaseMs?: number;
  /** Cap on individual retry delay. Default 10_000. */
  retryMaxMs?: number;
  /** Optional logger. Falls back to a no-op child of the default logger. */
  logger?: Logger;
  /** Inject a fetch implementation. Useful for tests. */
  fetchImpl?: typeof fetch;
  /** If true, skip Prometheus metric updates (used by tests to keep the global registry clean). */
  disableMetrics?: boolean;
}

export interface CallResult {
  ok: boolean;
  status: number;
  statusText: string;
  contentType?: string;
  body: string;
  parsedBody?: unknown;
  /** Number of retry attempts made BEFORE the final response (0 = first try succeeded). */
  attempts: number;
  /** Total wall-clock for the call including retries (ms). */
  durationMs: number;
  /** Short ID generated per logical call — surfaces in logs and tool results for correlation. */
  requestId: string;
}

export class TmcClient {
  private readonly baseUrl: string;
  private readonly pat: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly regionLabel: string;
  private readonly metricsEnabled: boolean;

  constructor(opts: TmcClientOptions) {
    if (!opts.pat) throw new Error("an auth token (PAT or API key) is required");
    if (opts.baseUrl) {
      // Explicit base URL (e.g. a Qlik tenant). `region` is only a metrics label here.
      this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
      this.regionLabel = opts.regionLabel ?? opts.region ?? "custom";
    } else {
      if (!opts.region || !TMC_REGIONS[opts.region]) {
        throw new Error(
          `Unknown TMC region "${opts.region}". Expected one of: ${Object.keys(TMC_REGIONS).join(", ")}`,
        );
      }
      this.baseUrl = TMC_REGIONS[opts.region];
      this.regionLabel = opts.regionLabel ?? opts.region;
    }
    this.pat = opts.pat;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = clampInt(opts.maxRetries, 0, 8, 3);
    this.retryBaseMs = clampInt(opts.retryBaseMs, 1, 5_000, 250);
    this.retryMaxMs = clampInt(opts.retryMaxMs, this.retryBaseMs, 60_000, 10_000);
    this.log = opts.logger ?? createLogger({ base: { component: "http-client" } });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.metricsEnabled = !opts.disableMetrics;
  }

  async call(tool: ToolDescriptor, args: Record<string, unknown>): Promise<CallResult> {
    const requestId = newRequestId();
    const callLog = this.log.child({ tool: tool.name, requestId });
    const url = this.buildUrl(tool, args);
    const headers = this.buildHeaders(tool, args);
    const body = this.buildBody(tool, args, headers);

    const start = Date.now();
    let attempt = 0;
    if (this.metricsEnabled) toolInFlight.inc();

    try {
      while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await this.fetchImpl(url, {
            method: tool.method.toUpperCase(),
            headers,
            body,
            signal: controller.signal,
          });
          const result = await readResponse(res, requestId, attempt, Date.now() - start);

          if (shouldRetry(res.status, undefined) && attempt < this.maxRetries) {
            const delay = this.computeDelay(attempt, res);
            callLog.warn("retrying after retryable status", {
              attempt: attempt + 1,
              status: res.status,
              delayMs: delay,
            });
            if (this.metricsEnabled) {
              recordRetry({
                tool: tool.name,
                api: tool.api,
                reason: res.status === 429 ? "status_429" : "status_5xx",
              });
            }
            await sleep(delay);
            attempt++;
            continue;
          }

          if (result.ok) {
            callLog.debug("call succeeded", {
              status: result.status,
              attempts: attempt,
              ms: result.durationMs,
            });
          } else {
            callLog.warn("call returned non-2xx", {
              status: result.status,
              statusText: result.statusText,
              attempts: attempt,
              ms: result.durationMs,
            });
          }
          if (this.metricsEnabled) {
            recordToolCall({
              tool: tool.name,
              api: tool.api,
              method: tool.method,
              status: result.ok ? "ok" : "error",
              httpStatus: result.status,
              durationMs: result.durationMs,
              attempts: attempt,
              region: this.regionLabel,
            });
          }
          return result;
        } catch (err) {
          const isAbort = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
          const transient = !isAbort && isTransientError(err);
          if ((transient || isAbort) && attempt < this.maxRetries) {
            const delay = this.computeDelay(attempt);
            callLog.warn("retrying after network/timeout error", {
              attempt: attempt + 1,
              reason: isAbort ? "timeout" : "transient",
              err: errMessage(err),
              delayMs: delay,
            });
            if (this.metricsEnabled) {
              recordRetry({
                tool: tool.name,
                api: tool.api,
                reason: isAbort ? "timeout" : "transient",
              });
            }
            await sleep(delay);
            attempt++;
            continue;
          }
          const msg = errMessage(err);
          callLog.error("call failed", { attempts: attempt, ms: Date.now() - start, err: msg });
          if (this.metricsEnabled) {
            recordToolCall({
              tool: tool.name,
              api: tool.api,
              method: tool.method,
              status: "error",
              httpStatus: null,
              durationMs: Date.now() - start,
              attempts: attempt,
              region: this.regionLabel,
            });
          }
          throw new TmcCallError(
            `HTTP request failed for ${tool.method.toUpperCase()} ${url} (after ${attempt} retr${attempt === 1 ? "y" : "ies"}): ${msg}`,
            { cause: err as Error, requestId, attempts: attempt },
          );
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      if (this.metricsEnabled) toolInFlight.dec();
    }
  }

  private buildHeaders(tool: ToolDescriptor, args: Record<string, unknown>): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pat}`,
      Accept: "application/json",
      "User-Agent": "talend-tmc-mcp/1.0",
    };
    for (const h of tool.headerParams) {
      const v = args[h];
      if (v !== undefined && v !== null) headers[h] = String(v);
    }
    return headers;
  }

  private buildBody(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    headers: Record<string, string>,
  ): BodyInit | undefined {
    if (args.body === undefined || args.body === null) return undefined;
    const ct = tool.bodyContentType ?? "application/json";
    headers["Content-Type"] = ct;
    if (ct === "application/json") {
      return JSON.stringify(args.body);
    }
    if (ct === "application/x-www-form-urlencoded") {
      return new URLSearchParams(args.body as Record<string, string>).toString();
    }
    return typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  private buildUrl(tool: ToolDescriptor, args: Record<string, unknown>): string {
    let path = tool.pathTemplate;
    for (const name of tool.pathParams) {
      const v = args[name];
      if (v === undefined || v === null) {
        throw new Error(`Missing required path parameter "${name}" for tool ${tool.name}`);
      }
      path = path.replace(`{${name}}`, encodeURIComponent(String(v)));
    }
    const url = new URL(path, this.baseUrl);
    for (const name of tool.queryParams) {
      const v = args[name];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(name, String(item));
      } else {
        url.searchParams.set(name, String(v));
      }
    }
    return url.toString();
  }

  private computeDelay(attempt: number, res?: Response): number {
    // Honor Retry-After when present (seconds or HTTP-date both supported).
    const retryAfter = res?.headers.get("retry-after");
    if (retryAfter) {
      const asSeconds = Number(retryAfter);
      if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return Math.min(this.retryMaxMs, asSeconds * 1000);
      }
      const asDate = Date.parse(retryAfter);
      if (Number.isFinite(asDate)) {
        const delta = asDate - Date.now();
        if (delta > 0) return Math.min(this.retryMaxMs, delta);
      }
    }
    // Exponential backoff with full jitter (avoids retry stampedes when many
    // tools fire concurrently against a recovering API).
    const exp = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
    return Math.floor(Math.random() * exp);
  }
}

/**
 * Qlik Cloud REST client. Identical retry/timeout/metrics engine as TmcClient,
 * but it targets a tenant URL and authenticates with a Qlik Cloud API key
 * (Bearer). Used by the read-only Qlik observability tools. Every call still
 * flows through the same per-tenant routing as Talend, so tenancy is preserved.
 */
export class QlikClient extends TmcClient {
  constructor(opts: {
    apiKey: string;
    tenantUrl: string;
    timeoutMs?: number;
    maxRetries?: number;
    logger?: Logger;
    fetchImpl?: typeof fetch;
    disableMetrics?: boolean;
  }) {
    super({
      pat: opts.apiKey,
      baseUrl: opts.tenantUrl,
      regionLabel: "qlik",
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      logger: opts.logger,
      fetchImpl: opts.fetchImpl,
      disableMetrics: opts.disableMetrics,
    });
  }
}

export class TmcCallError extends Error {
  readonly requestId: string;
  readonly attempts: number;
  constructor(message: string, opts: { cause?: Error; requestId: string; attempts: number }) {
    super(message);
    this.name = "TmcCallError";
    this.requestId = opts.requestId;
    this.attempts = opts.attempts;
    if (opts.cause) (this as Error & { cause?: Error }).cause = opts.cause;
  }
}

async function readResponse(
  res: Response,
  requestId: string,
  attempts: number,
  durationMs: number,
): Promise<CallResult> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? undefined;
  let parsed: unknown;
  if (contentType?.includes("application/json") && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave parsed undefined; raw text is still returned
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    contentType,
    body: text,
    parsedBody: parsed,
    attempts,
    durationMs,
    requestId,
  };
}

function shouldRetry(status: number, _body: unknown): boolean {
  if (status === 429) return true; // explicit rate limit
  if (status === 408) return true; // request timeout
  if (status >= 500 && status < 600) return true; // 5xx — likely transient
  return false;
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Node fetch surfaces transient network failures as TypeErrors with a `cause`
  // — we don't want to enumerate every libuv code, so match common patterns.
  const msg = (err.message ?? "").toLowerCase();
  return /econnreset|enotfound|etimedout|econnrefused|eai_again|socket hang up|network|fetch failed/.test(
    msg,
  );
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(v: number | undefined, lo: number, hi: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function newRequestId(): string {
  // 8 hex chars is plenty for correlation within a session and keeps log
  // lines compact. Not security-sensitive — collisions are merely annoying.
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}
