# Exporting to Datadog & Splunk via OpenTelemetry

The toolkit can fan its observability signals out to **Datadog** and **Splunk Observability Cloud** through an **OpenTelemetry Collector** — without changing how the rest of the stack works. Prometheus, Loki and the Qlik QVD path keep running; the collector is an *additional* sink.

```
MCP server + exporters  ──/metrics──▶  OpenTelemetry Collector  ──▶  Datadog
container logs ─────────────────────▶  (otel-collector.yaml)    ──▶  Splunk Observability Cloud
MCP traces (OTLP, optional) ────────▶
```

## What flows where

| Signal | Source (collector receiver) | Code change? | Exporters |
|--------|------------------------------|--------------|-----------|
| **Metrics** | `prometheus` scrape of `:9464–:9468` | none | `datadog`, `signalfx` |
| **Logs** | `filelog` (container json logs) / `otlp` | none | `datadog`, `splunk_hec` (O11y Cloud log ingest) |
| **Traces** | `otlp` (`:4317`/`:4318`) | opt-in SDK | `datadog`, `signalfx` (APM) |

Config: [`deploy/otel-collector.yaml`](../deploy/otel-collector.yaml).

## 1. Set credentials

```bash
# Datadog
export DD_API_KEY=...                 # https://app.datadoghq.com/organization-settings/api-keys
export DD_SITE=datadoghq.com          # or datadoghq.eu, us3..., ddog-gov.com

# Splunk Observability Cloud (SignalFx)
export SPLUNK_ACCESS_TOKEN=...        # Settings → Access Tokens
export SPLUNK_REALM=us0               # your realm, e.g. us0/us1/eu0
export DEPLOY_ENV=prod                # tags every signal with deployment.environment
```

Never commit real tokens — pass them via env / your secrets manager.

## 2. Bring up the collector

```bash
npm run deploy -- --target docker --profile otel
# or: docker compose -f docker-compose.observability.yml --profile otel up -d
```

The collector listens on `127.0.0.1:4317` (OTLP gRPC), `:4318` (OTLP HTTP), and exposes a health check on `:13133`. Metrics and logs start flowing immediately.

## 3. (Optional) emit traces from the MCP server

Traces are opt-in so the default install stays lean. Install the SDK and point the server at the collector:

```bash
npm i @opentelemetry/sdk-node \
      @opentelemetry/auto-instrumentations-node \
      @opentelemetry/exporter-trace-otlp-http

# then run the MCP server with:
export TMC_OTLP_ENDPOINT=http://localhost:4318
```

[`src/tracing.ts`](../src/tracing.ts) loads the SDK with a dynamic import and **no-ops** (logging a one-line hint) if `TMC_OTLP_ENDPOINT` is unset or the packages aren't installed — the server always runs either way.

## Kubernetes

Add the same image + `deploy/otel-collector.yaml` as a `ConfigMap` + `Deployment` in your overlay, and supply `DD_*` / `SPLUNK_*` via `external-secrets` (the EKS overlay already wires AWS Secrets Manager). The scrape targets become the in-cluster service DNS names.

## Notes

- **Splunk Enterprise/Cloud (HEC)** instead of Observability Cloud? Swap the `signalfx` exporter for `splunk_hec` pointed at your HEC endpoint/token, and move metrics/traces onto it.
- `filelog` reads the Docker host's container logs — on non-Linux hosts, prefer shipping logs over OTLP.
- This is purely additive: removing the `otel` profile leaves Prometheus/Grafana/Loki/Qlik untouched.
