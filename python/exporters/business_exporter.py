"""
Talend Cloud BUSINESS exporter for Prometheus — MULTI-TENANT.

Polls every Talend tenant configured in the shared v2 config file (or, in
CI, the single tenant defined by TMC_PAT/TMC_REGION env vars). One metric
namespace, `tenant` label distinguishes sources.

Metrics:
  talend_tasks_total{tenant, workspace}                          gauge
  talend_plans_total{tenant, workspace}                          gauge
  talend_executions_total{tenant, status, workspace, environment} counter
  talend_executions_failed_total{tenant, workspace, environment}  counter
  talend_execution_duration_seconds{tenant, status}              histogram
  talend_exporter_poll_duration_seconds{tenant, endpoint}        histogram
  talend_exporter_poll_errors_total{tenant, endpoint}            counter
  talend_exporter_last_success_timestamp{tenant, endpoint}       gauge

Env:
  TMC_EXPORTER_PORT       (9465)   /metrics bind port
  TMC_EXPORTER_HOST       (0.0.0.0)
  TMC_EXPORTER_INTERVAL   (60s)
  TMC_EXPORTER_LOOKBACK   (300s)   execution-history search window per poll
  TMC_WORKSPACES          ""       comma-separated workspace IDs (blank = all per tenant)
  TMC_CONFIG_PATH         (default OS-aware) override the shared config file location
  TMC_PAT / TMC_REGION    fallback single-tenant mode for CI
"""
from __future__ import annotations

import os
import signal
import sys
import time
from collections import deque
from dataclasses import dataclass

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from prometheus_client.exposition import start_http_server

# Make sibling packages importable when run as a module or as a script.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.logging import configure_logging  # noqa: E402
from common.tenants import (  # noqa: E402
    TalendTenantRec,
    iter_tenants_with_secret,
    load_talend_tenants,
)
from common.tmc_client import TmcClient, TmcClientConfig  # noqa: E402


registry = CollectorRegistry()

tasks_total = Gauge(
    "talend_tasks_total",
    "Current count of orchestration tasks visible to the exporter PAT.",
    ["tenant", "workspace"],
    registry=registry,
)
plans_total = Gauge(
    "talend_plans_total",
    "Current count of orchestration plans visible to the exporter PAT.",
    ["tenant", "workspace"],
    registry=registry,
)
executions_total = Counter(
    "talend_executions_total",
    "Task execution events observed by this exporter, by terminal status.",
    ["tenant", "status", "workspace", "environment"],
    registry=registry,
)
executions_failed_total = Counter(
    "talend_executions_failed_total",
    "Convenience counter: every execution observed with a failed/terminated status.",
    ["tenant", "workspace", "environment"],
    registry=registry,
)
execution_duration = Histogram(
    "talend_execution_duration_seconds",
    "Observed task execution duration (end - start).",
    ["tenant", "status"],
    buckets=(1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600),
    registry=registry,
)
poll_duration = Histogram(
    "talend_exporter_poll_duration_seconds",
    "Wall-clock time for one round-trip to a TMC endpoint.",
    ["tenant", "endpoint"],
    registry=registry,
)
poll_errors_total = Counter(
    "talend_exporter_poll_errors_total",
    "Polls that ended in an exception or non-200.",
    ["tenant", "endpoint"],
    registry=registry,
)
last_success_ts = Gauge(
    "talend_exporter_last_success_timestamp",
    "Unix timestamp of the last successful poll.",
    ["tenant", "endpoint"],
    registry=registry,
)
build_info = Gauge(
    "talend_exporter_build_info",
    "Identity gauge (always 1).",
    ["service", "tenants_loaded"],
    registry=registry,
)


@dataclass
class ExporterConfig:
    interval_s: float
    lookback_s: float
    workspaces: list[str]


def cfg_from_env() -> ExporterConfig:
    ws_env = os.environ.get("TMC_WORKSPACES", "").strip()
    workspaces = [w.strip() for w in ws_env.split(",") if w.strip()]
    return ExporterConfig(
        interval_s=float(os.environ.get("TMC_EXPORTER_INTERVAL", "60")),
        lookback_s=float(os.environ.get("TMC_EXPORTER_LOOKBACK", "300")),
        workspaces=workspaces,
    )


# Per-tenant bounded recent-ID dedupe.
_seen: dict[str, deque[str]] = {}
_seen_set: dict[str, set[str]] = {}


def _mark_seen(tenant_id: str, exec_id: str) -> bool:
    if tenant_id not in _seen:
        _seen[tenant_id] = deque(maxlen=10_000)
        _seen_set[tenant_id] = set()
    s = _seen_set[tenant_id]
    if exec_id in s:
        return False
    q = _seen[tenant_id]
    if len(q) == q.maxlen:
        evicted = q.popleft()
        s.discard(evicted)
    q.append(exec_id)
    s.add(exec_id)
    return True


