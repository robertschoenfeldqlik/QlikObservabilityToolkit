"""
Structured JSON logging — same shape as the MCP server's stderr output so
Loki/Promtail can apply the same parser to every container.

  {"ts":"...","level":"info","msg":"...","service":"...","..."}

Redacts known-secret fields (pat, token, authorization).
"""
from __future__ import annotations

import logging
import os
import re
import sys
from typing import Any

import structlog

REDACT_KEYS = {
    "pat",
    "token",
    "access_token",
    "accessToken",
    "authorization",
    "Authorization",
    "client_secret",
    "clientSecret",
    "x-api-key",
    "api_key",
    "apikey",
}

# Talend PAT shape + Bearer header.
_PAT_RE = re.compile(r"\btcp_[A-Za-z0-9_-]{8,}\b")
_BEARER_RE = re.compile(r"Bearer\s+[A-Za-z0-9._\-+/=]+")


def _redact(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return _BEARER_RE.sub("Bearer [REDACTED]", _PAT_RE.sub("[REDACTED]", value))
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if k in REDACT_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(v) for v in value]
    return value


def _redact_processor(_logger, _name, event_dict):
    return _redact(event_dict)


def configure_logging(service: str) -> structlog.stdlib.BoundLogger:
    """Configure structlog + stdlib root logger to emit JSON to stderr."""
    level_name = os.environ.get("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stderr,
        level=level,
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True, key="ts"),
            _redact_processor,
            structlog.processors.EventRenamer("msg"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )

    log = structlog.get_logger().bind(service=service)
    return log
