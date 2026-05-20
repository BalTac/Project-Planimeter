#!/usr/bin/env python3
"""Server locale per Project Planimeter con proxy WMS Agenzia Entrate."""

from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import logging
import math
import os
import pathlib
import platform
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import hashlib
import sqlite3
import threading
import urllib.parse
import urllib.request
import zipfile
import zlib
from collections.abc import Mapping
from html import unescape
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast

from PIL import Image


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
_log = logging.getLogger("planimeter")


UPSTREAM_WMS = "https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php"
UPSTREAM_MAX_SIZE = 2048

# Allowed WMS parameters forwarded upstream. Any key not in this set is stripped.
# Keys are compared case-insensitively (normalised to upper-case at parse time).
_WMS_ALLOWED_PARAMS: frozenset[str] = frozenset({
    "SERVICE", "REQUEST", "VERSION",
    "LAYERS", "QUERY_LAYERS", "STYLES",
    "FORMAT", "INFO_FORMAT",
    "TRANSPARENT", "BGCOLOR",
    "CRS", "SRS", "BBOX",
    "WIDTH", "HEIGHT",
    "I", "J", "X", "Y",
    "FEATURE_COUNT",
    "EXCEPTIONS",
})

# Rate limiter: max requests per window per client IP on proxy endpoints.
_RATE_LIMIT_WINDOW_S = 60
_RATE_LIMIT_MAX_REQ  = 120  # 2 req/s avg
_RATE_LIMIT_BONUS_PER_CONN_REQ = 30
_RATE_LIMIT_DYNAMIC_CAP_REQ = 600


class _RateLimiter:
    """Sliding-window rate limiter, thread-safe."""

    def __init__(
        self,
        window_s: float = _RATE_LIMIT_WINDOW_S,
        max_req: int = _RATE_LIMIT_MAX_REQ,
        per_conn_bonus_req: int = 0,
        max_dynamic_req: int | None = None,
    ) -> None:
        self._window = window_s
        self._max = max_req
        self._per_conn_bonus = max(0, int(per_conn_bonus_req))
        self._max_dynamic = max_req if max_dynamic_req is None else max(max_req, int(max_dynamic_req))
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _effective_limit(self, concurrent_requests: int | None) -> int:
        if concurrent_requests is None or concurrent_requests <= 1 or self._per_conn_bonus <= 0:
            return self._max
        computed = self._max + (concurrent_requests - 1) * self._per_conn_bonus
        return min(self._max_dynamic, computed)

    def is_allowed(self, client_ip: str, concurrent_requests: int | None = None) -> bool:
        now = time.monotonic()
        cutoff = now - self._window
        effective_limit = self._effective_limit(concurrent_requests)
        with self._lock:
            hits = self._hits.get(client_ip)
            if hits is None:
                self._hits[client_ip] = [now]
                return True
            # Prune old entries
            hits = [t for t in hits if t > cutoff]
            if len(hits) >= effective_limit:
                self._hits[client_ip] = hits
                return False
            hits.append(now)
            self._hits[client_ip] = hits
            return True


class _InFlightCounter:
    """Thread-safe counter for concurrent in-flight requests."""

    def __init__(self) -> None:
        self._value = 0
        self._lock = threading.Lock()

    def increment(self) -> int:
        with self._lock:
            self._value += 1
            return self._value

    def decrement(self) -> int:
        with self._lock:
            self._value = max(0, self._value - 1)
            return self._value

    def snapshot(self) -> int:
        with self._lock:
            return self._value


_rate_limiter = _RateLimiter(
    per_conn_bonus_req=_RATE_LIMIT_BONUS_PER_CONN_REQ,
    max_dynamic_req=_RATE_LIMIT_DYNAMIC_CAP_REQ,
)
_rate_limited_in_flight = _InFlightCounter()
HEALTHCHECK_QUERY = {
    "SERVICE": "WMS",
    "REQUEST": "GetCapabilities",
    "VERSION": "1.3.0",
}
HEALTHCHECK_TIMEOUT = 8
TRANSIENT_UPSTREAM_STATUS = {
    HTTPStatus.BAD_GATEWAY,
    HTTPStatus.SERVICE_UNAVAILABLE,
    HTTPStatus.GATEWAY_TIMEOUT,
}

DAILY_REQUEST_QUOTA_ESTIMATE = 3000


class DailyRequestQuotaCounter:
    """Local daily upstream-request counter with optional JSON persistence."""

    def __init__(self, store_path: pathlib.Path, daily_limit: int = DAILY_REQUEST_QUOTA_ESTIMATE) -> None:
        self._store_path = store_path
        self._daily_limit = max(1, int(daily_limit))
        self._lock = threading.Lock()
        self._state = {
            "day_key": self._today_key(),
            "total": 0,
            "by_request": {
                "GETMAP": 0,
                "GETFEATUREINFO": 0,
                "OTHER": 0,
            },
        }
        self._load()

    @staticmethod
    def _today_key() -> str:
        return time.strftime("%Y-%m-%d", time.localtime())

    def _ensure_current_day(self) -> None:
        today = self._today_key()
        if self._state.get("day_key") == today:
            return
        self._state = {
            "day_key": today,
            "total": 0,
            "by_request": {
                "GETMAP": 0,
                "GETFEATUREINFO": 0,
                "OTHER": 0,
            },
        }

    def _load(self) -> None:
        try:
            if not self._store_path.exists():
                return
            payload = json.loads(self._store_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return
            self._state["day_key"] = str(payload.get("day_key") or self._state["day_key"])
            self._state["total"] = max(0, int(payload.get("total") or 0))
            raw_by_request = payload.get("by_request")
            by_request = raw_by_request if isinstance(raw_by_request, dict) else {}
            for key in ("GETMAP", "GETFEATUREINFO", "OTHER"):
                raw_val = by_request.get(key, 0)
                if not isinstance(raw_val, (int, float, str)):
                    raw_val = 0
                self._state["by_request"][key] = max(0, int(raw_val or 0))
            self._ensure_current_day()
        except Exception:
            # Keep runtime robust even if persisted state is corrupted.
            self._ensure_current_day()

    def _save(self) -> None:
        try:
            self._store_path.parent.mkdir(parents=True, exist_ok=True)
            self._store_path.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            # Persistence failures must never break request handling.
            return

    def increment_from_url(self, url: str) -> None:
        request_name = "OTHER"
        try:
            parsed = urllib.parse.urlparse(url)
            qs = urllib.parse.parse_qs(parsed.query)
            request_name = str((qs.get("REQUEST") or [""])[0]).strip().upper() or "OTHER"
            if request_name not in {"GETMAP", "GETFEATUREINFO"}:
                request_name = "OTHER"
        except Exception:
            request_name = "OTHER"

        with self._lock:
            self._ensure_current_day()
            self._state["total"] = int(self._state.get("total") or 0) + 1
            by_request = self._state.get("by_request") or {}
            by_request[request_name] = int(by_request.get(request_name) or 0) + 1
            self._state["by_request"] = by_request
            self._save()

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            self._ensure_current_day()
            used = int(self._state.get("total") or 0)
            remaining = max(0, self._daily_limit - used)
            return {
                "day": self._state.get("day_key"),
                "limit": self._daily_limit,
                "used": used,
                "remaining_estimate": remaining,
                "ratio": round((used / self._daily_limit), 6),
                "by_request": dict(self._state.get("by_request") or {}),
                "is_estimate": True,
            }


_daily_quota_counter = DailyRequestQuotaCounter(pathlib.Path(".planimeter_request_quota.json"))
_local_state_store_path = pathlib.Path(".planimeter_state_store.json")
_local_state_store_lock = threading.Lock()


TILE_CACHE_TTL_DAYS_DEFAULT = 30
TILE_CACHE_MAX_MB_DEFAULT = 500
MIN_CACHE_TTL_DAYS = 1
MAX_CACHE_TTL_DAYS = 365
MIN_CACHE_SIZE_MB = 32
MAX_CACHE_SIZE_MB = 4096


class TileCache:
    """Thread-safe SQLite tile cache for WMS GetMap responses."""

    def __init__(
        self,
        cache_dir: pathlib.Path,
        ttl_days: int = TILE_CACHE_TTL_DAYS_DEFAULT,
        max_size_mb: int = TILE_CACHE_MAX_MB_DEFAULT,
    ) -> None:
        self._ttl = ttl_days * 86400
        self._max_size_bytes = max_size_mb * 1024 * 1024
        cache_dir.mkdir(parents=True, exist_ok=True)
        self._db_path = str(cache_dir / "tiles.db")
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS tiles "
                "(key TEXT PRIMARY KEY, ctype TEXT NOT NULL, data BLOB NOT NULL, ts REAL NOT NULL)"
            )
            conn.execute("PRAGMA journal_mode=WAL")

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._db_path)

    def get(self, key: str) -> tuple[str, bytes] | None:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT ctype, data, ts FROM tiles WHERE key = ?", (key,)
                ).fetchone()
        if row is None:
            return None
        ctype, data, ts = row
        if time.time() - ts > self._ttl:
            with self._lock:
                with self._connect() as conn:
                    conn.execute("DELETE FROM tiles WHERE key = ?", (key,))
            return None
        return ctype, bytes(data)

    def put(self, key: str, ctype: str, data: bytes) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO tiles (key, ctype, data, ts) VALUES (?, ?, ?, ?)",
                    (key, ctype, sqlite3.Binary(data), time.time()),
                )
                self._enforce_size_limit(conn)

    def set_config(self, ttl_days: int, max_size_mb: int) -> None:
        with self._lock:
            self._ttl = max(ttl_days, 1) * 86400
            self._max_size_bytes = max(max_size_mb, 1) * 1024 * 1024
            with self._connect() as conn:
                self._enforce_size_limit(conn)

    def get_config(self) -> dict[str, int]:
        return {
            "ttl_days": max(1, int(round(self._ttl / 86400))),
            "max_size_mb": max(1, int(round(self._max_size_bytes / (1024 * 1024)))),
        }

    def _enforce_size_limit(self, conn: sqlite3.Connection) -> None:
        row = conn.execute("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM tiles").fetchone()
        total_size = int(row[0] or 0)
        if total_size <= self._max_size_bytes:
            return

        # Eviction policy: oldest-first by insertion/update timestamp.
        for key, blob_size in conn.execute("SELECT key, LENGTH(data) FROM tiles ORDER BY ts ASC"):
            conn.execute("DELETE FROM tiles WHERE key = ?", (key,))
            total_size -= int(blob_size or 0)
            if total_size <= self._max_size_bytes:
                break

    def clear_all(self) -> int:
        with self._lock:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM tiles")
                return cur.rowcount

    def stats(self) -> dict[str, int]:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT COUNT(*), SUM(LENGTH(data)) FROM tiles").fetchone()
        return {"count": row[0] or 0, "size_bytes": row[1] or 0}


class UpstreamHTTPError(Exception):
    def __init__(self, status_code: int, headers, body: bytes):
        super().__init__(f"Upstream HTTP {status_code}")
        self.status_code = status_code
        self.headers = headers
        self.body = body


class PlanimeterHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    # ------------------------------------------------------------------
    # Security helpers
    # ------------------------------------------------------------------

    @contextlib.contextmanager
    def _rate_limited_scope(self):
        _rate_limited_in_flight.increment()
        try:
            yield
        finally:
            _rate_limited_in_flight.decrement()

    @staticmethod
    def _is_localhost(ip: str) -> bool:
        return ip in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

    def _check_rate_limit(self) -> bool:
        """Return True if request is allowed; send 429 and return False otherwise."""
        client_ip = self.client_address[0]
        if self._is_localhost(client_ip):
            return True
        concurrent_requests = max(1, _rate_limited_in_flight.snapshot())
        if _rate_limiter.is_allowed(client_ip, concurrent_requests=concurrent_requests):
            return True
        _log.warning(
            "rate-limit client=%s path=%s in_flight=%d",
            client_ip,
            self.path,
            concurrent_requests,
        )
        self.send_response(HTTPStatus.TOO_MANY_REQUESTS)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Retry-After", str(int(_RATE_LIMIT_WINDOW_S)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"Rate limit exceeded")
        return False

    @staticmethod
    def _filter_wms_params(query: dict[str, list[str]]) -> None:
        """Remove keys not in the WMS allowlist (in-place). Keys already uppercased."""
        to_remove = [k for k in query if k not in _WMS_ALLOWED_PARAMS]
        for k in to_remove:
            _log.debug("wms-allowlist stripped param=%s", k)
            del query[k]

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        if (self.path.startswith("/wms-proxy") or self.path.startswith("/wms-tile")
            or self.path.startswith("/cache-clear") or self.path.startswith("/cache-config")
            or self.path.startswith("/export-geotiff") or self.path.startswith("/export-pgw")
            or self.path.startswith("/export-bundle") or self.path.startswith("/parcel-at-point")
            or self.path.startswith("/local-state-load") or self.path.startswith("/local-state-save")):
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in {"/proxy-health", "/proxy-health/"}:
            self.handle_proxy_health()
            return
        if parsed.path in {"/request-quota-status", "/request-quota-status/"}:
            self.handle_request_quota_status()
            return
        if parsed.path in {"/wms-proxy", "/wms-proxy/"}:
            with self._rate_limited_scope():
                self.handle_wms_proxy(parsed.query)
            return
        if parsed.path in {"/wms-tile", "/wms-tile/"}:
            with self._rate_limited_scope():
                self.handle_wms_tile(parsed.query)
            return
        if parsed.path in {"/cache-stats", "/cache-stats/"}:
            self.handle_cache_stats()
            return
        if parsed.path in {"/cache-config", "/cache-config/"}:
            self.handle_cache_config_get()
            return
        if parsed.path in {"/local-state-load", "/local-state-load/"}:
            self.handle_local_state_load()
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in {"/cache-clear", "/cache-clear/"}:
            self.handle_cache_clear()
            return
        if parsed.path in {"/cache-config", "/cache-config/"}:
            self.handle_cache_config_update()
            return
        if parsed.path in {"/local-state-save", "/local-state-save/"}:
            self.handle_local_state_save()
            return
        if parsed.path in {"/export-geotiff", "/export-geotiff/"}:
            self.handle_export_geotiff()
            return
        if parsed.path in {"/export-pgw", "/export-pgw/"}:
            self.handle_export_pgw()
            return
        if parsed.path in {"/export-bundle", "/export-bundle/"}:
            self.handle_export_bundle()
            return
        if parsed.path in {"/parcel-at-point", "/parcel-at-point/"}:
            with self._rate_limited_scope():
                self.handle_parcel_at_point()
            return
        if parsed.path in {"/parcel-geometry-m3", "/parcel-geometry-m3/"}:
            with self._rate_limited_scope():
                self.handle_parcel_geometry_m3()
            return
        if parsed.path in {"/parcel-geometry-m3-refine", "/parcel-geometry-m3-refine/"}:
            with self._rate_limited_scope():
                self.handle_parcel_geometry_m3_refine()
            return
        if parsed.path in {"/parcel-geometry-m3-trace", "/parcel-geometry-m3-trace/"}:
            with self._rate_limited_scope():
                self.handle_parcel_geometry_m3_trace()
            return
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.end_headers()

    def send_json(self, status: HTTPStatus, payload: Mapping[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def get_upstream_timeout(self) -> float:
        return float(getattr(self.server, "upstream_timeout", 20.0))

    def get_upstream_retries(self) -> int:
        return int(getattr(self.server, "upstream_retries", 1))

    def fetch_upstream(self, req: urllib.request.Request, timeout: float, retries: int):
        for attempt in range(retries + 1):
            try:
                _daily_quota_counter.increment_from_url(req.full_url)
                response = urllib.request.urlopen(req, timeout=timeout)
                return response
            except urllib.error.HTTPError as exc:
                body = exc.read()
                should_retry = exc.code in TRANSIENT_UPSTREAM_STATUS and attempt < retries
                if should_retry:
                    time.sleep(0.35)
                    continue
                raise UpstreamHTTPError(exc.code, exc.headers, body) from exc
            except urllib.error.URLError:
                if attempt < retries:
                    time.sleep(0.35)
                    continue
                raise
        raise RuntimeError("fetch_upstream exhausted retries unexpectedly")

    def handle_parcel_at_point(self) -> None:
        """POST /parcel-at-point — coordinate-based cadastral parcel lookup.

        Input JSON: {"lat": float, "lon": float, "buffer": optional float (degrees)}
        Returns canonical parcel fields without exposing WMS internals.
        """
        if not self._check_rate_limit():
            return

        body = self._read_json_payload()
        if body is None:
            return

        lat = body.get("lat")
        lon = body.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon numerici richiesti."})
            return
        lat, lon = float(lat), float(lon)
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon fuori range."})
            return

        # Build a tiny bounding box around the point in EPSG:4326.
        buf_raw = body.get("buffer", 0.0001)
        buf = float(buf_raw) if isinstance(buf_raw, (int, float)) else 0.0001
        buf = max(1e-6, min(buf, 1.0))  # clamp to sensible range
        include_geometry_raw = body.get("includeGeometry", False)
        include_geometry = (
            include_geometry_raw is True
            or (isinstance(include_geometry_raw, (int, float)) and include_geometry_raw != 0)
            or (isinstance(include_geometry_raw, str) and include_geometry_raw.strip().lower() in {"1", "true", "yes", "on"})
        )

        # WMS 1.3.0 + EPSG:4326: axis order is latitude/longitude (Y/X), so BBOX = lat_min,lon_min,lat_max,lon_max
        bbox_4326 = f"{lat - buf},{lon - buf},{lat + buf},{lon + buf}"
        width, height = 101, 101   # odd -> center pixel = (50, 50) = I=50, J=50

        query: dict[str, list[str]] = {
            "SERVICE":      ["WMS"],
            "REQUEST":      ["GetFeatureInfo"],
            "VERSION":      ["1.3.0"],
            "LAYERS":       ["CP.CadastralParcel"],
            "QUERY_LAYERS": ["CP.CadastralParcel"],
            "STYLES":       [""],
            "CRS":          ["EPSG:4326"],
            "BBOX":         [bbox_4326],
            "WIDTH":        [str(width)],
            "HEIGHT":       [str(height)],
            "I":            [str(width // 2)],
            "J":            [str(height // 2)],
            "INFO_FORMAT":  ["text/html"],
            "FEATURE_COUNT": ["1"],
            "TRANSPARENT":  ["true"],
            "FORMAT":       ["image/png"],
        }

        self._normalize_wms_query(query)
        self._filter_wms_params(query)
        upstream_qs = urllib.parse.urlencode(query, doseq=True)
        upstream_url = f"{UPSTREAM_WMS}?language=ita&{upstream_qs}"

        req = urllib.request.Request(
            upstream_url,
            headers={
                "User-Agent": "Planimeter-Local-Proxy/1.0",
                "Accept": "text/html,text/*;q=0.9,*/*;q=0.2",
            },
        )

        started_at = time.perf_counter()
        try:
            with self.fetch_upstream(req, timeout=self.get_upstream_timeout(),
                                     retries=self.get_upstream_retries()) as response:
                payload = response.read()
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)

                if self._looks_like_wms_xml_exception(payload, response.headers.get("Content-Type", "")):
                    _log.warning("parcel-at-point WMS exception lat=%s lon=%s", lat, lon)
                    self.send_json(HTTPStatus.BAD_GATEWAY, {
                        "ok": False, "message": "WMS ServiceException.", "durationMs": elapsed_ms,
                    })
                    return

                raw_fields = self._extract_featureinfo_fields_from_html(payload)
                if not raw_fields:
                    _log.info("parcel-at-point empty lat=%s lon=%s %dms", lat, lon, elapsed_ms)
                    self.send_json(HTTPStatus.OK, {
                        "type": "ParcelLookup",
                        "point": [lat, lon],
                        "parcel": None,
                        "source": "wms",
                        "durationMs": elapsed_ms,
                    })
                    return

                canonical = self._to_canonical_parcel_fields(raw_fields)
                parcel_geometry = None
                parcel_geometry_crs = None
                if include_geometry:
                    parcel_geometry, parcel_geometry_crs = self._fetch_parcel_geometry_at_point(lat, lon, buf, canonical)
                _log.info("parcel-at-point OK lat=%s lon=%s fields=%s %dms",
                          lat, lon, list(canonical.keys()), elapsed_ms)
                response_obj: dict[str, object] = {
                    "type": "ParcelLookup",
                    "point": [lat, lon],
                    "parcel": canonical,
                    "raw": raw_fields,
                    "source": "wms",
                    "durationMs": elapsed_ms,
                }
                if parcel_geometry:
                    response_obj["parcelGeometry"] = parcel_geometry
                    response_obj["parcelGeometryCrs"] = parcel_geometry_crs or "EPSG:4326"
                self.send_json(HTTPStatus.OK, response_obj)

        except UpstreamHTTPError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self.send_json(HTTPStatus.BAD_GATEWAY, {
                "ok": False, "message": f"Upstream HTTP {exc.status_code}.", "durationMs": elapsed_ms,
            })
        except urllib.error.URLError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self.send_json(HTTPStatus.BAD_GATEWAY, {
                "ok": False, "message": f"Errore rete upstream: {exc.reason}", "durationMs": elapsed_ms,
            })

    def handle_request_quota_status(self) -> None:
        snapshot = _daily_quota_counter.snapshot()
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "type": "RequestQuotaStatus",
            **snapshot,
            "message": "Local estimated usage counter. Upstream remaining quota is not exposed by WMS.",
        })

    def handle_parcel_geometry_m3(self) -> None:
        """POST /parcel-geometry-m3 — M3 raster segmentation to detect parcel boundaries.

        Input JSON: {"lat": float, "lon": float, "radius": optional int}
        Returns: {"ok": true, "ring": [[lon, lat], ...], "debug": {...}} or error

        Detects cadastral parcel boundaries by:
        1. Fetching a mosaic of WMS tiles around the coordinate
        2. Masking out red logo pixels
        3. Detecting black borders (cadastral boundaries)
        4. Flood-filling from center to extract the region containing the point
        5. Converting boundary to lon/lat ring
        """
        if not self._check_rate_limit():
            return

        body = self._read_json_payload()
        if body is None:
            return

        lat = body.get("lat")
        lon = body.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon numerici richiesti."})
            return
        lat, lon = float(lat), float(lon)
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon fuori range."})
            return

        radius = body.get("radius", 2)
        radius = max(0, int(radius)) if isinstance(radius, (int, float)) else 2
        radius = min(radius, 5)  # clamp to 5 to avoid excessive tile fetching

        started_at = time.perf_counter()
        try:
            ring, debug_info = self._m3_detect_parcel_boundary(lon, lat, radius)
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            
            if ring is None:
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": f"Impossibile rilevare particella: {debug_info.get('reason', 'unknown')}",
                    "debug": debug_info,
                    "durationMs": elapsed_ms,
                })
                return

            self.send_json(HTTPStatus.OK, {
                "ok": True,
                "ring": ring,
                "debug": debug_info,
                "durationMs": elapsed_ms,
            })
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("parcel-geometry-m3 failed: %s", exc, exc_info=True)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "ok": False,
                "message": f"Errore interno nel rilevamento M3: {str(exc)[:100]}",
                "durationMs": elapsed_ms,
            })

    def _m3_detect_parcel_boundary(self, lon: float, lat: float, radius: int) -> tuple[list[list[float]] | None, dict[str, object]]:
        """Execute M3 raster segmentation to extract parcel boundary.
        
        Returns: (ring, debug_dict) where ring is [[lon, lat], ...] or None if detection failed
        """
        # Try to import required libraries; gracefully degrade if unavailable
        try:
            import cv2
            import numpy as np
        except ImportError as e:
            return None, {"reason": "missing_dependencies", "detail": str(e)}

        tile_half = 0.00030
        tile_px = 420

        def fetch_tile(center_lon: float, center_lat: float) -> Image.Image | None:
            """Fetch a single WMS tile centered at the given coordinates."""
            lon_min_t = center_lon - tile_half
            lat_min_t = center_lat - tile_half
            lon_max_t = center_lon + tile_half
            lat_max_t = center_lat + tile_half
            
            qs = urllib.parse.urlencode({
                "SERVICE": "WMS",
                "REQUEST": "GetMap",
                "VERSION": "1.3.0",
                "LAYERS": "CP.CadastralParcel",
                "STYLES": "",
                "CRS": "EPSG:6706",
                "BBOX": f"{lat_min_t},{lon_min_t},{lat_max_t},{lon_max_t}",
                "WIDTH": str(tile_px),
                "HEIGHT": str(tile_px),
                "FORMAT": "image/png",
                "TRANSPARENT": "true",
            })
            upstream_url = f"{UPSTREAM_WMS}?language=ita&{qs}"
            req = urllib.request.Request(
                upstream_url,
                headers={
                    "User-Agent": "Planimeter-Local-Proxy/1.0",
                    "Accept": "image/png,image/*;q=0.9,*/*;q=0.8",
                },
            )
            try:
                timeout = self.get_upstream_timeout()
                retries = self.get_upstream_retries()
                with self.fetch_upstream(req, timeout=timeout, retries=retries) as response:
                    png_data = response.read()
                    return Image.open(io.BytesIO(png_data)).convert("RGBA")
            except Exception:
                return None

        def build_mosaic(radius: int) -> Image.Image | None:
            """Fetch and assemble a grid of tiles into a mosaic."""
            side = (2 * radius + 1) * tile_px
            mosaic = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            span_deg = tile_half * 2.0

            for gy in range(radius, -radius - 1, -1):
                for gx in range(-radius, radius + 1):
                    lon_t = lon + gx * span_deg
                    lat_t = lat + gy * span_deg
                    tile = fetch_tile(lon_t, lat_t)
                    if tile is None:
                        tile = Image.new("RGBA", (tile_px, tile_px), (0, 0, 0, 0))
                    
                    px_x = (gx + radius) * tile_px
                    px_y = (radius - gy) * tile_px
                    mosaic.paste(tile, (px_x, px_y))
            
            return mosaic

        def detect_on_image(img: Image.Image, radius: int) -> tuple[list[list[float]] | None, dict[str, object]]:
            """Detect parcel boundary using flood-fill on raster edges."""
            img_cv = np.array(img.convert("RGB"))
            img_cv = cv2.cvtColor(img_cv, cv2.COLOR_RGB2BGR)
            
            # Mask red logo pixels (Agenzia Entrate branding)
            lower_red = np.array([0, 0, 150])    # BGR
            upper_red = np.array([100, 100, 255])
            red_mask = cv2.inRange(img_cv, lower_red, upper_red)
            background_color = np.array([189, 236, 253], dtype=np.uint8)
            img_cv[red_mask > 0] = background_color
            
            # Edge detection: find black borders (cadastral boundaries)
            gray = cv2.cvtColor(img_cv, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray, threshold1=50, threshold2=120)
            filled_area = cv2.bitwise_not(edges)
            
            # Flood-fill from center
            w, h = img.size
            cx, cy = w // 2, h // 2
            
            # Find center seed point (not on border)
            if filled_area[cy, cx] == 0:
                found = False
                for r_search in range(1, 20):
                    for dy in range(-r_search, r_search + 1):
                        for dx in range(-r_search, r_search + 1):
                            x, y = cx + dx, cy + dy
                            if 0 <= x < w and 0 <= y < h and filled_area[y, x] > 0:
                                cx, cy = x, y
                                found = True
                                break
                        if found:
                            break
                    if found:
                        break
            
            if filled_area[cy, cx] == 0:
                return None, {"reason": "center_on_border"}
            
            # Create mask via flood-fill
            mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
            cv2.floodFill(filled_area, mask, (cx, cy), (255,))
            region_mask = mask[1:-1, 1:-1]
            region_area_px = np.count_nonzero(region_mask)
            
            if region_area_px < 20:
                return None, {"reason": "region_too_small", "region_px": int(region_area_px)}

            # Expand by a few pixels so the extracted contour includes the outer cadastral black border
            # instead of staying strictly inside the fill region.
            border_kernel = np.ones((3, 3), dtype=np.uint8)
            expanded_region_mask = cv2.dilate(region_mask, border_kernel, iterations=2)
            
            # Extract contour
            contours, _ = cv2.findContours(expanded_region_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                return None, {"reason": "no_contours"}
            
            region_contour = max(contours, key=cv2.contourArea)
            epsilon = 0.005 * cv2.arcLength(region_contour, True)
            approx = cv2.approxPolyDP(region_contour, epsilon, True)
            boundary_px = [(pt[0][0], pt[0][1]) for pt in approx]
            
            if len(boundary_px) < 3:
                return None, {"reason": "too_few_vertices"}
            
            # Convert pixels to lon/lat
            total_half = tile_half * (2 * radius + 1)
            lon_min = lon - total_half
            lat_min = lat - total_half
            lon_max = lon + total_half
            lat_max = lat + total_half

            ownership_payload = self._pack_binary_mask(expanded_region_mask)
            mask_transform = {
                "lon_min": float(lon_min),
                "lat_min": float(lat_min),
                "lon_max": float(lon_max),
                "lat_max": float(lat_max),
                "width": int(w),
                "height": int(h),
            }
            
            def px_to_lonlat(x: int, y: int) -> list[float]:
                lon_v = lon_min + (x / (w - 1)) * (lon_max - lon_min)
                lat_v = lat_max - (y / (h - 1)) * (lat_max - lat_min)
                return [lon_v, lat_v]
            
            ring = [px_to_lonlat(x, y) for x, y in boundary_px]
            
            # Close ring if not already closed
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
            
            if len(ring) < 4:  # at least 3 unique vertices + closure
                return None, {"reason": "ring_too_small"}
            
            touches_border = any((x <= 2 or x >= w - 2 or y <= 2 or y >= h - 2) for x, y in boundary_px)
            
            return ring, {
                "region_area_px": int(region_area_px),
                "contour_vertices": len(approx),
                "touches_border": touches_border,
                "radius": radius,
                "mosaic_tiles": (2 * radius + 1) ** 2,
                "seed_cx": cx,
                "seed_cy": cy,
                "ownershipMask": ownership_payload,
                "maskTransform": mask_transform,
                "maskBounds": {
                    "lon_min": float(lon_min),
                    "lat_min": float(lat_min),
                    "lon_max": float(lon_max),
                    "lat_max": float(lat_max),
                },
            }

        # Single-shot detection at the exact requested radius.
        # Progressive expansion is orchestrated by the frontend with explicit user confirmations.
        mosaic = build_mosaic(radius)
        if mosaic is None:
            return None, {"reason": "mosaic_build_failed", "radius": radius, "radii_tried": [radius]}

        ring, debug = detect_on_image(mosaic, radius)
        if ring is not None:
            return ring, debug

        # Detection failed at this specific radius.
        debug = dict(debug)
        debug.setdefault("radius", radius)
        debug.setdefault("radii_tried", [radius])
        return None, debug

    @staticmethod
    def _pack_binary_mask(mask: Any) -> dict[str, object] | None:
        """Compress a binary mask for lightweight transport in debug payloads."""
        try:
            import numpy as np

            arr = np.asarray(mask)
            if arr.ndim != 2 or arr.size == 0:
                return None
            mask_u8 = (arr > 0).astype(np.uint8)
            height, width = mask_u8.shape
            packed = np.packbits(mask_u8.reshape(-1), bitorder="little").tobytes()
            compressed = zlib.compress(packed, level=6)
            payload = base64.b64encode(compressed).decode("ascii")
            return {
                "encoding": "packbits-zlib-base64",
                "width": int(width),
                "height": int(height),
                "payload": payload,
            }
        except Exception:
            return None

    @staticmethod
    def _unpack_binary_mask(blob: object):
        try:
            import numpy as np

            if not isinstance(blob, dict):
                return None
            if str(blob.get("encoding") or "") != "packbits-zlib-base64":
                return None
            width = int(blob.get("width") or 0)
            height = int(blob.get("height") or 0)
            payload = blob.get("payload")
            if width <= 0 or height <= 0 or not isinstance(payload, str):
                return None
            raw = zlib.decompress(base64.b64decode(payload.encode("ascii")))
            packed = np.frombuffer(raw, dtype=np.uint8)
            bits = np.unpackbits(packed, bitorder="little")
            needed = width * height
            if bits.size < needed:
                return None
            mask_u8 = bits[:needed].reshape((height, width)).astype(np.uint8)
            return mask_u8
        except Exception:
            return None

    @staticmethod
    def _sample_ownership(mask: Any, px: int, py: int) -> bool:
        """Bounds-safe nearest-neighbor ownership sampling."""
        h, w = mask.shape[:2]
        if px < 0 or py < 0 or px >= w or py >= h:
            return False
        return bool(mask[py, px] > 0)

    @staticmethod
    def _point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
        if len(ring) < 4:
            return False
        inside = False
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            cond = (y1 > lat) != (y2 > lat)
            if not cond:
                continue
            xinters = (x2 - x1) * (lat - y1) / max(1e-12, (y2 - y1)) + x1
            if lon < xinters:
                inside = not inside
        return inside

    @staticmethod
    def _signed_ring_area(ring: list[list[float]]) -> float:
        if len(ring) < 4:
            return 0.0
        acc = 0.0
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            acc += (x1 * y2) - (x2 * y1)
        return 0.5 * acc

    @staticmethod
    def _ring_centroid_xy(points: list[tuple[float, float]]) -> tuple[float, float]:
        if not points:
            return (0.0, 0.0)

        acc_x = 0.0
        acc_y = 0.0
        for x, y in points:
            acc_x += x
            acc_y += y

        inv = 1.0 / max(1, len(points))
        return (acc_x * inv, acc_y * inv)

    @staticmethod
    def _ring_mean_lat(ring: list[list[float]]) -> float:
        vals = [float(pt[1]) for pt in ring if isinstance(pt, list) and len(pt) >= 2]
        if not vals:
            return 0.0
        return sum(vals) / len(vals)

    @staticmethod
    def _meters_per_deg(mean_lat: float) -> tuple[float, float]:
        meters_per_deg_lon = 111320.0 * math.cos(math.radians(mean_lat))
        meters_per_deg_lat = 110540.0
        return meters_per_deg_lon, meters_per_deg_lat

    @staticmethod
    def _normalize_ring_lonlat(ring: list[list[float]]) -> list[list[float]]:
        pts = [
            [float(pt[0]), float(pt[1])]
            for pt in ring
            if isinstance(pt, list) and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float))
        ]
        if len(pts) < 3:
            return pts
        if pts[0] != pts[-1]:
            pts.append([pts[0][0], pts[0][1]])
        return pts

    def _densify_ring_by_spacing_m(self, ring: list[list[float]], spacing_m: float) -> list[list[float]]:
        ring = self._normalize_ring_lonlat(ring)
        if len(ring) < 4:
            return ring
        mean_lat = self._ring_mean_lat(ring)
        meters_per_deg_lon, meters_per_deg_lat = self._meters_per_deg(mean_lat)
        out: list[list[float]] = []

        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            dx_m = (x2 - x1) * meters_per_deg_lon
            dy_m = (y2 - y1) * meters_per_deg_lat
            seg_m = max(0.0, math.hypot(dx_m, dy_m))
            steps = max(1, int(math.ceil(seg_m / max(0.25, spacing_m))))
            if i == 0:
                out.append([x1, y1])
            for s in range(1, steps + 1):
                t = s / steps
                out.append([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t])

        if out and out[0] != out[-1]:
            out.append([out[0][0], out[0][1]])
        return out

    def _ring_area_m2(self, ring: list[list[float]]) -> float:
        ring = self._normalize_ring_lonlat(ring)
        if len(ring) < 4:
            return 0.0
        mean_lat = self._ring_mean_lat(ring)
        meters_per_deg_lon, meters_per_deg_lat = self._meters_per_deg(mean_lat)
        acc = 0.0
        for i in range(len(ring) - 1):
            lon1, lat1 = ring[i]
            lon2, lat2 = ring[i + 1]
            x1 = lon1 * meters_per_deg_lon
            y1 = lat1 * meters_per_deg_lat
            x2 = lon2 * meters_per_deg_lon
            y2 = lat2 * meters_per_deg_lat
            acc += (x1 * y2) - (x2 * y1)
        return abs(acc) * 0.5

    def _rdp_ring(self, ring: list[list[float]], epsilon_m: float) -> list[list[float]]:
        ring = self._normalize_ring_lonlat(ring)
        if len(ring) < 5:
            return ring

        mean_lat = self._ring_mean_lat(ring)
        meters_per_deg_lon, meters_per_deg_lat = self._meters_per_deg(mean_lat)
        pts = [(p[0] * meters_per_deg_lon, p[1] * meters_per_deg_lat) for p in ring[:-1]]

        def point_line_distance(p, a, b):
            if a == b:
                return math.hypot(p[0] - a[0], p[1] - a[1])
            num = abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0])
            den = math.hypot(b[1] - a[1], b[0] - a[0])
            return num / max(1e-9, den)

        def rdp(points):
            if len(points) < 3:
                return points
            first = points[0]
            last = points[-1]
            max_d = -1.0
            idx = -1
            for i in range(1, len(points) - 1):
                d = point_line_distance(points[i], first, last)
                if d > max_d:
                    max_d = d
                    idx = i
            if max_d > epsilon_m and idx > 0:
                left = rdp(points[: idx + 1])
                right = rdp(points[idx:])
                return left[:-1] + right
            return [first, last]

        simplified = rdp(pts)
        out = [[p[0] / meters_per_deg_lon, p[1] / meters_per_deg_lat] for p in simplified]
        if out and out[0] != out[-1]:
            out.append([out[0][0], out[0][1]])
        return out

    def _consolidate_corners(
        self,
        ring: list[list[float]],
        angle_threshold_deg: float = 18.0,
        min_run_length: int = 2,
        max_corner_jump_m: float = 6.0,
    ) -> tuple[list[list[float]], dict[str, object]]:
        """Polygonalize a dense (refined) ring by fitting lines to straight runs of vertices,
        then computing corners as the geometric intersection of adjacent fitted lines.

        This fixes the systematic "corner offset" problem of pure edge-attraction snap:
        densified vertices can only move along their own normal, so they never reach the
        apex of a corner (which sits at the intersection of two edges). Here we recover
        the true corner by extending the two adjacent edges until they meet.

        Returns (consolidated_ring, debug_info).
        """
        ring = self._normalize_ring_lonlat(ring)
        if len(ring) < 6:
            return ring, {"applied": False, "reason": "ring too short"}

        mean_lat = self._ring_mean_lat(ring)
        meters_per_deg_lon, meters_per_deg_lat = self._meters_per_deg(mean_lat)

        # Open ring (no duplicate closing vertex) in local metric coords.
        pts_ll = ring[:-1]
        n = len(pts_ll)
        xy = [(p[0] * meters_per_deg_lon, p[1] * meters_per_deg_lat) for p in pts_ll]

        # Edge direction angles (degrees), modulo 180 (lines are undirected).
        def edge_angle(i: int) -> float:
            x1, y1 = xy[i]
            x2, y2 = xy[(i + 1) % n]
            ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
            # normalize to [0, 180)
            if ang < 0:
                ang += 180.0
            if ang >= 180.0:
                ang -= 180.0
            return ang

        def angle_diff(a: float, b: float) -> float:
            d = abs(a - b) % 180.0
            return min(d, 180.0 - d)

        angles = [edge_angle(i) for i in range(n)]

        # Find break points: edge i and i+1 form a "corner" if their angle diff > threshold.
        breaks: list[int] = []  # indices i where a corner sits between edge i-1 and edge i
        for i in range(n):
            if angle_diff(angles[i], angles[(i - 1) % n]) > angle_threshold_deg:
                breaks.append(i)

        if len(breaks) < 3:
            return ring, {"applied": False, "reason": f"only {len(breaks)} breaks detected"}

        # Each run = the consecutive edges between two breaks. We use VERTICES of those
        # edges (including both endpoints) to fit the line.
        runs: list[list[int]] = []  # each run is a list of vertex indices
        for k in range(len(breaks)):
            start = breaks[k]
            end = breaks[(k + 1) % len(breaks)]
            # vertices from `start` up to and including `end` (the corner vertex of next run too)
            indices: list[int] = []
            i = start
            while True:
                indices.append(i)
                if i == end:
                    break
                i = (i + 1) % n
                if len(indices) > n + 2:  # safety
                    break
            runs.append(indices)

        # Drop runs that are too short (likely noise). Merge them into neighbor.
        # Simpler: skip if a run has < min_run_length+1 vertices => fall back.
        filtered: list[list[int]] = []
        for run in runs:
            if len(run) >= min_run_length + 1:
                filtered.append(run)
        if len(filtered) < 3:
            return ring, {"applied": False, "reason": "too few significant runs after filtering"}
        runs = filtered

        # PCA line fit per run: return (point_on_line, unit_direction).
        def fit_line(indices: list[int]) -> tuple[tuple[float, float], tuple[float, float]]:
            xs = [xy[i][0] for i in indices]
            ys = [xy[i][1] for i in indices]
            mx = sum(xs) / len(xs)
            my = sum(ys) / len(ys)
            sxx = sum((x - mx) ** 2 for x in xs)
            syy = sum((y - my) ** 2 for y in ys)
            sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            # principal axis angle of 2x2 covariance
            theta = 0.5 * math.atan2(2.0 * sxy, sxx - syy)
            return (mx, my), (math.cos(theta), math.sin(theta))

        lines = [fit_line(run) for run in runs]

        # Intersect consecutive line pairs to get corner positions.
        corners_xy: list[tuple[float, float]] = []
        intersection_failures = 0
        for k in range(len(lines)):
            (p1, d1) = lines[k]
            (p2, d2) = lines[(k + 1) % len(lines)]
            # Solve: p1 + t*d1 = p2 + s*d2  =>  [d1, -d2] [t,s]^T = p2 - p1
            denom = d1[0] * (-d2[1]) - d1[1] * (-d2[0])
            if abs(denom) < 1e-9:
                # parallel lines: fallback = midpoint of the natural break vertex
                break_idx = runs[(k + 1) % len(runs)][0]
                corners_xy.append(xy[break_idx])
                intersection_failures += 1
                continue
            rhs_x = p2[0] - p1[0]
            rhs_y = p2[1] - p1[1]
            t = (rhs_x * (-d2[1]) - rhs_y * (-d2[0])) / denom
            cx = p1[0] + t * d1[0]
            cy = p1[1] + t * d1[1]

            # Safety clamp: if intersection is absurdly far from the natural break vertex,
            # something is wrong (near-parallel lines or weird fit). Fall back to that vertex.
            break_idx = runs[(k + 1) % len(runs)][0]
            bx, by = xy[break_idx]
            if math.hypot(cx - bx, cy - by) > max_corner_jump_m:
                corners_xy.append((bx, by))
                intersection_failures += 1
            else:
                corners_xy.append((cx, cy))

        # Convert back to lon/lat, close ring.
        out: list[list[float]] = [
            [x / meters_per_deg_lon, y / meters_per_deg_lat] for x, y in corners_xy
        ]
        if out and out[0] != out[-1]:
            out.append([out[0][0], out[0][1]])

        return out, {
            "applied": True,
            "breaks": len(breaks),
            "runs": len(runs),
            "corners": len(corners_xy),
            "intersectionFailures": intersection_failures,
            "angleThresholdDeg": angle_threshold_deg,
            "minRunLength": min_run_length,
            "maxCornerJumpM": max_corner_jump_m,
        }

    def _sample_interior_parcel_id(self, lon: float, lat: float, centroid_lon: float, centroid_lat: float) -> str | None:
        """Sample interior of point towards centroid to verify parcel ownership."""
        offset_m = 1.5
        mean_lat = (lat + centroid_lat) / 2.0
        meters_per_deg_lon = 111320.0 * math.cos(math.radians(mean_lat))
        meters_per_deg_lat = 110540.0
        offset_lon = offset_m / max(1e-9, meters_per_deg_lon)
        offset_lat = offset_m / max(1e-9, meters_per_deg_lat)
        
        direction_lon = centroid_lon - lon
        direction_lat = centroid_lat - lat
        norm = math.hypot(direction_lon, direction_lat)
        if norm < 1e-9:
            return None
        direction_lon /= norm
        direction_lat /= norm
        
        sample_lon = lon + direction_lon * offset_lon
        sample_lat = lat + direction_lat * offset_lat
        
        buf = 0.00008
        lat_min, lon_min, lat_max, lon_max = sample_lat - buf, sample_lon - buf, sample_lat + buf, sample_lon + buf
        qs = urllib.parse.urlencode({
            "SERVICE": "WMS",
            "REQUEST": "GetFeatureInfo",
            "VERSION": "1.3.0",
            "LAYERS": "CP.CadastralParcel",
            "QUERY_LAYERS": "CP.CadastralParcel",
            "STYLES": "",
            "CRS": "EPSG:6706",
            "BBOX": f"{lat_min},{lon_min},{lat_max},{lon_max}",
            "WIDTH": "221",
            "HEIGHT": "221",
            "I": "110",
            "J": "110",
            "INFO_FORMAT": "text/html",
            "FEATURE_COUNT": "10",
            "TRANSPARENT": "true",
            "FORMAT": "image/png",
            "OUTPUT": "json",
        })
        try:
            server_address = cast(tuple[Any, ...], self.server.server_address)
            server_host, server_port = server_address[:2]
            if server_host in {"0.0.0.0", "::", ""}:
                server_host = "127.0.0.1"
            proxy_url = f"http://{server_host}:{server_port}/wms-proxy?{qs}"
            req = urllib.request.Request(
                proxy_url,
                headers={"User-Agent": "Planimeter-Local-Proxy/1.0"},
            )
            with urllib.request.urlopen(req, timeout=6.0) as response:
                payload = response.read()
                data = json.loads(payload.decode("utf-8", errors="replace"))
                parcel = data.get("parcel") if isinstance(data, dict) else None
                canonical = parcel if isinstance(parcel, dict) else {}
                parcel_id = str(canonical.get("id") or "").strip()
                if parcel_id:
                    return parcel_id
                parcel_label = str(canonical.get("label") or "").strip()
                return parcel_label or None
        except Exception:
            pass
        return None

    def handle_parcel_geometry_m3_refine(self) -> None:
        """POST /parcel-geometry-m3-refine — optional fine border alignment using border-only tile sampling."""
        if not self._check_rate_limit():
            return

        body = self._read_json_payload()
        if body is None:
            return

        lat = body.get("lat")
        lon = body.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon numerici richiesti."})
            return
        lat, lon = float(lat), float(lon)
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon fuori range."})
            return

        quality = str(body.get("quality") or "balanced").strip().lower()
        quality_cfg = {
            "fast": {"spacing_m": 2.6, "search_m": 1.6, "step_m": 0.24, "tile_half": 0.00018, "max_req": 12, "min_conf": 0.40, "line_floor": 0.18, "probe_m": 0.45},
            "balanced": {"spacing_m": 2.2, "search_m": 2.2, "step_m": 0.20, "tile_half": 0.00014, "max_req": 24, "min_conf": 0.46, "line_floor": 0.22, "probe_m": 0.75},
            "precise": {"spacing_m": 1.5, "search_m": 3.0, "step_m": 0.16, "tile_half": 0.00010, "max_req": 40, "min_conf": 0.50, "line_floor": 0.26, "probe_m": 0.55},
            "aggressive": {"spacing_m": 1.3, "search_m": 4.2, "step_m": 0.14, "tile_half": 0.00020, "max_req": 72, "min_conf": 0.34, "line_floor": 0.12, "probe_m": 0.85},
        }
        cfg = quality_cfg.get(quality, quality_cfg["balanced"])
        max_requests = body.get("maxRequests")
        if isinstance(max_requests, (int, float)):
            cfg = {**cfg, "max_req": max(4, min(120, int(max_requests)))}

        coarse_debug_obj = body.get("coarseDebug")
        coarse_debug: dict[str, object] = coarse_debug_obj if isinstance(coarse_debug_obj, dict) else {}
        ownership_blob = body.get("ownershipMask")
        if ownership_blob is None and coarse_debug:
            ownership_blob = coarse_debug.get("ownershipMask")
        mask_transform = body.get("maskTransform")
        if not isinstance(mask_transform, dict) and coarse_debug:
            debug_transform = coarse_debug.get("maskTransform")
            if isinstance(debug_transform, dict):
                mask_transform = debug_transform

        raw_coarse_ring = body.get("coarseRing")
        coarse_ring = self._normalize_ring_lonlat(raw_coarse_ring if isinstance(raw_coarse_ring, list) else [])
        if len(coarse_ring) < 4:
            coarse_radius = body.get("coarseRadius", 2)
            if isinstance(coarse_radius, (int, float)):
                coarse_radius = max(1, min(5, int(coarse_radius)))
            else:
                coarse_radius = 2
            auto_ring, auto_debug = self._m3_detect_parcel_boundary(lon, lat, coarse_radius)
            if auto_ring is None:
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": "Coarse ring unavailable for refinement.",
                    "debug": {"coarse": auto_debug},
                })
                return
            coarse_ring = self._normalize_ring_lonlat(auto_ring)
            if ownership_blob is None:
                ownership_blob = auto_debug.get("ownershipMask")
            if not isinstance(mask_transform, dict):
                auto_transform = auto_debug.get("maskTransform")
                if isinstance(auto_transform, dict):
                    mask_transform = auto_transform

        started_at = time.perf_counter()
        try:
            import cv2
            import numpy as np

            dense = self._densify_ring_by_spacing_m(coarse_ring, float(cfg["spacing_m"]))
            if len(dense) < 4:
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": "Dense ring generation failed.",
                    "debug": {"quality": quality},
                })
                return

            tile_px = 420
            tile_half = float(cfg["tile_half"])
            max_req = int(cfg["max_req"])
            search_m = float(cfg["search_m"])
            step_m = max(0.12, float(cfg["step_m"]))
            min_conf = float(cfg["min_conf"])
            line_floor = float(cfg["line_floor"])
            if quality == "balanced":
                continuity_base = 0.035
                distance_hard_clamp_m = 0.40
            elif quality == "aggressive":
                continuity_base = 0.095
                distance_hard_clamp_m = 0.85
            else:
                continuity_base = 0.05
                distance_hard_clamp_m = 0.45

            fetch_count = 0
            tile_cache: dict[str, dict[str, object]] = {}

            def fetch_local_tile(center_lon: float, center_lat: float):
                nonlocal fetch_count
                key = f"{center_lon:.5f}:{center_lat:.5f}:{tile_half:.6f}"
                cached = tile_cache.get(key)
                if cached is not None:
                    return cached
                if fetch_count >= max_req:
                    return None
                lon_min_t = center_lon - tile_half
                lat_min_t = center_lat - tile_half
                lon_max_t = center_lon + tile_half
                lat_max_t = center_lat + tile_half

                qs = urllib.parse.urlencode({
                    "SERVICE": "WMS",
                    "REQUEST": "GetMap",
                    "VERSION": "1.3.0",
                    "LAYERS": "CP.CadastralParcel",
                    "STYLES": "",
                    "CRS": "EPSG:6706",
                    "BBOX": f"{lat_min_t},{lon_min_t},{lat_max_t},{lon_max_t}",
                    "WIDTH": str(tile_px),
                    "HEIGHT": str(tile_px),
                    "FORMAT": "image/png",
                    "TRANSPARENT": "true",
                })
                req = urllib.request.Request(
                    f"{UPSTREAM_WMS}?language=ita&{qs}",
                    headers={
                        "User-Agent": "Planimeter-Local-Proxy/1.0",
                        "Accept": "image/png,image/*;q=0.9,*/*;q=0.8",
                    },
                )
                try:
                    with self.fetch_upstream(req, timeout=self.get_upstream_timeout(), retries=self.get_upstream_retries()) as response:
                        fetch_count += 1
                        img = Image.open(io.BytesIO(response.read())).convert("RGB")
                        arr = np.array(img)
                        bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

                        lower_red = np.array([0, 0, 150])
                        upper_red = np.array([100, 100, 255])
                        red_mask = cv2.inRange(bgr, lower_red, upper_red)
                        bgr[red_mask > 0] = np.array([189, 236, 253], dtype=np.uint8)

                        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
                        blur = cv2.GaussianBlur(gray, (3, 3), 0)
                        grad_x = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
                        grad_y = cv2.Sobel(blur, cv2.CV_32F, 0, 1, ksize=3)
                        grad_mag = cv2.magnitude(grad_x, grad_y)
                        adaptive = cv2.adaptiveThreshold(
                            blur,
                            255,
                            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                            cv2.THRESH_BINARY_INV,
                            31,
                            11,
                        )
                        close_kernel = np.ones((3, 3), dtype=np.uint8)
                        line_mask = cv2.morphologyEx(adaptive, cv2.MORPH_CLOSE, close_kernel, iterations=1)
                        line_mask = cv2.dilate(line_mask, close_kernel, iterations=1)
                        edge_map = cv2.Canny(blur, threshold1=35, threshold2=105)
                        edge_map = cv2.dilate(edge_map, close_kernel, iterations=1)
                        dist_map = cv2.distanceTransform(line_mask, cv2.DIST_L2, 3)
                        dist_max = float(dist_map.max()) if dist_map.size else 0.0
                        if dist_max > 1e-9:
                            dist_map = dist_map / dist_max

                        payload = {
                            "gray": gray,
                            "grad": grad_mag,
                            "line_mask": line_mask,
                            "edge_map": edge_map,
                            "dist_map": dist_map,
                            "lon_min": lon_min_t,
                            "lat_min": lat_min_t,
                            "lon_max": lon_max_t,
                            "lat_max": lat_max_t,
                        }
                        tile_cache[key] = payload
                        return payload
                except Exception:
                    return None

            def _as_float(value: object, fallback: float = 0.0) -> float:
                if isinstance(value, (int, float)):
                    return float(value)
                if isinstance(value, str):
                    try:
                        return float(value)
                    except Exception:
                        return fallback
                return fallback

            def _window_support(mask: Any, x: int, y: int, radius: int = 2) -> float:
                height, width = mask.shape[:2]
                x0 = max(0, x - radius)
                x1 = min(width, x + radius + 1)
                y0 = max(0, y - radius)
                y1 = min(height, y + radius + 1)
                if x0 >= x1 or y0 >= y1:
                    return 0.0
                region = mask[y0:y1, x0:x1]
                return float(np.mean(region)) / 255.0

            def _candidate_offsets(search_meters: float, step_meters: float) -> list[float]:
                step = max(0.12, step_meters)
                count = max(1, int(math.ceil(search_meters / step)))
                offsets = {0.0}
                for idx in range(1, count + 1):
                    offset = min(search_meters, idx * step)
                    offsets.add(round(offset, 6))
                    offsets.add(round(-offset, 6))
                return sorted(offsets)

            def _mask_px_from_lonlat(lon_v: float, lat_v: float, transform: dict[str, object]) -> tuple[int, int] | None:
                lon_min_t = _as_float(transform.get("lon_min"), 0.0)
                lon_max_t = _as_float(transform.get("lon_max"), 0.0)
                lat_min_t = _as_float(transform.get("lat_min"), 0.0)
                lat_max_t = _as_float(transform.get("lat_max"), 0.0)
                width_t = int(_as_float(transform.get("width"), 0.0))
                height_t = int(_as_float(transform.get("height"), 0.0))
                if width_t < 2 or height_t < 2 or lon_max_t == lon_min_t or lat_max_t == lat_min_t:
                    return None
                px = int(round((lon_v - lon_min_t) / (lon_max_t - lon_min_t) * (width_t - 1)))
                py = int(round((lat_max_t - lat_v) / (lat_max_t - lat_min_t) * (height_t - 1)))
                return px, py

            def _sample_ownership_lonlat(mask_obj: Any, transform: dict[str, object], lon_v: float, lat_v: float) -> bool:
                px_py = _mask_px_from_lonlat(lon_v, lat_v, transform)
                if px_py is None:
                    return False
                px, py = px_py
                return self._sample_ownership(mask_obj, px, py)

            def _ownership_probe(mask_obj: Any, transform: dict[str, object], cand_lon: float, cand_lat: float, nx_v: float, ny_v: float, probe_m: float) -> tuple[bool, bool]:
                probe_lon = probe_m / max(1e-9, meters_per_deg_lon)
                probe_lat = probe_m / max(1e-9, meters_per_deg_lat)
                inside_lon = cand_lon + nx_v * probe_lon
                inside_lat = cand_lat + ny_v * probe_lat
                outside_lon = cand_lon - nx_v * probe_lon
                outside_lat = cand_lat - ny_v * probe_lat
                inside_ok = _sample_ownership_lonlat(mask_obj, transform, inside_lon, inside_lat)
                outside_ok = _sample_ownership_lonlat(mask_obj, transform, outside_lon, outside_lat)
                return inside_ok, outside_ok

            def _fallback_ownership(cand_lon: float, cand_lat: float, nx_v: float, ny_v: float, probe_m: float) -> tuple[bool, bool]:
                probe_lon = probe_m / max(1e-9, meters_per_deg_lon)
                probe_lat = probe_m / max(1e-9, meters_per_deg_lat)
                inside_lon = cand_lon + nx_v * probe_lon
                inside_lat = cand_lat + ny_v * probe_lat
                outside_lon = cand_lon - nx_v * probe_lon
                outside_lat = cand_lat - ny_v * probe_lat
                inside_ok = self._point_in_ring(inside_lon, inside_lat, coarse_ring)
                outside_ok = self._point_in_ring(outside_lon, outside_lat, coarse_ring)
                return inside_ok, outside_ok

            def _tangent_relax_one_pass(ring: list[list[float]], factor: float = 0.22) -> list[list[float]]:
                ring = self._normalize_ring_lonlat(ring)
                if len(ring) < 5:
                    return ring
                out = [list(pt) for pt in ring[:-1]]
                for idx in range(len(out)):
                    prev = out[idx - 1]
                    cur = out[idx]
                    nxt = out[(idx + 1) % len(out)]
                    tx = nxt[0] - prev[0]
                    ty = nxt[1] - prev[1]
                    tnorm = math.hypot(tx, ty)
                    if tnorm <= 1e-12:
                        continue
                    tx /= tnorm
                    ty /= tnorm
                    mid_x = (prev[0] + nxt[0]) * 0.5
                    mid_y = (prev[1] + nxt[1]) * 0.5
                    delta_x = mid_x - cur[0]
                    delta_y = mid_y - cur[1]
                    projected = (delta_x * tx) + (delta_y * ty)
                    out[idx][0] = cur[0] + (tx * projected * factor)
                    out[idx][1] = cur[1] + (ty * projected * factor)
                out.append([out[0][0], out[0][1]])
                return out

            mean_lat = self._ring_mean_lat(dense)
            meters_per_deg_lon, meters_per_deg_lat = self._meters_per_deg(mean_lat)
            candidate_offsets = _candidate_offsets(search_m, step_m)
            ownership_mask = self._unpack_binary_mask(ownership_blob)
            ownership_transform = mask_transform if isinstance(mask_transform, dict) else None
            ownership_mode = "mask" if ownership_mask is not None and ownership_transform is not None else "ring"
            probe_m = float(cfg.get("probe_m", max(0.45, step_m * 2.0)))

            dense_core = dense[:-1]
            centroid_lon, centroid_lat = self._ring_centroid_xy([(pt[0], pt[1]) for pt in dense_core])

            base_normals: list[tuple[float, float]] = []
            for i in range(len(dense_core)):
                prev = dense_core[i - 1]
                cur = dense_core[i]
                nxt = dense_core[(i + 1) % len(dense_core)]
                tx = nxt[0] - prev[0]
                ty = nxt[1] - prev[1]
                norm = math.hypot(tx, ty)
                if norm <= 1e-12:
                    base_normals.append((0.0, 0.0))
                    continue
                nx = -ty / norm
                ny = tx / norm

                edge_mid_x = (cur[0] + nxt[0]) * 0.5
                edge_mid_y = (cur[1] + nxt[1]) * 0.5
                to_centroid_x = centroid_lon - edge_mid_x
                to_centroid_y = centroid_lat - edge_mid_y
                if (nx * to_centroid_x) + (ny * to_centroid_y) < 0.0:
                    nx, ny = -nx, -ny
                base_normals.append((nx, ny))

            smoothed_normals: list[tuple[float, float]] = []
            for i in range(len(dense_core)):
                acc_x = 0.0
                acc_y = 0.0
                for shift in (-2, -1, 0, 1, 2):
                    nx, ny = base_normals[(i + shift) % len(base_normals)]
                    acc_x += nx
                    acc_y += ny
                norm = math.hypot(acc_x, acc_y)
                if norm <= 1e-12:
                    smoothed_normals.append(base_normals[i])
                else:
                    smoothed_normals.append((acc_x / norm, acc_y / norm))

            refined: list[list[float]] = []
            snap_accepted = 0
            snap_kept = 0
            snap_rejected = 0
            snap_distances: list[float] = []
            snap_confidences: list[float] = []
            ownership_accepted = 0
            ownership_rejected = 0
            ownership_ambiguous = 0
            ownership_scores: list[float] = []
            ownership_positive_count = 0
            ownership_negative_count = 0
            ownership_debug_samples: list[dict[str, object]] = []
            ownership_inside_failures = 0
            ownership_outside_failures = 0
            previous_accept_direction: tuple[float, float] | None = None
            ownership_direction_flips = 0
            continuity_boosts: list[float] = []
            score_gains_accepted: list[float] = []
            rejected_by_distance = 0
            rejected_by_weak_gain = 0

            for i in range(len(dense_core)):
                cur = dense_core[i]
                nx, ny = smoothed_normals[i]
                if math.hypot(nx, ny) <= 1e-12:
                    refined.append([cur[0], cur[1]])
                    snap_kept += 1
                    continue

                tile = fetch_local_tile(cur[0], cur[1])
                if tile is None:
                    refined.append([cur[0], cur[1]])
                    snap_kept += 1
                    continue

                gray = tile.get("gray")
                grad = tile.get("grad")
                line_mask = tile.get("line_mask")
                edge_map = tile.get("edge_map")
                dist_map = tile.get("dist_map")
                lon_min = _as_float(tile.get("lon_min", 0.0), 0.0)
                lon_max = _as_float(tile.get("lon_max", 0.0), 0.0)
                lat_min = _as_float(tile.get("lat_min", 0.0), 0.0)
                lat_max = _as_float(tile.get("lat_max", 0.0), 0.0)
                if gray is None or grad is None or line_mask is None or edge_map is None or dist_map is None or lon_max == lon_min or lat_max == lat_min:
                    refined.append([cur[0], cur[1]])
                    snap_kept += 1
                    continue
                gray = cast(Any, gray)
                grad = cast(Any, grad)
                line_mask = cast(Any, line_mask)
                edge_map = cast(Any, edge_map)
                dist_map = cast(Any, dist_map)
                h, w = gray.shape

                best_score = -1e18
                best_lon = cur[0]
                best_lat = cur[1]
                best_offset_m = 0.0
                best_support = 0.0
                best_edge_support = 0.0
                best_ownership_score = 0.0
                best_continuity_boost = 0.0
                best_score_before = -1e18
                best_cand_dir: tuple[float, float] | None = None
                base_score = None
                has_ambiguous = False
                has_invalid = False
                has_valid = False

                for offset_m in candidate_offsets:
                    cand_lon = cur[0] + nx * (offset_m / max(1e-9, meters_per_deg_lon))
                    cand_lat = cur[1] + ny * (offset_m / max(1e-9, meters_per_deg_lat))

                    x = int(round((cand_lon - lon_min) / (lon_max - lon_min) * (w - 1)))
                    y = int(round((lat_max - cand_lat) / (lat_max - lat_min) * (h - 1)))
                    if x < 1 or y < 1 or x >= w - 1 or y >= h - 1:
                        continue

                    support = _window_support(line_mask, x, y, 2)
                    edge_support = _window_support(edge_map, x, y, 1)
                    dist_score = float(dist_map[y, x])
                    grad_score = min(1.0, float(grad[y, x]) / 255.0)
                    dark_score = (255.0 - float(gray[y, x])) / 255.0

                    if ownership_mode == "mask":
                        mask_transform_live = cast(dict[str, object], ownership_transform)
                        inside_ok, outside_ok = _ownership_probe(ownership_mask, mask_transform_live, cand_lon, cand_lat, nx, ny, probe_m)
                    else:
                        inside_ok, outside_ok = _fallback_ownership(cand_lon, cand_lat, nx, ny, probe_m)

                    if not inside_ok:
                        ownership_inside_failures += 1
                    if outside_ok:
                        ownership_outside_failures += 1

                    if inside_ok and (not outside_ok):
                        ownership_score = 1.0
                        has_valid = True
                    elif inside_ok and outside_ok:
                        ownership_score = 0.25
                        has_ambiguous = True
                    else:
                        ownership_score = -1.0
                        has_invalid = True

                    if ownership_score < 1.0:
                        continue

                    movement_dx = cand_lon - cur[0]
                    movement_dy = cand_lat - cur[1]
                    movement_norm = math.hypot(movement_dx, movement_dy)
                    cand_dir_x = 0.0
                    cand_dir_y = 0.0
                    if movement_norm > 1e-12:
                        cand_dir_x = movement_dx / movement_norm
                        cand_dir_y = movement_dy / movement_norm

                    score_before = (
                        (2.0 * dist_score)
                        + (1.4 * support)
                        + (0.7 * edge_support)
                        + (0.35 * grad_score)
                        + (0.20 * dark_score)
                        - (0.8 * (abs(offset_m) / max(1e-9, search_m)))
                    )

                    candidate_confidence = max(0.0, min(1.0, (0.45 * support) + (0.35 * edge_support) + (0.2 * min(1.0, max(0.0, score_before / 3.5)))))

                    continuity_boost = 0.0
                    if candidate_confidence >= min_conf and support >= line_floor and previous_accept_direction is not None and movement_norm > 1e-12:
                        continuity = (
                            cand_dir_x * previous_accept_direction[0]
                            + cand_dir_y * previous_accept_direction[1]
                        )
                        continuity_weight = continuity_base * max(0.0, 1.0 - (abs(offset_m) / max(1e-9, search_m)))
                        continuity_boost = continuity * continuity_weight

                    score = score_before + (1.1 * ownership_score) + continuity_boost
                    if abs(offset_m) <= 1e-9:
                        base_score = score

                    if score > best_score:
                        best_score = score
                        best_score_before = score_before
                        best_lon = cand_lon
                        best_lat = cand_lat
                        best_offset_m = offset_m
                        best_support = support
                        best_edge_support = edge_support
                        best_ownership_score = ownership_score
                        best_continuity_boost = continuity_boost
                        best_cand_dir = (cand_dir_x, cand_dir_y) if movement_norm > 1e-12 else None

                if base_score is None:
                    base_score = best_score

                if not has_valid:
                    refined.append([cur[0], cur[1]])
                    snap_kept += 1
                    if has_ambiguous:
                        ownership_ambiguous += 1
                        ownership_scores.append(0.25)
                    elif has_invalid:
                        ownership_rejected += 1
                        ownership_negative_count += 1
                        ownership_scores.append(0.0)
                    else:
                        ownership_scores.append(0.0)
                    continue

                confidence = max(0.0, min(1.0, (0.45 * best_support) + (0.35 * best_edge_support) + (0.2 * min(1.0, max(0.0, best_score / 3.5)))))
                score_gain = best_score - base_score
                movement_m = abs(best_offset_m)
                if movement_m > distance_hard_clamp_m and score_gain <= 1.25:
                    refined.append([cur[0], cur[1]])
                    snap_kept += 1
                    ownership_scores.append(0.25)
                    rejected_by_distance += 1
                    if movement_m > 1e-9:
                        snap_rejected += 1
                    continue

                if movement_m <= 1e-9 or confidence < min_conf or score_gain < 0.12 or best_support < line_floor:
                    refined.append([cur[0], cur[1]])
                    snap_kept += 1
                    ownership_scores.append(0.25)
                    if score_gain < 0.12:
                        rejected_by_weak_gain += 1
                    if movement_m > 1e-9:
                        snap_rejected += 1
                    continue

                refined.append([best_lon, best_lat])
                ownership_accepted += 1
                ownership_positive_count += 1
                ownership_scores.append(best_ownership_score)
                continuity_boosts.append(best_continuity_boost)
                score_gains_accepted.append(score_gain)
                if best_cand_dir is not None and previous_accept_direction is not None:
                    if ((best_cand_dir[0] * previous_accept_direction[0]) + (best_cand_dir[1] * previous_accept_direction[1])) < 0.0:
                        ownership_direction_flips += 1
                if best_cand_dir is not None:
                    previous_accept_direction = best_cand_dir
                if len(ownership_debug_samples) < 32:
                    ownership_debug_samples.append({
                        "inside": True,
                        "outside": False,
                        "score_before": round(best_score_before, 4),
                        "score_after": round(best_score, 4),
                    })
                snap_accepted += 1
                snap_distances.append(movement_m)
                snap_confidences.append(confidence)

            refined = self._normalize_ring_lonlat(refined)

            # Corner-aware consolidation (opt-in): replace tangent-relax + RDP smoothing
            # with line-fit + corner-intersection. This recovers sharp parcel corners
            # that pure normal-direction snap cannot reach.
            corner_snap_flag = bool(body.get("cornerSnap", False))
            corner_debug: dict[str, object] = {"requested": corner_snap_flag}
            if corner_snap_flag:
                angle_thr = body.get("cornerAngleDeg")
                angle_thr_f = float(angle_thr) if isinstance(angle_thr, (int, float)) else 18.0
                min_run = body.get("cornerMinRun")
                min_run_i = int(min_run) if isinstance(min_run, (int, float)) else 2
                max_jump = body.get("cornerMaxJumpM")
                max_jump_f = float(max_jump) if isinstance(max_jump, (int, float)) else 6.0
                consolidated, cs_info = self._consolidate_corners(
                    refined,
                    angle_threshold_deg=angle_thr_f,
                    min_run_length=min_run_i,
                    max_corner_jump_m=max_jump_f,
                )
                corner_debug.update(cs_info)
                if cs_info.get("applied") and len(consolidated) >= 4:
                    refined = consolidated
                else:
                    # Fallback to legacy smoothing if consolidation failed.
                    refined = _tangent_relax_one_pass(refined, factor=0.22)
                    refined = self._rdp_ring(refined, epsilon_m=0.20)
            else:
                refined = _tangent_relax_one_pass(refined, factor=0.22)
                refined = self._rdp_ring(refined, epsilon_m=0.20)
            if len(refined) < 4:
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": "Refinement produced invalid ring.",
                    "debug": {"quality": quality, "requestsUsed": fetch_count},
                })
                return

            coarse_area = self._ring_area_m2(coarse_ring)
            refined_area = self._ring_area_m2(refined)
            area_delta = refined_area - coarse_area
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)

            self.send_json(HTTPStatus.OK, {
                "ok": True,
                "coarseRing": coarse_ring,
                "ring": refined,
                "quality": quality if quality in quality_cfg else "balanced",
                "durationMs": elapsed_ms,
                "debug": {
                    "requestsUsed": fetch_count,
                    "requestsBudget": max_req,
                    "budgetLimited": fetch_count >= max_req,
                    "coarseVertices": max(0, len(coarse_ring) - 1),
                    "refinedVertices": max(0, len(refined) - 1),
                    "coarseAreaM2": coarse_area,
                    "refinedAreaM2": refined_area,
                    "areaDeltaM2": area_delta,
                    "areaDeltaRatio": (area_delta / coarse_area) if coarse_area > 1e-9 else 0.0,
                    "snapAcceptedVertices": snap_accepted,
                    "snapKeptVertices": snap_kept,
                    "snapRejectedVertices": snap_rejected,
                    "meanSnapMeters": round(sum(snap_distances) / len(snap_distances), 4) if snap_distances else 0.0,
                    "maxSnapMeters": round(max(snap_distances), 4) if snap_distances else 0.0,
                    "meanConfidence": round(sum(snap_confidences) / len(snap_confidences), 4) if snap_confidences else 0.0,
                    "ownershipMode": ownership_mode,
                    "ownershipAccepted": ownership_accepted,
                    "ownershipRejected": ownership_rejected,
                    "ownershipAmbiguous": ownership_ambiguous,
                    "meanOwnershipScore": round(sum(ownership_scores) / len(ownership_scores), 4) if ownership_scores else 0.0,
                    "ownershipPositiveCount": ownership_positive_count,
                    "ownershipNegativeCount": ownership_negative_count,
                    "ownershipDirectionFlips": ownership_direction_flips,
                    "ownershipInsideFailures": ownership_inside_failures,
                    "ownershipOutsideFailures": ownership_outside_failures,
                    "continuityBoostMean": round(sum(continuity_boosts) / len(continuity_boosts), 4) if continuity_boosts else 0.0,
                    "continuityBase": continuity_base,
                    "distanceHardClampM": distance_hard_clamp_m,
                    "meanScoreGain": round(sum(score_gains_accepted) / len(score_gains_accepted), 4) if score_gains_accepted else 0.0,
                    "rejectedByDistance": rejected_by_distance,
                    "rejectedByWeakGain": rejected_by_weak_gain,
                    "ownershipDebugSamples": ownership_debug_samples,
                    "searchMeters": search_m,
                    "stepMeters": step_m,
                    "minConfidence": min_conf,
                    "lineFloor": line_floor,
                    "probeMeters": probe_m,
                    "cornerSnap": corner_debug,
                },
            })
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("parcel-geometry-m3-refine failed: %s", exc, exc_info=True)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "ok": False,
                "message": f"Errore interno refine M3: {str(exc)[:120]}",
                "durationMs": elapsed_ms,
            })

    def handle_parcel_geometry_m3_trace(self) -> None:
        """POST /parcel-geometry-m3-trace — contorno pixel-perfect della ownership mask.

        Insight chiave: la ownership mask del coarse M3 è generata via flood-fill
        sui bordi neri Canny + dilate(2px), quindi il SUO bordo è già pixel-perfect
        sul bordo catastale. Basta:
          1. Recuperare ownership mask (input body o ricalcolo coarse).
          2. `cv2.findContours` sulla mask → contorno pixel-per-pixel.
          3. Selezionare il contorno che contiene il punto cliccato (lon/lat).
          4. RDP via `cv2.approxPolyDP` con epsilon = `toleranceM * pxPerM`.
          5. Convertire pixel → lon/lat.

        Niente skeleton, BFS, anti-fuga: tutto ridondante, perché l'ownership mask
        è GIÀ la verità (a 1px di precisione).
        """
        if not self._check_rate_limit():
            return
        body = self._read_json_payload()
        if body is None:
            return

        lat_raw = body.get("lat")
        lon_raw = body.get("lon")
        if not isinstance(lat_raw, (int, float)) or not isinstance(lon_raw, (int, float)):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "lat/lon numerici richiesti."})
            return
        lat = float(lat_raw)
        lon = float(lon_raw)

        tol_raw = body.get("toleranceM")
        tolerance_m = float(tol_raw) if isinstance(tol_raw, (int, float)) else 0.35
        tolerance_m = max(0.05, min(2.5, tolerance_m))

        coarse_radius_raw = body.get("coarseRadius")
        coarse_radius = int(coarse_radius_raw) if isinstance(coarse_radius_raw, (int, float)) else 2
        coarse_radius = max(1, min(4, coarse_radius))

        started_at = time.perf_counter()
        try:
            import cv2
            import numpy as np
        except ImportError as exc:
            self.send_json(HTTPStatus.OK, {
                "ok": False,
                "message": f"Trace M3 indisponibile (dipendenza mancante: {exc}).",
            })
            return

        try:
            # ----- Step 1: coarse ring + ownership mask --------------------------------
            raw_coarse_ring = body.get("coarseRing")
            coarse_ring = (
                self._normalize_ring_lonlat(raw_coarse_ring)
                if isinstance(raw_coarse_ring, list)
                else []
            )
            ownership_blob = body.get("ownershipMask")
            mask_transform: object = body.get("maskTransform")
            coarse_debug_obj = body.get("coarseDebug")
            if isinstance(coarse_debug_obj, dict):
                if ownership_blob is None:
                    ownership_blob = coarse_debug_obj.get("ownershipMask")
                if not isinstance(mask_transform, dict):
                    mt = coarse_debug_obj.get("maskTransform")
                    if isinstance(mt, dict):
                        mask_transform = mt

            if len(coarse_ring) < 4 or ownership_blob is None or not isinstance(mask_transform, dict):
                auto_ring, auto_debug = self._m3_detect_parcel_boundary(lon, lat, coarse_radius)
                if auto_ring is None:
                    self.send_json(HTTPStatus.OK, {
                        "ok": False,
                        "message": "Coarse detection non disponibile per il trace.",
                        "debug": {"coarse": auto_debug},
                    })
                    return
                coarse_ring = self._normalize_ring_lonlat(auto_ring)
                ownership_blob = auto_debug.get("ownershipMask")
                mt = auto_debug.get("maskTransform")
                if isinstance(mt, dict):
                    mask_transform = mt
                radius_dbg = auto_debug.get("radius")
                if isinstance(radius_dbg, (int, float)):
                    coarse_radius = int(radius_dbg)

            ownership_mask = self._unpack_binary_mask(ownership_blob)
            if ownership_mask is None or not isinstance(mask_transform, dict):
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": "Ownership mask richiesta per l'algoritmo trace.",
                })
                return

            m_lon_min = float(mask_transform["lon_min"])
            m_lon_max = float(mask_transform["lon_max"])
            m_lat_min = float(mask_transform["lat_min"])
            m_lat_max = float(mask_transform["lat_max"])
            m_w = int(mask_transform["width"])
            m_h = int(mask_transform["height"])

            # ----- Coordinate helpers --------------------------------------------------
            meters_per_deg_lon, meters_per_deg_lat = self._meters_per_deg(lat)
            px_per_m_x = (m_w - 1) / max(1e-9, (m_lon_max - m_lon_min) * meters_per_deg_lon)
            px_per_m_y = (m_h - 1) / max(1e-9, (m_lat_max - m_lat_min) * meters_per_deg_lat)
            px_per_m = (px_per_m_x + px_per_m_y) * 0.5
            tolerance_px = max(0.5, tolerance_m * px_per_m)

            def lonlat_to_px(lon_v: float, lat_v: float) -> tuple[int, int]:
                x = int(round((lon_v - m_lon_min) / max(1e-12, m_lon_max - m_lon_min) * (m_w - 1)))
                y = int(round((m_lat_max - lat_v) / max(1e-12, m_lat_max - m_lat_min) * (m_h - 1)))
                return x, y

            def px_to_lonlat(x: float, y: float) -> tuple[float, float]:
                lon_v = m_lon_min + (x / max(1e-12, m_w - 1)) * (m_lon_max - m_lon_min)
                lat_v = m_lat_max - (y / max(1e-12, m_h - 1)) * (m_lat_max - m_lat_min)
                return lon_v, lat_v

            # ----- Step 2: estrai contorni pixel-perfect dalla ownership mask ----------
            own_u8 = (ownership_mask > 0).astype(np.uint8) * 255
            # Lieve chiusura per saldare eventuali fori da 1px lasciati dal Canny upstream.
            kernel3 = np.ones((3, 3), dtype=np.uint8)
            own_u8 = cv2.morphologyEx(own_u8, cv2.MORPH_CLOSE, kernel3, iterations=1)

            contours, _hier = cv2.findContours(own_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if not contours:
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": "Nessun contorno estraibile dalla ownership mask.",
                })
                return

            # Seleziona il contorno che contiene il punto cliccato (in pixel).
            click_px = lonlat_to_px(lon, lat)
            target_contour = None
            target_idx = -1
            for idx, cnt in enumerate(contours):
                # pointPolygonTest: >0 dentro, 0 sul bordo, <0 fuori
                if cv2.pointPolygonTest(cnt, (float(click_px[0]), float(click_px[1])), False) >= 0:
                    target_contour = cnt
                    target_idx = idx
                    break
            # Fallback: contorno con area maggiore (caso edge dove il click cade sul bordo)
            if target_contour is None:
                target_idx = int(np.argmax([cv2.contourArea(c) for c in contours]))
                target_contour = contours[target_idx]

            raw_contour_pixels = int(len(target_contour))
            raw_contour_area_px = float(cv2.contourArea(target_contour))

            # ----- Step 3: RDP semplificazione adattiva --------------------------------
            approx = cv2.approxPolyDP(target_contour, tolerance_px, True)
            simplified = [(float(pt[0][0]), float(pt[0][1])) for pt in approx]

            if len(simplified) < 3:
                self.send_json(HTTPStatus.OK, {
                    "ok": False,
                    "message": "Contorno semplificato ha meno di 3 vertici.",
                    "debug": {
                        "rawContourPixels": raw_contour_pixels,
                        "tolerancePx": round(tolerance_px, 3),
                    },
                })
                return

            # ----- Step 4: converti pixel → lon/lat e chiudi anello --------------------
            ring_lonlat = [list(px_to_lonlat(px_v, py_v)) for px_v, py_v in simplified]
            if ring_lonlat[0] != ring_lonlat[-1]:
                ring_lonlat.append([ring_lonlat[0][0], ring_lonlat[0][1]])
            ring_lonlat = self._normalize_ring_lonlat(ring_lonlat)

            coarse_area = self._ring_area_m2(coarse_ring)
            traced_area = self._ring_area_m2(ring_lonlat)
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)

            self.send_json(HTTPStatus.OK, {
                "ok": True,
                "ring": ring_lonlat,
                "coarseRing": coarse_ring,
                "durationMs": elapsed_ms,
                "debug": {
                    "algorithm": "ownership-contour-rdp",
                    "toleranceM": tolerance_m,
                    "tolerancePx": round(tolerance_px, 3),
                    "pxPerM": round(px_per_m, 3),
                    "coarseRadius": coarse_radius,
                    "ownershipPixels": int(cv2.countNonZero(own_u8)),
                    "contoursFound": len(contours),
                    "targetContourIndex": target_idx,
                    "rawContourPixels": raw_contour_pixels,
                    "rawContourAreaPx": raw_contour_area_px,
                    "coarseVertices": max(0, len(coarse_ring) - 1),
                    "finalVertices": max(0, len(ring_lonlat) - 1),
                    "coarseAreaM2": coarse_area,
                    "tracedAreaM2": traced_area,
                    "areaDeltaM2": traced_area - coarse_area,
                    "areaDeltaRatio": (
                        (traced_area - coarse_area) / coarse_area if coarse_area > 1e-9 else 0.0
                    ),
                },
            })
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("parcel-geometry-m3-trace failed: %s", exc, exc_info=True)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "ok": False,
                "message": f"Errore interno trace M3: {str(exc)[:120]}",
                "durationMs": elapsed_ms,
            })

    def handle_proxy_health(self) -> None:
        started_at = time.perf_counter()
        probe_query = urllib.parse.urlencode(HEALTHCHECK_QUERY)
        upstream_url = f"{UPSTREAM_WMS}?language=ita&{probe_query}"
        req = urllib.request.Request(
            upstream_url,
            headers={
                "User-Agent": "Planimeter-Local-Proxy/1.0",
                "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
            },
        )

        try:
            timeout = min(HEALTHCHECK_TIMEOUT, self.get_upstream_timeout())
            retries = self.get_upstream_retries()
            with self.fetch_upstream(req, timeout=timeout, retries=retries) as response:
                probe = response.read(512)
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                content_type = response.headers.get("Content-Type", "")
                looks_like_wms = "xml" in content_type.lower() or probe.lstrip().startswith(b"<")

                if response.status >= HTTPStatus.BAD_REQUEST or not looks_like_wms:
                    self.send_json(
                        HTTPStatus.BAD_GATEWAY,
                        {
                            "ok": False,
                            "message": "Risposta health check non valida dal WMS upstream.",
                            "upstreamStatus": response.status,
                            "durationMs": elapsed_ms,
                        },
                    )
                    return

                self.send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "message": "Proxy WMS raggiungibile.",
                        "upstreamStatus": response.status,
                        "durationMs": elapsed_ms,
                        "retries": retries,
                    },
                )
        except UpstreamHTTPError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "ok": False,
                    "message": f"Upstream WMS ha risposto HTTP {exc.status_code}.",
                    "upstreamStatus": exc.status_code,
                    "durationMs": elapsed_ms,
                    "retries": self.get_upstream_retries(),
                },
            )
        except urllib.error.URLError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "ok": False,
                    "message": f"Errore rete verso upstream WMS: {exc.reason}",
                    "durationMs": elapsed_ms,
                    "retries": self.get_upstream_retries(),
                },
            )

    def handle_wms_proxy(self, query_string: str) -> None:
        if not self._check_rate_limit():
            return
        query = urllib.parse.parse_qs(query_string, keep_blank_values=True)
        if not query:
            self.send_error(HTTPStatus.BAD_REQUEST, "Query string mancante")
            return

        # Forza alcuni parametri stabili lato proxy per richieste WMS.
        query.setdefault("SERVICE", ["WMS"])
        query.setdefault("REQUEST", ["GetMap"])
        query.setdefault("VERSION", ["1.3.0"])
        query.setdefault("TRANSPARENT", ["true"])
        query.setdefault("FORMAT", ["image/png"])

        self._normalize_wms_query(query)

        layers = (query.get("LAYERS", [""])[0] or "").strip()
        bbox = (query.get("BBOX", [""])[0] or "").strip()
        width = (query.get("WIDTH", [""])[0] or "").strip()
        height = (query.get("HEIGHT", [""])[0] or "").strip()
        info_format = (query.get("INFO_FORMAT", [""])[0] or "").strip()
        started_at = time.perf_counter()

        resize_plan = self._compute_resize_plan(query)
        upstream_query = {k: list(v) for k, v in query.items()}
        if resize_plan:
            upstream_query["WIDTH"] = [str(resize_plan["upstream_width"])]
            upstream_query["HEIGHT"] = [str(resize_plan["upstream_height"])]

        # OUTPUT=json is a proxy-only signal; do not leak it upstream.
        upstream_query.pop("OUTPUT", None)
        self._filter_wms_params(upstream_query)
        safe_query = urllib.parse.urlencode(upstream_query, doseq=True)
        upstream_url = f"{UPSTREAM_WMS}?language=ita&{safe_query}"

        req = urllib.request.Request(
            upstream_url,
            headers={
                "User-Agent": "Planimeter-Local-Proxy/1.0",
                "Accept": self._build_proxy_accept_header(query, default="image/png,image/*;q=0.9,*/*;q=0.8"),
            },
        )

        try:
            with self.fetch_upstream(
                req,
                timeout=self.get_upstream_timeout(),
                retries=self.get_upstream_retries(),
            ) as response:
                payload = response.read()
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                content_type = response.headers.get("Content-Type", "application/octet-stream")

                # WMS servers often return ServiceException XML with HTTP 200.
                # Surface it as gateway error so the frontend can react clearly.
                if self._looks_like_wms_xml_exception(payload, content_type):
                    _log.warning("wms-proxy ServiceException layers=%s %dms", layers, elapsed_ms)
                    self.send_response(HTTPStatus.BAD_GATEWAY)
                    self.send_header("Content-Type", "application/xml; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(payload)
                    return

                if resize_plan and "png" in content_type.lower():
                    payload = self._resize_png_payload(
                        payload,
                        resize_plan["requested_width"],
                        resize_plan["requested_height"],
                    )

                _log.info(
                    "wms-proxy OK request=%s layers=%s info_format=%s size=%dx%s bbox=%s %dms %db",
                    (query.get("REQUEST", [""])[0] or "").upper(),
                    layers,
                    info_format,
                    int(width) if width else 0,
                    height,
                    bbox[:40] if bbox else "",
                    elapsed_ms, len(payload),
                )

                request_name = (query.get("REQUEST", [""])[0] or "").upper()
                info_format_lower = info_format.lower()
                output_mode = (query.get("OUTPUT", [""])[0] or "").lower()

                if request_name == "GETFEATUREINFO" and output_mode == "json":
                    # Structured JSON output mode: parse HTML and return canonical fields.
                    raw_fields = self._extract_featureinfo_fields_from_html(payload)
                    if raw_fields:
                        canonical = self._to_canonical_parcel_fields(raw_fields)
                        _log.info("wms-proxy featureinfo json layers=%s fields=%s", layers, list(canonical.keys()))
                        response_obj: dict = {
                            "type": "FeatureInfo",
                            "parcel": canonical,
                            "raw": raw_fields,
                        }
                    else:
                        _log.warning("wms-proxy featureinfo parse_failed layers=%s", layers)
                        raw_html = payload.decode("utf-8", errors="replace")
                        response_obj = {
                            "type": "FeatureInfo",
                            "error": "parse_failed",
                            "raw_html": raw_html,
                        }
                    json_bytes = json.dumps(response_obj, ensure_ascii=False).encode("utf-8")
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(json_bytes)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json_bytes)
                    return

                if request_name == "GETFEATUREINFO" and "text/html" in info_format_lower:
                    feature_fields = self._extract_featureinfo_fields_from_html(payload)
                    if feature_fields:
                        _log.info("wms-proxy parsed-featureinfo fields=%s", feature_fields)

                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(payload)
        except UpstreamHTTPError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("wms-proxy upstream HTTP %d layers=%s %dms", exc.status_code, layers, elapsed_ms)
            self.send_response(exc.status_code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain; charset=utf-8"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(exc.body)
        except urllib.error.URLError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("wms-proxy URLError layers=%s %dms: %s", layers, elapsed_ms, exc.reason)
            self.send_error(HTTPStatus.BAD_GATEWAY, f"Errore upstream WMS: {exc.reason}")

    def _normalize_wms_query(self, query: dict[str, list[str]]) -> None:
        request = (query.get("REQUEST", [""])[0] or "").upper()
        if request not in {"GETMAP", "GETFEATUREINFO"}:
            return

        self._normalize_crs_bbox_for_agenzia(query)

    def _build_proxy_accept_header(self, query: dict[str, list[str]], default: str) -> str:
        info_format = (query.get("INFO_FORMAT", [""])[0] or "").strip()
        if info_format:
            return f"{info_format}, text/xml;q=0.9, application/xml;q=0.8, */*;q=0.2"
        return default

    def _compute_resize_plan(self, query: dict[str, list[str]]) -> dict[str, int] | None:
        request = (query.get("REQUEST", [""])[0] or "").upper()
        if request != "GETMAP":
            return None

        width_raw = (query.get("WIDTH", [""])[0] or "").strip()
        height_raw = (query.get("HEIGHT", [""])[0] or "").strip()
        if not width_raw or not height_raw:
            return None

        try:
            requested_width = int(width_raw)
            requested_height = int(height_raw)
        except ValueError:
            return None

        if requested_width <= UPSTREAM_MAX_SIZE and requested_height <= UPSTREAM_MAX_SIZE:
            return None

        # Keep aspect ratio for upstream request within hard limits.
        scale = max(requested_width / UPSTREAM_MAX_SIZE, requested_height / UPSTREAM_MAX_SIZE)
        upstream_width = max(1, int(round(requested_width / scale)))
        upstream_height = max(1, int(round(requested_height / scale)))
        return {
            "requested_width": requested_width,
            "requested_height": requested_height,
            "upstream_width": upstream_width,
            "upstream_height": upstream_height,
        }

    @staticmethod
    def _resize_png_payload(payload: bytes, width: int, height: int) -> bytes:
        try:
            with Image.open(io.BytesIO(payload)) as img:
                resized = img.resize((width, height), Image.Resampling.BILINEAR)
                out = io.BytesIO()
                resized.save(out, format="PNG")
                return out.getvalue()
        except Exception:
            # If anything goes wrong, return original payload as a safe fallback.
            return payload

    def _normalize_crs_bbox_for_agenzia(self, query: dict[str, list[str]]) -> None:
        version = (query.get("VERSION", [""])[0] or "").strip()
        crs_key = "CRS" if version == "1.3.0" else "SRS"
        requested_crs = (query.get(crs_key, [""])[0] or "").upper()
        if requested_crs != "EPSG:3857":
            return

        bbox_raw = (query.get("BBOX", [""])[0] or "").strip()
        if not bbox_raw:
            return
        parts = [p.strip() for p in bbox_raw.split(",")]
        if len(parts) != 4:
            return

        try:
            minx, miny, maxx, maxy = [float(p) for p in parts]
        except ValueError:
            return

        lon_min, lat_min = self._webmercator_to_lonlat(minx, miny)
        lon_max, lat_max = self._webmercator_to_lonlat(maxx, maxy)

        # Agenzia capabilities advertise EPSG:6706 for WMS 1.3.0 with axis order lat,lon.
        query[crs_key] = ["EPSG:6706"]
        query["BBOX"] = [f"{lat_min},{lon_min},{lat_max},{lon_max}"]

    @staticmethod
    def _webmercator_to_lonlat(x: float, y: float) -> tuple[float, float]:
        origin_shift = 20037508.342789244
        lon = (x / origin_shift) * 180.0
        lat = (y / origin_shift) * 180.0
        lat = 180.0 / math.pi * (2.0 * math.atan(math.exp(lat * math.pi / 180.0)) - math.pi / 2.0)
        return lon, lat

    @staticmethod
    def _looks_like_wms_xml_exception(payload: bytes, content_type: str) -> bool:
        if not payload:
            return False
        head = payload[:256].lstrip().lower()
        if b"<?xml" not in head and b"<serviceexception" not in head and b"<ows:exception" not in head:
            return False
        ctype = (content_type or "").lower()
        return "xml" in ctype or "text/plain" in ctype or "application/vnd.ogc.se_xml" in ctype

    # Mapping from raw WMS HTML field names (case-insensitive) to canonical keys.
    _FEATUREINFO_FIELD_MAP: dict[str, str] = {
        "label": "label",
        "nationalcadastralreference": "id",
        "inspireid_localid": "local_id",
        "inspireid_namespace": "namespace",
    }

    @staticmethod
    def _to_canonical_parcel_fields(raw: dict[str, str]) -> dict[str, str]:
        """Map raw WMS FeatureInfo fields to canonical parcel keys."""
        field_map = PlanimeterHandler._FEATUREINFO_FIELD_MAP
        result: dict[str, str] = {}
        for raw_key, value in raw.items():
            normalized = raw_key.lower().replace(" ", "").replace("-", "_")
            canonical_key = field_map.get(normalized)
            if canonical_key:
                result[canonical_key] = value
        return result

    @staticmethod
    def _extract_featureinfo_fields_from_html(payload: bytes) -> dict[str, str]:
        if not payload:
            return {}

        text = payload.decode("utf-8", errors="ignore")
        fields: dict[str, str] = {}
        row_pattern = re.compile(
            r"<tr\b[^>]*>\s*<th\b[^>]*>(.*?)</th>\s*<td\b[^>]*>(.*?)</td>\s*</tr>",
            flags=re.IGNORECASE | re.DOTALL,
        )

        for key_raw, value_raw in row_pattern.findall(text):
            key = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", key_raw))).strip()
            value = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", value_raw))).strip()
            if not key or not value:
                continue
            fields[key] = value

        return fields

    def _fetch_parcel_geometry_at_point(
        self,
        lat: float,
        lon: float,
        buf: float,
        canonical: dict[str, str],
    ) -> tuple[dict[str, object] | None, str | None]:
        """Try extracting parcel geometry around point using GetFeatureInfo JSON."""
        # WMS 1.3.0 + EPSG:4326: axis order is latitude/longitude (Y/X)
        bbox_4326 = f"{lat - buf},{lon - buf},{lat + buf},{lon + buf}"
        width, height = 101, 101
        query: dict[str, list[str]] = {
            "SERVICE": ["WMS"],
            "REQUEST": ["GetFeatureInfo"],
            "VERSION": ["1.3.0"],
            "LAYERS": ["CP.CadastralParcel"],
            "QUERY_LAYERS": ["CP.CadastralParcel"],
            "STYLES": [""],
            "CRS": ["EPSG:4326"],
            "BBOX": [bbox_4326],
            "WIDTH": [str(width)],
            "HEIGHT": [str(height)],
            "I": [str(width // 2)],
            "J": [str(height // 2)],
            "INFO_FORMAT": ["application/json"],
            "FEATURE_COUNT": ["8"],
            "TRANSPARENT": ["true"],
            "FORMAT": ["image/png"],
        }

        self._normalize_wms_query(query)
        self._filter_wms_params(query)
        upstream_qs = urllib.parse.urlencode(query, doseq=True)
        upstream_url = f"{UPSTREAM_WMS}?language=ita&{upstream_qs}"
        req = urllib.request.Request(
            upstream_url,
            headers={
                "User-Agent": "Planimeter-Local-Proxy/1.0",
                "Accept": "application/json,application/geo+json;q=0.9,*/*;q=0.2",
            },
        )

        try:
            with self.fetch_upstream(req, timeout=self.get_upstream_timeout(), retries=self.get_upstream_retries()) as response:
                payload = response.read()
                content_type = (response.headers.get("Content-Type", "") or "").lower()
                if "json" not in content_type and not payload.lstrip().startswith((b"{", b"[")):
                    return None, None

                data = json.loads(payload.decode("utf-8", errors="ignore"))
                features = data.get("features") if isinstance(data, dict) else None
                if not isinstance(features, list) or not features:
                    return None, None

                chosen = self._pick_best_parcel_geometry_feature(features, canonical)
                if not chosen:
                    return None, None

                geometry = chosen.get("geometry")
                if not isinstance(geometry, dict):
                    return None, None

                geom_type = geometry.get("type")
                if geom_type not in {"Polygon", "MultiPolygon"}:
                    return None, None

                return geometry, "EPSG:4326"
        except Exception:
            return None, None

    @staticmethod
    def _pick_best_parcel_geometry_feature(features: list[object], canonical: dict[str, str]) -> dict[str, object] | None:
        target_ids = {
            str(canonical.get("id") or "").strip(),
            str(canonical.get("local_id") or "").strip(),
            str(canonical.get("label") or "").strip(),
        }
        target_ids.discard("")

        polygon_candidates: list[dict[str, object]] = []
        for feature in features:
            if not isinstance(feature, dict):
                continue
            geometry = feature.get("geometry")
            if not isinstance(geometry, dict):
                continue
            if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
                continue
            polygon_candidates.append(feature)

        if not polygon_candidates:
            return None
        if not target_ids:
            return polygon_candidates[0]

        for feature in polygon_candidates:
            props = feature.get("properties")
            if not isinstance(props, dict):
                continue
            prop_values = {str(value).strip() for value in props.values() if value is not None}
            if target_ids & prop_values:
                return feature

        return polygon_candidates[0]

    def handle_wms_tile(self, query_string: str) -> None:
        """WMS proxy with SQLite tile cache for all GetMap requests."""
        if not self._check_rate_limit():
            return
        query = urllib.parse.parse_qs(query_string, keep_blank_values=True)
        if not query:
            self.send_error(HTTPStatus.BAD_REQUEST, "Query string mancante")
            return

        query.setdefault("SERVICE", ["WMS"])
        query.setdefault("REQUEST", ["GetMap"])
        query.setdefault("VERSION", ["1.3.0"])
        query.setdefault("TRANSPARENT", ["true"])
        query.setdefault("FORMAT", ["image/png"])

        self._normalize_wms_query(query)

        layers = (query.get("LAYERS", [""])[0] or "").strip()
        bbox = (query.get("BBOX", [""])[0] or "").strip()
        started_at = time.perf_counter()

        tile_cache: TileCache | None = getattr(self.server, "tile_cache", None)
        request_type = (query.get("REQUEST", [""])[0] or "").upper()
        use_cache = (
            tile_cache is not None
            and request_type == "GETMAP"
        )

        cache_key: str | None = None
        if use_cache:
            cache_key = self._tile_cache_key(query)
            cached = tile_cache.get(cache_key)  # type: ignore[union-attr]
            if cached:
                content_type, data = cached
                _log.debug("wms-tile HIT layers=%s %db", layers, len(data))
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Tile-Cache", "HIT")
                self.end_headers()
                self.wfile.write(data)
                return

        resize_plan = self._compute_resize_plan(query)
        upstream_query = {k: list(v) for k, v in query.items()}
        if resize_plan:
            upstream_query["WIDTH"] = [str(resize_plan["upstream_width"])]
            upstream_query["HEIGHT"] = [str(resize_plan["upstream_height"])]

        self._filter_wms_params(upstream_query)
        safe_query = urllib.parse.urlencode(upstream_query, doseq=True)
        upstream_url = f"{UPSTREAM_WMS}?language=ita&{safe_query}"
        req = urllib.request.Request(
            upstream_url,
            headers={
                "User-Agent": "Planimeter-Local-Proxy/1.0",
                "Accept": "image/png,image/*;q=0.9,*/*;q=0.8",
            },
        )

        try:
            with self.fetch_upstream(
                req,
                timeout=self.get_upstream_timeout(),
                retries=self.get_upstream_retries(),
            ) as response:
                payload = response.read()
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                content_type = response.headers.get("Content-Type", "application/octet-stream")

                if self._looks_like_wms_xml_exception(payload, content_type):
                    _log.warning("wms-tile ServiceException layers=%s %dms", layers, elapsed_ms)
                    self.send_response(HTTPStatus.BAD_GATEWAY)
                    self.send_header("Content-Type", "application/xml; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(payload)
                    return

                if resize_plan and "png" in content_type.lower():
                    payload = self._resize_png_payload(
                        payload,
                        resize_plan["requested_width"],
                        resize_plan["requested_height"],
                    )

                if use_cache and cache_key and "png" in content_type.lower():
                    tile_cache.put(cache_key, content_type, payload)  # type: ignore[union-attr]

                _log.info(
                    "wms-tile MISS layers=%s bbox=%s %dms %db",
                    layers, bbox[:40] if bbox else "", elapsed_ms, len(payload),
                )
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Tile-Cache", "MISS")
                self.end_headers()
                self.wfile.write(payload)
        except UpstreamHTTPError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("wms-tile upstream HTTP %d layers=%s %dms", exc.status_code, layers, elapsed_ms)
            self.send_response(exc.status_code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain; charset=utf-8"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(exc.body)
        except urllib.error.URLError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            _log.error("wms-tile URLError layers=%s %dms: %s", layers, elapsed_ms, exc.reason)
            self.send_error(HTTPStatus.BAD_GATEWAY, f"Errore upstream WMS: {exc.reason}")

    def handle_cache_stats(self) -> None:
        cache: TileCache | None = getattr(self.server, "tile_cache", None)
        if cache is None:
            self.send_json(HTTPStatus.OK, {"count": 0, "size_bytes": 0, "enabled": False})
            return
        stats = cache.stats()
        stats.update(cache.get_config())
        stats["enabled"] = True  # type: ignore[assignment]
        self.send_json(HTTPStatus.OK, stats)

    def handle_cache_clear(self) -> None:
        cache: TileCache | None = getattr(self.server, "tile_cache", None)
        if cache is None:
            self.send_json(HTTPStatus.OK, {"deleted": 0, "enabled": False})
            return
        deleted = cache.clear_all()
        self.send_json(HTTPStatus.OK, {"deleted": deleted, "enabled": True})

    def handle_cache_config_get(self) -> None:
        cache: TileCache | None = getattr(self.server, "tile_cache", None)
        if cache is None:
            self.send_json(
                HTTPStatus.OK,
                {
                    "enabled": False,
                    "ttl_days": TILE_CACHE_TTL_DAYS_DEFAULT,
                    "max_size_mb": TILE_CACHE_MAX_MB_DEFAULT,
                },
            )
            return
        payload = cache.get_config()
        payload["enabled"] = True  # type: ignore[assignment]
        self.send_json(HTTPStatus.OK, payload)

    def handle_cache_config_update(self) -> None:
        cache: TileCache | None = getattr(self.server, "tile_cache", None)
        if cache is None:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Cache non disponibile."})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Payload mancante."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Payload JSON non valido."})
            return

        try:
            ttl_days = int(payload.get("ttl_days", TILE_CACHE_TTL_DAYS_DEFAULT))
            max_size_mb = int(payload.get("max_size_mb", TILE_CACHE_MAX_MB_DEFAULT))
        except Exception:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Valori cache non validi."})
            return

        if ttl_days < MIN_CACHE_TTL_DAYS or ttl_days > MAX_CACHE_TTL_DAYS:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {
                    "ok": False,
                    "message": f"TTL non valido: usare {MIN_CACHE_TTL_DAYS}-{MAX_CACHE_TTL_DAYS} giorni.",
                },
            )
            return
        if max_size_mb < MIN_CACHE_SIZE_MB or max_size_mb > MAX_CACHE_SIZE_MB:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {
                    "ok": False,
                    "message": f"Size limit non valido: usare {MIN_CACHE_SIZE_MB}-{MAX_CACHE_SIZE_MB} MB.",
                },
            )
            return

        cache.set_config(ttl_days=ttl_days, max_size_mb=max_size_mb)
        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "ttl_days": ttl_days,
                "max_size_mb": max_size_mb,
            },
        )

    def handle_local_state_load(self) -> None:
        with _local_state_store_lock:
            if not _local_state_store_path.exists():
                self.send_json(HTTPStatus.OK, {"ok": True, "store": None})
                return
            try:
                payload = json.loads(_local_state_store_path.read_text(encoding="utf-8"))
            except Exception:
                self.send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"ok": False, "message": "State locale non leggibile."},
                )
                return

        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "State locale non valido."})
            return

        self.send_json(HTTPStatus.OK, {"ok": True, "store": payload})

    def handle_local_state_save(self) -> None:
        payload = self._read_json_payload()
        if payload is None:
            return

        store = payload.get("store")
        if not isinstance(store, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "store non valido."})
            return

        serialized = json.dumps(store, ensure_ascii=False)
        if len(serialized.encode("utf-8")) > 25 * 1024 * 1024:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "store troppo grande."})
            return

        with _local_state_store_lock:
            _local_state_store_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = _local_state_store_path.with_suffix(".tmp")
            tmp_path.write_text(serialized, encoding="utf-8")
            tmp_path.replace(_local_state_store_path)

        self.send_json(HTTPStatus.OK, {"ok": True, "savedAt": store.get("savedAt")})

    def _read_json_payload(self) -> dict[str, object] | None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Payload mancante."})
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Payload JSON non valido."})
            return None
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Payload JSON non valido."})
            return None
        return payload

    def _parse_export_payload(self) -> tuple[list[float], int, int, list[str], str] | None:
        payload = self._read_json_payload()
        if payload is None:
            return None

        bbox_raw = payload.get("bbox")
        if not isinstance(bbox_raw, list) or len(bbox_raw) != 4:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "bbox non valido."})
            return None
        try:
            south, west, north, east = [float(v) for v in bbox_raw]
        except Exception:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "bbox non valido."})
            return None
        if (
            not all(math.isfinite(v) for v in (south, west, north, east))
            or south >= north
            or west >= east
            or south < -90
            or north > 90
            or west < -180
            or east > 180
        ):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "bbox non valido."})
            return None

        try:
            width = int(str(payload.get("width", 1024)))
            height = int(str(payload.get("height", 1024)))
        except Exception:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Dimensioni export non valide."})
            return None

        width = max(256, min(width, UPSTREAM_MAX_SIZE))
        height = max(256, min(height, UPSTREAM_MAX_SIZE))

        layers_raw = payload.get("layers")
        if isinstance(layers_raw, list):
            layers = [str(item).strip() for item in layers_raw if str(item).strip()]
        else:
            layers = ["CP.CadastralParcel"]
        if not layers:
            layers = ["CP.CadastralParcel"]

        features_json = payload.get("features")
        features = features_json if isinstance(features_json, str) else "{\"type\":\"FeatureCollection\",\"features\":[]}"

        return [south, west, north, east], width, height, layers, features

    def _fetch_wms_png(self, bbox: list[float], width: int, height: int, layers: list[str]) -> bytes:
        south, west, north, east = bbox
        query = {
            "SERVICE": ["WMS"],
            "REQUEST": ["GetMap"],
            "VERSION": ["1.3.0"],
            "CRS": ["EPSG:4258"],
            "BBOX": [f"{south},{west},{north},{east}"],
            "WIDTH": [str(width)],
            "HEIGHT": [str(height)],
            "LAYERS": [",".join(layers)],
            "STYLES": [""],
            "FORMAT": ["image/png"],
            "TRANSPARENT": ["true"],
        }
        safe_query = urllib.parse.urlencode(query, doseq=True)
        upstream_url = f"{UPSTREAM_WMS}?language=ita&{safe_query}"
        req = urllib.request.Request(
            upstream_url,
            headers={
                "User-Agent": "Planimeter-Local-Proxy/1.0",
                "Accept": "image/png,image/*;q=0.9,*/*;q=0.8",
            },
        )

        with self.fetch_upstream(
            req,
            timeout=self.get_upstream_timeout(),
            retries=self.get_upstream_retries(),
        ) as response:
            payload = response.read()
            content_type = response.headers.get("Content-Type", "application/octet-stream")
            if self._looks_like_wms_xml_exception(payload, content_type):
                raise ValueError("Upstream WMS ha restituito ServiceException")
            return payload

    def _build_world_file(self, bbox: list[float], width: int, height: int) -> str:
        south, west, north, east = bbox
        pixel_size_x = (east - west) / float(width)
        pixel_size_y = (north - south) / float(height)
        center_x = west + pixel_size_x / 2.0
        center_y = north - pixel_size_y / 2.0
        return "\n".join(
            [
                f"{pixel_size_x:.12f}",
                "0.0",
                "0.0",
                f"{-pixel_size_y:.12f}",
                f"{center_x:.12f}",
                f"{center_y:.12f}",
            ]
        )

    def _to_tiff(self, png_payload: bytes) -> bytes:
        with Image.open(io.BytesIO(png_payload)) as img:
            output = io.BytesIO()
            img.save(output, format="TIFF", compression="tiff_lzw")
            return output.getvalue()

    def handle_export_geotiff(self) -> None:
        parsed = self._parse_export_payload()
        if parsed is None:
            return
        bbox, width, height, layers, _features = parsed
        try:
            png_payload = self._fetch_wms_png(bbox, width, height, layers)
            tiff_payload = self._to_tiff(png_payload)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/tiff")
            self.send_header("Content-Length", str(len(tiff_payload)))
            self.send_header("Content-Disposition", "attachment; filename=planimeter-export.tif")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(tiff_payload)
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"ok": False, "message": f"Export TIFF fallito: {exc}"})

    def handle_export_pgw(self) -> None:
        parsed = self._parse_export_payload()
        if parsed is None:
            return
        bbox, width, height, layers, _features = parsed
        try:
            png_payload = self._fetch_wms_png(bbox, width, height, layers)
            world_file = self._build_world_file(bbox, width, height).encode("utf-8")

            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("planimeter-export.png", png_payload)
                zf.writestr("planimeter-export.pgw", world_file)
            payload = archive.getvalue()

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Disposition", "attachment; filename=planimeter-export-pgw.zip")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"ok": False, "message": f"Export PGW fallito: {exc}"})

    def handle_export_bundle(self) -> None:
        parsed = self._parse_export_payload()
        if parsed is None:
            return
        bbox, width, height, layers, features = parsed
        try:
            # Extract semantic report from payload (optional)
            payload = self._read_json_payload()
            semantic_report = payload.get("semanticReport") if payload else None

            png_payload = self._fetch_wms_png(bbox, width, height, layers)
            tiff_payload = self._to_tiff(png_payload)
            meta = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "bbox": bbox,
                "crs": "EPSG:4258",
                "width": width,
                "height": height,
                "layers": layers,
            }

            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("image.tif", tiff_payload)
                zf.writestr("areas.geojson", features.encode("utf-8"))
                zf.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"))
                if semantic_report:
                    zf.writestr("semantic-report.json", json.dumps(semantic_report, ensure_ascii=False, indent=2).encode("utf-8"))
            payload = archive.getvalue()

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Disposition", "attachment; filename=planimeter-export-bundle.zip")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"ok": False, "message": f"Export bundle fallito: {exc}"})

    @staticmethod
    def _tile_cache_key(query: dict[str, list[str]]) -> str:
        """MD5 of the normalized canonical GetMap parameters."""
        keys = ("LAYERS", "CRS", "BBOX", "WIDTH", "HEIGHT", "FORMAT")
        parts = [f"{k}={query[k][0]}" for k in keys if k in query and query[k]]
        return hashlib.md5("&".join(parts).encode("utf-8")).hexdigest()


