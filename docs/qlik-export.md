# Qlik Cloud QVD export

The `qvd-exporter` is the bridge between Prometheus and Qlik Cloud
Analytics. **The goal is to pull raw observability time-series out of
Prometheus and land them in a Qlik Sense app so an analyst can do deep
BI, correlation, and historical trend analysis** — without giving them a
PromQL learning curve or asking them to scrape Prometheus from Qlik.

## Architecture

```
┌─────────────┐  PromQL /query_range   ┌──────────────────┐  POST /api/v1/data-files   ┌────────────────┐
│ Prometheus  │ ─────────────────────▶ │  qvd-exporter    │ ─────────────────────────▶ │  Qlik Cloud    │
│ (any series │                        │  (Python)        │   (multipart, Bearer)      │  Data Files    │
│  matched by │                        │                  │                            │  (QVD)         │
│  config)    │                        │   • pandas       │                            │                │
└─────────────┘                        │   • pyqvd        │                            └────────┬───────┘
                                       └──────────────────┘                                     │
                                                                                                ▼
                                                                                        ┌────────────────┐
                                                                                        │  Qlik Sense    │
                                                                                        │  Cloud app     │
                                                                                        │  (load script  │
                                                                                        │   reads QVD)   │
                                                                                        └────────────────┘
```

The QVD is rewritten and re-uploaded on every tick (default every
15 min) using the same filename. The Qlik Sense app reloads on its own
schedule.

## QVD schema — long-form, analyst-friendly

The exporter writes one row per `(timestamp, metric, label_set, value)`
sample. No pre-aggregation, no wide-format hacks. This is **important**:

- Wide formats (one column per metric) blow up when you have hundreds of
  series.
- Pre-aggregating in the exporter hides outliers that the analyst might
  want to investigate.
- Long format is what every Qlik example script in the wild expects.

Columns (stable order):

| Column | Type | Notes |
| --- | --- | --- |
| `Timestamp` | string (ISO 8601 UTC) | Wrap in `Timestamp#()` in Qlik for a dual |
| `Metric` | string | The `name` from `qvd_exporter_config.yml` (e.g. `mcp_tool_calls_rate`) |
| `<label>` | string | One column per label declared in `labels_to_columns` for the union of all queries. Missing values become `""`. |
| `Value` | double | Sample value |

### Example rows

```
Timestamp,Metric,tool,status,workspace,reason,engine,environment,Value
2026-06-09T10:00:00Z,mcp_tool_calls_rate,orchestration__getTasks,ok,,,,,4.5
2026-06-09T10:00:00Z,mcp_tool_latency_p95,orchestration__getTasks,,,,,,0.084
2026-06-09T10:01:00Z,talend_executions_rate,,failed,ws-A,,,,0.12
2026-06-09T10:01:00Z,engine_jobs_failed_rate,,,ws-B,,engine-demo-01,,0.03
```

## Loading into a Qlik Sense app

In your Qlik Sense Cloud app's data load editor:

```qlik
SET vQvd = 'lib://DataFiles/talend_observability.qvd';

Observability:
LOAD
    Timestamp#(Timestamp, 'YYYY-MM-DDTHH:mm:ssZ') AS Timestamp,
    Metric,
    tool,
    status,
    workspace,
    reason,
    engine,
    environment,
    Value
FROM [$(vQvd)] (qvd);

// Convenient day/hour buckets for sheets:
[Observability_Aug]:
LOAD
    Date(Floor(Timestamp))               AS Day,
    Timestamp(Floor(Timestamp, 1/24))     AS Hour,
    Metric, tool, status, workspace, reason, engine, environment,
    Avg(Value)                            AS AvgValue,
    Max(Value)                            AS MaxValue,
    Min(Value)                            AS MinValue,
    Count(Value)                          AS Samples
RESIDENT Observability
GROUP BY
    Date(Floor(Timestamp)),
    Timestamp(Floor(Timestamp, 1/24)),
    Metric, tool, status, workspace, reason, engine, environment;
```

Replace `lib://DataFiles/` with whichever data connection name owns the
upload. The exporter uploads to the connection identified by
`QLIK_CLOUD_CONNECTION_ID` (see env below).

## Configuring what gets exported

`python/exporters/qvd_exporter_config.example.yml` ships as the
default. Mount your own at `/etc/qvd-exporter/config.yml` in the
container to override.

Shape:

```yaml
defaults:
  range_seconds: 3600      # how far back to query each tick
  step_seconds: 60         # PromQL step

queries:
  - name: mcp_tool_calls_rate
    promql: sum by (tool, status) (rate(tmc_mcp_tool_calls_total[5m]))
    labels_to_columns: [tool, status]
  - name: ...
```

Each `query` becomes a `Metric` value in the QVD. Labels you list in
`labels_to_columns` become QVD columns; everything else collapses into
the series (lost). Pick the labels your analysts will filter or group
by.

## Setting up Qlik Cloud credentials

