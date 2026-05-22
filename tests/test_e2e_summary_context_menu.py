"""E2E Playwright: 4 scenari del context menu summary (Alternativa C stack-aware).

Scenari coperti:
 1. Drawn area + parcel overlapping al pixel → 2 voci attive (una per layer).
 2. Drawn area + parcel non overlapping → 2 voci, una disabilitata con tooltip.
 3. Solo drawn area, nessun parcel sotto al cursore → 1 voce disabilitata se nessun
    candidato di intersezione sul layer opposto.
 4. Due drawn areas sovrapposte allo stesso pixel → submenu con due figli.
"""

from __future__ import annotations

from playwright.sync_api import Page

APP_PATH = "/planimeter.html"


def _go(page: Page, base: str) -> None:
    page.goto(base + APP_PATH)
    page.wait_for_load_state("networkidle")
    page.select_option("#lang-switcher", "it")
    page.wait_for_timeout(300)


def _reset(page: Page) -> None:
    page.evaluate(
        """
        () => {
            const app = window.planimeterApp;
            app.vectorSource.clear();
            app.pertenenzaSource.clear();
            app.clearSelection();
            app.setMode('navigate');
            app.state.userAreasVisible = true;
            app.state.pertenenzeVisible = true;
            app.layers.vector?.setVisible?.(true);
            app.layers.pertenenza?.setVisible?.(true);
            app.view.setCenter([1400000, 5300000]);
            app.view.setZoom(18);
            app.map.renderSync();
        }
        """
    )
    page.wait_for_timeout(150)


def _seed_and_build_menu(page: Page, scenario: str) -> dict:
    """Crea fixture geometriche e invoca buildSummaryContextMenu in modo deterministico.

    Restituisce un dump strutturale del menu (items, disabled, children).
    """
    return page.evaluate(
        """
        async ({ scenario }) => {
            const app = window.planimeterApp;
            // Risolto via importmap della pagina (ol/ → esm.sh/ol@8.2.0/).
            const olFeature = await import('ol/Feature.js');
            const olPoly = await import('ol/geom/Polygon.js');
            const Feature = olFeature.default;
            const Polygon = olPoly.default;
            {

                const cx = app.view.getCenter()[0];
                const cy = app.view.getCenter()[1];

                const mkPoly = (offX, offY, size = 40) => {
                    const ring = [
                        [cx + offX - size, cy + offY - size],
                        [cx + offX + size, cy + offY - size],
                        [cx + offX + size, cy + offY + size],
                        [cx + offX - size, cy + offY + size],
                        [cx + offX - size, cy + offY - size],
                    ];
                    return new Feature({ geometry: new Polygon([ring]) });
                };

                const mkUser = (offX, offY, size = 40, label = 'A') => {
                    const f = mkPoly(offX, offY, size);
                    f.set('featureId', 'u-' + label);
                    f.set('overlayLayer', 'user');
                    f.set('label', label);
                    return f;
                };
                const mkParcel = (offX, offY, size = 40, localId = 'P1') => {
                    const f = mkPoly(offX, offY, size);
                    f.set('featureId', 'p-' + localId);
                    f.set('overlayLayer', 'pertenenze');
                    f.set('inspire_local_id', localId);
                    return f;
                };

                if (scenario === 'overlap-both') {
                    app.vectorSource.addFeature(mkUser(0, 0, 50, 'A'));
                    app.pertenenzaSource.addFeature(mkParcel(10, 10, 60, 'IT.AGE.PLA.X.1'));
                } else if (scenario === 'no-opposite-parcel') {
                    // user al centro, parcel lontano (no overlap)
                    app.vectorSource.addFeature(mkUser(0, 0, 50, 'A'));
                    app.pertenenzaSource.addFeature(mkParcel(500, 500, 30, 'IT.AGE.PLA.X.99'));
                } else if (scenario === 'only-user-no-parcels') {
                    app.vectorSource.addFeature(mkUser(0, 0, 50, 'A'));
                } else if (scenario === 'stacked-user') {
                    app.vectorSource.addFeature(mkUser(0, 0, 50, 'A'));
                    app.vectorSource.addFeature(mkUser(5, 5, 45, 'B'));
                    // parcel sovrapposto per rendere le voci ENABLED
                    app.pertenenzaSource.addFeature(mkParcel(0, 0, 60, 'IT.AGE.PLA.X.42'));
                }

                app.map.renderSync();
                const pixel = app.map.getPixelFromCoordinate([cx, cy]);
                const menu = app.buildSummaryContextMenu({ pixel });

                const dumpItem = (it) => ({
                    key: it.key,
                    labelVars: it.labelVars ?? null,
                    disabled: Boolean(it.disabled),
                    tooltipKey: it.tooltipKey ?? null,
                    action: it.action ?? null,
                    payloadLayer: it.payload?.layerKey ?? null,
                    payloadFeatureCount: Array.isArray(it.payload?.features)
                        ? it.payload.features.length
                        : (it.payload?.feature ? 1 : 0),
                    children: Array.isArray(it.children) ? it.children.map(dumpItem) : null,
                });

                return {
                    ok: true,
                    isNull: menu == null,
                    itemCount: menu?.items?.length ?? 0,
                    items: (menu?.items ?? []).map(dumpItem),
                };
            }
        }
        """,
        {"scenario": scenario},
    )


