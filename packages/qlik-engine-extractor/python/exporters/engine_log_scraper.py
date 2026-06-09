"""
Talend Remote Engine LOG SCRAPER for Prometheus — multi-source.

Tails the JSON job-management log files written by one OR MORE Talend
Remote Engines on Linux (per Qlik docs:
<RemoteEngineInstallationDirectory>/data/log). Several engines can funnel
into a single /metrics endpoint, each described by an entry called a
"source" (name + directory + glob + read-from-beginning flag).

Each log line is a JSON object. Relevant lines have:
    event_type   = "JOB_STATUS"
    job_phase    in {STARTING_FLOW_EXECUTION, EXECUTION_EVENT_RECEIVED,
                     EXECUTION_SUCCESS, EXECUTION_FAILED, EXECUTION_TERMINATED}
    timestamp    = unix milliseconds
    context.*    = remote engine ID, task execution ID, workspace/env,
                   artifact versions, trigger timestamp, etc.
    count_of_attempts, rejected_rows

We expose:

  talend_engine_jobs_started_total{engine, workspace, environment}
  talend_engine_jobs_succeeded_total{engine, workspace, environment}
  talend_engine_jobs_failed_total{engine, workspace, environment}
  talend_engine_jobs_terminated_total{engine, workspace, environment}
  talend_engine_job_attempts{engine}                       histogram
  talend_engine_rejected_rows{engine, workspace}           histogram
  talend_engine_log_lines_total{level}                     counter (every line, by level)
  talend_engine_log_parse_errors_total                     counter (malformed lines)
  talend_engine_last_event_timestamp{engine}               gauge   - staleness alerts
  talend_engine_scraper_files_followed{source_name}        gauge   - debug, per source
  talend_engine_scraper_sources{source_name, dir}          gauge   - one row per source, value 1

The `engine` label is taken from the log line's `context.remoteEngineId`
when present. When the line lacks that field (heartbeats, init noise,
etc.) the source's `name` is used as the fallback `engine` label so the
metric never lands with an empty string.

Configuration (in priority order — the first match wins):

  1. TALEND_ENGINE_SOURCES env var. Comma-separated list of `name:dir`
     pairs. Glob defaults to "*.log:*.json"; from_beginning follows the
     global TALEND_ENGINE_FROM_BEGINNING flag. Example::

         TALEND_ENGINE_SOURCES="engine-prod-us:/var/log/talend/prod-us,\\
                                engine-dev-eu:/var/log/talend/dev-eu,\\
                                engine-qa-ap:/var/log/talend/qa-ap"

  2. `remoteEngines` array in the shared config file
     (the one Python loads via common.tenants). See
     `common.tenants.load_remote_engines` for the schema; this gives
     each source its own glob and from_beginning flag.

  3. Fallback to legacy single-source env vars
     TALEND_ENGINE_LOG_DIR + TALEND_ENGINE_LOG_GLOB. Backwards
     compatible — existing deployments keep working with no config
     change.

Env (besides the source-config vars above):

  TMC_EXPORTER_PORT             (9466)
  TMC_EXPORTER_HOST             (0.0.0.0)
  TALEND_ENGINE_SCRAPE_INTERVAL (5)   — file poll cadence in seconds
  TALEND_ENGINE_FROM_BEGINNING  (0)   — set to 1 to read existing files
                                         end-to-end on startup (used by
                                         legacy + TALEND_ENGINE_SOURCES
                                         paths; the config-file path
                                         sets fromBeginning per source)
  TALEND_ENGINE_LOG_DIR         (/var/log/talend)  — legacy single-source dir
  TALEND_ENGINE_LOG_GLOB        ("*.log:*.json")    — legacy single-source globs
  TALEND_ENGINE_SOURCES         ("")  — multi-source env-var form,
                                         comma-separated "name:dir" pairs

Designed to run as a sidecar on the engine host (or, in dev, anywhere the
log directories are mounted). It does NOT need TMC credentials.
"""
from __future__ import annotations

import glob
import json
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from prometheus_client.exposition import start_http_server

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.logging import configure_logging  # noqa: E402
from common.tenants import RemoteEngineRec, load_remote_engines  # noqa: E402


registry = CollectorRegistry()

