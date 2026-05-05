#!/usr/bin/env python3
"""Server locale per Project Planimeter con proxy WMS Agenzia Entrate."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


UPSTREAM_WMS = "https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php"
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

        safe_query = urllib.parse.urlencode(query, doseq=True)
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Server locale Project Planimeter")
    parser.add_argument("--host", default="127.0.0.1", help="Host di bind")
    parser.add_argument("--port", type=int, default=8000, help="Porta di ascolto")
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


def main() -> None:
    args = parse_args()
    workspace = pathlib.Path(__file__).resolve().parent
    os.chdir(workspace)

    def factory(*handler_args, **handler_kwargs):
        return PlanimeterHandler(*handler_args, directory=str(workspace), **handler_kwargs)

    server = ThreadingHTTPServer((args.host, args.port), factory)
    server.upstream_timeout = max(args.upstream_timeout, 1.0)
    server.upstream_retries = max(args.upstream_retries, 0)
    print(f"Project Planimeter server attivo su http://{args.host}:{args.port}/planimeter.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