def _open_real_context_menu(page: Page) -> dict:
    """Apre il context-menu reale al centro vista, ritorna struttura DOM osservata."""
    page.evaluate(
        """
        () => {
            const app = window.planimeterApp;
            const cx = app.view.getCenter()[0];
            const cy = app.view.getCenter()[1];
            const pixel = app.map.getPixelFromCoordinate([cx, cy]);
            const viewport = app.map.getViewport();
            const rect = viewport.getBoundingClientRect();
            const ev = new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: rect.left + pixel[0],
                clientY: rect.top + pixel[1],
                button: 2,
            });
            viewport.dispatchEvent(ev);
        }
        """
    )
    page.wait_for_timeout(120)
    return page.evaluate(
        """
        () => {
            const menu = document.querySelector('#map-context-menu');
            if (!menu || menu.hidden) return { visible: false };
            const items = Array.from(menu.querySelectorAll(':scope > ul > li'));
            const dump = (li) => {
                const btn = li.querySelector(':scope > button');
                const submenu = li.querySelector(':scope > ul.context-menu-submenu');
                return {
                    label: btn?.textContent?.trim() ?? '',
                    disabled: btn?.classList.contains('context-menu-item--disabled') ?? false,
                    hasSubmenu: Boolean(submenu),
                    title: btn?.title ?? '',
                    childrenCount: submenu ? submenu.querySelectorAll(':scope > li').length : 0,
                };
            };
            return { visible: true, items: items.map(dump) };
        }
        """
    )


# ─────────────────────────── Tests ──────────────────────────────────────────


def test_summary_ctx_overlap_both_layers(page: Page, planimeter_base_url: str):
    _go(page, planimeter_base_url)
    _reset(page)
    res = _seed_and_build_menu(page, 'overlap-both')
    assert res.get('ok'), res
    assert not res['isNull']
    # Due voci flat (user + parcel), entrambe abilitate
    assert res['itemCount'] == 2, res
    layers = sorted([it['payloadLayer'] for it in res['items']])
    assert layers == ['pertenenze', 'user'], res
    for it in res['items']:
        assert it['disabled'] is False, it
        assert it['action'] == 'openSummary'
        assert it['payloadFeatureCount'] == 1


def test_summary_ctx_no_intersection_disables_opposite(page: Page, planimeter_base_url: str):
    _go(page, planimeter_base_url)
    _reset(page)
    res = _seed_and_build_menu(page, 'no-opposite-parcel')
    assert res.get('ok'), res
    assert not res['isNull']
    # Solo la user è sotto al pixel; parcel è lontano e non viene proposto qui.
    # User non ha intersezione con nessun parcel → disabled + tooltip.
    assert res['itemCount'] == 1, res
    item = res['items'][0]
    assert item['payloadLayer'] == 'user'
    assert item['disabled'] is True
    assert item['tooltipKey'] == 'ctx.summary.noIntersection'


def test_summary_ctx_only_user_no_parcels_at_all(page: Page, planimeter_base_url: str):
    _go(page, planimeter_base_url)
    _reset(page)
    res = _seed_and_build_menu(page, 'only-user-no-parcels')
    assert res.get('ok'), res
    assert not res['isNull']
    assert res['itemCount'] == 1
    item = res['items'][0]
    assert item['payloadLayer'] == 'user'
    assert item['disabled'] is True
    assert item['tooltipKey'] == 'ctx.summary.noIntersection'


def test_summary_ctx_stacked_user_features_open_submenu(page: Page, planimeter_base_url: str):
    _go(page, planimeter_base_url)
    _reset(page)
    res = _seed_and_build_menu(page, 'stacked-user')
    assert res.get('ok'), res
    assert not res['isNull']
    # user → gruppo con 2 figli + parcel → flat enabled
    user_groups = [it for it in res['items'] if it['payloadLayer'] is None and it['children']]
    parcel_items = [it for it in res['items'] if it['payloadLayer'] == 'pertenenze']
    assert len(user_groups) == 1, res
    assert len(parcel_items) == 1, res
    grp = user_groups[0]
    assert grp['disabled'] is False
    assert len(grp['children']) == 2
    for child in grp['children']:
        assert child['action'] == 'openSummary'
        # parcel sovrapposto → entrambe le voci enabled
        assert child['disabled'] is False
    assert parcel_items[0]['disabled'] is False


def test_summary_ctx_dom_renders_disabled_and_submenu(page: Page, planimeter_base_url: str):
    """Verifica end-to-end che il DOM del context menu rispetti la struttura."""
    _go(page, planimeter_base_url)
    _reset(page)
    # Caso disabled
    _seed_and_build_menu(page, 'only-user-no-parcels')
    dom = _open_real_context_menu(page)
    assert dom['visible'], dom
    summary_items = [it for it in dom['items'] if it['title']]
    # almeno una voce con tooltip presente (la nostra disabled)
    assert any(it['disabled'] for it in dom['items']), dom

    _reset(page)
    # Caso submenu
    _seed_and_build_menu(page, 'stacked-user')
    dom2 = _open_real_context_menu(page)
    assert dom2['visible'], dom2
    submenu_items = [it for it in dom2['items'] if it['hasSubmenu']]
    assert len(submenu_items) >= 1, dom2
    assert submenu_items[0]['childrenCount'] == 2, dom2
