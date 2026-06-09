"""
Qlik Cloud OBSERVABILITY exporter for Prometheus.

Polls all configured Qlik tenants (from the shared config.json or, in CI,
QLIK_CLOUD_* env vars) and exposes per-tenant metrics on /metrics:

  qlik_apps_total{tenant, space_id}                              gauge
  qlik_reloads_total{tenant, status, app_id, space_id}           counter
  qlik_reload_duration_seconds{tenant, status}                   histogram
  qlik_audit_events_total{tenant, event_type, source}            counter
  qlik_quotas{tenant, resource}                                  gauge
  qlik_exporter_poll_duration_seconds{tenant, endpoint}          histogram
  qlik_exporter_poll_errors_total{tenant, endpoint}              counter
  qlik_exporter_last_success_timestamp{tenant, endpoint}         gauge

Env:
  TMC_EXPORTER_PORT      (9468)
  TMC_EXPORTER_HOST      (0.0.0.0)
  QLIK_OBS_INTERVAL      (60)   seconds between poll cycles
  QLIK_OBS_AUDIT_LIMIT   (200)  upper bound on audit events to scan per cycle

Single-tenant runs can use QLIK_CLOUD_TENANT_URL + QLIK_CLOUD_API_KEY +
(optional) QLIK_CLOUD_CONNECTION_ID, just like the QVD exporter. Multi-tenant
runs read the v2 config file written by the UI / setup wizard.
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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.logging import configure_logging  # noqa: E402
from common.qlik_obs_client import QlikObsClient  # noqa: E402
from common.tenants import (  # noqa: E402
    iter_tenants_with_secret,
    load_qlik_tenants,
)

registry = CollectorRegistry()

apps_total = Gauge(
    "qlik_apps_total",
    "Number of apps visible to the exporter API key in each tenant.",
    ["tenant", "space_id"],
    registry=registry,
)
reloads_total = Counter(
    "qlik_reloads_total",
    "Reload events observed by this exporter, by outcome.",
    ["tenant", "status", "app_id", "space_id"],
    registry=registry,
)
reload_duration = Histogram(
    "qlik_reload_duration_seconds",
    "Observed reload duration (end - start).",
    ["tenant", "status"],
    buckets=(1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600),
    registry=registry,
)
audit_events_total = Counter(
    "qlik_audit_events_total",
    "Audit events observed by this exporter.",
    ["tenant", "event_type", "source"],
    registry=registry,
)
quotas = Gauge(
    "qlik_quotas",
    "Quota usage as reported by Qlik Cloud (value semantics vary by quota).",
    ["tenant", "resource"],
    registry=registry,
)
poll_duration = Histogram(
    "qlik_exporter_poll_duration_seconds",
    "Wall-clock per poll cycle, by endpoint.",
    ["tenant", "endpoint"],
    registry=registry,
)
poll_errors_total = Counter(
    "qlik_exporter_poll_errors_total",
    "Polls that errored or returned non-200.",
    ["tenant", "endpoint"],
    registry=registry,
)
last_success_ts = Gauge(
    "qlik_exporter_last_success_timestamp",
    "Unix timestamp of the last successful poll, per tenant/endpoint.",
    ["tenant", "endpoint"],
    registry=registry,
)
build_info = Gauge(
    "qlik_exporter_build_info",
    "Identity gauge (always 1).",
    ["service"],
    registry=registry,
)


@dataclass
class Cfg:
    interval_s: float
    audit_limit: int


def cfg_from_env() -> Cfg:
    return Cfg(
        interval_s=float(os.environ.get("QLIK_OBS_INTERVAL", "60")),
        audit_limit=int(os.environ.get("QLIK_OBS_AUDIT_LIMIT", "200")),
    )


# Bounded dedupe — recent IDs per tenant.
_seen: dict[str, deque[str]] = {}
_seen_set: dict[str, set[str]] = {}


def _mark_seen(tenant_id: str, key: str) -> bool:
    if tenant_id not in _seen:
        _seen[tenant_id] = deque(maxlen=10_000)
        _seen_set[tenant_id] = set()
    s = _seen_set[tenant_id]
    if key in s:
        return False
    q = _seen[tenant_id]
    if len(q) == q.maxlen:
        evicted = q.popleft()
        s.discard(evicted)
    q.append(key)
    s.add(key)
    return True


def poll_apps(client: QlikObsClient, tenant_id: str, log) -> None:
    endpoint = "apps"
    started = time.monotonic()
    try:
        # Reset gauges keyed only by this tenant so deletions get reflected.
        # (prom-client doesn't have a per-label-subset clear, so we use
        # remove + repopulate by stashing seen-space IDs.)
        counts_by_space: dict[str, int] = {}
        for app in client.iter_apps():
            attrs = app.get("attributes") or app
            space = str(attrs.get("spaceId") or attrs.get("space_id") or "personal")
            counts_by_space[space] = counts_by_space.get(space, 0) + 1
        for space, n in counts_by_space.items():
            apps_total.labels(tenant=tenant_id, space_id=space).set(n)
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
        log.debug("polled apps", tenant=tenant_id, spaces=len(counts_by_space))
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_apps failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def poll_reloads(client: QlikObsClient, tenant_id: str, log) -> None:
    endpoint = "reloads"
    started = time.monotonic()
    new_count = 0
    try:
        for r in client.iter_reloads():
            rid = str(r.get("id") or r.get("reloadId") or "")
            if not rid or not _mark_seen(tenant_id, "reload:" + rid):
                continue
            status = str(r.get("status", "unknown")).lower()
            app_id = str(r.get("appId") or r.get("app_id") or "")
            space_id = str(r.get("spaceId") or r.get("space_id") or "")
            reloads_total.labels(
                tenant=tenant_id, status=status, app_id=app_id, space_id=space_id
            ).inc()
            # Duration from start/end timestamps
            start_iso = r.get("startTime") or r.get("startedAt")
            end_iso = r.get("endTime") or r.get("endedAt")
            if start_iso and end_iso:
                try:
                    from datetime import datetime
                    start = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
                    end = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
                    dur = max(0.0, (end - start).total_seconds())
                    reload_duration.labels(tenant=tenant_id, status=status).observe(dur)
                except (ValueError, TypeError):
                    pass
            new_count += 1
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
        log.debug("polled reloads", tenant=tenant_id, new=new_count)
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_reloads failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def poll_audits(client: QlikObsClient, tenant_id: str, log, limit: int) -> None:
    endpoint = "audits"
    started = time.monotonic()
    new_count = 0
    try:
        scanned = 0
        for ev in client.iter_audits():
            scanned += 1
            if scanned > limit:
                break
            eid = str(ev.get("id") or ev.get("eventId") or "")
            if not eid or not _mark_seen(tenant_id, "audit:" + eid):
                continue
            event_type = str(ev.get("eventType") or ev.get("eventTypeId") or "unknown")
            source = str(ev.get("source") or ev.get("eventSource") or "unknown")
            audit_events_total.labels(
                tenant=tenant_id, event_type=event_type, source=source
            ).inc()
            new_count += 1
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
        log.debug("polled audits", tenant=tenant_id, scanned=scanned, new=new_count)
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_audits failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def poll_quotas(client: QlikObsClient, tenant_id: str, log) -> None:
    endpoint = "quotas"
    started = time.monotonic()
    try:
        for q in client.get_quotas():
            attrs = q.get("attributes") or q
            resource = str(q.get("id") or attrs.get("name") or "unknown")
            usage = attrs.get("usage") or attrs.get("value")
            if isinstance(usage, (int, float)):
                quotas.labels(tenant=tenant_id, resource=resource).set(float(usage))
        last_success_ts.labels(tenant=tenant_id, endpoint=endpoint).set(time.time())
    except Exception as exc:
        poll_errors_total.labels(tenant=tenant_id, endpoint=endpoint).inc()
        log.error("poll_quotas failed", tenant=tenant_id, err=str(exc))
    finally:
        poll_duration.labels(tenant=tenant_id, endpoint=endpoint).observe(time.monotonic() - started)


def main() -> int:
    log = configure_logging("qlik-obs-exporter")
    cfg = cfg_from_env()
    port = int(os.environ.get("TMC_EXPORTER_PORT", "9468"))
    host = os.environ.get("TMC_EXPORTER_HOST", "0.0.0.0")

    build_info.labels(service="qlik-obs-exporter").set(1)
    server, _thread = start_http_server(port, addr=host, registry=registry)
    log.info(
        "starting qlik observability exporter",
        port=port,
        interval_s=cfg.interval_s,
        audit_limit=cfg.audit_limit,
    )

    stopping = False

    def _on_signal(signum, _frame):
        nonlocal stopping
        log.info("shutdown signal", signum=signum)
        stopping = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    while not stopping:
        tenants = list(iter_tenants_with_secret(load_qlik_tenants(), "api_key", log=log))
        if not tenants:
            log.warning(
                "no qlik tenants with api_key — exporter idle. configure one via the config UI."
            )
        for t in tenants:
            client = QlikObsClient(t.tenant_url, t.api_key or "", logger=log)
            try:
                poll_apps(client, t.id, log)
                poll_reloads(client, t.id, log)
                poll_audits(client, t.id, log, cfg.audit_limit)
                poll_quotas(client, t.id, log)
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
