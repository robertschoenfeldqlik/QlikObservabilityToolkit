/**
 * Optional HTTP server that exposes Prometheus metrics + a health endpoint
 * alongside the stdio MCP server.
 *
 * Opt in via TMC_METRICS_PORT. Bound to 0.0.0.0 by default (so Prometheus
 * in another container can scrape it). Set TMC_METRICS_HOST to lock it
 * down if you want to scrape over a loopback proxy.
 *
 * Endpoints:
 *   GET /metrics  → text/plain, Prometheus exposition (0.0.4)
 *   GET /health   → 200 if the server has finished startup and isn't draining,
 *                   503 otherwise. Body is JSON.
 *   GET /         → tiny landing page pointing at the two above.
 */
import http from "node:http";

import type { Logger } from "./logger.js";
import { registry } from "./metrics.js";
import { PKG_NAME, PKG_VERSION } from "./version.js";

export interface MetricsServerOptions {
  port: number;
  host?: string;
  logger?: Logger;
  /** Probe function that returns true when the server is healthy enough to take traffic. */
  isReady: () => boolean;
}

export interface MetricsServerHandle {
  close: () => Promise<void>;
  url: string;
}

export async function startMetricsServer(opts: MetricsServerOptions): Promise<MetricsServerHandle> {
  const host = opts.host ?? "0.0.0.0";
  const port = opts.port;
  const log = opts.logger;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url === "/metrics" && req.method === "GET") {
      try {
        const body = await registry.metrics();
        res.writeHead(200, {
          "Content-Type": registry.contentType,
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        log?.error("metrics render failed", { err: errMsg(err) });
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("metrics render failed");
      }
      return;
    }
    if (url === "/health" && req.method === "GET") {
      const ready = opts.isReady();
      const body = JSON.stringify({
        status: ready ? "ok" : "draining",
        service: PKG_NAME,
        version: PKG_VERSION,
        ts: new Date().toISOString(),
      });
      res.writeHead(ready ? 200 : 503, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url === "/" && req.method === "GET") {
      const body =
        `${PKG_NAME} v${PKG_VERSION}\n\n` +
        `GET /metrics — Prometheus exposition\n` +
        `GET /health  — readiness probe (200 / 503)\n`;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  // Read the actual bound port (port: 0 → OS-assigned).
  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}`;
  log?.info("metrics server listening", { host, port: boundPort, url });

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // closeAllConnections lives on Node 18+; gives us prompt shutdown.
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      }),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
