"""P0 E2E extended tests: cache stats/clear, export downloads, preferences restore."""

import io
import json
import re
import zipfile

import pytest
from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, expect

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
    assert box is not None, "Map canvas bounding box unavailable"
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
        try:
            resp = page.request.post(
                f"{planimeter_base_url}/export-bundle",
                data=json.dumps(payload),
                headers={"Content-Type": "application/json"},
                timeout=120000,
            )
        except PlaywrightTimeoutError:
            pytest.skip("export-bundle timed out (upstream WMS/backend latency)")
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


class TestHoleWorkflow:
    def test_context_menu_draw_hole_available_in_navigate_and_switches_mode(self, page: Page, planimeter_base_url: str):
        """
        Navigate mode flow:
        - draw a polygon
        - right-click polygon in Navigate mode
        - Draw hole action is visible
        - click action -> app switches to Edit and activates hole draw interaction
        """
        go(page, planimeter_base_url)
        page.select_option("#lang-switcher", "it")
        page.wait_for_timeout(250)

        _draw_polygon(page)

        # Ensure we are in Navigate mode (default) and open context menu on polygon.
        page.click("[data-mode='navigate']")
        page.wait_for_timeout(200)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None, "Map canvas bounding box unavailable"
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        page.mouse.click(cx, cy)
        page.wait_for_timeout(180)
        page.mouse.click(cx, cy, button="right")

        draw_hole_item = page.locator("#map-context-menu button").filter(
            has_text=re.compile(r"Disegna buco|Draw hole", re.IGNORECASE)
        ).first
        expect(draw_hole_item).to_be_visible()
        draw_hole_item.click()
        page.wait_for_timeout(260)

        state = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                return {
                    ok: true,
                    mode: app.state?.mode,
                    holeActive: Boolean(app.holeDrawInteraction?.getActive?.()),
                    selectedPolygon: ['Polygon', 'MultiPolygon'].includes(
                        app.state?.selectedFeature?.getGeometry?.()?.getType?.() || ''
                    ),
                };
            }
            """
        )

        assert state["ok"], f"Unexpected app state: {state}"
        assert state["mode"] == "edit", f"Expected edit mode after Draw hole from Navigate: {state}"
        assert state["holeActive"], f"Hole draw interaction is not active: {state}"
        assert state["selectedPolygon"], f"Selected feature is not polygonal: {state}"

    def test_context_menu_draw_hole_ui_flow(self, page: Page, planimeter_base_url: str):
        """
        Pure UI flow (mouse + context menu):
        - draw a polygon
        - switch to edit mode and select it
        - right-click -> Draw hole
        - draw hole and accept preview
        - verify inner ring persisted and draft overlay is cleared
        """
        go(page, planimeter_base_url)
        page.select_option("#lang-switcher", "it")
        page.wait_for_timeout(250)

        _draw_polygon(page)

        page.click("[data-mode='edit']")
        page.wait_for_timeout(250)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None, "Map canvas bounding box unavailable"
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        # Select polygon then open context menu at the same point.
        page.mouse.click(cx, cy)
        page.wait_for_timeout(220)
        page.mouse.click(cx, cy, button="right")

        draw_hole_item = page.locator("#map-context-menu button").filter(
            has_text=re.compile(r"Disegna buco|Draw hole", re.IGNORECASE)
        ).first
        expect(draw_hole_item).to_be_visible()
        draw_hole_item.click()
        page.wait_for_timeout(220)

        # Draw a smaller hole and close with double click.
        off = 24
        page.mouse.click(cx - off, cy - off)
        page.wait_for_timeout(120)
        page.mouse.click(cx + off, cy - off)
        page.wait_for_timeout(120)
        page.mouse.click(cx + off, cy + off)
        page.wait_for_timeout(120)
        page.mouse.dblclick(cx - off, cy + off)

        expect(page.locator("#m3-refine-report")).to_be_visible()
        page.click("#btn-m3-refine-accept")
        page.wait_for_timeout(280)

        result = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                const collect = [
                    ...app.vectorSource.getFeatures(),
                    ...app.pertenenzaSource.getFeatures(),
                ];

                const candidate = collect.find((f) => {
                    const geom = f?.getGeometry?.();
                    if (!geom || geom.getType?.() !== 'Polygon') return false;
                    const coords = geom.getCoordinates?.() ?? [];
                    return Array.isArray(coords) && coords.length > 1;
                });

                const innerRingCount = candidate
                    ? Math.max(0, (candidate.getGeometry().getCoordinates?.() ?? []).length - 1)
                    : 0;

                return {
                    ok: true,
                    innerRingCount,
                    pendingPreview: Boolean(app.pendingM3Refine),
                    holeDraftCount: app.holeDraftSource.getFeatures().length,
                };
            }
            """
        )

        assert result["ok"], f"Unexpected app state: {result}"
        assert result["innerRingCount"] >= 1, f"No persisted inner ring after accept: {result}"
        assert not result["pendingPreview"], f"Preview still pending after accept: {result}"
        assert result["holeDraftCount"] == 0, f"Draft overlay not cleared after accept: {result}"

    def test_context_menu_draw_hole_outside_is_rejected(self, page: Page, planimeter_base_url: str):
        """
        Negative case:
        - draw polygon
        - start Draw hole from context menu
        - draw a hole contour that goes outside polygon bounds
        - expect rejection (no preview panel, no inner ring persisted)
        """
        go(page, planimeter_base_url)
        page.select_option("#lang-switcher", "it")
        page.wait_for_timeout(250)

        _draw_polygon(page)

        page.click("[data-mode='edit']")
        page.wait_for_timeout(250)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None, "Map canvas bounding box unavailable"
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        page.mouse.click(cx, cy)
        page.wait_for_timeout(220)
        page.mouse.click(cx, cy, button="right")

        draw_hole_item = page.locator("#map-context-menu button").filter(
            has_text=re.compile(r"Disegna buco|Draw hole", re.IGNORECASE)
        ).first
        expect(draw_hole_item).to_be_visible()
        draw_hole_item.click()
        page.wait_for_timeout(220)

        # Draw a contour intentionally larger than the original polygon.
        off = 90
        page.mouse.click(cx - off, cy - off)
        page.wait_for_timeout(120)
        page.mouse.click(cx + off, cy - off)
        page.wait_for_timeout(120)
        page.mouse.click(cx + off, cy + off)
        page.wait_for_timeout(120)
        page.mouse.dblclick(cx - off, cy + off)
        page.wait_for_timeout(350)

        # Rejected holes should not open accept/reject preview.
        expect(page.locator("#m3-refine-report")).to_be_hidden()
        expect(page.locator("#hole-draw-warning")).to_be_visible()

        status_text = page.locator("#toolbar-status").inner_text()
        assert (
            "dentro il perimetro" in status_text.lower()
            or "inside" in status_text.lower()
        ), f"Unexpected status message after outside-hole reject: {status_text}"

        result = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                const collect = [
                    ...app.vectorSource.getFeatures(),
                    ...app.pertenenzaSource.getFeatures(),
                ];

                const candidate = collect.find((f) => {
                    const geom = f?.getGeometry?.();
                    if (!geom || geom.getType?.() !== 'Polygon') return false;
                    const coords = geom.getCoordinates?.() ?? [];
                    return Array.isArray(coords) && coords.length >= 1;
                });

                const rings = candidate ? (candidate.getGeometry().getCoordinates?.() ?? []) : [];
                return {
                    ok: true,
                    innerRingCount: Array.isArray(rings) ? Math.max(0, rings.length - 1) : 0,
                    pendingPreview: Boolean(app.pendingM3Refine),
                    holeDraftCount: app.holeDraftSource.getFeatures().length,
                };
            }
            """
        )

        assert result["ok"], f"Unexpected app state: {result}"
        assert result["innerRingCount"] == 0, f"Outside-hole was persisted unexpectedly: {result}"
        assert not result["pendingPreview"], f"Preview should not remain pending: {result}"
        assert result["holeDraftCount"] == 0, f"Draft overlay not cleared after rejection: {result}"

    def test_real_parcel_hole_accept_clears_draft_overlay(self, page: Page, planimeter_base_url: str):
        """
        Real-case regression (parcel 333 containing parcel 117):
        - build outer/hole rings via backend detect endpoint
        - run hole preview pipeline
        - accept preview
        - ensure dashed draft overlay source is empty and geometry keeps inner ring
        """
        go(page, planimeter_base_url)

        result = page.evaluate(
            """
            async () => {
                const app = window.planimeterApp;
                if (!app) {
                    return { ok: false, reason: 'app-not-ready' };
                }

                const fetchRing = async (lat, lon) => {
                    const resp = await fetch('/parcel-geometry-m3', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ lat, lon, radius: 2 }),
                    });
                    if (!resp.ok) {
                        return { ok: false, status: resp.status };
                    }
                    const data = await resp.json();
                    if (!data?.ok || !Array.isArray(data?.ring) || data.ring.length < 4) {
                        return { ok: false, status: 'invalid-payload' };
                    }
                    return { ok: true, ring: data.ring };
                };

                const outer = await fetchRing(43.013727, 12.560621); // parcel 333
                const hole = await fetchRing(43.013670, 12.560484);  // parcel 117
                if (!outer.ok || !hole.ok) {
                    return { ok: false, reason: 'detect-failed', outer, hole };
                }

                const readOpts = {
                    dataProjection: 'EPSG:4326',
                    featureProjection: app.view.getProjection(),
                };

                const outerFeature = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: {
                        featureName: 'Regression-333',
                        overlayLayer: 'pertenenze',
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [outer.ring],
                    },
                }, readOpts);

                app.pertenenzaSource.addFeature(outerFeature);
                app.setEditingLayer('pertenenze');
                app.setMode('edit');
                app.state.selectedFeature = outerFeature;

                app.pendingHoleOperation = {
                    feature: outerFeature,
                    overlayLayer: 'pertenenze',
                    originalCoordinates: app.cloneGeometryCoordinates(outerFeature.getGeometry()),
                };

                const draftFeature = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'Polygon',
                        coordinates: [hole.ring],
                    },
                }, readOpts);

                app.finalizeHoleDraft(draftFeature);

                const previewPending = Boolean(app.pendingM3Refine?.operationType === 'hole');
                const beforeAcceptDraftCount = app.holeDraftSource.getFeatures().length;

                app.acceptPendingM3Refine();

                const coords = outerFeature.getGeometry()?.getCoordinates?.() ?? [];
                const innerRingCount = Array.isArray(coords) ? Math.max(0, coords.length - 1) : 0;
                const afterAcceptDraftCount = app.holeDraftSource.getFeatures().length;

                return {
                    ok: true,
                    previewPending,
                    innerRingCount,
                    beforeAcceptDraftCount,
                    afterAcceptDraftCount,
                };
            }
            """
        )

        if not result.get("ok"):
            pytest.skip(f"Real parcel detect unavailable for hole regression: {result}")

        assert result["previewPending"], f"Hole preview was not created: {result}"
        assert result["innerRingCount"] >= 1, f"Hole not persisted as inner ring: {result}"
        assert result["beforeAcceptDraftCount"] == 0, f"Draft overlay remained before accept: {result}"
        assert result["afterAcceptDraftCount"] == 0, f"Draft overlay remained after accept: {result}"


class TestDrawOverlapWorkflow:
    def test_ctrl_overlap_preview_and_merge_action(self, page: Page, planimeter_base_url: str):
        """
        Deterministic overlap workflow check (no fragile pixel clicks):
        - seed one existing polygon
        - seed a second overlapping draft polygon
        - start CTRL overlap preview programmatically
        - apply Merge action
        - verify pending preview is cleared and source contains one merged geometry
        """
        go(page, planimeter_base_url)

        result = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                app.vectorSource.clear();
                app.pertenenzaSource.clear();
                app.setEditingLayer('user');
                app.setMode('draw');

                const center = app.view.getCenter();
                const centerPx = app.map.getPixelFromCoordinate(center);
                const p = (dx, dy) => app.map.getCoordinateFromPixel([centerPx[0] + dx, centerPx[1] + dy]);

                const existing = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: { featureName: 'Existing', overlayLayer: 'user' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            p(-100, -70),
                            p(20, -70),
                            p(20, 70),
                            p(-100, 70),
                            p(-100, -70),
                        ]],
                    },
                }, {
                    dataProjection: app.view.getProjection(),
                    featureProjection: app.view.getProjection(),
                });
                app.vectorSource.addFeature(existing);

                const draft = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: { featureName: 'Draft', overlayLayer: 'user' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            p(-20, -70),
                            p(120, -70),
                            p(120, 70),
                            p(-20, 70),
                            p(-20, -70),
                        ]],
                    },
                }, {
                    dataProjection: app.view.getProjection(),
                    featureProjection: app.view.getProjection(),
                });
                app.vectorSource.addFeature(draft);

                const overlaps = app.findOverlappingPolygonFeatures(draft, app.vectorSource);
                const started = app.startDrawOverlapPreview(draft, app.vectorSource, overlaps, 'user');
                const previewVisible = !document.getElementById('m3-refine-report')?.hidden;
                const mergeVisible = !document.getElementById('btn-m3-refine-merge')?.hidden;
                if (!started) {
                    return {
                        ok: false,
                        reason: 'preview-not-started',
                        overlaps: overlaps.length,
                        previewVisible,
                        mergeVisible,
                    };
                }

                app.applyPendingDrawOverlapAction('merge');

                const features = app.vectorSource.getFeatures();
                const pending = Boolean(app.pendingM3Refine);
                return {
                    ok: true,
                    overlaps: overlaps.length,
                    previewVisible,
                    mergeVisible,
                    pending,
                    featureCount: features.length,
                    geometryTypes: features.map((f) => f.getGeometry()?.getType?.() ?? '-'),
                };
            }
            """
        )

        assert result["ok"], f"Overlap preview/merge flow failed: {result}"
        assert result["overlaps"] >= 1, f"Expected overlap candidates before preview: {result}"
        assert result["previewVisible"], f"Overlap preview panel should be visible: {result}"
        assert result["mergeVisible"], f"Merge action should be visible in overlap preview: {result}"
        assert not result["pending"], f"Preview should be cleared after merge apply: {result}"
        assert result["featureCount"] == 1, f"Merge should collapse overlap into one resulting feature: {result}"

    def test_edit_selection_tool_preview_and_merge_action(self, page: Page, planimeter_base_url: str):
        """
        Deterministic edit-selection overlap workflow:
        - seed base + operand polygon in overlap
        - arm explicit Selection tool in Edit mode
        - trigger preview from operand pixel
        - apply Merge
        - verify pending preview cleared and one merged polygon remains
        """
        go(page, planimeter_base_url)

        result = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                app.vectorSource.clear();
                app.pertenenzaSource.clear();
                app.setEditingLayer('user');
                app.setMode('edit');

                const center = app.view.getCenter();
                const centerPx = app.map.getPixelFromCoordinate(center);
                const p = (dx, dy) => app.map.getCoordinateFromPixel([centerPx[0] + dx, centerPx[1] + dy]);

                const base = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: { featureName: 'Base', overlayLayer: 'user' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            p(-120, -70),
                            p(20, -70),
                            p(20, 70),
                            p(-120, 70),
                            p(-120, -70),
                        ]],
                    },
                }, {
                    dataProjection: app.view.getProjection(),
                    featureProjection: app.view.getProjection(),
                });

                const operand = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: { featureName: 'Operand', overlayLayer: 'user' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            p(-20, -70),
                            p(120, -70),
                            p(120, 70),
                            p(-20, 70),
                            p(-20, -70),
                        ]],
                    },
                }, {
                    dataProjection: app.view.getProjection(),
                    featureProjection: app.view.getProjection(),
                });

                app.vectorSource.addFeature(base);
                app.vectorSource.addFeature(operand);
                app.state.selectedFeature = base;
                const selected = app.getActiveInteractions().select.getFeatures();
                selected.clear();
                selected.push(base);

                app.toggleEditSelectionOverlapTool();
                const armed = Boolean(app.pendingEditSelectionOverlap);

                const started = app.startEditSelectionOverlapPreview(
                    base,
                    operand,
                    app.vectorSource,
                    'user'
                );

                const previewVisible = !document.getElementById('m3-refine-report')?.hidden;
                const mergeVisible = !document.getElementById('btn-m3-refine-merge')?.hidden;

                app.applyPendingDrawOverlapAction('merge');

                const features = app.vectorSource.getFeatures();
                return {
                    ok: true,
                    armed,
                    started,
                    previewVisible,
                    mergeVisible,
                    pending: Boolean(app.pendingM3Refine),
                    featureCount: features.length,
                };
            }
            """
        )

        assert result["ok"], f"Edit selection overlap flow failed: {result}"
        assert result["armed"], f"Selection tool should be armed before target click: {result}"
        assert result["started"], f"Selection overlap preview should start from operand click: {result}"
        assert result["previewVisible"], f"Overlap preview panel should be visible: {result}"
        assert result["mergeVisible"], f"Merge action should be visible in selection overlap preview: {result}"
        assert not result["pending"], f"Preview should be cleared after merge apply: {result}"
        assert result["featureCount"] == 1, f"Merge should leave one resulting feature: {result}"


class TestVertexDeleteWorkflow:
    def _seed_polygon(self, page: Page, with_inner_ring: bool = False) -> dict:
        return page.evaluate(
            """
            ({ withInnerRing }) => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                app.vectorSource.clear();
                app.pertenenzaSource.clear();

                const center = app.view.getCenter();
                const centerPx = app.map.getPixelFromCoordinate(center);
                const p = (dx, dy) => app.map.getCoordinateFromPixel([centerPx[0] + dx, centerPx[1] + dy]);

                const outer = [
                    p(-90, -90),
                    p(90, -90),
                    p(120, 0),
                    p(90, 90),
                    p(-90, 90),
                    p(-90, -90),
                ];

                const rings = [outer];
                if (withInnerRing) {
                    const inner = [
                        p(-24, -24),
                        p(24, -24),
                        p(24, 24),
                        p(-24, 24),
                        p(-24, -24),
                    ];
                    rings.push(inner);
                }

                const feature = app.geoJsonFormat.readFeature({
                    type: 'Feature',
                    properties: { featureName: 'E2E-Vertex-Target', overlayLayer: 'user' },
                    geometry: { type: 'Polygon', coordinates: rings },
                }, {
                    dataProjection: app.view.getProjection(),
                    featureProjection: app.view.getProjection(),
                });

                app.vectorSource.addFeature(feature);
                app.setEditingLayer('user');
                app.setMode('edit');
                app.state.selectedFeature = feature;
                app.refreshEditVertexOverlay();

                const outerPxA = app.map.getPixelFromCoordinate(outer[0]);
                const outerPxB = app.map.getPixelFromCoordinate(outer[1]);
                const innerPx = withInnerRing ? app.map.getPixelFromCoordinate(rings[1][0]) : null;
                return {
                    ok: true,
                    outerPxA,
                    outerPxB,
                    innerPx,
                    beforeOpenVertices: outer.length - 1,
                    beforeRingCount: rings.length,
                };
            }
            """,
            {"withInnerRing": with_inner_ring},
        )

    def test_ctrl_multiselect_then_delete_selected(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)

        seeded = self._seed_polygon(page, with_inner_ring=False)
        assert seeded.get("ok"), f"Cannot seed polygon: {seeded}"

        result = page.evaluate(
            """
            ({ outerPxA, outerPxB, beforeOpenVertices }) => {
                const app = window.planimeterApp;
                const feature = app?.state?.selectedFeature;
                if (!app || !feature) return { ok: false, reason: 'app-not-ready' };

                const coordA = app.map.getCoordinateFromPixel(outerPxA);
                const coordB = app.map.getCoordinateFromPixel(outerPxB);
                const pickA = app.findNearestEditableVertex(feature, coordA, 12);
                const pickB = app.findNearestEditableVertex(feature, coordB, 12);
                if (!pickA || !pickB) return { ok: false, reason: 'vertex-not-found', pickA, pickB };

                app.updateVertexSelectionFromPicked(pickA, false);
                app.updateVertexSelectionFromPicked(pickB, true);
                app.requestDeleteSelectedVertex();

                const ring = feature.getGeometry()?.getCoordinates?.()?.[0] ?? [];
                return {
                    ok: true,
                    openVertices: Math.max(0, ring.length - 1),
                    expected: beforeOpenVertices - 2,
                    selectedCount: Array.isArray(app.state.selectedEditVertices) ? app.state.selectedEditVertices.length : -1,
                };
            }
            """,
            {
                "outerPxA": seeded["outerPxA"],
                "outerPxB": seeded["outerPxB"],
                "beforeOpenVertices": seeded["beforeOpenVertices"],
            },
        )

        assert result["ok"], f"Delete selected flow failed: {result}"
        assert result["openVertices"] == result["expected"], f"Unexpected vertex count after delete selected: {result}"
        assert result["selectedCount"] == 0, f"Selection should be cleared after delete selected: {result}"

    def test_delete_all_inner_ring_removes_hole(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)

        seeded = self._seed_polygon(page, with_inner_ring=True)
        assert seeded.get("ok"), f"Cannot seed polygon with hole: {seeded}"

        result = page.evaluate(
            """
            ({ innerPx, beforeRingCount }) => {
                const app = window.planimeterApp;
                const f = app?.state?.selectedFeature;
                if (!app || !f) return { ok: false, reason: 'app-not-ready' };

                const coord = app.map.getCoordinateFromPixel(innerPx);
                const pick = app.findNearestEditableVertex(f, coord, 12);
                if (!pick) return { ok: false, reason: 'inner-vertex-not-found' };

                app.updateVertexSelectionFromPicked(pick, false);
                app.promptDeleteAllSelectedVertices();
                const warningShown = !app.elements.vertexDeleteAllWarning.hidden;
                app.confirmDeleteAllSelectedVertices();

                const rings = f?.getGeometry?.()?.getCoordinates?.() ?? [];
                return {
                    ok: true,
                    expected: beforeRingCount - 1,
                    ringCount: Array.isArray(rings) ? rings.length : -1,
                    warningShown,
                    warningHidden: Boolean(app?.elements?.vertexDeleteAllWarning?.hidden),
                };
            }
            """,
            {
                "innerPx": seeded["innerPx"],
                "beforeRingCount": seeded["beforeRingCount"],
            },
        )

        assert result["ok"], f"Delete-all inner flow failed: {result}"
        assert result["warningShown"], f"Delete-all warning should be visible before accept: {result}"
        assert result["ringCount"] == result["expected"], f"Inner ring not removed by delete all: {result}"
        assert result["warningHidden"], f"Delete-all warning should be hidden after accept: {result}"

    def test_delete_all_outer_ring_deletes_feature(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)

        seeded = self._seed_polygon(page, with_inner_ring=True)
        assert seeded.get("ok"), f"Cannot seed polygon with hole: {seeded}"

        result = page.evaluate(
            """
            ({ outerPxA }) => {
                const app = window.planimeterApp;
                const f = app?.state?.selectedFeature;
                if (!app || !f) return { ok: false, reason: 'app-not-ready' };

                const coord = app.map.getCoordinateFromPixel(outerPxA);
                const pick = app.findNearestEditableVertex(f, coord, 12);
                if (!pick) return { ok: false, reason: 'outer-vertex-not-found' };

                app.updateVertexSelectionFromPicked(pick, false);
                app.promptDeleteAllSelectedVertices();
                const warningShown = !app.elements.vertexDeleteAllWarning.hidden;
                app.confirmDeleteAllSelectedVertices();

                return {
                    ok: true,
                    userCount: app?.vectorSource?.getFeatures?.().length ?? -1,
                    warningShown,
                    warningHidden: Boolean(app?.elements?.vertexDeleteAllWarning?.hidden),
                };
            }
            """,
            {
                "outerPxA": seeded["outerPxA"],
            },
        )

        assert result["ok"], f"Delete-all outer flow failed: {result}"
        assert result["warningShown"], f"Delete-all warning should be visible before accept: {result}"
        assert result["userCount"] == 0, f"Feature should be deleted when delete all targets outer ring: {result}"
        assert result["warningHidden"], f"Delete-all warning should be hidden after accept: {result}"

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


class TestPointerOverlayAndCursorState:
    def test_pointer_panel_visible_in_edit_and_gauges_populated(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("[data-mode='edit']")
        page.wait_for_timeout(180)

        panel = page.locator("#pointer-coordinates")
        expect(panel).to_be_visible()

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None
        page.mouse.move(box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.42)
        page.wait_for_timeout(180)

        values = page.evaluate(
            """
            () => ({
                coords: document.getElementById('pointer-coordinates-value')?.textContent?.trim() || '',
                vx: document.getElementById('pointer-coordinates-vx')?.textContent?.trim() || '',
                vy: document.getElementById('pointer-coordinates-vy')?.textContent?.trim() || '',
                zoom: document.getElementById('pointer-coordinates-zoom')?.textContent?.trim() || '',
            })
            """
        )

        assert "," in values["coords"], f"Coordinate value not populated: {values}"
        assert values["vx"].endswith("%") and values["vx"] != "--", f"Viewport X gauge not populated: {values}"
        assert values["vy"].endswith("%") and values["vy"] != "--", f"Viewport Y gauge not populated: {values}"
        assert values["zoom"] and values["zoom"] != "--", f"Zoom gauge not populated: {values}"

    def test_pointer_panel_freezes_during_draw_conflict(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        page.click("[data-mode='draw']")
        page.wait_for_timeout(200)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None

        page.mouse.move(box["x"] + box["width"] * 0.35, box["y"] + box["height"] * 0.35)
        page.wait_for_timeout(100)

        page.mouse.click(box["x"] + box["width"] * 0.45, box["y"] + box["height"] * 0.45)
        page.wait_for_timeout(140)

        frozen = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };
                return {
                    ok: true,
                    isDrawing: Boolean(app.state?.isDrawing),
                    coords: document.getElementById('pointer-coordinates-value')?.textContent?.trim() || '',
                    vx: document.getElementById('pointer-coordinates-vx')?.textContent?.trim() || '',
                    vy: document.getElementById('pointer-coordinates-vy')?.textContent?.trim() || '',
                };
            }
            """
        )

        assert frozen["ok"], f"Unexpected app state: {frozen}"
        assert frozen["isDrawing"], f"Expected draw in progress: {frozen}"
        assert frozen["coords"] == "--, --", f"Coordinates should freeze placeholder while drawing: {frozen}"
        assert frozen["vx"] == "--", f"Viewport X should freeze placeholder while drawing: {frozen}"
        assert frozen["vy"] == "--", f"Viewport Y should freeze placeholder while drawing: {frozen}"

        page.keyboard.press("Escape")

    def test_cursor_class_changes_by_mode(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)

        states = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };
                const viewport = app.map?.getViewport?.();
                if (!viewport) return { ok: false, reason: 'viewport-missing' };

                const hasClass = (name) => viewport.classList.contains(name);

                app.setMode('navigate');
                const nav = hasClass('map-cursor-navigate');

                app.setMode('draw');
                const draw = hasClass('map-cursor-draw');

                app.setMode('delete');
                const del = hasClass('map-cursor-delete');

                app.setMode('edit');
                app.pendingEditSelectionOverlap = { baseFeature: null, overlayLayer: 'user', source: app.vectorSource };
                app.applyMapCursorState();
                const editSelection = hasClass('map-cursor-edit-selection');
                app.pendingEditSelectionOverlap = null;
                app.applyMapCursorState();

                return { ok: true, nav, draw, del, editSelection };
            }
            """
        )

        assert states["ok"], f"Cursor state probe failed: {states}"
        assert states["nav"], f"Navigate cursor class missing: {states}"
        assert states["draw"], f"Draw cursor class missing: {states}"
        assert states["del"], f"Delete cursor class missing: {states}"
        assert states["editSelection"], f"Edit-selection cursor class missing: {states}"

    def test_pointer_gauge_legend_it_en_labels(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)

        labels_it = page.evaluate(
            """
            () => Array.from(document.querySelectorAll('#pointer-coordinates .pointer-legend__item span:last-child'))
                .map((el) => (el.textContent || '').trim())
            """
        )
        assert labels_it == ["Basso", "Medio", "Alto"], f"Unexpected IT legend labels: {labels_it}"

        page.select_option("#lang-switcher", "en")
        page.wait_for_timeout(250)

        labels_en = page.evaluate(
            """
            () => Array.from(document.querySelectorAll('#pointer-coordinates .pointer-legend__item span:last-child'))
                .map((el) => (el.textContent || '').trim())
            """
        )
        assert labels_en == ["Low", "Mid", "High"], f"Unexpected EN legend labels: {labels_en}"

    def test_pointer_panel_hides_during_export_selection_and_restores(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)

        state = page.evaluate(
            """
            () => {
                const app = window.planimeterApp;
                if (!app) return { ok: false, reason: 'app-not-ready' };

                const panel = document.getElementById('pointer-coordinates');
                if (!panel) return { ok: false, reason: 'panel-missing' };

                const beforeHidden = panel.hidden;

                app.startSelectionExportMode();
                const duringHidden = panel.hidden;
                const exportActive = Boolean(app.selectionExport?.active);

                app.cancelSelectionExportMode(false);
                const afterHidden = panel.hidden;
                const exportCleared = !app.selectionExport;

                return {
                    ok: true,
                    beforeHidden,
                    duringHidden,
                    afterHidden,
                    exportActive,
                    exportCleared,
                };
            }
            """
        )

        assert state["ok"], f"Unexpected app state: {state}"
        assert not state["beforeHidden"], f"Pointer panel should be visible before export selection: {state}"
        assert state["duringHidden"], f"Pointer panel should hide while export selection is active: {state}"
        assert state["exportActive"], f"Export selection should be active during hide check: {state}"
        assert not state["afterHidden"], f"Pointer panel should restore after export selection cancel: {state}"
        assert state["exportCleared"], f"Export selection state should be cleared after cancel: {state}"


class TestPointerPanelVisualSmoke:
    def test_pointer_panel_screenshot_desktop(self, page: Page, planimeter_base_url: str):
        page.set_viewport_size({"width": 1366, "height": 768})
        go(page, planimeter_base_url)

        page.click("[data-mode='edit']")
        page.wait_for_timeout(180)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None
        page.mouse.move(box["x"] + box["width"] * 0.52, box["y"] + box["height"] * 0.46)
        page.wait_for_timeout(160)

        panel = page.locator("#pointer-coordinates")
        expect(panel).to_be_visible()
        shot = panel.screenshot(type="png")
        assert len(shot) > 1200, "Pointer panel desktop screenshot seems empty"

    def test_pointer_panel_screenshot_mobile(self, page: Page, planimeter_base_url: str):
        page.set_viewport_size({"width": 390, "height": 844})
        go(page, planimeter_base_url)

        page.click("[data-mode='edit']")
        page.wait_for_timeout(180)

        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box is not None
        page.mouse.move(box["x"] + box["width"] * 0.58, box["y"] + box["height"] * 0.44)
        page.wait_for_timeout(160)

        panel = page.locator("#pointer-coordinates")
        expect(panel).to_be_visible()
        shot = panel.screenshot(type="png")
        assert len(shot) > 1000, "Pointer panel mobile screenshot seems empty"


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
