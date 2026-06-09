# qlik-engine-extractor

> **Headless** Talend Remote Engine log scraper. Install on the engine host,
> run as a service, monitor remotely from the
> [Qlik Observability Toolkit](https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit) UI control plane.

Tails the JSON job-management log files written by one or more Talend
Remote Engines and emits Prometheus metrics. No UI of its own — the
agent only exposes `/metrics` for Prometheus scraping. All monitoring
and remote status checks happen through the central
**Qlik Observability Toolkit** UI via the heartbeat endpoint.

## Install

```bash
# Linux engine host
npm install -g qlik-engine-extractor

# Bootstrap the Python venv (auto-runs as postinstall, but you can force it):
qlik-engine-extractor bootstrap

# One-shot run in foreground (useful for smoke testing):
TALEND_ENGINE_LOG_DIR=/opt/Talend/RemoteEngine/data/log \
TMC_EXPORTER_PORT=9466 \
  qlik-engine-extractor run

# Install + enable a systemd service (typically needs sudo):
sudo qlik-engine-extractor install --service --user=talend
```

Prerequisites: Node 18+, Python 3.10+, and (Linux only) `systemd` for the
`--service` install path.

## Usage

```
qlik-engine-extractor <command> [flags]

  bootstrap [--auto]               Create venv + install Python deps
  run                              Run the scraper in foreground (stdio JSON logs)
  install --service [--user=NAME]  Generate + enable a systemd unit
  uninstall --service              Stop + disable the systemd unit
  heartbeat [--once]               Register + heartbeat to the central UI
  status                           Print current metrics-endpoint health
  config                           Print resolved sources + env defaults
  help                             Show usage
```

## Configuration

Multi-source feeds into a single `/metrics` endpoint. Three sources of
truth, first non-empty wins:

1. **`TALEND_ENGINE_SOURCES`** env — comma-separated `name:dir` pairs:
   ```
   TALEND_ENGINE_SOURCES="engine-prod-us:/var/log/talend/prod-us,engine-dev-eu:/var/log/talend/dev-eu"
   ```
2. **`remoteEngines[]`** array in the shared config file pointed at by
   `TMC_CONFIG_PATH`. Same schema as the central Qlik Observability
   Toolkit config — copy that file (or just the `remoteEngines` slice)
   here.
3. Legacy single-source `TALEND_ENGINE_LOG_DIR` + `TALEND_ENGINE_LOG_GLOB`.

All other env vars from the engine scraper apply: `TMC_EXPORTER_PORT`,
`TMC_EXPORTER_HOST`, `TALEND_ENGINE_SCRAPE_INTERVAL`,
`TALEND_ENGINE_FROM_BEGINNING`. See the
[business-metrics doc](https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit/blob/main/docs/business-metrics.md)
for the full env reference + emitted metric list.

## Headless by design — central UI is the control plane

This package deliberately ships no UI. The agent:

- **emits `/metrics`** for the central Prometheus to scrape directly
  (which then renders in the Toolkit's Grafana dashboard);
- **logs structured JSON** to stderr so Promtail / Vector / any log
  shipper can index it into Loki;
- **heartbeats to the central UI** every 30 s (`qlik-engine-extractor
  heartbeat`) so the Exporters tab can show:
  - host + IP
  - source list (engine name + log dir)
  - last seen
  - latest metrics-scrape sample count

Operators add / remove / restart agents from the central UI — never from
this package. To register with the central UI, set:

```
TMC_CONTROL_PLANE_URL=http://<central-ui-host>:8788
```

…then run `qlik-engine-extractor heartbeat` (typically as a sibling
systemd unit, or simply let your supervisor keep it alive next to the
`run` process).

## Service install — what it writes

`qlik-engine-extractor install --service` drops a systemd unit at
`/etc/systemd/system/qlik-engine-extractor.service` with:

- `Type=simple`, `Restart=on-failure`
- Hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `ReadWritePaths=/var/log/talend`
- `EnvironmentFile=-/etc/qlik-engine-extractor.env` — drop your
  `TALEND_ENGINE_SOURCES` (and any other env) here

Then runs `systemctl daemon-reload && enable && start`.

`qlik-engine-extractor uninstall --service` is the inverse.

## License

MIT — see the [parent repo](https://github.com/robertschoenfeldqlik/QlikObservabilityToolkit).