jobs_started_total = Counter(
    "talend_engine_jobs_started_total",
    "Jobs that emitted STARTING_FLOW_EXECUTION on this engine.",
    ["engine", "workspace", "environment"],
    registry=registry,
)
jobs_succeeded_total = Counter(
    "talend_engine_jobs_succeeded_total",
    "Jobs whose terminal event was EXECUTION_SUCCESS.",
    ["engine", "workspace", "environment"],
    registry=registry,
)
jobs_failed_total = Counter(
    "talend_engine_jobs_failed_total",
    "Jobs whose terminal event was EXECUTION_FAILED.",
    ["engine", "workspace", "environment"],
    registry=registry,
)
jobs_terminated_total = Counter(
    "talend_engine_jobs_terminated_total",
    "Jobs whose terminal event was EXECUTION_TERMINATED (user-killed).",
    ["engine", "workspace", "environment"],
    registry=registry,
)
job_attempts = Histogram(
    "talend_engine_job_attempts",
    "Deployment attempts per job (Talend caps at 5).",
    ["engine"],
    buckets=(1, 2, 3, 4, 5),
    registry=registry,
)
rejected_rows = Histogram(
    "talend_engine_rejected_rows",
    "rejected_rows field observed on JOB_STATUS events.",
    ["engine", "workspace"],
    buckets=(0, 1, 10, 100, 1000, 10000, 100000),
    registry=registry,
)
log_lines_total = Counter(
    "talend_engine_log_lines_total",
    "All log lines parsed, by JSON-encoded `level` field.",
    ["level"],
    registry=registry,
)
parse_errors_total = Counter(
    "talend_engine_log_parse_errors_total",
    "Lines that failed JSON parse or didn't have the expected shape.",
    registry=registry,
)
last_event_ts = Gauge(
    "talend_engine_last_event_timestamp",
    "Unix timestamp of the most recent JOB_STATUS event seen, by engine.",
    ["engine"],
    registry=registry,
)
files_followed = Gauge(
    "talend_engine_scraper_files_followed",
    "How many log files this scraper is currently tracking, per source.",
    ["source_name"],
    registry=registry,
)
scraper_sources = Gauge(
    "talend_engine_scraper_sources",
    "One row per configured log source (value always 1) so operators "
    "can see what feeds this scraper is reading.",
    ["source_name", "dir"],
    registry=registry,
)
build_info = Gauge(
    "talend_engine_scraper_build_info",
    "Identity gauge (always 1).",
    ["service"],
    registry=registry,
)


@dataclass
class FileState:
    path: str
    inode: int
    source_name: str            # the source this file belongs to
    position: int = 0
    # Track per-execution job_phase so we can fold STARTING + COMPLETED pairs
    # into duration observations if the engine emits them in sequence.
    pending_starts: dict[str, float] = field(default_factory=dict)


def _stat_inode(path: str) -> int:
    try:
        return os.stat(path).st_ino
    except FileNotFoundError:
        return -1


def _discover_files(globs: list[str]) -> list[str]:
    found: list[str] = []
    for pattern in globs:
        found.extend(glob.glob(pattern))
    # dedupe + sort for stable ordering in logs
    return sorted(set(found))


def _parse_line(raw: str, log, source_name: str) -> dict | None:
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        parse_errors_total.inc()
        if log.isEnabledFor(__import__("logging").DEBUG):  # pragma: no cover
            log.debug(
                "malformed log line",
                source=source_name,
                sample=raw[:200],
            )
        return None


def _record_event(obj: dict, log, source_name: str) -> None:
    """Update metrics for a single parsed JSON log entry.

    `source_name` is used as the fallback `engine` label when the log
    line doesn't carry context.remoteEngineId.
    """
    level = str(obj.get("level", "")).lower() or "unknown"
    log_lines_total.labels(level=level).inc()

    if obj.get("event_type") != "JOB_STATUS":
        return

    phase = str(obj.get("job_phase", ""))
    ctx = obj.get("context") or {}
    engine = str(
        ctx.get("remoteEngineId")
        or ctx.get("remote_engine_id")
        or source_name
    )
    workspace = str(ctx.get("workspaceId") or ctx.get("workspace_id") or "")
    environment = str(ctx.get("environmentId") or ctx.get("environment_id") or "")
    ts_ms = obj.get("timestamp")
    if isinstance(ts_ms, (int, float)):
        last_event_ts.labels(engine=engine).set(float(ts_ms) / 1000.0)

    attempts = obj.get("count_of_attempts")
    if isinstance(attempts, int):
        job_attempts.labels(engine=engine).observe(attempts)

    rej = obj.get("rejected_rows")
    if isinstance(rej, (int, float)):
        rejected_rows.labels(engine=engine, workspace=workspace).observe(float(rej))

    if phase == "STARTING_FLOW_EXECUTION":
        jobs_started_total.labels(
            engine=engine, workspace=workspace, environment=environment
        ).inc()
    elif phase == "EXECUTION_SUCCESS":
        jobs_succeeded_total.labels(
            engine=engine, workspace=workspace, environment=environment
        ).inc()
    elif phase == "EXECUTION_FAILED":
        jobs_failed_total.labels(
            engine=engine, workspace=workspace, environment=environment
        ).inc()
    elif phase == "EXECUTION_TERMINATED":
        jobs_terminated_total.labels(
            engine=engine, workspace=workspace, environment=environment
        ).inc()
    # EXECUTION_EVENT_RECEIVED is informational — we don't bucket it.


