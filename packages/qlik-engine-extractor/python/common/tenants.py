"""
Shared multi-tenant loader for the Python exporters.

Reads the same `config.json` the TypeScript UI writes (v2 schema) and yields
typed Talend / Qlik tenant records. Used by every exporter that needs to
poll multiple tenants.

Resolution order for each secret:
  1. Tenant record has the secret inline (storage == "file"): use it.
  2. Tenant record has storage == "keychain": try the OS keyring via
     `keyring` (Python lib). On most exporter deployments — Docker on
     Linux without libsecret — the keyring is unavailable; the loader
     returns the tenant with secret=None and the caller logs+skips.
  3. Env-var override (TENANT_PAT, TENANT_API_KEY) for single-tenant
     ad-hoc runs — useful in CI.

We deliberately keep this loader's dependencies minimal: just `os`, `json`,
`pathlib`, plus a soft import of `keyring`. If the keyring isn't installed
in the exporter image, file-based tenants still work.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


def _default_path() -> str:
    # Mirror the TS configPath() resolution but only at import time.
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, "talend-tmc-mcp", "config.json")
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "talend-tmc-mcp", "config.json")


# Re-resolve at function call so env changes in tests take effect.
def config_path() -> Path:
    if "TMC_CONFIG_PATH" in os.environ:
        return Path(os.environ["TMC_CONFIG_PATH"])
    return Path(_default_path())


@dataclass
class TalendTenantRec:
    id: str
    label: str
    region: str
    url_override: str | None
    pat: str | None
    pat_storage: str           # "file" | "keychain"
    apis: list[str]
    timeout_ms: int | None
    is_default: bool

    def base_url(self) -> str:
        if self.url_override:
            return self.url_override.rstrip("/")
        return _REGIONS.get(self.region, _REGIONS["us"])


@dataclass
class QlikTenantRec:
    id: str
    label: str
    tenant_url: str
    api_key: str | None
    api_key_storage: str       # "file" | "keychain"
    connection_id: str | None
    timeout_ms: int | None
    is_default: bool


@dataclass
class RemoteEngineRec:
    """A single Talend Remote Engine log source.

    `id` doubles as the fallback `engine` label on metrics emitted from
    log lines that don't carry `context.remoteEngineId` (e.g. heartbeats).
    `label` is a human-friendly name for dashboards / debugging.
    """
    id: str
    label: str
    log_dir: str
    log_glob: str              # colon-separated globs, e.g. "*.log:*.json"
    from_beginning: bool


_REGIONS = {
    "eu": "https://api.eu.cloud.talend.com",
    "us": "https://api.us.cloud.talend.com",
    "ap": "https://api.ap.cloud.talend.com",
    "au": "https://api.au.cloud.talend.com",
    "us-west": "https://api.us-west.cloud.talend.com",
}


# --------------------------------------------------------------------------
# Keyring access (soft dependency)
# --------------------------------------------------------------------------

KEYCHAIN_SERVICE = "talend-tmc-mcp"


def _keyring_get(account: str) -> str | None:
    """Best-effort keyring lookup. Returns None when the lib isn't installed
    or the entry doesn't exist."""
    try:
        import keyring  # type: ignore
    except ImportError:
        return None
    try:
        return keyring.get_password(KEYCHAIN_SERVICE, account)
    except Exception:
        return None


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def _load_raw() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def load_talend_tenants() -> list[TalendTenantRec]:
    """Return all Talend tenants, default first."""
    cfg = _load_raw()
    raw_list = cfg.get("talendTenants") or []
    default_id = cfg.get("defaultTalendId")

    # Back-compat: synthesize a single tenant from legacy v1 fields if needed.
    if not raw_list and cfg.get("pat") and cfg.get("region"):
        raw_list = [
            {
                "id": "default",
                "label": "Default",
                "region": cfg.get("region"),
                "pat": cfg.get("pat"),
                "patStorage": cfg.get("patStorage") or "file",
                "apis": cfg.get("apis") or [],
                "timeoutMs": cfg.get("timeoutMs"),
            }
        ]
        default_id = "default"

    out: list[TalendTenantRec] = []
    for raw in raw_list:
        tid = str(raw.get("id", "")).strip()
        if not tid:
            continue
        storage = raw.get("patStorage") or "file"
        pat: str | None = None
        if storage == "keychain":
            pat = _keyring_get(f"talend:{tid}")
        else:
            pat = raw.get("pat") or None
        out.append(
            TalendTenantRec(
                id=tid,
                label=raw.get("label") or tid,
                region=raw.get("region") or "us",
                url_override=raw.get("urlOverride"),
                pat=pat,
                pat_storage=storage,
                apis=list(raw.get("apis") or []),
                timeout_ms=raw.get("timeoutMs"),
                is_default=(tid == default_id),
            )
        )
    # Single-tenant env override — useful in CI / quick tests.
    if not out:
        env_pat = os.environ.get("TMC_PAT")
        env_region = os.environ.get("TMC_REGION", "us")
        if env_pat:
            out.append(
                TalendTenantRec(
                    id="env",
                    label="(from TMC_PAT env)",
                    region=env_region,
                    url_override=None,
                    pat=env_pat,
                    pat_storage="file",
                    apis=[],
                    timeout_ms=None,
                    is_default=True,
                )
            )
    out.sort(key=lambda t: (0 if t.is_default else 1, t.id))
    return out


