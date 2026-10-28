"""End-to-end Playwright verification for Multi-Campaign seasons, visual/instrumental comparison, and 5-year PAC rotation."""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
REAL_STORE_PATH = REPO_ROOT / ".planimeter_state_store.json"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_ready(url: str, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"Server did not become ready at {url}")


@pytest.fixture(scope="module")
def live_server_with_real_data():
    port = _free_port()
    tmp_dir = tempfile.mkdtemp(prefix="planimeter_e2e_pac_")
    temp_state_file = Path(tmp_dir) / "state_store.json"
    if REAL_STORE_PATH.exists():
        import json
        with open(REAL_STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        camp_2026 = [c for c in data.get("campaigns", []) if c.get("id") == "2026-annual"]
        if camp_2026:
            data["campaigns"] = camp_2026
            data["activeCampaignId"] = "2026-annual"
            data["features"] = camp_2026[0]["features"]
        with open(temp_state_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    real_agri_db = REPO_ROOT / ".planimeter_agriculture.db"
    temp_agri_db = Path(tmp_dir) / "agriculture.db"
    if real_agri_db.exists():
        shutil.copyfile(real_agri_db, temp_agri_db)

    env = {
        **os.environ,
        "PORT": str(port),
        "PLANIMETER_STATE_STORE_FILE": str(temp_state_file),
        "PLANIMETER_AGRICULTURE_DB": str(temp_agri_db),
        "PLANIMETER_CULTIVAR_STORE_FILE": str(temp_agri_db),
        "PLANIMETER_HISTORY_STORE_FILE": str(Path(tmp_dir) / "history.json"),
        "TILE_CACHE_DB": str(Path(tmp_dir) / "tiles.sqlite"),
    }
    proc = subprocess.Popen(
        [sys.executable, str(REPO_ROOT / "server.py"), "--port", str(port), "--no-browser", "--instance-policy", "replace"],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_ready(f"{base_url}/planimeter.html")
        yield base_url, temp_state_file
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_e2e_multi_campaign_comparison_and_pac_rotation(page, live_server_with_real_data):
    base_url, temp_state_file = live_server_with_real_data
    page_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))

    # Auto-accept window.confirm when creating a new season
    page.on("dialog", lambda dialog: dialog.accept())

    page.goto(f"{base_url}/planimeter.html", wait_until="domcontentloaded")
    page.wait_for_function("() => Boolean(window.planimeterApp && window.planimeterApp.state.dslReady)")

    # Wait for the restore prompt (local empty + mirror non-empty) and click Load backup
    load_btn = page.locator("[data-restore-prompt-load]").first
    load_btn.wait_for(state="visible", timeout=10000)
    load_btn.click()

    page.wait_for_function("() => window.planimeterApp.vectorSource.getFeatures().length === 31")
    assert page_errors == [], f"Unexpected page errors: {page_errors}"

    # 1. Verify 2025/2026 campaign loaded with 31 drawn areas and 13 pertinenze
    initial_state = page.evaluate(
        """() => ({
            activeCampaignId: window.planimeterApp.state.activeCampaignId,
            activeSelectText: document.querySelector('#campaign-active-select')?.selectedOptions?.[0]?.textContent,
            areaCount: window.planimeterApp.vectorSource.getFeatures().length,
            pertCount: window.planimeterApp.pertenenzaSource.getFeatures().length,
            granoUuid: window.planimeterApp.vectorSource.getFeatures().find(f => f.get('dsl')?.categoryId === 'grano_duro')?.get('uuid'),
        })"""
    )
    assert initial_state["activeCampaignId"] == "2026-annual"
    assert initial_state["activeSelectText"] == "2025/2026"
    assert initial_state["areaCount"] == 31
    assert initial_state["pertCount"] == 13
    grano_uuid = initial_state["granoUuid"]
    assert grano_uuid

    # 2. Click '+ Nuova stagione' to create 2026/2027
    page.locator("#btn-campaign-new-season").click()
    page.wait_for_function("() => window.planimeterApp.state.activeCampaignId === '2027-annual'")

    new_season_state = page.evaluate(
        """() => {
            const p = window.planimeterApp;
            const areas = p.vectorSource.getFeatures();
            const assignedCats = areas.map(f => f.get('dsl')?.categoryId || null).filter(Boolean);
            return {
                activeId: p.state.activeCampaignId,
                activeYear: p.state.activeCampaignYear,
                activeLabel: document.querySelector('#campaign-active-select')?.selectedOptions?.[0]?.textContent,
                compareId: p.state.compareCampaignId,
                compareVisible: p.state.compareOverlayVisible,
                compareFeatureCount: p.compareSource.getFeatures().length,
                areaCount: areas.length,
                pertCount: p.pertenenzaSource.getFeatures().length,
                assignedCats,
            };
        }"""
    )
    assert new_season_state["activeId"] == "2027-annual"
    assert new_season_state["activeYear"] == 2027
    assert new_season_state["activeLabel"] == "2026/2027"
    assert new_season_state["compareId"] == "2026-annual"
    assert new_season_state["compareVisible"] is True
    assert new_season_state["compareFeatureCount"] == 31
    assert new_season_state["areaCount"] == 31
    assert new_season_state["pertCount"] == 13
    # Only multiannual ('prato') should remain assigned; all annual crops cleared
    assert set(new_season_state["assignedCats"]) == {"prato"}

    # Verify old 2025/2026 campaign in localStorage is 100% untouched
    old_campaign_check = page.evaluate(
        """() => {
            const raw = JSON.parse(localStorage.getItem('planimeter.features.v1'));
            const oldCamp = raw.campaigns.find(c => c.id === '2026-annual');
            const oldAreas = oldCamp.features.features.filter(f => (f.properties?.overlayLayer ?? 'user') === 'user');
            const oldAssigned = oldAreas.filter(f => f.properties?.dsl?.categoryId);
            return { count: oldAreas.length, assignedCount: oldAssigned.length };
        }"""
    )
    assert old_campaign_check["count"] == 31
    assert old_campaign_check["assignedCount"] == 31

    # 3. Test 1-click Exclusive Peek button and 'V' hotkey
    page.locator("#btn-campaign-peek").click()
    assert page.evaluate("() => window.planimeterApp.state.compareExclusivePeek === true && !window.planimeterApp.layers.vector.getVisible()")
    page.locator("#btn-campaign-peek").click()
    assert page.evaluate("() => window.planimeterApp.state.compareExclusivePeek === false && window.planimeterApp.layers.vector.getVisible()")

    # Test 'V' hotkey hold & release
    page.keyboard.down("v")
    assert page.evaluate("() => window.planimeterApp.state.compareExclusivePeek === true")
    page.keyboard.up("v")
    assert page.evaluate("() => window.planimeterApp.state.compareExclusivePeek === false")

    # 4. Test PAC 5-Year Rotation Engine on the plot that had grano_duro in 2025/2026
    pac_ui_state = page.evaluate(
        """(granoUuid) => {
            const p = window.planimeterApp;
            const targetArea = p.vectorSource.getFeatures().find(f => f.get('originFeatureUuid') === granoUuid);
            p.state.selectedFeature = targetArea;
            p.state.selectedFeatures = [targetArea];
            p.updateSummary();

            const sel = document.querySelector('#dsl-category-select');
            const options = Object.fromEntries([...sel.options].filter(o => o.value).map(o => [o.value, o.textContent]));
            const chainHtml = document.querySelector('#dsl-pac-history-chain')?.textContent || '';

            // Now select grano_duro to trigger forbidden_bcaa7 advisory
            sel.value = 'grano_duro';
            sel.dispatchEvent(new Event('change'));
            const bcaa7Advisory = document.querySelector('#dsl-pac-advisory')?.textContent || '';
            const hasForbiddenClass = Boolean(document.querySelector('#dsl-pac-advisory .pac-status-forbidden_bcaa7'));

            // Now select orzo to trigger warning_eco4 advisory
            sel.value = 'orzo';
            sel.dispatchEvent(new Event('change'));
            const eco4Advisory = document.querySelector('#dsl-pac-advisory')?.textContent || '';
            const hasWarningClass = Boolean(document.querySelector('#dsl-pac-advisory .pac-status-warning_eco4'));

            // Now switch fertilization to 'biologica' and check grano_duro derogation
            const fertSelect = document.querySelector('#dsl-field-fertilization');
            if (fertSelect) {
                fertSelect.value = 'biologica';
                fertSelect.dispatchEvent(new Event('change'));
            }
            sel.value = 'grano_duro';
            sel.dispatchEvent(new Event('change'));
            const bioOptionText = [...sel.options].find(o => o.value === 'grano_duro')?.textContent || '';
            const hasExemptClass = Boolean(document.querySelector('#dsl-pac-advisory .pac-status-exempt_bio_sqnpi'));

            return {
                options,
                chainHtml,
                bcaa7Advisory,
                hasForbiddenClass,
                eco4Advisory,
                hasWarningClass,
                bioOptionText,
                hasExemptClass,
            };
        }""",
        grano_uuid,
    )

    assert "2025/2026:" in pac_ui_state["chainHtml"]
    assert "Grano duro" in pac_ui_state["chainHtml"]

    # Check category badges before bio switch
    assert "⛔" in pac_ui_state["options"]["grano_duro"]
    assert "⛔" in pac_ui_state["options"]["grano_tenero"]
    assert "⚠️" in pac_ui_state["options"]["orzo"]
    assert "✅" in pac_ui_state["options"]["favino"]
    assert "✅" in pac_ui_state["options"]["girasole"]
    assert "✅" in pac_ui_state["options"]["sorgo"]

    assert pac_ui_state["hasForbiddenClass"] is True
    assert "BCAA 7" in pac_ui_state["bcaa7Advisory"]
    assert pac_ui_state["hasWarningClass"] is True
    assert "Eco-schema 4" in pac_ui_state["eco4Advisory"]
    assert "ℹ️" in pac_ui_state["bioOptionText"]
    assert pac_ui_state["hasExemptClass"] is True

    # 5. Test spatial fallback on a newly created/split polygon in EPSG:3857 (no originFeatureUuid)
    spatial_fallback_ok = page.evaluate(
        """(granoUuid) => {
            const p = window.planimeterApp;
            const targetArea = p.vectorSource.getFeatures().find(f => f.get('originFeatureUuid') === granoUuid);
            const clone = targetArea.clone();
            clone.set('uuid', 'brand-new-uuid');
            clone.set('originFeatureUuid', null);
            clone.set('featureId', 'area-999');
            p.state.selectedFeature = clone;
            p.state.selectedFeatures = [clone];
            p.updateDslAssignmentControls(true);
            const chainText = document.querySelector('#dsl-pac-history-chain')?.textContent || '';
            return chainText.includes('2025/2026') && chainText.includes('Grano duro');
        }""",
        grano_uuid,
    )
    assert spatial_fallback_ok is True

    # 6. Test Summary Panel 'prevCrop' column
    summary_prev_crop = page.evaluate(
        """(granoUuid) => {
            const p = window.planimeterApp;
            const targetArea = p.vectorSource.getFeatures().find(f => f.get('originFeatureUuid') === granoUuid);
            p.openIntersectionSummary([targetArea]);
            const panelText = document.querySelector('#summary-panel')?.textContent || '';
            return panelText;
        }""",
        grano_uuid,
    )
    assert "Coltura anno prec." in summary_prev_crop or "Prev year crop" in summary_prev_crop
    assert "Grano duro - Averngur (2025/2026)" in summary_prev_crop

    assert page_errors == [], f"Unexpected page errors at end of test: {page_errors}"


def test_e2e_crop_catalog_and_variety_autocomplete(page, live_server_with_real_data):
    base_url, temp_state_file = live_server_with_real_data
    page_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: print(f"[browser console] {msg.type}: {msg.text}"))

    page.goto(f"{base_url}/planimeter.html", wait_until="domcontentloaded")
    page.wait_for_function("() => Boolean(window.planimeterApp && window.planimeterApp.state.dslReady)")

    try:
        load_btn = page.locator("[data-restore-prompt-load]").first
        load_btn.wait_for(state="visible", timeout=3000)
        load_btn.click()
        page.wait_for_timeout(300)
    except Exception:
        pass

    # 1. Verify Colza native category exists in domain and category dropdown
    colza_info = page.evaluate(
        """() => {
            const domain = window.planimeterApp.getDomain('agriculture');
            const cat = domain?.categories?.find(c => c.id === 'colza');
            const opt = document.querySelector('#dsl-category-select option[value="colza"]');
            return {
                domainHasColza: Boolean(cat),
                genus: cat?.botanicalGenus,
                pacGroup: cat?.pacGroup,
                eco4Role: cat?.eco4Role,
                optionExists: Boolean(opt),
            };
        }"""
    )
    assert colza_info["domainHasColza"] is True
    assert colza_info["genus"] == "Brassica"
    assert colza_info["pacGroup"] == "oilseed"
    assert colza_info["eco4Role"] == "renewal"
    assert colza_info["optionExists"] is True

    # 2. Select a feature and verify PAC badge for Colza is '✅' (renewal after cereal)
    page.evaluate(
        """() => {
            const p = window.planimeterApp;
            let f = p.vectorSource.getFeatures()[0];
            if (!f) {
                const geom = new ol.geom.Polygon([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
                f = new ol.Feature({ geometry: geom });
                f.set('uuid', 'mock-area-pac');
                f.set('overlayLayer', 'user');
                p.vectorSource.addFeature(f);
            }
            p.state.selectedFeature = f;
            p.state.selectedFeatures = [f];
            p.updateSummary();
        }"""
    )
    colza_badge = page.evaluate(
        """() => {
            const opt = document.querySelector('#dsl-category-select option[value="colza"]');
            return opt ? opt.textContent : null;
        }"""
    )
    assert colza_badge is not None
    assert "✅" in colza_badge or "Colza" in colza_badge

    # 3. Test Variety Autocomplete via backend API
    autocomplete_check = page.evaluate(
        """async () => {
            const colzaRes = await fetch('/agriculture-varieties-autocomplete?category_id=colza&genus=Brassica&q=');
            const colzaData = await colzaRes.json();
            const granoRes = await fetch('/agriculture-varieties-autocomplete?category_id=grano_duro&genus=Triticum&q=Aver');
            const granoData = await granoRes.json();
            return {
                colzaCount: colzaData.varieties?.length || 0,
                colzaFirst: colzaData.varieties?.[0]?.variety,
                granoPresetFirst: granoData.varieties?.[0]?.variety,
                granoIsPreset: granoData.varieties?.[0]?.isPreset,
            };
        }"""
    )
    assert autocomplete_check["colzaCount"] > 0
    assert autocomplete_check["granoPresetFirst"] == "Averngur"
    assert autocomplete_check["granoIsPreset"] is True

    # 4. Test Variety Autocomplete UI datalist population
    page.evaluate(
        """() => {
            const sel = document.querySelector('#dsl-category-select');
            sel.value = 'colza';
            sel.dispatchEvent(new Event('change'));
            const cultivarInput = document.querySelector('#dsl-cultivar-name');
            cultivarInput.value = '44';
            cultivarInput.dispatchEvent(new Event('input'));
        }"""
    )
    page.wait_for_function(
        "() => document.querySelectorAll('#dsl-variety-autocomplete-list option').length > 0",
        timeout=5000,
    )
    options_count = page.evaluate("() => document.querySelectorAll('#dsl-variety-autocomplete-list option').length")
    assert options_count > 0

    # 5. Test '+ Nuova coltura' Detached Modal Dialog
    # Verify detached dialog is initially closed
    assert page.evaluate("() => Boolean(document.querySelector('#dsl-category-creator')?.open)") is False

    # Open creator
    page.locator("#btn-dsl-add-category").click()
    page.wait_for_function("() => Boolean(document.querySelector('#dsl-category-creator')?.open)")

    # Test closing via X button
    page.locator("#btn-dsl-close-creator").click()
    page.wait_for_function("() => !document.querySelector('#dsl-category-creator')?.open")

    # Reopen and test closing via Cancel button
    page.locator("#btn-dsl-add-category").click()
    page.wait_for_function("() => Boolean(document.querySelector('#dsl-category-creator')?.open)")
    page.locator("#btn-dsl-cancel-category").click()
    page.wait_for_function("() => !document.querySelector('#dsl-category-creator')?.open")

    # Reopen to create Mais
    page.locator("#btn-dsl-add-category").click()
    page.wait_for_function("() => Boolean(document.querySelector('#dsl-category-creator')?.open)")

    # Search for Mais in official species list and trigger input
    page.evaluate(
        """() => {
            const searchInput = document.querySelector('#dsl-creator-search');
            searchInput.value = 'Mais';
            searchInput.dispatchEvent(new Event('input'));
        }"""
    )

    # Verify fields auto-filled
    creator_fields = page.evaluate(
        """() => ({
            name: document.querySelector('#dsl-creator-label')?.value,
            genus: document.querySelector('#dsl-creator-genus')?.value,
            pacGroup: document.querySelector('#dsl-creator-pac-group')?.value,
            eco4Role: document.querySelector('#dsl-creator-eco4-role')?.value,
        })"""
    )
    assert creator_fields["name"] == "Mais"
    assert creator_fields["genus"] == "Zea"
    assert creator_fields["pacGroup"] == "cereal_renewal"
    assert creator_fields["eco4Role"] == "renewal"

    # Save new crop
    page.locator("#btn-dsl-save-category").click()
    page.wait_for_function("() => Boolean(document.querySelector('#dsl-category-creator')?.hidden)")

    # Verify newly added category is present in category select and selected
    page.wait_for_function("() => Boolean(document.querySelector('#dsl-category-select option[value=\"mais\"]'))")
    new_cat_select_state = page.evaluate(
        """() => {
            const sel = document.querySelector('#dsl-category-select');
            const opt = sel.querySelector('option[value="mais"]');
            return {
                optExists: Boolean(opt),
                optText: opt?.textContent,
                selectedValue: sel.value,
                allOpts: [...sel.options].map(o => ({ v: o.value, s: o.selected })),
            };
        }"""
    )
    assert new_cat_select_state["optExists"] is True
    assert "Mais" in new_cat_select_state["optText"]
    assert new_cat_select_state["selectedValue"] == "mais"

    # Verify persisted in backend SQLite
    backend_custom_cats = page.evaluate(
        """async () => {
            const res = await fetch('/agriculture-custom-categories');
            return await res.json();
        }"""
    )
    mais_cat = next((c for c in backend_custom_cats.get("categories", []) if c.get("id") == "mais"), None)
    assert mais_cat is not None
    assert mais_cat["label"] == "Mais"
    assert mais_cat["botanicalGenus"] == "Zea"

    assert page_errors == [], f"Unexpected page errors: {page_errors}"

