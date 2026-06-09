"""
Thin Talend Cloud REST client.

Used by the business exporter. Mirrors the TypeScript MCP server's
TmcClient behavior at a high level:
- PAT bearer auth
- Region-aware base URL
- Bounded retries on 429/5xx/network errors with exponential backoff + jitter
- Per-call timeout

We deliberately do NOT load OpenAPI specs here — the exporter calls a small
fixed set of endpoints, so hand-typed helper methods are clearer than
spec-driven dispatch.
"""
from __future__ import annotations

import os
import random
import time
from dataclasses import dataclass
from typing import Any, Iterable

import httpx

REGIONS = {
    "eu": "https://api.eu.cloud.talend.com",
    "us": "https://api.us.cloud.talend.com",
    "ap": "https://api.ap.cloud.talend.com",
    "au": "https://api.au.cloud.talend.com",
    "us-west": "https://api.us-west.cloud.talend.com",
}


@dataclass
class TmcClientConfig:
    pat: str
    region: str
    timeout_s: float = 30.0
    max_retries: int = 3
    retry_base_s: float = 0.25
    retry_max_s: float = 10.0


class TmcClient:
    def __init__(self, cfg: TmcClientConfig, logger=None):
        if cfg.region not in REGIONS:
            raise ValueError(
                f"Unknown TMC region {cfg.region!r}. Expected one of: {', '.join(REGIONS)}"
            )
        self.cfg = cfg
        self.base_url = REGIONS[cfg.region]
        self.log = logger
        self._http = httpx.Client(
            base_url=self.base_url,
            timeout=cfg.timeout_s,
            headers={
                "Authorization": f"Bearer {cfg.pat}",
                "Accept": "application/json",
                "User-Agent": "talend-tmc-exporter/1.0",
            },
        )

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------
    # Low-level request with retries
    # ------------------------------------------------------------------
    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> httpx.Response:
        attempt = 0
        while True:
            try:
                res = self._http.request(method, path, params=params, json=json)
                if _should_retry(res.status_code) and attempt < self.cfg.max_retries:
                    delay = self._delay(attempt, res)
                    self._warn(
                        "retrying after retryable status",
                        attempt=attempt + 1,
                        status=res.status_code,
                        delay=delay,
                    )
                    time.sleep(delay)
                    attempt += 1
                    continue
                return res
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                if attempt < self.cfg.max_retries:
                    delay = self._delay(attempt, None)
                    self._warn(
                        "retrying after transport error",
                        attempt=attempt + 1,
                        err=str(exc),
                        delay=delay,
                    )
                    time.sleep(delay)
                    attempt += 1
                    continue
                raise

    def _delay(self, attempt: int, res: httpx.Response | None) -> float:
        # Honor Retry-After header when present.
        if res is not None:
            ra = res.headers.get("retry-after")
            if ra is not None:
                try:
                    return min(self.cfg.retry_max_s, float(ra))
                except ValueError:
                    pass  # ignore HTTP-date form; jitter fallback below
        cap = min(self.cfg.retry_max_s, self.cfg.retry_base_s * (2 ** attempt))
        return random.uniform(0, cap)

    def _warn(self, msg: str, **fields: Any) -> None:
        if self.log:
            self.log.warning(msg, **fields)

    # ------------------------------------------------------------------
    # Endpoints we care about for the business exporter
    # ------------------------------------------------------------------
    def list_tasks(self, *, workspace_id: str | None = None, limit: int = 100) -> Iterable[dict]:
        """Paginate the orchestration tasks endpoint."""
        offset = 0
        while True:
            params: dict[str, Any] = {"limit": limit, "offset": offset}
            if workspace_id:
                params["workspaceId"] = workspace_id
            res = self.request("GET", "/orchestration/executables/tasks", params=params)
            if res.status_code != 200:
                self._warn(
                    "list_tasks non-200", status=res.status_code, body=res.text[:200]
                )
                return
            page = res.json()
            items = page.get("items") if isinstance(page, dict) else page
            if not items:
                return
            for it in items:
                yield it
            if len(items) < limit:
                return
            offset += len(items)

    def list_plans(self, *, workspace_id: str | None = None, limit: int = 100) -> Iterable[dict]:
        offset = 0
        while True:
            params: dict[str, Any] = {"limit": limit, "offset": offset}
            if workspace_id:
                params["workspaceId"] = workspace_id
            res = self.request("GET", "/orchestration/executables/plans", params=params)
            if res.status_code != 200:
                self._warn("list_plans non-200", status=res.status_code, body=res.text[:200])
                return
            page = res.json()
            items = page.get("items") if isinstance(page, dict) else page
            if not items:
                return
            for it in items:
                yield it
            if len(items) < limit:
                return
            offset += len(items)

    def search_executions(
        self, *, from_ms: int, to_ms: int, limit: int = 200
    ) -> Iterable[dict]:
        """
        POST /monitoring/observability/executions/search — execution history
        records (status, duration, workspace/env, task ID, etc.).
        """
        offset = 0
        while True:
            body = {
                "from": from_ms,
                "to": to_ms,
                "limit": limit,
                "offset": offset,
            }
            res = self.request(
                "POST", "/monitoring/observability/executions/search", json=body
            )
            if res.status_code != 200:
                self._warn(
                    "search_executions non-200",
                    status=res.status_code,
                    body=res.text[:200],
                )
                return
            page = res.json()
            items = page.get("items") if isinstance(page, dict) else page
            if not items:
                return
            for it in items:
                yield it
            if len(items) < limit:
                return
            offset += len(items)


def _should_retry(status: int) -> bool:
    return status == 429 or status == 408 or 500 <= status < 600


def client_from_env(logger=None) -> TmcClient:
    pat = os.environ.get("TMC_PAT")
    region = os.environ.get("TMC_REGION", "us")
    if not pat:
        raise SystemExit("TMC_PAT environment variable is required")
    return TmcClient(
        TmcClientConfig(
            pat=pat,
            region=region,
            timeout_s=float(os.environ.get("TMC_TIMEOUT_S", "30")),
            max_retries=int(os.environ.get("TMC_MAX_RETRIES", "3")),
        ),
        logger=logger,
    )
