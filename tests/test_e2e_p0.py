"""P0 E2E tests via Playwright.

Covers:
- App loads, map renders, toolbar visible
- Layer group A mutual exclusion (base layers)
- Layer group B mutual exclusion (admin layers)
- Tool buttons switch active state
- Locale switch IT → EN (toolbar text changes)
- Draw polygon → GeoJSON export contains the polygon
- Hover hints (title attributes) present on tool buttons
- Settings tab accessible
"""

import json

import pytest
from playwright.sync_api import Page, expect

APP_PATH = "/planimeter.html"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def app_url(base: str) -> str:
    return base + APP_PATH


# ---------------------------------------------------------------------------
# Smoke: app loads
# ---------------------------------------------------------------------------

class TestAppLoads:
    def test_page_title(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        import re
        expect(page).to_have_title(re.compile(r"Project Planimeter", re.IGNORECASE))

    def test_map_canvas_visible(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        canvas = page.locator("canvas").first
        expect(canvas).to_be_visible()

    def test_toolbar_visible(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        expect(page.locator("#tab-operate")).to_be_visible()

    def test_no_js_errors(self, page: Page, planimeter_base_url: str):
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.goto(app_url(planimeter_base_url))
        page.wait_for_timeout(1500)
        assert errors == [], f"JS errors on load: {errors}"


# ---------------------------------------------------------------------------
# Layer groups mutual exclusion
# ---------------------------------------------------------------------------

class TestLayerGroups:
    def _goto(self, page: Page, base: str) -> None:
        page.goto(app_url(base))
        page.wait_for_load_state("networkidle")

    def test_group_a_only_one_active(self, page: Page, planimeter_base_url: str):
        """Clicking a group-A layer deactivates the current one."""
        self._goto(page, planimeter_base_url)
        sat = page.locator("#layer-sat")
        topo = page.locator("#layer-open-topo")

        # Sat is checked by default; click Topo → sat should uncheck
        expect(sat).to_be_checked()
        topo.click()
        page.wait_for_timeout(300)
        expect(topo).to_be_checked()
        expect(sat).not_to_be_checked()

    def test_group_a_max_one_at_any_time(self, page: Page, planimeter_base_url: str):
        """No two base layers checked simultaneously."""
        self._goto(page, planimeter_base_url)
        base_checkboxes = page.locator("[data-layer-group='base']")
        for cb in [page.locator("#layer-esri-topo"), page.locator("#layer-esri-relief")]:
            cb.click()
            page.wait_for_timeout(200)
            checked = [
                base_checkboxes.nth(i).is_checked()
                for i in range(base_checkboxes.count())
            ]
            assert checked.count(True) <= 1, f"Multiple base layers active: {checked}"

    def test_group_b_mutual_exclusion(self, page: Page, planimeter_base_url: str):
        """Enabling OSM then catasto should leave at most one group-B layer active."""
        self._goto(page, planimeter_base_url)
        osm = page.locator("#layer-osm")
        catasto = page.locator("#layer-catasto")

        osm.click()
        page.wait_for_timeout(200)
        catasto.click()
        page.wait_for_timeout(200)

        assert not osm.is_checked() or not catasto.is_checked(), \
            "Both OSM and Catasto checked simultaneously"

    def test_total_active_layers_never_exceed_two(self, page: Page, planimeter_base_url: str):
        """At any point there can be max 1 base + max 1 admin layer enabled."""
        self._goto(page, planimeter_base_url)

        base_ids = ["#layer-sat", "#layer-open-topo", "#layer-esri-topo", "#layer-esri-relief"]
        admin_ids = ["#layer-osm", "#layer-catasto"]

        for base_id in base_ids:
            page.locator(base_id).click()
            page.wait_for_timeout(120)
            for admin_id in admin_ids:
                page.locator(admin_id).click()
                page.wait_for_timeout(120)

                active_base = sum(page.locator(sel).is_checked() for sel in base_ids)
                active_admin = sum(page.locator(sel).is_checked() for sel in admin_ids)
                assert active_base <= 1, f"More than one base layer active: {active_base}"
                assert active_admin <= 1, f"More than one admin layer active: {active_admin}"
                assert (active_base + active_admin) <= 2, \
                    f"More than two total layers active: base={active_base} admin={active_admin}"


# ---------------------------------------------------------------------------
# Tool buttons
# ---------------------------------------------------------------------------

class TestToolButtons:
    def _goto(self, page: Page, base: str) -> None:
        page.goto(app_url(base))
        page.wait_for_load_state("networkidle")

    def test_default_active_tool_is_navigate(self, page: Page, planimeter_base_url: str):
        self._goto(page, planimeter_base_url)
        navigate_btn = page.locator("[data-mode='navigate']")
        expect(navigate_btn).to_have_attribute("aria-pressed", "true")

    def test_clicking_draw_activates_it(self, page: Page, planimeter_base_url: str):
        self._goto(page, planimeter_base_url)
        draw_btn = page.locator("[data-mode='draw']")
        draw_btn.click()
        page.wait_for_timeout(200)
        expect(draw_btn).to_have_attribute("aria-pressed", "true")
        expect(page.locator("[data-mode='navigate']")).to_have_attribute("aria-pressed", "false")

    def test_tool_buttons_have_title_hint(self, page: Page, planimeter_base_url: str):
        self._goto(page, planimeter_base_url)
        for mode in ("navigate", "draw", "edit", "delete"):
            btn = page.locator(f"[data-mode='{mode}']")
            title = btn.get_attribute("title")
            assert title and len(title) > 2, f"No title hint on {mode} button"


# ---------------------------------------------------------------------------
# Locale switch
# ---------------------------------------------------------------------------

class TestLocaleSwitch:
    def test_switch_to_english(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        page.wait_for_load_state("networkidle")

        # Switch to EN via lang-switcher
        page.select_option("#lang-switcher", "en")
        page.wait_for_timeout(400)

        tab_text = page.locator("#tab-operate").inner_text()
        # In EN it should say "Operate" or similar (not "Operativo")
        assert "Operativo" not in tab_text, f"Locale did not switch to EN: tab text='{tab_text}'"

    def test_switch_back_to_italian(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        page.wait_for_load_state("networkidle")

        page.select_option("#lang-switcher", "en")
        page.wait_for_timeout(300)
        page.select_option("#lang-switcher", "it")
        page.wait_for_timeout(300)

        tab_text = page.locator("#tab-operate").inner_text()
        assert "Operativo" in tab_text, f"Locale did not switch back to IT: '{tab_text}'"


# ---------------------------------------------------------------------------
# Settings tab
# ---------------------------------------------------------------------------

class TestSettingsTab:
    def test_settings_tab_opens(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        page.wait_for_load_state("networkidle")
        page.click("#tab-settings")
        page.wait_for_timeout(300)
        panel = page.locator("#panel-settings")
        cls = panel.get_attribute("class") or ""
        assert "is-active" in cls, f"Settings panel not active after click, class='{cls}'"

    def test_settings_panel_visible_after_click(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        page.wait_for_load_state("networkidle")
        page.click("#tab-settings")
        page.wait_for_timeout(300)
        lang_select = page.locator("#settings-language")
        expect(lang_select).to_be_visible()


# ---------------------------------------------------------------------------
# Draw polygon → GeoJSON export
# ---------------------------------------------------------------------------

class TestDrawAndExport:
    def test_draw_polygon_and_export_geojson(self, page: Page, planimeter_base_url: str):
        """
        Draw a simple polygon by clicking on the map, close it,
        then export as GeoJSON and verify the download contains a polygon feature.
        """
        page.goto(app_url(planimeter_base_url))
        page.wait_for_load_state("networkidle")

        # Switch to Draw mode
        page.click("[data-mode='draw']")
        page.wait_for_timeout(300)

        # Click 4 points on the map canvas to form a quadrilateral, then double-click to close
        canvas = page.locator("canvas").first
        box = canvas.bounding_box()
        assert box, "Map canvas not found"
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        offset = 60

        page.mouse.click(cx - offset, cy - offset)
        page.wait_for_timeout(150)
        page.mouse.click(cx + offset, cy - offset)
        page.wait_for_timeout(150)
        page.mouse.click(cx + offset, cy + offset)
        page.wait_for_timeout(150)
        page.mouse.dblclick(cx - offset, cy + offset)
        page.wait_for_timeout(400)

        # Set export format to GeoJSON (should be default)
        page.select_option("#export-format", "geojson")

        # Trigger export and capture download
        with page.expect_download(timeout=8000) as dl_info:
            page.click("#btn-export")
        download = dl_info.value

        path = download.path()
        assert path, "Download did not complete"
        content = open(path, encoding="utf-8").read()
        data = json.loads(content)

        assert data.get("type") == "FeatureCollection", "Not a FeatureCollection"
        features = data.get("features", [])
        assert len(features) >= 1, "No features in exported GeoJSON"

        geom_types = {f["geometry"]["type"] for f in features}
        assert "Polygon" in geom_types or "MultiPolygon" in geom_types, \
            f"No polygon geometry found, got: {geom_types}"
