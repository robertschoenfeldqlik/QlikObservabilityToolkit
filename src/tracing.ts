import type { Logger } from "./logger.js";

/**
 * Optional OpenTelemetry tracing for the MCP server.
 *
 * Traces are emitted ONLY when BOTH are true:
 *   1. TMC_OTLP_ENDPOINT is set (e.g. http://otel-collector:4318), and
 *   2. the OpenTelemetry SDK packages are installed:
 *        npm i @opentelemetry/sdk-node \
 *              @opentelemetry/auto-instrumentations-node \
 *              @opentelemetry/exporter-trace-otlp-http
 *
 * The SDK is loaded with a dynamic import so it stays OUT of the default
 * dependency tree (the toolkit ships lean; tracing is opt-in). If the endpoint
 * is set but the packages are absent, we log a one-line hint and no-op — the
 * server still runs. The collector then forwards traces to Datadog + Splunk
 * Observability Cloud (see deploy/otel-collector.yaml).
 */
export async function startTracing(log: Logger): Promise<void> {
  const endpoint = process.env.TMC_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;

  try {
    // String-variable dynamic imports => no compile-time module resolution,
    // so these stay optional and the build needs no @opentelemetry packages.
    const sdkMod = "@opentelemetry/sdk-node";
    const otlpMod = "@opentelemetry/exporter-trace-otlp-http";
    const autoMod = "@opentelemetry/auto-instrumentations-node";
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { NodeSDK } = (await import(sdkMod)) as any;
    const { OTLPTraceExporter } = (await import(otlpMod)) as any;
    const { getNodeAutoInstrumentations } = (await import(autoMod)) as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || "qlik-observability-toolkit-mcp",
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint.replace(/\/+$/, "")}/v1/traces`,
      }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    await sdk.start();
    log.info("opentelemetry tracing started", { endpoint });

    const stop = async () => {
      try {
        await sdk.shutdown();
      } catch {
        /* best-effort flush on exit */
      }
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch {
    log.warn("TMC_OTLP_ENDPOINT is set but the OpenTelemetry SDK is not installed — traces disabled", {
      hint: "npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http",
    });
  }
}
