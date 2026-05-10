"""Tests for FeatureInfo structured JSON output (P1 interpretation layer)."""

import importlib.util
import json
import pathlib
import sys
import types
import unittest

# ---------------------------------------------------------------------------
# Load server.py without executing module-level side effects (no argparse,
# no server start). We import only the handler class.
# ---------------------------------------------------------------------------

_SERVER_PATH = pathlib.Path(__file__).parent.parent / "server.py"


def _load_server_module() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("server", _SERVER_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    # Prevent argparse / server startup from running during import.
    sys.modules.setdefault("server", mod)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_server = _load_server_module()
Handler = _server.PlanimeterHandler  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SAMPLE_HTML = b"""
<html><body>
<table>
  <tr><th>Label</th><td>67</td></tr>
  <tr><th>NationalCadastralReference</th><td>B609_000200.67</td></tr>
  <tr><th>InspireId_localId</th><td>IT.AGE.PLA.B609_000200.67</td></tr>
  <tr><th>InspireId_namespace</th><td>IT.AGE.PLA</td></tr>
</table>
</body></html>
"""

_EMPTY_HTML = b"<html><body><p>No features found</p></body></html>"


class TestExtractFeatureinfoFieldsFromHtml(unittest.TestCase):
    def test_parses_known_fields(self):
        fields = Handler._extract_featureinfo_fields_from_html(_SAMPLE_HTML)
        self.assertEqual(fields.get("Label"), "67")
        self.assertEqual(fields.get("NationalCadastralReference"), "B609_000200.67")
        self.assertEqual(fields.get("InspireId_localId"), "IT.AGE.PLA.B609_000200.67")
        self.assertEqual(fields.get("InspireId_namespace"), "IT.AGE.PLA")

    def test_returns_empty_for_no_table_rows(self):
        fields = Handler._extract_featureinfo_fields_from_html(_EMPTY_HTML)
        self.assertEqual(fields, {})

    def test_returns_empty_for_empty_payload(self):
        fields = Handler._extract_featureinfo_fields_from_html(b"")
        self.assertEqual(fields, {})


class TestToCanonicalParcelFields(unittest.TestCase):
    def test_canonical_mapping(self):
        raw = Handler._extract_featureinfo_fields_from_html(_SAMPLE_HTML)
        canonical = Handler._to_canonical_parcel_fields(raw)
        self.assertEqual(canonical.get("label"), "67")
        self.assertEqual(canonical.get("id"), "B609_000200.67")
        self.assertEqual(canonical.get("local_id"), "IT.AGE.PLA.B609_000200.67")
        self.assertEqual(canonical.get("namespace"), "IT.AGE.PLA")

    def test_unknown_fields_are_excluded(self):
        raw = {"SomeUnknownField": "value", "Label": "42"}
        canonical = Handler._to_canonical_parcel_fields(raw)
        self.assertNotIn("SomeUnknownField", canonical)
        self.assertNotIn("someunknownfield", canonical)
        self.assertEqual(canonical.get("label"), "42")

    def test_empty_raw_returns_empty_canonical(self):
        self.assertEqual(Handler._to_canonical_parcel_fields({}), {})


class TestOutputJsonResponseShape(unittest.TestCase):
    """Validates the JSON response structure without running the HTTP server."""

    def _build_response(self, html: bytes) -> dict:
        """Simulate the OUTPUT=json branch logic from handle_wms_proxy."""
        raw_fields = Handler._extract_featureinfo_fields_from_html(html)
        if raw_fields:
            canonical = Handler._to_canonical_parcel_fields(raw_fields)
            return {
                "type": "FeatureInfo",
                "parcel": canonical,
                "raw": raw_fields,
            }
        else:
            return {
                "type": "FeatureInfo",
                "error": "parse_failed",
                "raw_html": html.decode("utf-8", errors="replace"),
            }

    def test_success_response_shape(self):
        result = self._build_response(_SAMPLE_HTML)
        self.assertEqual(result["type"], "FeatureInfo")
        self.assertIn("parcel", result)
        self.assertIn("raw", result)
        self.assertNotIn("error", result)
        # Canonical fields present
        parcel = result["parcel"]
        self.assertIn("label", parcel)
        self.assertIn("id", parcel)
        self.assertIn("local_id", parcel)
        self.assertIn("namespace", parcel)

    def test_parse_failed_response_shape(self):
        result = self._build_response(_EMPTY_HTML)
        self.assertEqual(result["type"], "FeatureInfo")
        self.assertEqual(result["error"], "parse_failed")
        self.assertIn("raw_html", result)
        self.assertNotIn("parcel", result)

    def test_response_is_json_serialisable(self):
        result = self._build_response(_SAMPLE_HTML)
        serialised = json.dumps(result, ensure_ascii=False)
        roundtrip = json.loads(serialised)
        self.assertEqual(roundtrip["type"], "FeatureInfo")


if __name__ == "__main__":
    unittest.main()