def _process_file(state: FileState, log, max_bytes: int = 4 * 1024 * 1024) -> None:
    """Read newly-appended bytes from the file and update metrics."""
    try:
        with open(state.path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            # Handle truncation/rotation: if the file shrank, restart from the
            # current end so we don't backfill a rotated-and-reused file.
            if size < state.position:
                log.info(
                    "file truncated, resetting position",
                    source=state.source_name,
                    path=state.path,
                    size=size,
                )
                state.position = 0
            if state.position >= size:
                return
            f.seek(state.position)
            chunk = f.read(min(max_bytes, size - state.position))
            state.position += len(chunk)
    except FileNotFoundError:
        return

    text = chunk.decode("utf-8", errors="replace")
    # Last line might be partial — back up so we re-read it next tick.
    # (Approximation: only commit through the last newline.)
    last_nl = text.rfind("\n")
    if last_nl == -1:
        # No complete line yet; rewind.
        state.position -= len(chunk)
        return
    complete = text[: last_nl + 1]
    leftover_bytes = len(chunk) - len(complete.encode("utf-8"))
    state.position -= leftover_bytes

    for line in complete.splitlines():
        obj = _parse_line(line, log, state.source_name)
        if obj is not None:
            try:
                _record_event(obj, log, state.source_name)
            except Exception as exc:  # pragma: no cover — defensive
                log.error(
                    "event handler raised",
                    source=state.source_name,
                    err=str(exc),
                )


# --------------------------------------------------------------------------
# Source resolution: env var -> config file -> legacy single-source.
# --------------------------------------------------------------------------

def _parse_sources_env(raw: str, from_beginning: bool) -> list[RemoteEngineRec]:
    """Parse TALEND_ENGINE_SOURCES into a list of RemoteEngineRec.

    Format: comma-separated `name:dir` pairs. Windows paths with drive
    letters (e.g. ``C:\\path``) are tolerated because we split on the
    FIRST colon only.

    >>> recs = _parse_sources_env("a:/tmp/a,b:/tmp/b", False)
    >>> [(r.id, r.log_dir, r.from_beginning) for r in recs]
    [('a', '/tmp/a', False), ('b', '/tmp/b', False)]
    """
    out: list[RemoteEngineRec] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        # Drive-letter-friendly split: only the first colon separates name and dir.
        name, sep, directory = entry.partition(":")
        name = name.strip()
        directory = directory.strip()
        if not sep or not name or not directory:
            continue
        out.append(
            RemoteEngineRec(
                id=name,
                label=name,
                log_dir=directory,
                log_glob="*.log:*.json",
                from_beginning=from_beginning,
            )
        )
    return out


def _resolve_sources(log, from_beginning: bool) -> list[RemoteEngineRec]:
    """Pick the source list from env -> config -> legacy single-source.

    Example: three sources funneling into one /metrics endpoint via the
    TALEND_ENGINE_SOURCES env var::

        TALEND_ENGINE_SOURCES="engine-prod-us:/var/log/talend/prod-us,\
                               engine-dev-eu:/var/log/talend/dev-eu,\
                               engine-qa-ap:/var/log/talend/qa-ap"

    Each line emitted from /var/log/talend/prod-us is tagged
    ``engine="engine-prod-us"`` (unless the JSON itself carries a
    different remoteEngineId, in which case the JSON wins).
    """
    env_sources = os.environ.get("TALEND_ENGINE_SOURCES", "").strip()
    if env_sources:
        srcs = _parse_sources_env(env_sources, from_beginning)
        if srcs:
            log.info(
                "resolved sources from TALEND_ENGINE_SOURCES env",
                count=len(srcs),
            )
            return srcs
        log.warning(
            "TALEND_ENGINE_SOURCES set but parsed to zero sources",
            raw=env_sources,
        )

    cfg_sources = load_remote_engines()
    if cfg_sources:
        log.info(
            "resolved sources from shared config remoteEngines",
            count=len(cfg_sources),
        )
        return cfg_sources

    # Legacy fallback: single source from TALEND_ENGINE_LOG_DIR + GLOB.
    base_dir = os.environ.get("TALEND_ENGINE_LOG_DIR", "/var/log/talend")
    glob_env = os.environ.get("TALEND_ENGINE_LOG_GLOB", "*.log:*.json")
    legacy = RemoteEngineRec(
        id="default",
        label="default",
        log_dir=base_dir,
        log_glob=glob_env,
        from_beginning=from_beginning,
    )
    log.info(
        "resolved single legacy source",
        log_dir=base_dir,
        glob=glob_env,
    )
    return [legacy]


def _globs_for(source: RemoteEngineRec) -> list[str]:
    """Expand a source's colon-separated glob spec to absolute patterns."""
    return [
        str(Path(source.log_dir) / g)
        for g in source.log_glob.split(":")
        if g.strip()
    ]


def main() -> int:
    log = configure_logging("talend-engine-log-scraper")
    port = int(os.environ.get("TMC_EXPORTER_PORT", "9466"))
    host = os.environ.get("TMC_EXPORTER_HOST", "0.0.0.0")
    interval_s = float(os.environ.get("TALEND_ENGINE_SCRAPE_INTERVAL", "5"))
    from_beginning = os.environ.get("TALEND_ENGINE_FROM_BEGINNING", "0") == "1"

    sources = _resolve_sources(log, from_beginning)

    log.info(
        "starting engine log scraper",
        sources=[
            {"name": s.id, "dir": s.log_dir, "glob": s.log_glob,
             "from_beginning": s.from_beginning}
            for s in sources
        ],
        interval_s=interval_s,
        port=port,
    )

    build_info.labels(service="talend-engine-log-scraper").set(1)
    for s in sources:
        scraper_sources.labels(source_name=s.id, dir=s.log_dir).set(1)
        # Pre-init the per-source file-count gauge so it shows up at 0
        # even when no files are present yet.
        files_followed.labels(source_name=s.id).set(0)

    server, _thread = start_http_server(port, addr=host, registry=registry)
    log.info("metrics endpoint listening", url=f"http://{host}:{port}/metrics")

    # path -> FileState (paths are absolute; collisions across sources
    # would mean two sources pointing at the same dir, which is the user's
    # bug — we don't try to disambiguate by source here).
    states: dict[str, FileState] = {}

    def _refresh_files():
        seen: set[str] = set()
        # Track count per source for the gauge.
        per_source_count: dict[str, int] = {s.id: 0 for s in sources}
        for source in sources:
            globs = _globs_for(source)
            for path in _discover_files(globs):
                seen.add(path)
                inode = _stat_inode(path)
                if path not in states or states[path].inode != inode:
                    # New or rotated file.
                    start_pos = 0
                    if not source.from_beginning and path not in states:
                        try:
                            start_pos = os.path.getsize(path)
                        except FileNotFoundError:
                            start_pos = 0
                    states[path] = FileState(
                        path=path,
                        inode=inode,
                        source_name=source.id,
                        position=start_pos,
                    )
                    log.info(
                        "tracking log file",
                        source=source.id,
                        path=path,
                        inode=inode,
                        start_position=start_pos,
                    )
                per_source_count[source.id] += 1
        # Drop files that disappeared.
        for path in list(states):
            if path not in seen:
                log.info(
                    "stopped tracking log file",
                    source=states[path].source_name,
                    path=path,
                )
                del states[path]
        for sid, count in per_source_count.items():
            files_followed.labels(source_name=sid).set(count)

    stopping = False

    def _on_signal(signum, _frame):
        nonlocal stopping
        log.info("shutdown signal", signum=signum)
        stopping = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        while not stopping:
            _refresh_files()
            # Iterate sources, then files within each source — keeps the
            # tail order deterministic across feeds.
            for source in sources:
                for st in list(states.values()):
                    if st.source_name != source.id:
                        continue
                    _process_file(st, log)
            slept = 0.0
            while slept < interval_s and not stopping:
                time.sleep(min(1.0, interval_s - slept))
                slept += 1.0
    finally:
        server.shutdown()
        log.info("scraper stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
