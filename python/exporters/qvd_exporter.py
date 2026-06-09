"""
Prometheus -> Qlik Cloud QVD exporter.

Purpose: pull raw observability time-series out of Prometheus and land them
in a Qlik Cloud tenant as a QVD that an analyst can pick up in a Qlik
Sense app for deep BI / correlation / historical trend analysis.

Design:
- The QVD is long-form (one row per (timestamp, metric, label_set, value))
  so the analyst owns the rollup logic in their app. Wide-format
  pre-aggregation hides outliers from BI tools that expect normalized data.
- Schema:
      Timestamp        : datetime (Qlik dual)
      Metric           : string   — the `name` from config.yml
      <each label>     : string   — one column per configured label
      Value            : double   — sample value at that timestamp

- Runs on an interval (QVD_EXPORTER_INTERVAL, default 900s/15min). Each
  tick writes a fresh QVD covering the configured range_seconds window
  and uploads it under the same filename, overwriting the previous
  version in Qlik Cloud.

- Also exposes its OWN /metrics so Prometheus can monitor the exporter's
  health (last successful export timestamp, rows written, upload bytes).

Env:
  PROMETHEUS_URL                 (http://prometheus:9090)
  QVD_EXPORTER_CONFIG            (/etc/qvd-exporter/config.yml)
  QVD_EXPORTER_OUTPUT_DIR        (/var/lib/qvd-exporter)
  QVD_EXPORTER_FILENAME          (talend_observability.qvd)
  QVD_EXPORTER_INTERVAL          (900)   seconds
  QVD_EXPORTER_PORT              (9467)  /metrics port
  QVD_EXPORTER_HOST              (0.0.0.0)
  QVD_EXPORTER_DRY_RUN           (0)     set to 1 to write the QVD but skip upload
  QLIK_CLOUD_TENANT_URL          (required unless DRY_RUN)
  QLIK_CLOUD_API_KEY             (required unless DRY_RUN)
  QLIK_CLOUD_CONNECTION_ID       (required unless DRY_RUN)
"""
from __future__ import annotations

import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
import yaml
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from prometheus_client.exposition import start_http_server

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.logging import configure_logging  # noqa: E402
from common.qlik_client import client_from_env as qlik_from_env  # noqa: E402


registry = CollectorRegistry()
last_run_ts = Gauge(
    "qvd_exporter_last_run_timestamp",
    "Unix timestamp of the last successful export run.",
    registry=registry,
)
last_rows = Gauge(
    "qvd_exporter_last_rows",
    "Number of rows written in the last QVD.",
    registry=registry,
)
last_bytes = Gauge(
    "qvd_exporter_last_qvd_bytes",
    "Byte size of the QVD written in the last run.",
    registry=registry,
)
runs_total = Counter(
    "qvd_exporter_runs_total",
    "Total export runs attempted, by outcome.",
    ["outcome"],
    registry=registry,
)
run_duration = Histogram(
    "qvd_exporter_run_duration_seconds",
    "Wall-clock per export run.",
    ["phase"],   # query | write | upload
    registry=registry,
)
build_info = Gauge(
    "qvd_exporter_build_info",
    "Identity gauge (always 1).",
    ["service"],
    registry=registry,
)


@dataclass
class QueryDef:
    name: str
    promql: str
    labels_to_columns: list[str]


@dataclass
class ExporterCfg:
    prometheus_url: str
    queries: list[QueryDef]
    range_seconds: int
    step_seconds: int
    output_dir: Path
    filename: str
    dry_run: bool


def load_config() -> ExporterCfg:
    path = Path(os.environ.get("QVD_EXPORTER_CONFIG", "/etc/qvd-exporter/config.yml"))
    if not path.is_file():
        raise SystemExit(f"QVD exporter config not found: {path}")
    raw = yaml.safe_load(path.read_text())
    defaults = raw.get("defaults") or {}
    queries_raw = raw.get("queries") or []
    queries = [
        QueryDef(
            name=q["name"],
            promql=q["promql"],
            labels_to_columns=list(q.get("labels_to_columns") or []),
        )
        for q in queries_raw
    ]
    if not queries:
        raise SystemExit("QVD exporter config has no queries")
    return ExporterCfg(
        prometheus_url=os.environ.get("PROMETHEUS_URL", "http://prometheus:9090").rstrip("/"),
        queries=queries,
        range_seconds=int(defaults.get("range_seconds", 3600)),
        step_seconds=int(defaults.get("step_seconds", 60)),
        output_dir=Path(os.environ.get("QVD_EXPORTER_OUTPUT_DIR", "/var/lib/qvd-exporter")),
        filename=os.environ.get("QVD_EXPORTER_FILENAME", "talend_observability.qvd"),
        dry_run=os.environ.get("QVD_EXPORTER_DRY_RUN", "0") == "1",
    )


def query_range(http: httpx.Client, base_url: str, q: QueryDef, end: float, range_s: int, step_s: int) -> list[dict]:
    """Hit /api/v1/query_range and return Prometheus matrix rows."""
    res = http.get(
        f"{base_url}/api/v1/query_range",
        params={
            "query": q.promql,
            "start": end - range_s,
            "end": end,
            "step": step_s,
        },
    )
    res.raise_for_status()
    body = res.json()
    if body.get("status") != "success":
        raise RuntimeError(f"Prometheus error for {q.name!r}: {body.get('error')}")
    data = body.get("data") or {}
    return data.get("result") or []


