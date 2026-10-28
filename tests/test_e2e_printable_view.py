"""E2E tests for the Printable View (Vista Stampabile) feature.

Covers:
- Presence and accessibility of #btn-print-view in the toolbar.
- Opening #print-preview-modal dialog.
- Default values (paper format A4 landscape, season title, compact surface format).
- Spinner hides cleanly after rendering without blocking preview.
- Interactive controls (paper format switcher, oriented labels, merge contiguous, title editing).
- Canvas composition and high-res rendering.
- Suppression of web labels during printable composition so only printable labels appear.
- Triggering PNG download and Print sheet population.
- Modal closure via Cancel and Close button.
"""

import re
import pytest
from playwright.sync_api import Page, expect

APP_PATH = "/planimeter.html"


def app_url(base: str) -> str:
    return base + APP_PATH


class TestPrintableView:
    def test_button_present_in_toolbar(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        btn = page.locator("#btn-print-view")
        expect(btn).to_be_visible()
        expect(btn).to_be_enabled()
        expect(btn).to_contain_text("Vista stampabile")

    def test_open_and_close_modal(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        modal = page.locator("#print-preview-modal")
        expect(modal).not_to_have_attribute("open", "")

        # Open modal
        page.click("#btn-print-view")
        expect(modal).to_have_attribute("open", "")

        # Title check
        header_title = page.locator(".print-preview-dialog__header-title strong")
        expect(header_title).to_contain_text("Esporta Vista Stampabile")

        # Verify title input prefilled with Coltivazioni
        title_input = page.locator("#print-preview-title")
        expect(title_input).to_be_visible()
        val = title_input.input_value()
        assert "Coltivazioni" in val, f"Expected Coltivazioni in title, got: {val}"

        # Close via Close button (X)
        page.click("#btn-print-preview-close")
        page.wait_for_timeout(200)
        expect(modal).not_to_have_attribute("open", "")

        # Re-open and close via Cancel button in footer
        page.click("#btn-print-view")
        expect(modal).to_have_attribute("open", "")
        page.click("#btn-print-preview-cancel")
        page.wait_for_timeout(200)
        expect(modal).not_to_have_attribute("open", "")

    def test_controls_and_canvas_composition(self, page: Page, planimeter_base_url: str):
        js_errors: list[str] = []
        page.on("pageerror", lambda err: js_errors.append(str(err)))

        page.goto(app_url(planimeter_base_url))
        page.click("#btn-print-view")
        page.wait_for_timeout(400)

        canvas = page.locator("#print-preview-canvas")
        expect(canvas).to_be_visible()

        # Check spinner hides and does not block canvas
        spinner = page.locator("#print-preview-spinner")
        expect(spinner).to_be_hidden()

        # Check default format
        format_select = page.locator("#print-preview-format")
        expect(format_select).to_have_value("a4-landscape")

        # Check surface format selector default (compact)
        surface_select = page.locator("#print-preview-surface-format")
        expect(surface_select).to_have_value("compact")

        # Check all default toggles
        expect(page.locator("#print-preview-opt-satellite-fade")).to_be_checked()
        expect(page.locator("#print-preview-opt-catasto")).to_be_checked()
        expect(page.locator("#print-preview-opt-labels")).to_be_checked()
        expect(page.locator("#print-preview-opt-oriented")).to_be_checked()
        expect(page.locator("#print-preview-opt-merge-contiguous")).to_be_checked()
        expect(page.locator("#print-preview-opt-pac")).to_be_checked()
        expect(page.locator("#print-preview-opt-legend")).to_be_checked()

        # Switch surface format to unit (m²/ha)
        surface_select.select_option("unit")
        page.wait_for_timeout(300)

        # Switch format to A3 Landscape
        format_select.select_option("a3-landscape")
        page.wait_for_timeout(300)

        # Switch format to Viewport
        format_select.select_option("viewport")
        page.wait_for_timeout(300)

        # Edit title
        title_input = page.locator("#print-preview-title")
        title_input.fill("Azienda Agricola BalTac - Piano Colturale 2026")
        page.wait_for_timeout(300)

        # Toggle oriented and merge-contiguous off and on
        page.uncheck("#print-preview-opt-merge-contiguous")
        page.wait_for_timeout(300)
        page.check("#print-preview-opt-merge-contiguous")
        page.wait_for_timeout(300)

        page.uncheck("#print-preview-opt-oriented")
        page.wait_for_timeout(300)
        page.check("#print-preview-opt-oriented")
        page.wait_for_timeout(300)

        # Toggle satellite fade off and on
        page.uncheck("#print-preview-opt-satellite-fade")
        page.wait_for_timeout(300)
        page.check("#print-preview-opt-satellite-fade")
        page.wait_for_timeout(300)

        # Verify no runtime JavaScript exceptions occurred
        assert js_errors == [], f"JavaScript errors during canvas composition: {js_errors}"

    def test_web_labels_suppressed_for_clean_print_composite(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        res = page.evaluate("""
            async () => {
                const app = window.planimeterApp;
                const { default: Feature } = await import('ol/Feature.js');
                const { default: Polygon } = await import('ol/geom/Polygon.js');

                const f = new Feature({
                    geometry: new Polygon([[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]),
                });
                f.set('featureName', 'TestField');
                f.set('overlayLayer', 'user');
                app.vectorSource.addFeature(f);

                const normalStyles = app.featureStyle(f);
                const hasLabelNormal = normalStyles.some(s => Boolean(s.getText?.()?.getText?.()));

                app.state.suppressFeatureLabels = true;
                const suppressedStyles = app.featureStyle(f);
                const hasLabelSuppressed = suppressedStyles.some(s => Boolean(s.getText?.()?.getText?.()));
                app.state.suppressFeatureLabels = false;

                return { hasLabelNormal, hasLabelSuppressed };
            }
        """)
        assert res["hasLabelNormal"] is True, "Normal vector style should render text label"
        assert res["hasLabelSuppressed"] is False, "Suppressed vector style must not render text label"

    def test_download_png_trigger(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))
        page.click("#btn-print-view")
        page.wait_for_timeout(400)

        # Verify download button is present
        btn_download = page.locator("#btn-print-preview-download")
        expect(btn_download).to_be_visible()

        with page.expect_download() as download_info:
            btn_download.click()
        download = download_info.value
        assert download.suggested_filename.startswith("planimeter-mappa-stampabile-")
        assert download.suggested_filename.endswith(".png")

    def test_print_sheet_population(self, page: Page, planimeter_base_url: str):
        page.goto(app_url(planimeter_base_url))

        # Mock window.print to prevent browser hanging on print dialog
        page.evaluate("window.print = () => { window.__printCalled = true; };")

        page.click("#btn-print-view")
        page.wait_for_timeout(400)

        btn_print = page.locator("#btn-print-preview-print")
        expect(btn_print).to_be_visible()
        btn_print.click()

        # Wait for the print image to be populated with base64 data
        page.wait_for_timeout(250)
        img_src = page.locator("#printable-print-img").get_attribute("src") or ""
        assert img_src.startswith("data:image/png;base64,"), f"Expected data URL on print image, got: {img_src[:40]}"

        # Verify mock print was called
        print_called = page.evaluate("() => Boolean(window.__printCalled)")
        assert print_called is True, "window.print() was not invoked"