The exporter uses a **Qlik Cloud API key** (Bearer header) and uploads
into a specific data connection.

### 1. Generate an API key

Qlik Sense Cloud hub → **Profile → Settings → API keys → Generate new
key**. Default lifetime is 30 days; bump it. Treat the key like a PAT —
once generated, it's only visible once.

API keys require the **Developer** role on the tenant; ask a Tenant Admin
to grant it before generating. See
<https://qlik.dev/authenticate/api-key/> for the full flow.

### 2. Find your data connection ID

Either of:

- In the hub, **Catalog → My data files → Connection details**. The
  GUID after `/connections/` in the URL is the ID.
- API: `GET /api/v1/data-connections?type=qvd` then pick the connection
  you want files to live in. (Most tenants have a personal `DataFiles`
  connection by default.)

### 3. Set env vars

| Var | Required | Description |
| --- | --- | --- |
| `QLIK_CLOUD_TENANT_URL` | yes | e.g. `https://your-tenant.us.qlikcloud.com` |
| `QLIK_CLOUD_API_KEY` | yes | The Bearer token from step 1. Redacted from logs. |
| `QLIK_CLOUD_CONNECTION_ID` | yes | The connection GUID from step 2. |
| `QVD_EXPORTER_FILENAME` | no (default `talend_observability.qvd`) | The name to upload as. |
| `QVD_EXPORTER_INTERVAL` | no (default `900` seconds) | How often to re-export. |
| `QVD_EXPORTER_DRY_RUN` | no (default `0`) | `1` writes the QVD to disk but skips the upload. Use this to iterate on the config before talking to Qlik. |
| `PROMETHEUS_URL` | no (default `http://prometheus:9090`) | Source Prometheus. |

### 4. Verify

After `docker compose ... --profile qlik up -d`:

```bash
docker logs tmc-qvd-exporter --tail 30
# Look for: "qvd uploaded" with the size/id from Qlik.

curl http://127.0.0.1:9467/metrics | grep qvd_exporter
# qvd_exporter_last_run_timestamp <recent epoch>
# qvd_exporter_last_rows <N>
# qvd_exporter_runs_total{outcome="success"} >= 1
```

In the Qlik Sense hub, **Catalog → My data files** should list
`talend_observability.qvd` with a fresh modified timestamp.

## What to build in the Qlik app

This is just observability data in a familiar grid — the same trend /
correlation patterns work as any other monitoring data:

- **Trend sheet**: `Timestamp` on the x-axis, `Avg(Value)` on the y-axis,
  filter by `Metric`. Drop in selection boxes for `tool`, `status`,
  `workspace`, `engine`.
- **Error correlation**: filter to `Metric = 'mcp_tool_errors_rate' or
  'talend_executions_failed_rate' or 'engine_jobs_failed_rate'`, group
  by minute — spot whether MCP errors lead/lag Talend failures lead/lag
  engine failures.
- **Capacity planning**: combine the `Metric IN ('mcp_tool_calls_rate',
  'talend_executions_rate')` series against business calendars from
  another QVD to attribute load to business events.
- **Long-horizon trends**: Prometheus retention is short (the bundled
  stack keeps 14 days). The Qlik app accumulates each daily QVD into a
  historical fact table for year-over-year analysis. Add a separate
  load step that appends instead of replaces:
  ```qlik
  ObservabilityHistory:
  LOAD * FROM [lib://DataFiles/observability_history.qvd] (qvd);

  Concatenate
  LOAD * FROM [lib://DataFiles/talend_observability.qvd] (qvd)
  WHERE NOT EXISTS(Timestamp);

  STORE ObservabilityHistory INTO [lib://DataFiles/observability_history.qvd] (qvd);
  ```

## Troubleshooting

**`qlik upload failed` / 401**
API key is wrong, expired, or for the wrong tenant. Regenerate.

**`qlik upload failed` / 403**
Your API key's user lacks the role / permission for the chosen
connection. Pick a personal `DataFiles` connection or grant the role.

**`qlik upload failed` / 404 on PATCH**
The `find_file_id` lookup returned an ID that doesn't exist anymore
(someone deleted the file in the hub). Wait one cycle; the next run does
a POST instead.

**The QVD shows up but is empty in Qlik**
Run `QVD_EXPORTER_DRY_RUN=1` and inspect the file — likely the queries
returned no series during the lookback window. Either widen
`range_seconds` or wait for the source metrics to accumulate.

**Schema drift between runs**
The exporter unions `labels_to_columns` across all queries to keep the
schema stable. If you add a new query with a new label and the Qlik
load script is hard-coded to specific columns, update the load script
at the same time.

**Exporter `runs_total{outcome="error"}` is climbing**
Check `docker logs tmc-qvd-exporter`. Common causes: Prometheus
unreachable, the `pyqvd` write failing on an unexpected dtype, Qlik
rejecting the upload because the connection ID is wrong.
