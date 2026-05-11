"""P0 E2E extended tests: cache stats/clear, export downloads, preferences restore."""

import io
import json
import zipfile

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

    def test_wms_tile_cache_miss_then_hit(self, page: Page, planimeter_base_url: str):
        """Same tile request should be MISS first, then HIT after caching."""
        page.request.post(f"{planimeter_base_url}/cache-clear")

        url = (
            f"{planimeter_base_url}/wms-tile"
            "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
            "&LAYERS=CP.CadastralParcel&STYLES="
            "&CRS=EPSG:3857"
            "&BBOX=1389388,5142231,1390388,5143231"
            "&WIDTH=256&HEIGHT=256"
            "&FORMAT=image/png&TRANSPARENT=true"
        )

        first = page.request.get(url)
        if first.status != 200:
            pytest.skip(f"WMS tile unavailable for cache test (status={first.status})")

        first_cache = first.headers.get("x-tile-cache", "")
        assert first_cache.upper() == "MISS", f"Expected MISS, got '{first_cache}'"

        second = page.request.get(url)
        assert second.status == 200
        second_cache = second.headers.get("x-tile-cache", "")
        assert second_cache.upper() == "HIT", f"Expected HIT, got '{second_cache}'"

    def test_wms_tile_cache_miss_then_hit_on_second_layer(self, page: Page, planimeter_base_url: str):
        """Cache should behave consistently also on a different WMS layer."""
        page.request.post(f"{planimeter_base_url}/cache-clear")

        url = (
            f"{planimeter_base_url}/wms-tile"
            "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
            "&LAYERS=CP.CadastralZoning&STYLES="
            "&CRS=EPSG:3857"
            "&BBOX=1389388,5142231,1390388,5143231"
            "&WIDTH=256&HEIGHT=256"
            "&FORMAT=image/png&TRANSPARENT=true"
        )

        first = page.request.get(url)
        if first.status != 200:
            pytest.skip(f"Secondary layer unavailable for cache test (status={first.status})")

        first_cache = first.headers.get("x-tile-cache", "")
        assert first_cache.upper() == "MISS", f"Expected MISS, got '{first_cache}'"

        second = page.request.get(url)
        assert second.status == 200
        second_cache = second.headers.get("x-tile-cache", "")
        assert second_cache.upper() == "HIT", f"Expected HIT, got '{second_cache}'"


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
            payload = resp.body()
            assert payload[:2] in (b"II", b"MM"), "GeoTIFF endpoint body has invalid TIFF signature"

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
            zip_bytes = resp.body()
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                names = set(zf.namelist())
                assert "planimeter-export.png" in names
                assert "planimeter-export.pgw" in names
                png_header = zf.read("planimeter-export.png")[:8]
                assert png_header == b"\x89PNG\r\n\x1a\n"
                world_lines = zf.read("planimeter-export.pgw").decode("utf-8").strip().splitlines()
                assert len(world_lines) == 6

    def test_export_bundle_endpoint_responds(self, page: Page, planimeter_base_url: str):
        payload = dict(self.VALID_BBOX_PAYLOAD)
        payload["features"] = json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "sample"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[[12.4, 41.8], [12.41, 41.8], [12.41, 41.81], [12.4, 41.81], [12.4, 41.8]]],
                        },
                    }
                ],
            }
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
            zip_bytes = resp.body()
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                names = set(zf.namelist())
                assert "image.tif" in names
                assert "areas.geojson" in names
                assert "meta.json" in names
                tif_header = zf.read("image.tif")[:4]
                assert tif_header[:2] in (b"II", b"MM")
                geo = json.loads(zf.read("areas.geojson").decode("utf-8"))
                assert geo.get("type") == "FeatureCollection"
                assert len(geo.get("features", [])) >= 1
                meta = json.loads(zf.read("meta.json").decode("utf-8"))
                for key in ("bbox", "crs", "width", "height", "layers", "timestamp"):
                    assert key in meta

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


# ---------------------------------------------------------------------------
# Responsive + accessibility
# ---------------------------------------------------------------------------

class TestResponsiveAndAccessibility:
    def test_toolbar_desktop_no_overflow(self, page: Page, planimeter_base_url: str):
        page.set_viewport_size({"width": 1366, "height": 768})
        go(page, planimeter_base_url)

        toolbar = page.locator("#app-toolbar")
        expect(toolbar).to_be_visible()
        box = toolbar.bounding_box()
        assert box is not None
        assert box["x"] >= 0
        assert box["y"] >= 0
        assert box["x"] + box["width"] <= 1366 + 1
        assert box["y"] + box["height"] <= 768 + 1

        no_horizontal_overflow = page.evaluate(
            "() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"
        )
        assert no_horizontal_overflow, "Desktop page has horizontal overflow"

    def test_toolbar_mobile_no_overflow(self, page: Page, planimeter_base_url: str):
        page.set_viewport_size({"width": 390, "height": 844})
        go(page, planimeter_base_url)

        toolbar = page.locator("#app-toolbar")
        expect(toolbar).to_be_visible()
        box = toolbar.bounding_box()
        assert box is not None
        assert box["x"] >= 0
        assert box["x"] + box["width"] <= 390 + 1

        no_horizontal_overflow = page.evaluate(
            "() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"
        )
        assert no_horizontal_overflow, "Mobile page has horizontal overflow"

    def test_tool_hints_update_between_it_and_en(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        draw = page.locator("[data-mode='draw']")

        hint_it = draw.get_attribute("title")
        assert hint_it and len(hint_it) > 2

        page.select_option("#lang-switcher", "en")
        page.wait_for_timeout(300)
        hint_en = draw.get_attribute("title")
        assert hint_en and len(hint_en) > 2
        assert hint_en != hint_it, "IT/EN hover hint did not change"

    def test_tool_buttons_are_keyboard_operable(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        draw = page.locator("[data-mode='draw']")
        navigate = page.locator("[data-mode='navigate']")

        draw.focus()
        page.keyboard.press("Enter")
        page.wait_for_timeout(150)

        expect(draw).to_have_attribute("aria-pressed", "true")
        expect(navigate).to_have_attribute("aria-pressed", "false")


# ---------------------------------------------------------------------------
# Cache runtime settings: apply + clear metrics
# ---------------------------------------------------------------------------

class TestCacheRuntimeSettings:
    def test_apply_cache_runtime_config_from_settings(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("#tab-settings")
        page.wait_for_timeout(300)

        page.fill("#settings-cache-ttl-days", "45")
        page.fill("#settings-cache-size-mb", "256")
        page.click("#btn-cache-apply")
        page.wait_for_timeout(500)

        resp = page.request.get(f"{planimeter_base_url}/cache-config")
        assert resp.ok
        body = resp.json()
        assert body["enabled"] is True
        assert body["ttl_days"] == 45
        assert body["max_size_mb"] == 256

    def test_clear_cache_resets_metrics(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("#tab-settings")
        page.wait_for_timeout(300)

        page.click("#btn-cache-clear")
        page.wait_for_timeout(500)

        resp = page.request.get(f"{planimeter_base_url}/cache-stats")
        assert resp.ok
        stats = resp.json()
        assert stats["enabled"] is True
        assert stats["count"] == 0
        assert stats["size_bytes"] == 0
