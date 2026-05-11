"""P4 geometry engine tests: intersection metrics and cadastral geometry cache."""

import pytest
from playwright.sync_api import Page


APP_PATH = "/planimeter.html"


def app_url(base: str) -> str:
    return base + APP_PATH


def go(page: Page, base: str) -> None:
    page.goto(app_url(base))
    page.wait_for_load_state("networkidle")


class TestIntersectionEngine:
    def test_polygon_intersection_metrics(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        result = page.evaluate(
            """
            async () => {
                const mod = await import('/src/geometry/intersection.js');
                const subject = {
                    type: 'Polygon',
                    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
                };
                const target = {
                    type: 'Polygon',
                    coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]],
                };
                return mod.calculateIntersectionMetrics(subject, target, { ratioBase: 'target' });
            }
            """
        )

        assert round(result["subjectArea"], 6) == 100
        assert round(result["targetArea"], 6) == 100
        assert round(result["intersectionArea"], 6) == 25
        assert round(result["coverageRatio"], 6) == 0.25
        assert round(result["coverageRatioSubject"], 6) == 0.25
        assert round(result["coverageRatioTarget"], 6) == 0.25

    def test_cadastral_geometry_cache_reuses_geometry(self, page: Page, planimeter_base_url: str):
        go(page, planimeter_base_url)
        result = page.evaluate(
            """
            async () => {
                const mod = await import('/src/geometry/intersection.js');
                mod.clearCadastralGeometryCache();

                const subject = {
                    type: 'Polygon',
                    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
                };
                const cachedGeometry = {
                    type: 'Polygon',
                    coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]],
                };

                let providerCalls = 0;
                const first = mod.calculateIntersectionMetricsWithCache(
                    subject,
                    'parcel-123',
                    () => {
                        providerCalls += 1;
                        return cachedGeometry;
                    },
                    { ratioBase: 'target' },
                );
                const second = mod.calculateIntersectionMetricsWithCache(
                    subject,
                    'parcel-123',
                    () => {
                        providerCalls += 1;
                        return cachedGeometry;
                    },
                    { ratioBase: 'target' },
                );

                return {
                    providerCalls,
                    first,
                    second,
                    stats: mod.getCadastralGeometryCacheStats(),
                };
            }
            """
        )

        assert result["providerCalls"] == 1
        assert round(result["first"]["intersectionArea"], 6) == 25
        assert round(result["second"]["intersectionArea"], 6) == 25
        assert result["stats"]["count"] == 1
        assert result["stats"]["misses"] == 1
        assert result["stats"]["hits"] == 1
