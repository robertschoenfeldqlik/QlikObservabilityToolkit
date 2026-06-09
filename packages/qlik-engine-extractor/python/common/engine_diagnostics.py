"""
Self-diagnosis for Talend Remote Engine log sources.

The extractor runs headless on a customer's engine host — nobody's logged in
to eyeball whether the log pickup directory is right or whether job logging
is even switched on. These checks answer, per source:

  - Does the pickup directory exist and is it readable?
  - Are there any files matching the configured glob? (logging writes files)
  - Is at least one file *recent*? (logging is actively writing, not stale)
  - Do any recent lines carry event_type=="JOB_STATUS"? (job-management
    logging is enabled, not just generic engine logs)

These map to a verdict per source:

  ok            — path exists, files present, recent, JOB_STATUS seen
  no_path       — directory missing / unreadable
  no_files      — directory exists but no matching files
  stale         — files exist but none modified within the freshness window
  no_job_status — files are fresh but contain no JOB_STATUS events
                  (usually means job-management logging is OFF in the engine
                   config — see Qlik's remote-engine logging docs)

Used by:
  - the engine scraper, to publish gauges
        talend_engine_source_path_exists{source_name}
        talend_engine_logging_enabled{source_name}
  - the `qlik-engine-extractor doctor` CLI, for a human-readable report
  - the heartbeat payload, so the central UI shows a per-source verdict
"""
from __future__ import annotations

import glob
import json
import os
import time
from dataclasses import dataclass, asdict
from typing import Literal

Verdict = Literal["ok", "no_path", "no_files", "stale", "no_job_status"]

# A file modified within this many seconds counts as "recent" / "logging is live".
DEFAULT_FRESHNESS_S = 3600
# How many trailing bytes of the newest file we scan looking for JOB_STATUS.
TAIL_BYTES = 256 * 1024


@dataclass
class SourceDiagnostic:
    source_name: str
    dir: str
    verdict: Verdict
    path_exists: bool
    readable: bool
    file_count: int
    newest_file: str | None
    newest_age_seconds: float | None
    job_status_seen: bool
    logging_enabled: bool          # convenience: verdict == "ok"
    detail: str                    # one-line human explanation

    def to_dict(self) -> dict:
        return asdict(self)


def _split_globs(glob_spec: str) -> list[str]:
    return [g for g in glob_spec.split(":") if g.strip()]


def diagnose_source(
    source_name: str,
    log_dir: str,
    glob_spec: str = "*.log:*.json",
    *,
    freshness_s: int = DEFAULT_FRESHNESS_S,
    now: float | None = None,
) -> SourceDiagnostic:
    """Run all checks for one source and return a structured verdict."""
    now = now if now is not None else time.time()

    path_exists = os.path.isdir(log_dir)
    readable = path_exists and os.access(log_dir, os.R_OK | os.X_OK)

    if not path_exists:
        return SourceDiagnostic(
            source_name, log_dir, "no_path", False, False, 0, None, None, False, False,
            f"Pickup directory does not exist: {log_dir}",
        )
    if not readable:
        return SourceDiagnostic(
            source_name, log_dir, "no_path", True, False, 0, None, None, False, False,
            f"Pickup directory exists but is not readable (check permissions): {log_dir}",
        )

    files: list[str] = []
    for pattern in _split_globs(glob_spec):
        files.extend(glob.glob(os.path.join(log_dir, pattern)))
    files = sorted(set(files))

    if not files:
        return SourceDiagnostic(
            source_name, log_dir, "no_files", True, True, 0, None, None, False, False,
            f"No files match {glob_spec!r} in {log_dir}. Is the engine writing logs here?",
        )

    # Newest file by mtime.
    newest = max(files, key=lambda f: _safe_mtime(f))
    newest_age = now - _safe_mtime(newest)

    if newest_age > freshness_s:
        return SourceDiagnostic(
            source_name, log_dir, "stale", True, True, len(files), newest,
            round(newest_age, 1), False, False,
            f"Newest file is {int(newest_age)}s old (> {freshness_s}s). "
            "Logging may have stopped, or the engine is idle.",
        )

    # Scan the tail of the newest file for a JOB_STATUS event.
    job_status_seen = _tail_has_job_status(newest)

    if not job_status_seen:
        return SourceDiagnostic(
            source_name, log_dir, "no_job_status", True, True, len(files), newest,
            round(newest_age, 1), False, False,
            "Files are fresh but no JOB_STATUS events found. Job-management "
            "logging is likely OFF in the Remote Engine config.",
        )

    return SourceDiagnostic(
        source_name, log_dir, "ok", True, True, len(files), newest,
        round(newest_age, 1), True, True,
        f"OK — {len(files)} file(s), newest {int(newest_age)}s old, JOB_STATUS present.",
    )


def _safe_mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def _tail_has_job_status(path: str, tail_bytes: int = TAIL_BYTES) -> bool:
    """Read the last `tail_bytes` of the file and look for a JOB_STATUS event.
    Cheap heuristic — we substring-match before parsing JSON to avoid parsing
    every line."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
                f.readline()  # discard partial line
            chunk = f.read()
    except OSError:
        return False
    text = chunk.decode("utf-8", errors="replace")
    if "JOB_STATUS" not in text:
        return False
    # Confirm at least one complete line parses with event_type JOB_STATUS,
    # so a stray occurrence in a message string doesn't false-positive.
    for line in text.splitlines():
        line = line.strip()
        if not line or "JOB_STATUS" not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("event_type") == "JOB_STATUS":
            return True
    return False


def diagnose_all(sources: list[tuple[str, str, str]], **kw) -> list[SourceDiagnostic]:
    """sources: list of (name, dir, glob_spec)."""
    return [diagnose_source(name, d, g, **kw) for (name, d, g) in sources]
