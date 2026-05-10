"""P0 backend smoke tests: module import, WMS allowlist, rate limiter, TileCache."""

import importlib.util
import pathlib
import sys
import time
import types
import unittest

# ---------------------------------------------------------------------------
# Load server module
# ---------------------------------------------------------------------------

_SERVER_PATH = pathlib.Path(__file__).parent.parent / "server.py"


def _load_server_module() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("server_smoke", _SERVER_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("server_smoke", mod)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_server = _load_server_module()
Handler = _server.PlanimeterHandler  # type: ignore[attr-defined]
TileCache = _server.TileCache  # type: ignore[attr-defined]
_WMS_ALLOWED_PARAMS = _server._WMS_ALLOWED_PARAMS  # type: ignore[attr-defined]
_RateLimiter = _server._RateLimiter  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Smoke: module-level symbols exist
# ---------------------------------------------------------------------------

class TestModuleSmoke(unittest.TestCase):
    def test_handler_class_exists(self):
        self.assertTrue(callable(Handler))

    def test_allowed_params_is_frozenset(self):
        self.assertIsInstance(_WMS_ALLOWED_PARAMS, frozenset)

    def test_rate_limiter_class_exists(self):
        self.assertTrue(callable(_RateLimiter))

    def test_tile_cache_class_exists(self):
        self.assertTrue(callable(TileCache))

    def test_upstream_wms_constant(self):
        url = _server.UPSTREAM_WMS  # type: ignore[attr-defined]
        self.assertIn("agenziaentrate.gov.it", url)


# ---------------------------------------------------------------------------
# WMS allowlist
# ---------------------------------------------------------------------------

class TestWmsAllowlist(unittest.TestCase):
    def _filter(self, params: dict) -> dict:
        """Run _filter_wms_params and return modified dict."""
        Handler._filter_wms_params(params)
        return params

    def test_known_params_pass(self):
        q = {"SERVICE": ["WMS"], "REQUEST": ["GetMap"], "LAYERS": ["CP.CadastralParcel"],
             "BBOX": ["0,0,1,1"], "WIDTH": ["256"], "HEIGHT": ["256"], "CRS": ["EPSG:3857"],
             "FORMAT": ["image/png"], "VERSION": ["1.3.0"], "TRANSPARENT": ["true"]}
        result = self._filter(dict(q))
        self.assertEqual(set(result.keys()), set(q.keys()))

    def test_unknown_param_stripped(self):
        q = {"SERVICE": ["WMS"], "REQUEST": ["GetMap"], "EVIL": ["<script>alert(1)</script>"]}
        result = self._filter(q)
        self.assertNotIn("EVIL", result)
        self.assertIn("SERVICE", result)

    def test_output_already_absent_from_allowlist(self):
        # OUTPUT is a proxy-only param, must NOT be in allowlist
        self.assertNotIn("OUTPUT", _WMS_ALLOWED_PARAMS)

    def test_multiple_unknown_params_all_stripped(self):
        q = {"SERVICE": ["WMS"], "FOO": ["bar"], "BAZ": ["qux"], "LAYERS": ["CP.CadastralParcel"]}
        result = self._filter(q)
        self.assertNotIn("FOO", result)
        self.assertNotIn("BAZ", result)
        self.assertIn("LAYERS", result)

    def test_empty_query_stays_empty(self):
        self.assertEqual(self._filter({}), {})

    def test_featureinfo_params_pass(self):
        q = {"I": ["128"], "J": ["128"], "INFO_FORMAT": ["text/html"], "FEATURE_COUNT": ["10"],
             "QUERY_LAYERS": ["CP.CadastralParcel"]}
        result = self._filter(dict(q))
        self.assertEqual(set(result.keys()), set(q.keys()))


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class TestRateLimiter(unittest.TestCase):
    def test_allows_requests_within_limit(self):
        rl = _RateLimiter(window_s=60, max_req=5)
        for _ in range(5):
            self.assertTrue(rl.is_allowed("1.2.3.4"))

    def test_blocks_when_limit_exceeded(self):
        rl = _RateLimiter(window_s=60, max_req=3)
        for _ in range(3):
            rl.is_allowed("1.2.3.4")
        self.assertFalse(rl.is_allowed("1.2.3.4"))

    def test_different_ips_independent(self):
        rl = _RateLimiter(window_s=60, max_req=1)
        self.assertTrue(rl.is_allowed("10.0.0.1"))
        self.assertFalse(rl.is_allowed("10.0.0.1"))
        self.assertTrue(rl.is_allowed("10.0.0.2"))  # different IP: allowed

    def test_window_expiry_allows_again(self):
        rl = _RateLimiter(window_s=0.05, max_req=1)  # 50ms window
        self.assertTrue(rl.is_allowed("5.5.5.5"))
        self.assertFalse(rl.is_allowed("5.5.5.5"))
        time.sleep(0.06)
        self.assertTrue(rl.is_allowed("5.5.5.5"))


# ---------------------------------------------------------------------------
# TileCache (in-memory via temp dir)
# ---------------------------------------------------------------------------

class TestTileCacheBasics(unittest.TestCase):
    def setUp(self):
        import tempfile, pathlib
        self._tmpdir = tempfile.mkdtemp()
        self.cache = TileCache(pathlib.Path(self._tmpdir), ttl_days=1, max_size_mb=1)

    def test_miss_returns_none(self):
        self.assertIsNone(self.cache.get("nonexistent-key"))

    def test_put_then_get(self):
        self.cache.put("k1", "image/png", b"\x89PNG")
        result = self.cache.get("k1")
        self.assertIsNotNone(result)
        ctype, data = result
        self.assertEqual(ctype, "image/png")
        self.assertEqual(data, b"\x89PNG")

    def test_stats_reflect_inserted(self):
        self.cache.put("k2", "image/png", b"data")
        s = self.cache.stats()
        self.assertGreaterEqual(s["count"], 1)
        self.assertGreater(s["size_bytes"], 0)

    def test_clear_all(self):
        self.cache.put("k3", "image/png", b"x")
        self.cache.clear_all()
        self.assertIsNone(self.cache.get("k3"))
        self.assertEqual(self.cache.stats()["count"], 0)


if __name__ == "__main__":
    unittest.main()
