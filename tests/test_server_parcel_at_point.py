"""Tests for POST /parcel-at-point endpoint (P1 - semantic parcel lookup)."""

import io
import json
import pathlib
import sys
import types
import unittest
import importlib.util
from http import HTTPStatus
from unittest.mock import MagicMock, patch

_SERVER_PATH = pathlib.Path(__file__).parent.parent / "server.py"


def _load_server_module() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("server_pat", _SERVER_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("server_pat", mod)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_server = _load_server_module()
Handler = _server.PlanimeterHandler  # type: ignore[attr-defined]

# ---------------------------------------------------------------------------
# Sample HTML from WMS (same fixture as featureinfo tests)
# ---------------------------------------------------------------------------

_SAMPLE_HTML = b"""
<html><body><table>
  <tr><th>Label</th><td>67</td></tr>
  <tr><th>NationalCadastralReference</th><td>B609_000200.67</td></tr>
  <tr><th>InspireId_localId</th><td>IT.AGE.PLA.B609_000200.67</td></tr>
  <tr><th>InspireId_namespace</th><td>IT.AGE.PLA</td></tr>
</table></body></html>
"""
_EMPTY_HTML = b"<html><body><p>No features</p></body></html>"


def _make_handler(body: bytes) -> Handler:
    """Build a PlanimeterHandler stub with a given POST body."""
    h = Handler.__new__(Handler)
    raw = json.dumps(body if isinstance(body, dict) else {}).encode()
    from email.message import Message
    msg = Message()
    msg["Content-Length"] = str(len(raw))
    h.headers = msg
    h.rfile = io.BytesIO(raw)
    h.client_address = ("127.0.0.1", 9999)
    h.server = MagicMock()
    h.server.upstream_timeout = 10
    h.server.upstream_retries = 0
    # Capture send_json calls
    h._sent = []
    h.send_json = lambda status, payload: h._sent.append((status, payload))
    return h


def _make_handler_with_json(body: dict) -> Handler:
    h = Handler.__new__(Handler)
    raw = json.dumps(body).encode()
    from email.message import Message
    msg = Message()
    msg["Content-Length"] = str(len(raw))
    h.headers = msg
    h.rfile = io.BytesIO(raw)
    h.client_address = ("127.0.0.1", 9999)
    h.server = MagicMock()
    h.server.upstream_timeout = 10
    h.server.upstream_retries = 0
    h._sent = []
    h.send_json = lambda status, payload: h._sent.append((status, payload))
    return h


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

class TestParcelAtPointValidation(unittest.TestCase):
    def _invoke(self, body: dict):
        h = _make_handler_with_json(body)
        # Patch _check_rate_limit to always allow
        with patch.object(Handler, "_check_rate_limit", return_value=True):
            h.handle_parcel_at_point()
        return h._sent

    def test_missing_lat_rejected(self):
        sent = self._invoke({"lon": 12.5})
        self.assertEqual(len(sent), 1)
        status, payload = sent[0]
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertFalse(payload["ok"])

    def test_missing_lon_rejected(self):
        sent = self._invoke({"lat": 41.9})
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], HTTPStatus.BAD_REQUEST)

    def test_non_numeric_lat_rejected(self):
        sent = self._invoke({"lat": "north", "lon": 12.5})
        self.assertEqual(sent[0][0], HTTPStatus.BAD_REQUEST)

    def test_out_of_range_lat_rejected(self):
        sent = self._invoke({"lat": 200.0, "lon": 12.5})
        self.assertEqual(sent[0][0], HTTPStatus.BAD_REQUEST)

    def test_out_of_range_lon_rejected(self):
        sent = self._invoke({"lat": 41.9, "lon": -200.0})
        self.assertEqual(sent[0][0], HTTPStatus.BAD_REQUEST)


# ---------------------------------------------------------------------------
# Successful parcel found
# ---------------------------------------------------------------------------

class TestParcelAtPointSuccess(unittest.TestCase):
    def _invoke_with_upstream(self, html_response: bytes) -> list:
        h = _make_handler_with_json({"lat": 41.9, "lon": 12.5})

        mock_response = MagicMock()
        mock_response.read.return_value = html_response
        mock_response.headers.get.return_value = "text/html"
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch.object(Handler, "_check_rate_limit", return_value=True), \
             patch.object(Handler, "fetch_upstream", return_value=mock_response), \
             patch.object(Handler, "_looks_like_wms_xml_exception", return_value=False):
            h.handle_parcel_at_point()

        return h._sent

    def test_parcel_found_response_shape(self):
        sent = self._invoke_with_upstream(_SAMPLE_HTML)
        self.assertEqual(len(sent), 1)
        status, payload = sent[0]
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(payload["type"], "ParcelLookup")
        self.assertEqual(payload["point"], [41.9, 12.5])
        self.assertEqual(payload["source"], "wms")
        parcel = payload["parcel"]
        self.assertEqual(parcel.get("label"), "67")
        self.assertEqual(parcel.get("id"), "B609_000200.67")
        self.assertIn("raw", payload)
        self.assertIn("durationMs", payload)

    def test_empty_response_returns_null_parcel(self):
        sent = self._invoke_with_upstream(_EMPTY_HTML)
        self.assertEqual(len(sent), 1)
        status, payload = sent[0]
        self.assertEqual(status, HTTPStatus.OK)
        self.assertIsNone(payload["parcel"])
        self.assertEqual(payload["type"], "ParcelLookup")

    def test_response_serialisable(self):
        sent = self._invoke_with_upstream(_SAMPLE_HTML)
        serialised = json.dumps(sent[0][1], ensure_ascii=False)
        roundtrip = json.loads(serialised)
        self.assertEqual(roundtrip["type"], "ParcelLookup")


# ---------------------------------------------------------------------------
# WMS error paths
# ---------------------------------------------------------------------------

class TestParcelAtPointErrors(unittest.TestCase):
    def test_wms_xml_exception_returns_bad_gateway(self):
        h = _make_handler_with_json({"lat": 41.9, "lon": 12.5})
        mock_response = MagicMock()
        mock_response.read.return_value = b"<ServiceExceptionReport/>"
        mock_response.headers.get.return_value = "application/vnd.ogc.se_xml"
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch.object(Handler, "_check_rate_limit", return_value=True), \
             patch.object(Handler, "fetch_upstream", return_value=mock_response), \
             patch.object(Handler, "_looks_like_wms_xml_exception", return_value=True):
            h.handle_parcel_at_point()

        self.assertEqual(h._sent[0][0], HTTPStatus.BAD_GATEWAY)


if __name__ == "__main__":
    unittest.main()
