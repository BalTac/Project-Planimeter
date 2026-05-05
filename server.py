#!/usr/bin/env python3
"""Server locale per Project Planimeter con proxy WMS Agenzia Entrate."""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import pathlib
import platform
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image


UPSTREAM_WMS = "https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php"
UPSTREAM_MAX_SIZE = 2048
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


class UpstreamHTTPError(Exception):
    def __init__(self, status_code: int, headers, body: bytes):
        super().__init__(f"Upstream HTTP {status_code}")
        self.status_code = status_code
        self.headers = headers
        self.body = body


class PlanimeterHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/wms-proxy") or self.path.startswith("/wms-proxy/"):
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
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
            self.handle_wms_proxy(parsed.query)
            return
        super().do_GET()

    def send_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
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

        self._normalize_getmap_query(query)

        resize_plan = self._compute_resize_plan(query)
        upstream_query = {k: list(v) for k, v in query.items()}
        if resize_plan:
            upstream_query["WIDTH"] = [str(resize_plan["upstream_width"])]
            upstream_query["HEIGHT"] = [str(resize_plan["upstream_height"])]

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
                content_type = response.headers.get("Content-Type", "application/octet-stream")

                # WMS servers often return ServiceException XML with HTTP 200.
                # Surface it as gateway error so the frontend can react clearly.
                if self._looks_like_wms_xml_exception(payload, content_type):
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

                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(payload)
        except UpstreamHTTPError as exc:
            self.send_response(exc.status_code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain; charset=utf-8"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(exc.body)
        except urllib.error.URLError as exc:
            self.send_error(HTTPStatus.BAD_GATEWAY, f"Errore upstream WMS: {exc.reason}")

    def _normalize_getmap_query(self, query: dict[str, list[str]]) -> None:
        request = (query.get("REQUEST", [""])[0] or "").upper()
        if request != "GETMAP":
            return

        self._normalize_crs_bbox_for_agenzia(query)

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


class PlanimeterServer(ThreadingHTTPServer):
    # Avoid multiple listeners on the same port (especially on Windows).
    allow_reuse_address = False


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
    # Windows-first implementation for current project environment.
    if platform.system().lower() != "windows":
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
    print(f"Project Planimeter server attivo su http://{args.host}:{effective_port}/planimeter.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
