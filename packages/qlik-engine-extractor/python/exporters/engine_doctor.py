"""
Standalone preflight doctor for the Talend Remote Engine extractor.

Deliberately stdlib-only (plus common.engine_diagnostics / common.tenants,
which are themselves stdlib) so it runs on a bare host BEFORE the scraper's
venv with prometheus_client is set up. That's the point — you run `doctor`
to check your config is right, then `run` once it is.

Source resolution mirrors engine_log_scraper.py exactly:
  1. TALEND_ENGINE_SOURCES env ("name:dir,name:dir")
  2. remoteEngines[] in the shared config file
  3. legacy TALEND_ENGINE_LOG_DIR + TALEND_ENGINE_LOG_GLOB

Exit code 0 only if every source's verdict is "ok".
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.engine_diagnostics import diagnose_source  # noqa: E402
from common.tenants import load_remote_engines  # noqa: E402


def resolve_sources() -> list[tuple[str, str, str]]:
    """Return [(name, dir, glob_spec)] using the same precedence as the scraper."""
    env = os.environ.get("TALEND_ENGINE_SOURCES", "").strip()
    if env:
        out = []
        for item in (p for p in env.split(",") if p.strip()):
            name, _, d = item.partition(":")
            out.append((name.strip(), d.strip(), "*.log:*.json"))
        return out

    engines = load_remote_engines()
    if engines:
        return [(e.id, e.log_dir, e.log_glob) for e in engines]

    log_dir = os.environ.get("TALEND_ENGINE_LOG_DIR")
    if log_dir:
        return [("default", log_dir, os.environ.get("TALEND_ENGINE_LOG_GLOB", "*.log:*.json"))]

    return []


def main() -> int:
    sources = resolve_sources()
    print("Talend Remote Engine — extractor doctor\n")
    if not sources:
        print("No sources configured. Set TALEND_ENGINE_SOURCES, add a")
        print("remoteEngines[] block to the config file, or set")
        print("TALEND_ENGINE_LOG_DIR. Nothing to check.\n")
        return 1

    worst = 0
    for name, d, glob_spec in sources:
        diag = diagnose_source(name, d, glob_spec)
        icon = "OK " if diag.verdict == "ok" else "!! "
        print(f"[{icon}] {name}")
        print(f"       dir:      {d}")
        print(f"       glob:     {glob_spec}")
        print(f"       verdict:  {diag.verdict}")
        age = (
            f" (newest {int(diag.newest_age_seconds)}s old)"
            if diag.newest_age_seconds is not None
            else ""
        )
        print(f"       files:    {diag.file_count}{age}")
        print(f"       logging:  {'ENABLED' if diag.logging_enabled else 'NOT DETECTED'}")
        print(f"       detail:   {diag.detail}\n")
        if diag.verdict != "ok":
            worst = 1

    if worst:
        print("One or more sources are unhealthy (see above).")
        print(
            "Remote Engine job-logging docs: "
            "https://help.qlik.com/talend/en-US/remote-engine-user-guide-linux/Cloud/job-management-logs"
        )
    else:
        print("All sources healthy. Job-management logging is ON.")
    return worst


if __name__ == "__main__":
    raise SystemExit(main())
