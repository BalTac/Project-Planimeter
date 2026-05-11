"""P0 E2E extended tests: cache stats/clear, export downloads, preferences restore."""

import json

import pytest
from playwright.sync_api import Page, expect

APP_PATH = "/planimeter.html"


def app_url(base: str) -> str:
    return base + APP_PATH


def go(page: Page, base: str) -> None:
    page.goto(app_url(base))
    page.wait_for_load_state("networkidle")


# ---------------------------------------------------------------------------
# Cache: stats endpoint reachable from Settings UI
# ---------------------------------------------------------------------------

class TestCacheSettings:
    def test_settings_shows_cache_stats(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("#tab-settings")
        page.wait_for_timeout(400)
        stats = page.locator("#cache-stats-display")
        expect(stats).to_be_visible()
        # Text should eventually update from "Caricamento..." to something else
        page.wait_for_timeout(1500)
        text = stats.inner_text()
        assert text  # not empty

    def test_cache_clear_button_present(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("#tab-settings")
        page.wait_for_timeout(300)
        expect(page.locator("#btn-cache-clear")).to_be_visible()

    def test_cache_clear_via_api(self, page: Page, planimeter_base_url: str):
        """Hit /cache-clear directly and verify JSON response."""
        resp = page.request.post(f"{planimeter_base_url}/cache-clear")
        assert resp.ok, f"cache-clear returned {resp.status}"
        body = resp.json()
        assert "deleted" in body

    def test_cache_stats_api(self, page: Page, planimeter_base_url: str):
        resp = page.request.get(f"{planimeter_base_url}/cache-stats")
        assert resp.ok
        body = resp.json()
        assert "count" in body
        assert "size_bytes" in body

    def test_cache_config_api(self, page: Page, planimeter_base_url: str):
        resp = page.request.get(f"{planimeter_base_url}/cache-config")
        assert resp.ok
        body = resp.json()
        assert "ttl_days" in body
        assert "max_size_mb" in body

    def test_cache_apply_button_present(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("#tab-settings")
        page.wait_for_timeout(300)
        expect(page.locator("#btn-cache-apply")).to_be_visible()


# ---------------------------------------------------------------------------
# Export: GeoJSON, KML, PNG+PGW zip, bundle zip
# ---------------------------------------------------------------------------

def _draw_polygon(page: Page) -> None:
    """Draw a minimal 4-point polygon on the map canvas."""
    page.click("[data-mode='draw']")
    page.wait_for_timeout(300)
    canvas = page.locator("canvas").first
    box = canvas.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    off = 50
    page.mouse.click(cx - off, cy - off)
    page.wait_for_timeout(120)
    page.mouse.click(cx + off, cy - off)
    page.wait_for_timeout(120)
    page.mouse.click(cx + off, cy + off)
    page.wait_for_timeout(120)
    page.mouse.dblclick(cx - off, cy + off)
    page.wait_for_timeout(400)


class TestExportFormats:
    def test_export_geojson_download(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        _draw_polygon(page)
        page.select_option("#export-format", "geojson")
        with page.expect_download(timeout=8000) as dl:
            page.click("#btn-export")
        path = dl.value.path()
        data = json.loads(open(path, encoding="utf-8").read())
        assert data["type"] == "FeatureCollection"
        assert len(data["features"]) >= 1

    def test_export_kml_download(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        _draw_polygon(page)
        page.select_option("#export-format", "kml")
        with page.expect_download(timeout=8000) as dl:
            page.click("#btn-export")
        path = dl.value.path()
        content = open(path, encoding="utf-8").read()
        assert "<kml" in content.lower() or "<?xml" in content.lower(), \
            "Downloaded file does not look like KML"

    # ------------------------------------------------------------------
    # GeoTIFF / PGW / Bundle: test via direct API POST.
    # These formats require fetching WMS tiles; the server may return
    # 200 (WMS reachable) or 502 (WMS unreachable in CI).  Either is
    # acceptable — we just verify the endpoint exists and the server
    # responds with the expected Content-Type or JSON error shape.
    # ------------------------------------------------------------------
    VALID_BBOX_PAYLOAD = {
        "bbox": [41.8, 12.4, 41.82, 12.42],
        "width": 64,
        "height": 64,
        "crs": "EPSG:4258",
        "layers": ["CP.CadastralParcel"],
    }

    def test_export_geotiff_endpoint_responds(self, page: Page, planimeter_base_url: str):
        resp = page.request.post(
            f"{planimeter_base_url}/export-geotiff",
            data=json.dumps(self.VALID_BBOX_PAYLOAD),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status in (200, 502), f"Unexpected status {resp.status}"
        if resp.status == 200:
            ct = resp.headers.get("content-type", "")
            assert "tiff" in ct or "octet" in ct, f"Unexpected Content-Type: {ct}"

    def test_export_pgw_endpoint_responds(self, page: Page, planimeter_base_url: str):
        resp = page.request.post(
            f"{planimeter_base_url}/export-pgw",
            data=json.dumps(self.VALID_BBOX_PAYLOAD),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status in (200, 502), f"Unexpected status {resp.status}"
        if resp.status == 200:
            ct = resp.headers.get("content-type", "")
            assert "zip" in ct, f"Unexpected Content-Type: {ct}"

    def test_export_bundle_endpoint_responds(self, page: Page, planimeter_base_url: str):
        payload = dict(self.VALID_BBOX_PAYLOAD)
        payload["features"] = json.dumps(
            {"type": "FeatureCollection", "features": []}
        )
        resp = page.request.post(
            f"{planimeter_base_url}/export-bundle",
            data=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status in (200, 502), f"Unexpected status {resp.status}"
        if resp.status == 200:
            ct = resp.headers.get("content-type", "")
            assert "zip" in ct, f"Unexpected Content-Type: {ct}"


# ---------------------------------------------------------------------------
# Preferences: layer/tool state restored after reload
# ---------------------------------------------------------------------------

class TestPreferencesRestore:
    def test_layer_preference_persists_after_reload(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        # Switch to Topografico (away from default Satellitare)
        page.click("#layer-open-topo")
        page.wait_for_timeout(400)
        assert page.locator("#layer-open-topo").is_checked()

        # Reload
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        assert page.locator("#layer-open-topo").is_checked(), \
            "Layer preference not restored after reload"

    def test_language_preference_persists_after_reload(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.select_option("#lang-switcher", "en")
        page.wait_for_timeout(400)

        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)

        tab_text = page.locator("#tab-operate").inner_text()
        assert "Operativo" not in tab_text, \
            f"Language preference (EN) not restored after reload: '{tab_text}'"