class PlanimeterServer(ThreadingHTTPServer):
    # Avoid multiple listeners on the same port (especially on Windows).
    allow_reuse_address = False
    upstream_timeout: float
    upstream_retries: int
    tile_cache: TileCache


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Server locale Project Planimeter")
    parser.add_argument("--host", default="127.0.0.1", help="Host di bind")
    parser.add_argument("--port", type=int, default=8000, help="Porta di ascolto")
    parser.add_argument(
        "--instance-policy",
        choices=["reuse", "replace"],
        default="reuse",
        help=(
            "Comportamento quando la porta richiesta e gia occupata da un'altra istanza Planimeter: "
            "reuse=usa istanza esistente (default), replace=termina istanza esistente e avvia nuova"
        ),
    )
    parser.add_argument(
        "--upstream-timeout",
        type=float,
        default=float(os.environ.get("PLANIMETER_WMS_TIMEOUT", "20")),
        help="Timeout richieste verso WMS upstream in secondi",
    )
    parser.add_argument(
        "--upstream-retries",
        type=int,
        default=int(os.environ.get("PLANIMETER_WMS_RETRIES", "1")),
        help="Numero retry brevi su errori transitori upstream",
    )
    parser.add_argument(
        "--tile-cache-ttl",
        type=int,
        default=int(os.environ.get("PLANIMETER_TILE_CACHE_TTL_DAYS", str(TILE_CACHE_TTL_DAYS_DEFAULT))),
        help=f"TTL in giorni per le tile WMS in cache (default: {TILE_CACHE_TTL_DAYS_DEFAULT})",
    )
    parser.add_argument(
        "--tile-cache-max-mb",
        type=int,
        default=int(os.environ.get("PLANIMETER_TILE_CACHE_MAX_MB", str(TILE_CACHE_MAX_MB_DEFAULT))),
        help=f"Dimensione massima cache tile in MB (default: {TILE_CACHE_MAX_MB_DEFAULT})",
    )
    parser.add_argument(
        "--tile-cache-dir",
        type=pathlib.Path,
        default=None,
        help="Directory per il database SQLite delle tile (default: <workspace>/_tile_cache)",
    )
    return parser.parse_args()