def matrix_to_rows(q: QueryDef, matrix: list[dict]) -> list[dict[str, Any]]:
    """Flatten Prometheus matrix output into long-form rows."""
    rows: list[dict[str, Any]] = []
    for series in matrix:
        metric_labels = series.get("metric") or {}
        # Build the label-column dict for this series.
        label_cols = {lbl: str(metric_labels.get(lbl, "")) for lbl in q.labels_to_columns}
        for ts, val in series.get("values") or []:
            try:
                value = float(val)
            except (TypeError, ValueError):
                continue
            rows.append(
                {
                    "Timestamp": pd.to_datetime(float(ts), unit="s", utc=True),
                    "Metric": q.name,
                    **label_cols,
                    "Value": value,
                }
            )
    return rows


def build_dataframe(cfg: ExporterCfg, log) -> pd.DataFrame:
    end = time.time()
    all_rows: list[dict[str, Any]] = []
    with httpx.Client(timeout=30.0) as http:
        for q in cfg.queries:
            phase_start = time.monotonic()
            try:
                matrix = query_range(
                    http, cfg.prometheus_url, q, end, cfg.range_seconds, cfg.step_seconds
                )
            except Exception as exc:
                log.error("prometheus query failed", query=q.name, err=str(exc))
                runs_total.labels(outcome="query_failed").inc()
                continue
            finally:
                run_duration.labels(phase="query").observe(time.monotonic() - phase_start)
            all_rows.extend(matrix_to_rows(q, matrix))
            log.debug("queried", query=q.name, series=len(matrix))

    if not all_rows:
        return pd.DataFrame(
            columns=["Timestamp", "Metric", "Value"] + sorted({
                lbl for q in cfg.queries for lbl in q.labels_to_columns
            })
        )

    df = pd.DataFrame(all_rows)
    # Ensure every label column exists even when a particular query didn't
    # contribute it — Qlik dislikes ragged schemas.
    all_label_cols = sorted({lbl for q in cfg.queries for lbl in q.labels_to_columns})
    for col in all_label_cols:
        if col not in df.columns:
            df[col] = ""
    # Stable column order: Timestamp, Metric, labels..., Value
    ordered = ["Timestamp", "Metric", *all_label_cols, "Value"]
    df = df[ordered].fillna("")
    return df


def write_qvd(df: pd.DataFrame, out_path: Path, log) -> int:
    """Write the DataFrame to QVD via pyqvd. Returns byte size."""
    from pyqvd import QvdDataFrame  # lazy import — keep optional for dry-run

    out_path.parent.mkdir(parents=True, exist_ok=True)
    phase_start = time.monotonic()
    # QVD doesn't have a true datetime type — convert to ISO 8601 string so
    # Qlik's automatic date parser picks it up reliably. Analysts can wrap
    # in Date#() / Timestamp#() in the load script if they want a dual.
    df_out = df.copy()
    if "Timestamp" in df_out.columns:
        df_out["Timestamp"] = df_out["Timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    QvdDataFrame.from_pandas(df_out).to_qvd(str(out_path))
    run_duration.labels(phase="write").observe(time.monotonic() - phase_start)
    size = out_path.stat().st_size
    log.info("qvd written", path=str(out_path), rows=len(df_out), bytes=size)
    return size


def upload_to_qlik(out_path: Path, filename: str, log) -> None:
    phase_start = time.monotonic()
    client = qlik_from_env(logger=log)
    try:
        body = client.upload_or_replace(filename, out_path)
        log.info("qvd uploaded", filename=filename, id=body.get("id"), size=body.get("size"))
    finally:
        client.close()
        run_duration.labels(phase="upload").observe(time.monotonic() - phase_start)


def run_once(cfg: ExporterCfg, log) -> None:
    started = time.monotonic()
    try:
        df = build_dataframe(cfg, log)
        out_path = cfg.output_dir / cfg.filename
        size = write_qvd(df, out_path, log)
        if not cfg.dry_run:
            upload_to_qlik(out_path, cfg.filename, log)
        last_run_ts.set(time.time())
        last_rows.set(len(df))
        last_bytes.set(size)
        runs_total.labels(outcome="success").inc()
        log.info("export run complete", rows=len(df), bytes=size, took_s=round(time.monotonic() - started, 3))
    except Exception as exc:
        runs_total.labels(outcome="error").inc()
        log.error("export run failed", err=str(exc), exc_type=type(exc).__name__)


def main() -> int:
    log = configure_logging("qvd-exporter")
    cfg = load_config()
    port = int(os.environ.get("QVD_EXPORTER_PORT", "9467"))
    host = os.environ.get("QVD_EXPORTER_HOST", "0.0.0.0")
    interval_s = float(os.environ.get("QVD_EXPORTER_INTERVAL", "900"))

    build_info.labels(service="qvd-exporter").set(1)
    server, _thread = start_http_server(port, addr=host, registry=registry)
    log.info(
        "starting qvd exporter",
        port=port,
        prometheus=cfg.prometheus_url,
        queries=[q.name for q in cfg.queries],
        interval_s=interval_s,
        dry_run=cfg.dry_run,
        output=str(cfg.output_dir / cfg.filename),
    )

    stopping = False

    def _on_signal(signum, _frame):
        nonlocal stopping
        log.info("shutdown signal", signum=signum)
        stopping = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    # Run immediately on startup, then on the interval.
    run_once(cfg, log)
    while not stopping:
        slept = 0.0
        while slept < interval_s and not stopping:
            time.sleep(min(1.0, interval_s - slept))
            slept += 1.0
        if stopping:
            break
        run_once(cfg, log)

    server.shutdown()
    log.info("exporter stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