def _client_for(t: TalendTenantRec, log) -> TmcClient:
    cfg = TmcClientConfig(
        pat=t.pat or "",
        region=t.region,
        timeout_s=(float(t.timeout_ms) / 1000.0) if t.timeout_ms else 30.0,
    )
    client = TmcClient(cfg, logger=log)
    # If the tenant overrides the URL, swap the base_url after construction.
    if t.url_override:
        client._http.base_url = t.url_override.rstrip("/")  # type: ignore[attr-defined]
        client.base_url = t.url_override.rstrip("/")        # type: ignore[attr-defined]
    return client


def poll_tasks(client, tenant_id, log, workspaces):
    endpoint = "tasks"
    started = time.monotonic()
    try:
        if not workspaces:
            count = sum(1 for _ in client.list_tasks(workspace_id=None))
            tasks_total.labels(tenant=tenant_id, workspace="").set(count)
        else:
            for ws in workspaces:
                count = sum(1 for _ in client.list_tasks(workspace_id=ws))
                tasks_total.labels(tenant=tenant_id, workspace=ws).set(count)
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_tasks failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def poll_plans(client, tenant_id, log, workspaces):
    endpoint = "plans"
    started = time.monotonic()
    try:
        if not workspaces:
            count = sum(1 for _ in client.list_plans(workspace_id=None))
            plans_total.labels(tenant=tenant_id, workspace="").set(count)
        else:
            for ws in workspaces:
                count = sum(1 for _ in client.list_plans(workspace_id=ws))
                plans_total.labels(tenant=tenant_id, workspace=ws).set(count)
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_plans failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def poll_executions(client, tenant_id, log, lookback_s):
    endpoint = "executions"
    started = time.monotonic()
    try:
        now_ms = int(time.time() * 1000)
        from_ms = now_ms - int(lookback_s * 1000)
        new_count = 0
        for ex in client.search_executions(from_ms=from_ms, to_ms=now_ms):
            exec_id = str(
                ex.get("id") or ex.get("executionId") or ex.get("execution_id") or ""
            )
            if not exec_id or not _mark_seen(tenant_id, exec_id):
                continue
            status = str(ex.get("status", "unknown")).lower()
            workspace = str(ex.get("workspaceId", ex.get("workspace", "")))
            environment = str(ex.get("environmentId", ex.get("environment", "")))
            executions_total.labels(
                tenant=tenant_id, status=status, workspace=workspace, environment=environment
            ).inc()
            if status in {"failed", "terminated", "error"}:
                executions_failed_total.labels(
                    tenant=tenant_id, workspace=workspace, environment=environment
                ).inc()
            dur_s: float | None = None
            if isinstance(ex.get("duration"), (int, float)):
                dur_s = float(ex["duration"]) / 1000.0
            else:
                start = ex.get("startTimestamp") or ex.get("start")
                end = ex.get("endTimestamp") or ex.get("end")
                if isinstance(start, (int, float)) and isinstance(end, (int, float)):
                    dur_s = max(0.0, (float(end) - float(start)) / 1000.0)
            if dur_s is not None:
                execution_duration.labels(tenant=tenant_id, status=status).observe(dur_s)
            new_count += 1
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
        log.debug("polled executions", tenant=tenant_id, new=new_count, window_s=lookback_s)
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_executions failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def main() -> int:
    log = configure_logging("talend-business-exporter")
    cfg = cfg_from_env()
    port = int(os.environ.get("TMC_EXPORTER_PORT", "9465"))
    host = os.environ.get("TMC_EXPORTER_HOST", "0.0.0.0")

    log.info(
        "starting business exporter",
        port=port,
        host=host,
        interval_s=cfg.interval_s,
        lookback_s=cfg.lookback_s,
        workspaces=cfg.workspaces or ["<all>"],
    )
    server, _thread = start_http_server(port, addr=host, registry=registry)

    stopping = False

    def _on_signal(signum, _frame):
        nonlocal stopping
        log.info("shutdown signal", signum=signum)
        stopping = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    while not stopping:
        tenants = list(iter_tenants_with_secret(load_talend_tenants(), "pat", log=log))
        build_info.labels(service="talend-business-exporter", tenants_loaded=str(len(tenants))).set(1)
        if not tenants:
            log.warning(
                "no talend tenants with pat — exporter idle. configure one via the config UI."
            )
        for t in tenants:
            client = _client_for(t, log)
            try:
                poll_tasks(client, t.id, log, cfg.workspaces)
                poll_plans(client, t.id, log, cfg.workspaces)
                poll_executions(client, t.id, log, cfg.lookback_s)
            finally:
                client.close()

        slept = 0.0
        while slept < cfg.interval_s and not stopping:
            time.sleep(min(1.0, cfg.interval_s - slept))
            slept += 1.0

    server.shutdown()
    log.info("exporter stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