def can_bind(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def is_port_occupied(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def probe_planimeter_server(host: str, port: int, timeout: float = 1.2) -> bool:
    url = f"http://{host}:{port}/proxy-health"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            if res.status >= 400:
                return False
            content_type = (res.headers.get("Content-Type", "") or "").lower()
            if "json" not in content_type:
                return False
            payload = json.loads(res.read().decode("utf-8", errors="replace"))
            return isinstance(payload, dict) and "ok" in payload and "message" in payload
    except Exception:
        return False


def pick_random_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def find_listening_pids(port: int) -> list[int]:
    system_name = platform.system().lower()
    if system_name != "windows":
        # Prefer lsof when available on Unix-like systems.
        if shutil.which("lsof"):
            try:
                output = subprocess.check_output(
                    ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                pids: set[int] = set()
                for line in output.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        pids.add(int(line))
                    except ValueError:
                        continue
                return sorted(pids)
            except Exception:
                pass

        # Fallback to ss parser on Linux systems without lsof.
        if shutil.which("ss"):
            try:
                output = subprocess.check_output(
                    ["ss", "-ltnp"],
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                pids: set[int] = set()
                pid_pattern = re.compile(r"pid=(\d+)")
                port_marker = f":{port}"
                for line in output.splitlines():
                    if port_marker not in line:
                        continue
                    for match in pid_pattern.findall(line):
                        try:
                            pids.add(int(match))
                        except ValueError:
                            continue
                return sorted(pids)
            except Exception:
                pass

        return []

    try:
        output = subprocess.check_output(
            ["netstat", "-ano", "-p", "tcp"],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:
        return []

    pids: set[int] = set()
    for line in output.splitlines():
        upper = line.upper()
        if "LISTENING" not in upper:
            continue
        if f":{port}" not in line:
            continue
        parts = line.split()
        if not parts:
            continue
        try:
            pids.add(int(parts[-1]))
        except ValueError:
            continue
    return sorted(pids)


def terminate_processes(pids: list[int]) -> bool:
    if not pids:
        return False
    ok = True
    for pid in pids:
        if pid == os.getpid():
            continue
        try:
            if platform.system().lower() == "windows":
                subprocess.check_call(
                    ["taskkill", "/PID", str(pid), "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                os.kill(pid, 15)
        except Exception:
            ok = False
    return ok


def resolve_startup_binding(host: str, requested_port: int, instance_policy: str) -> tuple[int | None, str]:
    if not is_port_occupied(host, requested_port) and can_bind(host, requested_port):
        return requested_port, "free"

    if probe_planimeter_server(host, requested_port):
        if instance_policy == "replace":
            pids = find_listening_pids(requested_port)
            terminated = terminate_processes(pids)
            if terminated and can_bind(host, requested_port):
                return requested_port, "replaced"
            # fallback to existing when replace fails.
            return None, "reuse-existing"
        return None, "reuse-existing"

    random_port = pick_random_port(host)
    return random_port, "random-fallback"


def main() -> None:
    args = parse_args()
    workspace = pathlib.Path(__file__).resolve().parent
    os.chdir(workspace)

    selected_port, mode = resolve_startup_binding(args.host, args.port, args.instance_policy)
    if mode == "reuse-existing":
        print(
            f"Project Planimeter gia attivo su http://{args.host}:{args.port}/planimeter.html "
            f"(instance-policy={args.instance_policy})."
        )
        return

    if mode == "random-fallback" and selected_port is not None:
        print(
            f"Porta {args.port} occupata da servizio non Planimeter. "
            f"Avvio su porta libera {selected_port}."
        )

    effective_port = selected_port if selected_port is not None else args.port

    def factory(*handler_args, **handler_kwargs):
        return PlanimeterHandler(*handler_args, directory=str(workspace), **handler_kwargs)

    server = PlanimeterServer((args.host, effective_port), factory)
    server.upstream_timeout = max(args.upstream_timeout, 1.0)
    server.upstream_retries = max(args.upstream_retries, 0)
    cache_dir = args.tile_cache_dir if args.tile_cache_dir else (workspace / "_tile_cache")
    server.tile_cache = TileCache(
        cache_dir,
        ttl_days=max(args.tile_cache_ttl, MIN_CACHE_TTL_DAYS),
        max_size_mb=max(args.tile_cache_max_mb, MIN_CACHE_SIZE_MB),
    )
    print(f"Project Planimeter server attivo su http://{args.host}:{effective_port}/planimeter.html")
    print(
        "Tile cache WMS: "
        f"{cache_dir / 'tiles.db'} "
        f"(TTL: {max(args.tile_cache_ttl, MIN_CACHE_TTL_DAYS)} giorni, "
        f"limite: {max(args.tile_cache_max_mb, MIN_CACHE_SIZE_MB)} MB)"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