def load_qlik_tenants() -> list[QlikTenantRec]:
    cfg = _load_raw()
    raw_list = cfg.get("qlikTenants") or []
    default_id = cfg.get("defaultQlikId")

    out: list[QlikTenantRec] = []
    for raw in raw_list:
        tid = str(raw.get("id", "")).strip()
        if not tid:
            continue
        storage = raw.get("apiKeyStorage") or "file"
        key: str | None = None
        if storage == "keychain":
            key = _keyring_get(f"qlik:{tid}")
        else:
            key = raw.get("apiKey") or None
        out.append(
            QlikTenantRec(
                id=tid,
                label=raw.get("label") or tid,
                tenant_url=str(raw.get("tenantUrl") or "").rstrip("/"),
                api_key=key,
                api_key_storage=storage,
                connection_id=raw.get("connectionId"),
                timeout_ms=raw.get("timeoutMs"),
                is_default=(tid == default_id),
            )
        )
    # Env override for ad-hoc runs.
    if not out and os.environ.get("QLIK_CLOUD_TENANT_URL") and os.environ.get("QLIK_CLOUD_API_KEY"):
        out.append(
            QlikTenantRec(
                id="env",
                label="(from QLIK_CLOUD_* env)",
                tenant_url=os.environ["QLIK_CLOUD_TENANT_URL"].rstrip("/"),
                api_key=os.environ["QLIK_CLOUD_API_KEY"],
                api_key_storage="file",
                connection_id=os.environ.get("QLIK_CLOUD_CONNECTION_ID"),
                timeout_ms=None,
                is_default=True,
            )
        )
    out.sort(key=lambda t: (0 if t.is_default else 1, t.id))
    return out


def load_remote_engines() -> list[RemoteEngineRec]:
    """Return all Talend Remote Engine log sources declared in config.

    Reads the `remoteEngines` array from the shared config file. Returns
    [] when the field is missing, the file is absent, or it can't be
    parsed — callers are expected to fall back to env-var configuration.

    Each entry shape:
        {
          "id":            "engine-prod-us",        // required, used as fallback engine label
          "label":         "Prod US engine",        // optional, defaults to id
          "logDir":        "/var/log/talend/...",   // required
          "logGlob":       "*.log:*.json",          // optional, colon-separated
          "fromBeginning": false                    // optional, default false
        }
    """
    cfg = _load_raw()
    raw_list = cfg.get("remoteEngines") or []
    out: list[RemoteEngineRec] = []
    for raw in raw_list:
        eid = str(raw.get("id", "")).strip()
        log_dir = str(raw.get("logDir", "")).strip()
        if not eid or not log_dir:
            continue
        out.append(
            RemoteEngineRec(
                id=eid,
                label=raw.get("label") or eid,
                log_dir=log_dir,
                log_glob=raw.get("logGlob") or "*.log:*.json",
                from_beginning=bool(raw.get("fromBeginning") or False),
            )
        )
    return out


def iter_tenants_with_secret(items: Iterable[Any], secret_attr: str, log=None):
    """Yield only the tenants whose secret is present. Logs+skips the rest."""
    for t in items:
        if getattr(t, secret_attr, None):
            yield t
        elif log:
            log.warning(
                "skipping tenant — secret missing",
                tenant=t.id,
                storage=getattr(t, secret_attr + "_storage", "?"),
            )
