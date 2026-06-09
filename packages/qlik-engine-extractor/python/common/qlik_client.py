"""
Minimal Qlik Cloud client — uploads files to the Data Files API.

Auth:
  - API key (Bearer header). Generate in Qlik Cloud Hub:
    Profile -> Settings -> API keys -> Generate new key.

Endpoint:
  POST  {QLIK_CLOUD_TENANT_URL}/api/v1/data-files            (multipart create)
  PATCH {QLIK_CLOUD_TENANT_URL}/api/v1/data-files/{id}       (multipart replace)

Connection ID is mandatory when uploading a NEW file (which data connection
should own it). For most tenants the default personal connection is
"DataFiles". Discover yours from the Qlik Sense Hub or via the
data-files-connections API.

References:
  https://qlik.dev/apis/rest/data-files
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


@dataclass
class QlikCloudConfig:
    tenant_url: str          # e.g. https://your-tenant.eu.qlikcloud.com
    api_key: str
    connection_id: str       # data connection that should own the file
    timeout_s: float = 60.0


class QlikCloudClient:
    def __init__(self, cfg: QlikCloudConfig, logger=None):
        if not cfg.tenant_url:
            raise ValueError("QLIK_CLOUD_TENANT_URL is required")
        if not cfg.api_key:
            raise ValueError("QLIK_CLOUD_API_KEY is required")
        if not cfg.connection_id:
            raise ValueError("QLIK_CLOUD_CONNECTION_ID is required")
        self.cfg = cfg
        self.log = logger
        self._http = httpx.Client(
            base_url=cfg.tenant_url.rstrip("/"),
            timeout=cfg.timeout_s,
            headers={
                "Authorization": f"Bearer {cfg.api_key}",
                "User-Agent": "talend-tmc-qvd-exporter/1.0",
            },
        )

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------
    # Public ops
    # ------------------------------------------------------------------
    def find_file_id(self, name: str) -> str | None:
        """Look up an existing data file by name in the configured connection."""
        params = {
            "name": name,
            "connectionId": self.cfg.connection_id,
        }
        res = self._http.get("/api/v1/data-files", params=params)
        res.raise_for_status()
        body = res.json()
        items = body.get("data") if isinstance(body, dict) else body
        if not items:
            return None
        for it in items:
            if it.get("name") == name:
                return it.get("id")
        return None

    def upload_or_replace(
        self,
        name: str,
        file_path: str | Path,
        *,
        source_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Upload a file. If a file with the same name already exists in the
        configured connection, replace it via PATCH. Returns the API response body.
        """
        file_path = Path(file_path)
        if not file_path.is_file():
            raise FileNotFoundError(file_path)
        existing_id = source_id or self.find_file_id(name)
        if existing_id:
            return self._patch(existing_id, name, file_path)
        return self._post(name, file_path)

    # ------------------------------------------------------------------
    # Underlying HTTP
    # ------------------------------------------------------------------
    def _post(self, name: str, file_path: Path) -> dict[str, Any]:
        json_part = {
            "Name": name,
            "ConnectionId": self.cfg.connection_id,
        }
        with file_path.open("rb") as fh:
            files = {
                "Json": (None, _json_dumps(json_part), "application/json"),
                "File": (name, fh, "application/octet-stream"),
            }
            res = self._http.post("/api/v1/data-files", files=files)
        if res.status_code >= 300:
            self._raise("POST /data-files", res)
        return res.json()

    def _patch(self, file_id: str, name: str, file_path: Path) -> dict[str, Any]:
        json_part = {"Name": name}
        with file_path.open("rb") as fh:
            files = {
                "Json": (None, _json_dumps(json_part), "application/json"),
                "File": (name, fh, "application/octet-stream"),
            }
            res = self._http.request(
                "PATCH", f"/api/v1/data-files/{file_id}", files=files
            )
        if res.status_code >= 300:
            self._raise(f"PATCH /data-files/{file_id}", res)
        return res.json() if res.text else {"id": file_id, "name": name}

    def _raise(self, op: str, res: httpx.Response) -> None:
        if self.log:
            self.log.error(
                "qlik upload failed",
                op=op,
                status=res.status_code,
                body=res.text[:500],
            )
        res.raise_for_status()


def _json_dumps(obj: Any) -> str:
    import json
    return json.dumps(obj, separators=(",", ":"))


def client_from_env(logger=None) -> QlikCloudClient:
    return QlikCloudClient(
        QlikCloudConfig(
            tenant_url=os.environ.get("QLIK_CLOUD_TENANT_URL", "").rstrip("/"),
            api_key=os.environ.get("QLIK_CLOUD_API_KEY", ""),
            connection_id=os.environ.get("QLIK_CLOUD_CONNECTION_ID", ""),
            timeout_s=float(os.environ.get("QLIK_CLOUD_TIMEOUT_S", "60")),
        ),
        logger=logger,
    )
