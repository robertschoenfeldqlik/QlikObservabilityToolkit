"""
Lightweight Qlik Cloud client for observability polling.

Covers the platform-services endpoints we read for metrics:
  - GET /api/v1/apps          (paginated)
  - GET /api/v1/reloads       (paginated, optionally filtered by `from`)
  - GET /api/v1/audits        (audit events; paginated)
  - GET /api/v1/quotas        (tenant quotas)

Auth: Bearer API key.
Retries: bounded exponential backoff with jitter on 429 / 5xx.
"""
from __future__ import annotations

import random
import time
from typing import Any, Iterator

import httpx

_DEFAULT_PAGE = 100


class QlikObsClient:
    def __init__(
        self,
        tenant_url: str,
        api_key: str,
        *,
        timeout_s: float = 30.0,
        max_retries: int = 3,
        logger=None,
    ):
        if not tenant_url:
            raise ValueError("tenant_url is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.base_url = tenant_url.rstrip("/")
        self.max_retries = max_retries
        self.log = logger
        self._http = httpx.Client(
            base_url=self.base_url,
            timeout=timeout_s,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "User-Agent": "qlik-cloud-obs-exporter/1.0",
            },
        )

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------
    # Core request with retry
    # ------------------------------------------------------------------
    def request(self, method: str, path: str, *, params: dict | None = None) -> httpx.Response:
        attempt = 0
        while True:
            try:
                res = self._http.request(method, path, params=params)
                if _should_retry(res.status_code) and attempt < self.max_retries:
                    delay = self._delay(attempt, res)
                    if self.log:
                        self.log.warning(
                            "qlik retry",
                            attempt=attempt + 1,
                            status=res.status_code,
                            delay=delay,
                        )
                    time.sleep(delay)
                    attempt += 1
                    continue
                return res
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                if attempt < self.max_retries:
                    delay = self._delay(attempt, None)
                    if self.log:
                        self.log.warning(
                            "qlik transport retry",
                            attempt=attempt + 1,
                            err=str(exc),
                            delay=delay,
                        )
                    time.sleep(delay)
                    attempt += 1
                    continue
                raise

    def _delay(self, attempt: int, res: httpx.Response | None) -> float:
        if res is not None:
            ra = res.headers.get("retry-after")
            if ra:
                try:
                    return min(10.0, float(ra))
                except ValueError:
                    pass
        cap = min(10.0, 0.25 * (2 ** attempt))
        return random.uniform(0, cap)

    # ------------------------------------------------------------------
    # Paginated iterators — Qlik APIs follow the cursor/next-link pattern.
    # The list shape varies a little per endpoint, so each helper handles
    # its own pagination signal.
    # ------------------------------------------------------------------
    def iter_apps(self, *, limit: int = _DEFAULT_PAGE) -> Iterator[dict[str, Any]]:
        next_url: str | None = f"/api/v1/items?resourceType=app&limit={limit}"
        while next_url:
            res = self.request("GET", next_url)
            if res.status_code != 200:
                if self.log:
                    self.log.warning(
                        "qlik apps non-200",
                        status=res.status_code,
                        body=res.text[:200],
                    )
                return
            body = res.json()
            for item in body.get("data") or []:
                yield item
            links = body.get("links") or {}
            nxt = links.get("next")
            next_url = (nxt.get("href") if isinstance(nxt, dict) else nxt) if nxt else None
            # If the server returned an absolute URL, strip the tenant prefix.
            if next_url and next_url.startswith(self.base_url):
                next_url = next_url[len(self.base_url):]

    def iter_reloads(self, *, limit: int = _DEFAULT_PAGE) -> Iterator[dict[str, Any]]:
        next_url: str | None = f"/api/v1/reloads?limit={limit}"
        while next_url:
            res = self.request("GET", next_url)
            if res.status_code != 200:
                if self.log:
                    self.log.warning(
                        "qlik reloads non-200",
                        status=res.status_code,
                        body=res.text[:200],
                    )
                return
            body = res.json()
            for item in body.get("data") or []:
                yield item
            links = body.get("links") or {}
            nxt = links.get("next")
            next_url = (nxt.get("href") if isinstance(nxt, dict) else nxt) if nxt else None
            if next_url and next_url.startswith(self.base_url):
                next_url = next_url[len(self.base_url):]

    def iter_audits(self, *, limit: int = _DEFAULT_PAGE) -> Iterator[dict[str, Any]]:
        next_url: str | None = f"/api/v1/audits?limit={limit}"
        while next_url:
            res = self.request("GET", next_url)
            if res.status_code != 200:
                if self.log:
                    self.log.warning(
                        "qlik audits non-200",
                        status=res.status_code,
                        body=res.text[:200],
                    )
                return
            body = res.json()
            for item in body.get("data") or []:
                yield item
            links = body.get("links") or {}
            nxt = links.get("next")
            next_url = (nxt.get("href") if isinstance(nxt, dict) else nxt) if nxt else None
            if next_url and next_url.startswith(self.base_url):
                next_url = next_url[len(self.base_url):]

    def get_quotas(self) -> list[dict[str, Any]]:
        res = self.request("GET", "/api/v1/quotas")
        if res.status_code != 200:
            return []
        body = res.json()
        return list(body.get("data") or [])


def _should_retry(status: int) -> bool:
    return status == 429 or status == 408 or 500 <= status < 600
