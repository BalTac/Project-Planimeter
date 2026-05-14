#!/usr/bin/env python3
"""Server locale per Project Planimeter con proxy WMS Agenzia Entrate."""

from __future__ import annotations

import argparse
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
from collections.abc import Mapping
from html import unescape
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

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
            or self.path.startswith("/export-bundle") or self.path.startswith("/parcel-at-point")):
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
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in {"/cache-clear", "/cache-clear/"}:
            self.handle_cache_clear()
            return
        if parsed.path in {"/cache-config", "/cache-config/"}:
            self.handle_cache_config_update()
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

        bbox_4326 = f"{lon - buf},{lat - buf},{lon + buf},{lat + buf}"
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
                _log.info("parcel-at-point OK lat=%s lon=%s fields=%s %dms",
                          lat, lon, list(canonical.keys()), elapsed_ms)
                self.send_json(HTTPStatus.OK, {
                    "type": "ParcelLookup",
                    "point": [lat, lon],
                    "parcel": canonical,
                    "raw": raw_fields,
                    "source": "wms",
                    "durationMs": elapsed_ms,
                })

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
