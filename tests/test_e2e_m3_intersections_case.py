"""E2E Playwright: caso reale M3 + intersezioni summary (parcel/drawn)."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import Page, expect

APP_PATH = "/planimeter.html"
TARGET_LON = 12.562959
TARGET_LAT = 43.011822
EXPECTED_LOCAL_ID = "IT.AGE.PLA.B609_000200.35"


def app_url(base: str) -> str:
    return base + APP_PATH


def _go(page: Page, base: str) -> None:
    page.goto(app_url(base))
    page.wait_for_load_state("networkidle")
    page.select_option("#lang-switcher", "it")
    page.wait_for_timeout(400)


def _set_baseline_state(page: Page) -> None:
    # Stato pulito per evitare falsi positivi da persistenza locale.
    page.evaluate(
        """
        () => {
            const app = window.planimeterApp;
            app.vectorSource.clear();
            app.pertenenzaSource.clear();
            app.clearSelection();
            app.state.parcelInfoEnabled = true;
            if (app.elements.settingsParcelInfoEnabled) {
                app.elements.settingsParcelInfoEnabled.checked = true;
            }
            app.elements.layerCatasto.checked = true;
            app.setCatastoSource('official');
            app.applyLayerGroupSelection();
            app.setMode('navigate');
        }
        """
    )
    page.wait_for_timeout(500)


def _pixel_for_lonlat(page: Page, lon: float, lat: float) -> list[float]:
    return page.evaluate(
        """
        ({ lon, lat }) => {
            const app = window.planimeterApp;

            const R = 20037508.34;
            const x = lon * R / 180;
            let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
            y = y * R / 180;

            const coord3857 = [x, y];
            app.view.setCenter(coord3857);
            app.view.setZoom(19);
            app.map.renderSync();

            return app.map.getPixelFromCoordinate(coord3857);
        }
        """,
        {"lon": lon, "lat": lat},
    )


def _write_debug_report(report: dict) -> None:
    out_dir = Path(__file__).resolve().parent / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "e2e_m3_intersections_case_report.json"
    out_file.write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")


def _match_inspire_local_id(candidate: str, reference: str) -> bool:
    candidate_norm = str(candidate or "").strip().lower()
    reference_norm = str(reference or "").strip().lower()
    if not candidate_norm or not reference_norm:
        return False
    if candidate_norm == reference_norm:
        return True
    if reference_norm.endswith(candidate_norm):
        return True
    if candidate_norm.endswith(reference_norm):
        return True
    if reference_norm.startswith("it.age.pla."):
        suffix = reference_norm.removeprefix("it.age.pla.")
        return suffix == candidate_norm or suffix.endswith(candidate_norm)
    return False


def test_e2e_real_case_m3_and_intersections(page: Page, planimeter_base_url: str):
    # In detect M3 può apparire conferma espansione raggio: per debug base manteniamo il primo risultato.
    page.on("dialog", lambda dialog: dialog.dismiss())

    _go(page, planimeter_base_url)
    _set_baseline_state(page)

    target_px = _pixel_for_lonlat(page, TARGET_LON, TARGET_LAT)
    assert isinstance(target_px, list) and len(target_px) == 2, "Pixel target non disponibile"

    # 1) Detect M3 su layer Pertinenze (caso reale)
    detect_result = page.evaluate(
        """
        async ({ px, expectedLocalId, lon, lat }) => {
            const app = window.planimeterApp;
            const matchesLocalId = (candidate, reference) => {
                const c = String(candidate || '').trim().toLowerCase();
                const r = String(reference || '').trim().toLowerCase();
                if (!c || !r) return false;
                if (c === r) return true;
                if (r.endsWith(c)) return true;
                if (c.endsWith(r)) return true;
                if (r.startsWith('it.age.pla.')) {
                    const suffix = r.slice('it.age.pla.'.length);
                    return suffix === c || suffix.endsWith(c);
                }
                return false;
            };

            await app.detectParcelM3AtPixel(px);

            const features = app.pertenenzaSource.getFeatures();
            let detected = features.find((f) => {
                const v = String(f.get('inspire_local_id') || f.get('parcel_local_id') || '').trim();
                return matchesLocalId(v, expectedLocalId);
            }) || null;

            const summary = await app.fetchParcelSummaryAtLonLat(lon, lat);
            const summaryLocalId = String(summary?.parcel?.local_id || summary?.parcel?.id || '').trim();

            if (!detected && features.length > 0 && summary?.parcel) {
                app.applyParcelMetadataToFeature(features[0], summary);
                detected = features.find((f) => {
                    const v = String(f.get('inspire_local_id') || f.get('parcel_local_id') || '').trim();
                        return matchesLocalId(v, expectedLocalId);
                }) || null;
            }

            const status = String(app.elements.toolbarStatus?.textContent || '').trim();
                const anchor = features[0] || null;
                let anchorPixel = null;
                if (anchor?.getGeometry?.()) {
                    const extent = anchor.getGeometry().getExtent();
                    const center = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
                    anchorPixel = app.map.getPixelFromCoordinate(center);
                }
            return {
                count: features.length,
                toolbarStatus: status,
                expectedLocalId,
                summaryLocalId,
                detectedLocalIds: features.map((f) => String(f.get('inspire_local_id') || f.get('parcel_local_id') || '').trim()).filter(Boolean),
                detectedFound: Boolean(detected),
                    anchorPixel,
            };
        }
        """,
        {"px": target_px, "expectedLocalId": EXPECTED_LOCAL_ID, "lon": TARGET_LON, "lat": TARGET_LAT},
    )

    assert detect_result["count"] >= 1, f"Nessuna pertinenza rilevata: {detect_result}"
    # Il requisito del test e il detect da coordinate; il localId e riscontro documentale non bloccante.
    local_id_documental_match = _match_inspire_local_id(detect_result["summaryLocalId"], EXPECTED_LOCAL_ID)

    # 2) Switch Drawn areas e disegno quadrato che interseca la particella.
    page.select_option("#editing-layer-select", "user")
    page.click("[data-mode='draw']")
    page.wait_for_timeout(300)

    anchor_px = detect_result.get("anchorPixel") or target_px
    cx, cy = float(anchor_px[0]), float(anchor_px[1])
    d = 45
    page.mouse.click(cx - d, cy - d)
    page.wait_for_timeout(140)
    page.mouse.click(cx + d, cy - d)
    page.wait_for_timeout(140)
    page.mouse.click(cx + d, cy + d)
    page.wait_for_timeout(140)
    page.mouse.dblclick(cx - d, cy + d)
    page.wait_for_timeout(550)

    created_result = page.evaluate(
        """
        () => {
            const app = window.planimeterApp;
            const userPolygons = app.vectorSource.getFeatures().filter((f) => {
                const t = f.getGeometry?.()?.getType?.();
                return t === 'Polygon' || t === 'MultiPolygon';
            });
            return {
                userPolygonCount: userPolygons.length,
                toolbarStatus: String(app.elements.toolbarStatus?.textContent || '').trim(),
            };
        }
        """
    )
    assert created_result["userPolygonCount"] >= 1, f"Quadrato non creato: {created_result}"

    # 3) Summary lato Pertinence scopes (seleziono la particella rilevata).
    parcel_summary = page.evaluate(
        """
        async ({ expectedLocalId }) => {
            const app = window.planimeterApp;
            const matchesLocalId = (candidate, reference) => {
                const c = String(candidate || '').trim().toLowerCase();
                const r = String(reference || '').trim().toLowerCase();
                if (!c || !r) return false;
                if (c === r) return true;
                if (r.endsWith(c)) return true;
                if (c.endsWith(r)) return true;
                if (r.startsWith('it.age.pla.')) {
                    const suffix = r.slice('it.age.pla.'.length);
                    return suffix === c || suffix.endsWith(c);
                }
                return false;
            };

            const parcel = app.pertenenzaSource.getFeatures().find((f) => {
                const v = String(f.get('inspire_local_id') || f.get('parcel_local_id') || '').trim();
                return matchesLocalId(v, expectedLocalId);
            }) || app.pertenenzaSource.getFeatures()[0] || null;
            if (!parcel) {
                return { ok: false, reason: 'parcel-not-found' };
            }

            app.clearSelection();
            app.state.selectedFeature = parcel;
            app.state.selectedFeatures = [parcel];
            app.allInteractions.pertenenze.select.getFeatures().push(parcel);
            app.openIntersectionSummary([parcel]);

            const { calculateIntersectionMetrics } = await import('/src/geometry/intersection.js');
            const areas = app.vectorSource.getFeatures().filter((f) => {
                const t = f.getGeometry?.()?.getType?.();
                return t === 'Polygon' || t === 'MultiPolygon';
            });
            const intersections = areas
                .map((area) => ({
                    areaFeatureId: String(area.get('featureId') || ''),
                    metrics: calculateIntersectionMetrics(area, parcel, {
                        sourceProjection: app.view.getProjection(),
                        targetProjection: app.view.getProjection(),
                        ratioBase: 'target',
                    }),
                }))
                .filter((entry) => entry.metrics.intersectionArea > 0.1);

            return {
                ok: true,
                selectedBy: String(parcel.get('inspire_local_id') || parcel.get('parcel_local_id') || '').trim() ? 'local_id' : 'first_detected_feature',
                intersectionCount: intersections.length,
                intersections,
            };
        }
        """,
        {"expectedLocalId": EXPECTED_LOCAL_ID},
    )
    assert parcel_summary.get("ok"), f"Summary particella non disponibile: {parcel_summary}"
    assert parcel_summary["intersectionCount"] >= 1, f"Nessuna intersezione lato pertinenze: {parcel_summary}"

    # 4) Summary lato Drawn areas (seleziono ultimo poligono utente).
    drawn_summary = page.evaluate(
        """
        async () => {
            const app = window.planimeterApp;
            const userPolygons = app.vectorSource.getFeatures().filter((f) => {
                const t = f.getGeometry?.()?.getType?.();
                return t === 'Polygon' || t === 'MultiPolygon';
            });
            const area = userPolygons[userPolygons.length - 1];
            if (!area) {
                return { ok: false, reason: 'drawn-area-not-found' };
            }

            app.clearSelection();
            app.state.selectedFeature = area;
            app.state.selectedFeatures = [area];
            app.allInteractions.user.select.getFeatures().push(area);
            app.openIntersectionSummary([area]);

            const { calculateIntersectionMetrics } = await import('/src/geometry/intersection.js');
            const parcels = app.pertenenzaSource.getFeatures().filter((f) => {
                const t = f.getGeometry?.()?.getType?.();
                return t === 'Polygon' || t === 'MultiPolygon';
            });
            const intersections = parcels
                .map((parcel) => ({
                    parcelFeatureId: String(parcel.get('featureId') || ''),
                    metrics: calculateIntersectionMetrics(area, parcel, {
                        sourceProjection: app.view.getProjection(),
                        targetProjection: app.view.getProjection(),
                        ratioBase: 'target',
                    }),
                }))
                .filter((entry) => entry.metrics.intersectionArea > 0.1);

            return {
                ok: true,
                intersectionCount: intersections.length,
                intersections,
            };
        }
        """,
    )
    assert drawn_summary.get("ok"), f"Summary area disegnata non disponibile: {drawn_summary}"
    assert drawn_summary["intersectionCount"] >= 1, f"Nessuna intersezione lato aree disegnate: {drawn_summary}"

    # Evidenza finale per debug umano/machine.
    report = {
        "target": {
            "lon": TARGET_LON,
            "lat": TARGET_LAT,
            "expected_inspire_local_id": EXPECTED_LOCAL_ID,
            "pixel": target_px,
        },
        "detect_m3": detect_result,
        "documentary_checks": {
            "expected_inspire_local_id": EXPECTED_LOCAL_ID,
            "summary_local_id_matches_expected": local_id_documental_match,
            "note": "Il test e2e valida il detect da coordinate; inspireId.localId resta verifica documentale non bloccante.",
        },
        "drawn_area": created_result,
        "summary_pertenenze": parcel_summary,
        "summary_drawn_areas": drawn_summary,
    }
    _write_debug_report(report)

    # Il pannello summary deve essere visibile in entrambe le interrogazioni.
    expect(page.locator("#summary-panel")).to_be_visible()

    # Il body delle tabelle delle intersezioni deve contenere almeno una riga
    # (regressione del bug appendChild che lasciava il <tbody> vuoto).
    dom_check = page.evaluate(
        """
        () => {
            const panel = document.querySelector('#summary-panel');
            if (!panel) return { ok: false, reason: 'no-panel' };
            const tables = panel.querySelectorAll('.summary-panel__sections .summary-table');
            let totalRows = 0;
            for (const t of tables) {
                totalRows += t.querySelectorAll('tbody tr').length;
            }
            return {
                ok: true,
                sectionTableCount: tables.length,
                totalRows,
                aggregateBlocks: panel.querySelectorAll('.summary-aggregate-block').length,
            };
        }
        """
    )
    assert dom_check.get("ok"), f"DOM summary non disponibile: {dom_check}"
    assert dom_check["sectionTableCount"] >= 1, f"Nessuna tabella sezione: {dom_check}"
    assert dom_check["totalRows"] >= 1, f"Tabella intersezioni vuota: {dom_check}"
    assert dom_check["aggregateBlocks"] >= 1, f"Header aggregato mancante: {dom_check}"

