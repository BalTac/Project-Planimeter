import Map          from 'ol/Map.js';
import View         from 'ol/View.js';
import VectorSource from 'ol/source/Vector.js';
import { defaults as defaultControls } from 'ol/control.js';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';

import { createInitialState }            from './core/state.js';
import { buildLayers }                   from './map/layers.js';
import { buildInteractions }             from './map/interactions.js';
import { calculateArea, calculatePerimeter, calculateLength } from './geometry/calculations.js';
import { buildFeatureStyle }             from './geometry/style.js';
import { decorateFeature }               from './geometry/decorate.js';
import { t, setLocale, detectLocale }    from './i18n/i18n.js';
import { UnitSystem }                    from './units/units.js';
import { ProxyHealthMonitor }            from './ui/proxy-health.js';
import { initContextMenu }               from './ui/context-menu.js';
import {
    schedulePersistenceSync,
    restorePersistedFeatures,
} from './io/persistence.js';
import { buildExportConfig, triggerDownload, requestBackendExport } from './io/export.js';
import { detectImportFormat, readImportedFeatures } from './io/import.js';
import { loadPreferences, savePreferences } from './io/preferences.js';
import { CATASTO_WMS_LAYER_DEFS, DEFAULT_CATASTO_WMS_LAYER_SETTINGS } from './core/constants.js';

const BASE_LAYER_KEYS = ['sat', 'openTopoMap', 'esriTopo', 'esriRelief'];
const ADMIN_LAYER_KEYS = ['osm', 'catasto'];

export default class Planimeter {
    constructor() {
        const preferences = loadPreferences();

        // ── Locale & units ────────────────────────────────────────────────────
        const locale = preferences.locale ?? detectLocale();
        setLocale(locale);
        this.unitSystem = new UnitSystem(
            preferences.unitSystem ?? UnitSystem.autoDetect(navigator.language),
        );

        // ── State & source ────────────────────────────────────────────────────
        this.state        = createInitialState();
        this.state.locale = locale;
        this.state.unitSystem = this.unitSystem.system;
        this.state.toolbarPanel = preferences.toolbarPanel;
        this.state.activeBaseLayer = this.sanitizeBaseLayerKey(preferences.activeBaseLayer);
        this.state.activeAdminLayer = this.sanitizeAdminLayerKey(preferences.activeAdminLayer);
        this.state.catastoWmsLayerSettings = this.sanitizeCatastoWmsLayerSettings(
            preferences.catastoWmsLayerSettings,
            preferences.catastoWmsLayers,
            preferences.catastoOpacity,
        );
        this.state.parcelInfoEnabled = preferences.parcelInfoEnabled;
        this.state.exportImageQuality = this.sanitizeExportImageQuality(preferences.exportImageQuality);
        this.state.cacheTtlDays = this.sanitizeCacheTtlDays(preferences.cacheTtlDays);
        this.state.cacheSizeMb = this.sanitizeCacheSizeMb(preferences.cacheSizeMb);
        this.state.parcelInfoStatusKey = preferences.parcelInfoEnabled
            ? 'parcelInfo.clickHint'
            : 'parcelInfo.disabled';

        this.vectorSource = new VectorSource();

        // ── DOM ───────────────────────────────────────────────────────────────
        this.elements = this.collectElements();

        // ── Layers & map ──────────────────────────────────────────────────────
        this.layers = buildLayers(this.vectorSource, this.featureStyle.bind(this));
        this.initMap();

        // ── Interactions ──────────────────────────────────────────────────────
        this.interactions = buildInteractions(this.vectorSource, this.layers.vector);
        this.addInteractionsToMap();
        this.bindInteractionEvents();

        // ── UI bindings ───────────────────────────────────────────────────────
        this.bindUI();
        initContextMenu({
            map:             this.map,
            elements:        this.elements,
            getIsDrawing:    () => this.state.isDrawing,
            getMode:         () => this.state.mode,
            abortActiveDraw: () => this.abortActiveDraw(),
            canQueryParcel:  () => this.canQueryParcelFromContextMenu(),
            canRefreshWmsTile: () => this.canRefreshWmsTile(),
            editFeature:     (feature) => this.editFeatureFromContext(feature),
            deleteFeature:   (feature) => this.deleteFeatureFromContext(feature),
            queryParcelAtPixel: (pixel) => this.fetchParcelInfoAtPixel(pixel),
            refreshTileAtPixel: (pixel) => this.refreshTileAtPixel(pixel),
            exportView:      () => this.exportViewSnapshot(),
            exportSelection: () => this.startSelectionExportMode(),
            exportAreas:     () => this.exportFeatures(),
            getSpecialContextMenu: (ctx) => this.getSpecialContextMenu(ctx),
        });

        // ── Proxy health ──────────────────────────────────────────────────────
        this.proxyHealth = new ProxyHealthMonitor({
            elements:       this.elements,
            onHealthChange: (status, msg) => {
                if (status === 'ko' && this.state.catastoSource === 'official' &&
                    this.elements.layerCatasto.checked) {
                    this.setToolbarMessage(msg);
                }
            },
        });
        this.proxyHealth.setHealth('checking', t('proxy.awaitInit'));
        this.applyLayerGroupSelection();

        // ── Restore localStorage ──────────────────────────────────────────────
        restorePersistedFeatures(
            this.state,
            this.vectorSource,
            this.view,
            (count) => {
                this.setToolbarMessage(t('msg.featuresRestored', { count }));
                this.fitToFeatures();
            },
        );

        this.updateSummary();
        this.setMode('navigate');
        this.syncPreferenceControls();
        this.applyCatastoWmsLayerSettings();
        this.renderParcelInfo();
        this.setToolbarPanel(this.state.toolbarPanel);
        this.loadCacheStats();

        this.selectionExport = null;
        this.dragPanInteractions = null;
    }

    // ── DOM helpers ─────────────────────────────────────────────────────────────

    collectElements() {
        return {
            tabButtons:                [...document.querySelectorAll('.toolbar-tab')],
            toolbarPanels:             [...document.querySelectorAll('.toolbar-panel')],
            layerSat:                  document.getElementById('layer-sat'),
            layerOpenTopoMap:          document.getElementById('layer-open-topo'),
            layerEsriTopo:             document.getElementById('layer-esri-topo'),
            layerEsriRelief:           document.getElementById('layer-esri-relief'),
            layerOsm:                  document.getElementById('layer-osm'),
            layerCatasto:              document.getElementById('layer-catasto'),
            baseLayerInputs:           [...document.querySelectorAll('[data-layer-group="base"]')],
            adminLayerInputs:          [...document.querySelectorAll('[data-layer-group="admin"]')],
            catastoSource:             document.getElementById('catasto-source'),
            catastoHint:               document.getElementById('catasto-hint'),
            locateButton:              document.getElementById('btn-locate'),
            clearButton:               document.getElementById('btn-clear'),
            exportButton:              document.getElementById('btn-export'),
            importButton:              document.getElementById('btn-import'),
            exportFormat:              document.getElementById('export-format'),
            duplicateSelectedButton:   document.getElementById('btn-duplicate-selected'),
            deleteSelectedButton:      document.getElementById('btn-delete-selected'),
            importInput:               document.getElementById('file-import'),
            modeButtons:               [...document.querySelectorAll('[data-mode]')],
            status:                    document.getElementById('toolbar-status'),
            statCount:                 document.getElementById('stat-count'),
            statTotalArea:             document.getElementById('stat-total-area'),
            statTotalPerimeter:        document.getElementById('stat-total-perimeter'),
            statSelectedArea:          document.getElementById('stat-selected-area'),
            statZoom:                  document.getElementById('stat-zoom'),
            statCatastoSource:         document.getElementById('stat-catasto-source'),
            statProxyHealth:           document.getElementById('stat-proxy-health'),
            proxyHealthDetail:         document.getElementById('proxy-health-detail'),
            snapStatus:                document.getElementById('snap-status'),
            contextMenu:               document.getElementById('map-context-menu'),
            langSwitcher:              document.getElementById('lang-switcher'),
            settingsLanguage:          document.getElementById('settings-language'),
            settingsUnitSystem:        document.getElementById('settings-unit-system'),
            settingsExportQuality:     document.getElementById('settings-export-quality'),
            settingsCacheTtlDays:      document.getElementById('settings-cache-ttl-days'),
            settingsCacheSizeMb:       document.getElementById('settings-cache-size-mb'),
            settingsParcelInfoEnabled: document.getElementById('settings-parcel-info-enabled'),
            settingsWmsLayerParts:     [...document.querySelectorAll('[data-wms-layer-part]')],
            settingsWmsLayerOpacity:   [...document.querySelectorAll('[data-wms-layer-opacity]')],
            parcelInfoStatus:          document.getElementById('parcel-info-status'),
            parcelInfoPopover:         document.getElementById('parcel-info-popover'),
            parcelInfoPopoverStatus:   document.getElementById('parcel-info-popover-status'),
            parcelInfoPopoverFrame:    document.getElementById('parcel-info-popover-frame'),
            parcelInfoCloseButton:     document.getElementById('parcel-info-close'),
            cacheStatsDisplay:         document.getElementById('cache-stats-display'),
            btnCacheApply:             document.getElementById('btn-cache-apply'),
            btnCacheClear:             document.getElementById('btn-cache-clear'),
        };
    }

    // ── Map initialisation ───────────────────────────────────────────────────────

    initMap() {
        this.view = new View({
            center: fromLonLat([12.4964, 41.9028]),
            zoom: 6,
        });

        this.map = new Map({
            target: 'map',
            // Keep WMS requests within Agenzia max image size limits on HiDPI displays.
            pixelRatio: 1,
            layers: [
                this.layers.sat,
                this.layers.openTopoMap,
                this.layers.esriTopo,
                this.layers.esriRelief,
                this.layers.osm,
                ...Object.values(this.layers.catastoOfficial),
                this.layers.catastoFallback,
                this.layers.vector,
            ],
            view: this.view,
            controls: defaultControls({ zoom: false, rotate: false }),
        });

        Object.values(this.layers.catastoOfficial).forEach((layer) => {
            layer.getSource().on('tileloaderror', () => {
                if (this.state.catastoSource === 'official' && this.elements.layerCatasto.checked) {
                    this.proxyHealth?.setHealth('ko', t('msg.layerError'));
                    this.setToolbarMessage(t('msg.layerError'));
                }
            });
        });

        this.view.on('change:resolution', () => this.updateSummary());
        this.vectorSource.on('addfeature',    () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource); });
        this.vectorSource.on('removefeature', () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource); });
        this.vectorSource.on('changefeature', () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource); });
    }

    addInteractionsToMap() {
        const ix = this.interactions;
        this.map.addInteraction(ix.select);
        this.map.addInteraction(ix.modify);
        this.map.addInteraction(ix.draw);
        this.map.addInteraction(ix.drawStraight);
        this.map.addInteraction(ix.drawPolyline);
        this.map.addInteraction(ix.snap);
    }

    // ── Interaction events ───────────────────────────────────────────────────────

    bindInteractionEvents() {
        const ix = this.interactions;

        ix.draw.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage(t('msg.drawInProgress'));
        });
        ix.draw.on('drawend', (ev) => {
            this.state.isDrawing = false;
            decorateFeature(ev.feature, this.state, this.vectorSource.getFeatures().length);
            this.state.selectedFeature = ev.feature;
            this.layers.vector.changed();
            this.updateSummary();
            this.setToolbarMessage(t('msg.drawDone'));
            this.pauseDrawAfterClose();
        });
        ix.draw.on('drawabort', () => {
            this.state.isDrawing = false;
            this.setToolbarMessage(t('msg.drawAborted'));
        });

        ix.drawStraight.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage(t('msg.straightInProgress'));
        });
        ix.drawStraight.on('drawend', (ev) => {
            this.state.isDrawing = false;
            ev.feature.set('measurementType', 'straight');
            decorateFeature(ev.feature, this.state, this.vectorSource.getFeatures().length);
            this.state.selectedFeature = ev.feature;
            this.layers.vector.changed();
            this.updateSummary();
            this.setToolbarMessage(t('msg.straightDone'));
        });
        ix.drawStraight.on('drawabort', () => {
            this.state.isDrawing = false;
            this.setToolbarMessage(t('msg.straightAborted'));
        });

        ix.drawPolyline.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage(t('msg.polylineInProgress'));
        });
        ix.drawPolyline.on('drawend', (ev) => {
            this.state.isDrawing = false;
            ev.feature.set('measurementType', 'polyline');
            decorateFeature(ev.feature, this.state, this.vectorSource.getFeatures().length);
            this.state.selectedFeature = ev.feature;
            this.layers.vector.changed();
            this.updateSummary();
            this.setToolbarMessage(t('msg.polylineDone'));
        });
        ix.drawPolyline.on('drawabort', () => {
            this.state.isDrawing = false;
            this.setToolbarMessage(t('msg.polylineAborted'));
        });

        ix.select.on('select', (ev) => this.handleFeatureSelection(ev));

        ix.modify.on('modifystart', () => {
            this.setToolbarMessage(t('msg.editVerticesActive'));
        });
        ix.modify.on('modifyend', () => {
            this.updateSummary();
            this.setToolbarMessage(t('msg.editDone'));
            const now = new Date().toISOString();
            for (const f of this.interactions.select.getFeatures().getArray()) {
                f.set('version',    (f.get('version') ?? 1) + 1);
                f.set('modifiedAt', now);
            }
        });

        document.addEventListener('keydown', (ev) => {
            if (ev.ctrlKey && !this.state.isCtrlPressed) {
                this.state.isCtrlPressed = true;
                this.refreshSnapState();
            }
        });
        document.addEventListener('keyup', (ev) => {
            if (!ev.ctrlKey && this.state.isCtrlPressed) {
                this.state.isCtrlPressed = false;
                this.refreshSnapState();
            }
        });
        window.addEventListener('blur', () => {
            if (this.state.isCtrlPressed) {
                this.state.isCtrlPressed = false;
                this.refreshSnapState();
            }
        });
    }

    // ── UI bindings ──────────────────────────────────────────────────────────────

    bindUI() {
        this.bindLayerGroupToggles();

        this.elements.tabButtons.forEach((button) => {
            button.addEventListener('click', () => this.setToolbarPanel(button.dataset.panel));
        });

        this.elements.catastoSource.addEventListener('change', (ev) => {
            this.setCatastoSource(ev.target.value);
        });

        this.elements.modeButtons.forEach((btn) => {
            btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
        });

        this.elements.locateButton.addEventListener('click',  () => this.geolocate());
        this.elements.clearButton.addEventListener('click',   () => this.clearAllFeatures());
        this.elements.exportButton.addEventListener('click',  () => this.exportFeatures());
        this.elements.importButton.addEventListener('click',  () => this.elements.importInput.click());
        this.elements.duplicateSelectedButton.addEventListener('click', () => this.duplicateSelectedArea());
        this.elements.deleteSelectedButton.addEventListener('click',    () => this.deleteSelectedFeature());
        this.elements.importInput.addEventListener('change', (ev) => this.importFeatures(ev));
        this.elements.parcelInfoCloseButton?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.closeParcelInfoPopover();
        });

        document.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0) return;
            const popover = this.elements.parcelInfoPopover;
            if (!popover || popover.hidden) return;
            const target = ev.target;
            if (!(target instanceof Node) || popover.contains(target)) return;

            const viewport = this.map?.getViewport();
            if (viewport?.contains(target)) {
                this.state.suppressNextParcelInfoClick = true;
            }

            this.closeParcelInfoPopover();
        });

        this.elements.langSwitcher?.addEventListener('change', (ev) => {
            this.updateLocale(ev.target.value);
        });

        this.elements.settingsLanguage?.addEventListener('change', (ev) => {
            this.updateLocale(ev.target.value);
        });

        this.elements.settingsUnitSystem?.addEventListener('change', (ev) => {
            this.updateUnitSystem(ev.target.value);
        });

        this.elements.settingsExportQuality?.addEventListener('change', (ev) => {
            this.updateExportImageQuality(ev.target.value);
        });

        this.elements.settingsCacheTtlDays?.addEventListener('change', (ev) => {
            this.state.cacheTtlDays = this.sanitizeCacheTtlDays(ev.target.value);
            this.syncPreferenceControls();
            this.persistPreferences();
        });

        this.elements.settingsCacheSizeMb?.addEventListener('change', (ev) => {
            this.state.cacheSizeMb = this.sanitizeCacheSizeMb(ev.target.value);
            this.syncPreferenceControls();
            this.persistPreferences();
        });

        this.elements.btnCacheApply?.addEventListener('click', () => this.updateCacheRuntimeConfig());
        this.elements.btnCacheClear?.addEventListener('click', () => this.clearTileCache());

        this.elements.settingsParcelInfoEnabled?.addEventListener('change', (ev) => {
            this.state.parcelInfoEnabled = ev.target.checked;
            this.state.parcelInfoLoading = false;
            this.state.parcelInfoStatusKey = ev.target.checked
                ? 'parcelInfo.clickHint'
                : 'parcelInfo.disabled';
            this.persistPreferences();
            this.renderParcelInfo();
        });

        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && this.selectionExport?.active) {
                this.cancelSelectionExportMode();
            }
        });

        this.elements.settingsWmsLayerParts?.forEach((el) => {
            el.addEventListener('change', () => this.updateCatastoWmsLayersFromSettings());
        });
        this.elements.settingsWmsLayerOpacity?.forEach((el) => {
            el.addEventListener('input', () => this.updateCatastoWmsLayerOpacityFromSettings());
        });
    }

    // ── Feature style ────────────────────────────────────────────────────────────

    featureStyle(feature) {
        return buildFeatureStyle(
            feature,
            this.state.selectedFeature,
            this.view?.getProjection(),
            this.unitSystem,
        );
    }

    // ── Mode management ──────────────────────────────────────────────────────────

    setMode(mode) {
        if (this.selectionExport?.active) {
            this.cancelSelectionExportMode(false);
        }

        this.state.mode = mode;

        if (this.state.drawLockTimeoutId) {
            window.clearTimeout(this.state.drawLockTimeoutId);
            this.state.drawLockTimeoutId = null;
        }

        const ix = this.interactions;
        ix.draw.setActive(mode === 'draw');
        ix.drawStraight.setActive(mode === 'measure-straight');
        ix.drawPolyline.setActive(mode === 'measure-polyline');
        ix.select.setActive(mode === 'edit' || mode === 'delete' || mode === 'navigate');
        ix.modify.setActive(mode === 'edit');
        this.refreshSnapState();

        if (this.isMeasureOrDrawMode(mode)) {
            ix.select.getFeatures().clear();
        } else if (this.state.selectedFeature) {
            ix.select.getFeatures().clear();
            ix.select.getFeatures().push(this.state.selectedFeature);
        }

        this.elements.modeButtons.forEach((btn) => {
            const active = btn.dataset.mode === mode;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', String(active));
        });

        const modeMsg = {
            'navigate':         'msg.navigateActive',
            'draw':             'msg.drawActive',
            'edit':             'msg.editActive',
            'delete':           'msg.deleteActive',
            'measure-straight': 'msg.measureStraightActive',
            'measure-polyline': 'msg.measurePolylineActive',
        };

        // Parcel info can be requested only from context menu in Navigate mode.
        if (mode !== 'navigate') {
            this.state.parcelInfoHtml = null;
            this.state.parcelInfoLoading = false;
            this.state.parcelInfoStatusKey = 'parcelInfo.clickHint';
            this.state.parcelInfoPopoverDismissed = true;
            this.state.parcelInfoAnchorPixel = null;
            this.state.suppressNextParcelInfoClick = false;
        }

        this.setToolbarMessage(t(modeMsg[mode] ?? 'msg.navigateActive'));
        this.renderParcelInfo();
    }

    isMeasureOrDrawMode(mode) {
        return mode === 'draw' || mode === 'measure-straight' || mode === 'measure-polyline';
    }

    getActiveDrawInteraction() {
        if (this.state.mode === 'measure-straight') return this.interactions.drawStraight;
        if (this.state.mode === 'measure-polyline') return this.interactions.drawPolyline;
        if (this.state.mode === 'draw')             return this.interactions.draw;
        return null;
    }

    abortActiveDraw() {
        this.getActiveDrawInteraction()?.abortDrawing();
    }

    pauseDrawAfterClose() {
        this.interactions.draw.setActive(false);
        if (this.state.drawLockTimeoutId) window.clearTimeout(this.state.drawLockTimeoutId);
        this.state.drawLockTimeoutId = window.setTimeout(() => {
            this.state.drawLockTimeoutId = null;
            if (this.state.mode === 'draw') {
                this.interactions.draw.setActive(true);
                this.refreshSnapState();
                this.setToolbarMessage(t('msg.drawResumed'));
            }
        }, 1000);
    }

    refreshSnapState() {
        const allowed = this.isMeasureOrDrawMode(this.state.mode) || this.state.mode === 'edit';
        this.interactions.snap.setActive(allowed && !this.state.isCtrlPressed);

        if (this.state.mode === 'navigate') {
            this.elements.snapStatus.textContent = t('snap.off.navigate');
        } else if (this.state.mode === 'delete') {
            this.elements.snapStatus.textContent = t('snap.off.delete');
        } else if (this.state.isCtrlPressed) {
            this.elements.snapStatus.textContent = t('snap.off.ctrl');
        } else {
            this.elements.snapStatus.textContent = t('snap.on');
        }
    }

    // ── Feature selection ────────────────────────────────────────────────────────

    handleFeatureSelection(event) {
        const feature = event.selected[0] ?? null;

        if (!feature) {
            this.state.selectedFeature = null;
            this.layers.vector.changed();
            this.updateSummary();
            return;
        }

        if (this.state.mode === 'delete') {
            this.vectorSource.removeFeature(feature);
            this.clearSelection();
            this.setToolbarMessage(t('msg.featureDeleted'));
            return;
        }

        this.state.selectedFeature = feature;
        this.layers.vector.changed();
        this.updateSummary();
        this.setToolbarMessage(t('msg.featureSelected', { name: feature.get('featureName') }));
    }

    clearSelection() {
        this.state.selectedFeature = null;
        this.interactions.select.getFeatures().clear();
        this.layers.vector.changed();
        this.updateSummary();
    }

    // ── Summary ──────────────────────────────────────────────────────────────────

    updateSummary() {
        const features     = this.vectorSource.getFeatures();
        const areaFeatures = features.filter((f) => {
            const type = f.getGeometry()?.getType();
            return type === 'Polygon' || type === 'MultiPolygon';
        });

        const proj         = this.view?.getProjection();
        const totalArea    = areaFeatures.reduce((s, f) => s + calculateArea(f, proj), 0);
        const totalPerim   = areaFeatures.reduce((s, f) => s + calculatePerimeter(f, proj), 0);

        const selType = this.state.selectedFeature?.getGeometry()?.getType();
        const selectedMeasure = !this.state.selectedFeature
            ? t('stat.selection.none')
            : (selType === 'Polygon' || selType === 'MultiPolygon')
                ? t('feature.selectionArea', {
                    area:      this.unitSystem.formatArea(calculateArea(this.state.selectedFeature, proj)),
                    perimeter: this.unitSystem.formatPerimeter(calculatePerimeter(this.state.selectedFeature, proj)),
                })
                : this.unitSystem.formatLength(calculateLength(this.state.selectedFeature, proj));

        this.elements.statCount.textContent          = String(areaFeatures.length);
        this.elements.statTotalArea.textContent      = this.unitSystem.formatArea(totalArea);
        this.elements.statTotalPerimeter.textContent = this.unitSystem.formatPerimeter(totalPerim);
        this.elements.statSelectedArea.textContent   = selectedMeasure;
        this.elements.statZoom.textContent           = (this.view?.getZoom() ?? 0).toFixed(1);
    }

    // ── Feature actions ──────────────────────────────────────────────────────────

    duplicateSelectedArea() {
        if (!this.state.selectedFeature) {
            alert(t('alert.noDuplicate'));
            return;
        }
        const type = this.state.selectedFeature.getGeometry()?.getType();
        if (type !== 'Polygon' && type !== 'MultiPolygon') {
            alert(t('alert.duplicatePolygonOnly'));
            return;
        }

        const clone = this.state.selectedFeature.clone();
        const geom  = clone.getGeometry();
        if (!geom) return;

        const offset = (this.view.getResolution() ?? 1) * 24;
        geom.translate(offset, -offset);
        clone.unset('featureId', true);
        clone.unset('featureName', true);
        decorateFeature(clone, this.state, this.vectorSource.getFeatures().length);
        this.vectorSource.addFeature(clone);

        this.state.selectedFeature = clone;
        this.layers.vector.changed();
        this.interactions.select.getFeatures().clear();
        this.interactions.select.getFeatures().push(clone);
        this.updateSummary();
        this.setToolbarMessage(t('msg.featureDuplicated'));
    }

    deleteSelectedFeature() {
        if (!this.state.selectedFeature) {
            alert(t('alert.noSelection'));
            return;
        }
        this.vectorSource.removeFeature(this.state.selectedFeature);
        this.clearSelection();
        this.setToolbarMessage(t('msg.featureDeletedSelected'));
    }

    clearAllFeatures() {
        if (!this.vectorSource.getFeatures().length) {
            this.setToolbarMessage(t('msg.nothingToClear'));
            return;
        }
        if (!window.confirm(t('confirm.clearAll'))) return;
        this.vectorSource.clear();
        this.clearSelection();
        this.setToolbarMessage(t('msg.clearDone'));
    }

    // ── Export / Import ──────────────────────────────────────────────────────────

    async exportFeatures() {
        const features = this.vectorSource.getFeatures();
        if (!features.length) {
            alert(t('alert.noExport'));
            return;
        }
        const fmt    = this.elements.exportFormat.value;

        if (['geotiff', 'pgw', 'bundle'].includes(fmt)) {
            this.setToolbarMessage(t('msg.exportProcessing'));
            try {
                const size = this.map.getSize();
                if (!size) {
                    throw new Error('Map size unavailable');
                }
                const extent = this.map.getView().calculateExtent(size);
                // OpenLayers ships EPSG:4326 by default; use it for bbox conversion.
                const [west, south, east, north] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');

                await requestBackendExport(
                    /** @type {'geotiff'|'pgw'|'bundle'} */ (fmt),
                    {
                        bbox: [south, west, north, east],
                        width: size[0],
                        height: size[1],
                        layers: this.getVisibleCatastoWmsLayerNames(),
                    },
                    features,
                );
                this.setToolbarMessage(t(`export.done.${fmt}`));
            } catch (error) {
                const message = error instanceof Error ? error.message : 'unknown error';
                this.setToolbarMessage(t('export.error.backend', { error: message }));
            }
            return;
        }

        const config = buildExportConfig(features, fmt);
        triggerDownload(
            config.payload,
            config.mimeType,
            `planimeter-${new Date().toISOString().slice(0, 10)}.${config.extension}`,
        );
        this.setToolbarMessage(t('msg.exportDone', { format: config.label }));
    }

    exportViewSnapshot() {
        const qualityScale = this.getExportScaleFactor();
        const composite = this.buildViewportCompositeCanvas(qualityScale);
        if (!composite) {
            this.setToolbarMessage(t('msg.exportImageFailed'));
            return;
        }

        const finalCanvas = this.composeExportCanvasWithFooter(composite.canvas, { kind: 'view' });
        const exported = this.downloadCanvasAsPng(finalCanvas, `planimeter-view-${Date.now()}.png`);
        if (!exported) return;

        if (composite.skippedCount > 0) {
            this.setToolbarMessage(t('msg.exportImagePartial', { count: composite.skippedCount }));
            return;
        }
        this.setToolbarMessage(t('msg.exportViewDone'));
    }

    startSelectionExportMode() {
        if (this.selectionExport?.active) {
            this.cancelSelectionExportMode(false);
        }

        const viewport = this.map.getViewport();
        const container = document.createElement('div');
        container.className = 'export-selection-box';
        container.hidden = true;
        container.innerHTML = `
            <div class="export-selection-handle" data-handle="nw"></div>
            <div class="export-selection-handle" data-handle="n"></div>
            <div class="export-selection-handle" data-handle="ne"></div>
            <div class="export-selection-handle" data-handle="e"></div>
            <div class="export-selection-handle" data-handle="se"></div>
            <div class="export-selection-handle" data-handle="s"></div>
            <div class="export-selection-handle" data-handle="sw"></div>
            <div class="export-selection-handle" data-handle="w"></div>
            <div class="export-selection-handle export-selection-handle--center" data-handle="center"></div>
            <div class="export-selection-handle export-selection-handle--rotate" data-handle="rotate"></div>
        `;
        viewport.appendChild(container);

        const state = {
            active: true,
            viewport,
            container,
            rect: null,
            interaction: null,
            panTimer: null,
        };

        const stopAutoPan = () => {
            if (state.panTimer) {
                window.clearInterval(state.panTimer);
                state.panTimer = null;
            }
        };

        const maybeAutoPan = () => {
            if (!state.interaction || !state.interaction.pointer) {
                stopAutoPan();
                return;
            }
            if (state.panTimer) return;

            state.panTimer = window.setInterval(() => {
                if (!state.interaction || !state.interaction.pointer) return;
                const size = this.map.getSize() ?? [0, 0];
                const margin = 28;
                const stepPx = 22;
                let dx = 0;
                let dy = 0;

                if (state.interaction.pointer[0] < margin) dx = -stepPx;
                else if (state.interaction.pointer[0] > size[0] - margin) dx = stepPx;

                if (state.interaction.pointer[1] < margin) dy = -stepPx;
                else if (state.interaction.pointer[1] > size[1] - margin) dy = stepPx;

                if (!dx && !dy) return;

                const center = this.view.getCenter();
                const resolution = this.view.getResolution() ?? 1;
                if (!center) return;

                this.view.setCenter([
                    center[0] + dx * resolution,
                    center[1] - dy * resolution,
                ]);

                state.interaction.pointer = [
                    state.interaction.pointer[0] - dx,
                    state.interaction.pointer[1] - dy,
                ];

                if (state.interaction.type === 'create') {
                    this.updateSelectionRectFromCreate(state, state.interaction.startPointer, state.interaction.pointer);
                    this.renderSelectionRect(state);
                }
            }, 35);
        };

        const onMouseDown = (ev) => {
            if (ev.button !== 0) return;

            const pointer = this.map.getEventPixel(ev);
            const handle = ev.target.closest('[data-handle]')?.dataset.handle ?? null;

            ev.preventDefault();
            ev.stopPropagation();

            if (handle && state.rect) {
                state.interaction = this.beginSelectionTransform(state.rect, handle, pointer);
            } else {
                state.interaction = {
                    type: 'create',
                    startPointer: pointer,
                    pointer,
                };
                this.updateSelectionRectFromCreate(state, pointer, pointer);
                this.renderSelectionRect(state);
            }

            maybeAutoPan();
        };

        const onMouseMove = (ev) => {
            if (!state.interaction) return;

            const pointer = this.map.getEventPixel(ev);
            state.interaction.pointer = pointer;

            if (state.interaction.type === 'create') {
                this.updateSelectionRectFromCreate(state, state.interaction.startPointer, pointer);
            } else {
                this.updateSelectionRectFromTransform(state, state.interaction, pointer);
            }

            this.renderSelectionRect(state);
            maybeAutoPan();
        };

        const onMouseUp = () => {
            if (!state.interaction) return;
            stopAutoPan();

            if (state.interaction.type === 'create') {
                if (!state.rect || state.rect.width < 24 || state.rect.height < 24) {
                    state.rect = null;
                    this.renderSelectionRect(state);
                    this.setToolbarMessage(t('msg.exportSelectionTooSmall'));
                } else {
                    this.setToolbarMessage(t('msg.exportSelectionReady'));
                }
            }

            state.interaction = null;
        };

        const onContextMenu = (ev) => {
            if (!state.active) return;
            ev.preventDefault();
        };

        viewport.classList.add('export-selection-active');
        this.setMapNavigationEnabled(false);
        viewport.addEventListener('mousedown', onMouseDown);
        viewport.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        viewport.addEventListener('contextmenu', onContextMenu);

        state.cleanup = () => {
                stopAutoPan();
                viewport.classList.remove('export-selection-active');
                viewport.removeEventListener('mousedown', onMouseDown);
                viewport.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                viewport.removeEventListener('contextmenu', onContextMenu);
                container.remove();
                this.setMapNavigationEnabled(true);
        };

        this.selectionExport = state;

        this.setToolbarMessage(t('msg.exportSelectionMode'));
    }

    exportActiveSelection() {
        const rect = this.selectionExport?.rect;
        if (!rect || rect.width < 24 || rect.height < 24) {
            this.setToolbarMessage(t('msg.exportSelectionTooSmall'));
            return;
        }

        const qualityScale = this.getExportScaleFactor();
        const composite = this.buildViewportCompositeCanvas(qualityScale);
        if (!composite) {
            this.setToolbarMessage(t('msg.exportImageFailed'));
            return;
        }

        const cropCanvas = this.cropCompositeBySelection(composite.canvas, rect, composite.scale);
        const extent = this.selectionRectToExtent(rect);
        const finalCanvas = this.composeExportCanvasWithFooter(cropCanvas, {
            kind: 'selection',
            extent,
        });

        const exported = this.downloadCanvasAsPng(finalCanvas, `planimeter-selection-${Date.now()}.png`);
        if (!exported) return;

        if (composite.skippedCount > 0) {
            this.setToolbarMessage(t('msg.exportImagePartial', { count: composite.skippedCount }));
        } else {
            this.setToolbarMessage(t('msg.exportSelectionDone'));
        }
        this.cancelSelectionExportMode(false);
    }

    cancelSelectionExportMode(showMessage = true) {
        if (!this.selectionExport?.active) return;
        this.selectionExport.active = false;
        this.selectionExport.cleanup?.();
        this.selectionExport = null;
        if (showMessage) {
            this.setToolbarMessage(t('msg.exportSelectionCancelled'));
        }
    }

    buildViewportCompositeCanvas(scale = 1) {
        const size = this.map.getSize();
        if (!size) return null;

        const [width, height] = size;
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = Math.max(1, Math.round(width * scale));
        exportCanvas.height = Math.max(1, Math.round(height * scale));
        const context = exportCanvas.getContext('2d');
        let skippedCount = 0;
        let drawnCount = 0;

        try {
            const canvases = this.map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer');
            canvases.forEach((canvas) => {
                if (!canvas.width || !canvas.height) return;
                if (!this.canUseCanvasForExport(canvas)) {
                    skippedCount += 1;
                    return;
                }

                const parent = canvas.parentNode;
                const opacity = parent?.style?.opacity;
                context.globalAlpha = opacity === '' || opacity == null ? 1 : Number(opacity);

                const transform = canvas.style.transform;
                let matrix = [1, 0, 0, 1, 0, 0];
                if (transform) {
                    const match = transform.match(/^matrix\(([^)]+)\)$/);
                    if (match) {
                        matrix = match[1].split(',').map(Number);
                    }
                }

                context.setTransform(
                    matrix[0] * scale,
                    matrix[1] * scale,
                    matrix[2] * scale,
                    matrix[3] * scale,
                    matrix[4] * scale,
                    matrix[5] * scale,
                );
                context.drawImage(canvas, 0, 0);
                drawnCount += 1;
            });

            if (drawnCount === 0) {
                return null;
            }

            context.setTransform(1, 0, 0, 1, 0, 0);
            context.globalAlpha = 1;
            return {
                canvas: exportCanvas,
                scale,
                skippedCount,
            };
        } catch (error) {
            console.error('Map canvas export failed:', error);
            return null;
        }
    }

    canUseCanvasForExport(canvas) {
        try {
            const probe = document.createElement('canvas');
            probe.width = 1;
            probe.height = 1;
            const probeCtx = probe.getContext('2d', { willReadFrequently: true });
            probeCtx.drawImage(canvas, 0, 0, 1, 1, 0, 0, 1, 1);
            probeCtx.getImageData(0, 0, 1, 1);
            return true;
        } catch {
            return false;
        }
    }

    getExportScaleFactor() {
        if (this.state.exportImageQuality === 'ultra') return 2;
        if (this.state.exportImageQuality === 'high') return 1.5;
        return 1;
    }

    getSpecialContextMenu(ctx) {
        if (!this.selectionExport?.active) return null;

        const hasRect = Boolean(this.selectionExport.rect);
        const clickedHandle = Boolean(ctx?.event?.target?.closest?.('[data-handle]'));
        const clickedContainer = Boolean(ctx?.event?.target?.closest?.('.export-selection-box'));
        const clickedInsideRect = hasRect && Array.isArray(ctx?.pixel)
            ? this.isPointInsideSelectionRect(ctx.pixel, this.selectionExport.rect)
            : false;

        if (hasRect && !(clickedHandle || clickedContainer || clickedInsideRect)) {
            return null;
        }

        const items = [];
        if (hasRect) {
            items.push({ key: 'ctx.exportSelection', action: 'exportSelectionNow' });
        }
        items.push({ key: 'ctx.cancelSelectionExport', action: 'cancelSelectionExport' });

        return {
            items,
            actions: {
                exportSelectionNow: () => this.exportActiveSelection(),
                cancelSelectionExport: () => this.cancelSelectionExportMode(),
            },
        };
    }

    isPointInsideSelectionRect(pixel, rect) {
        if (!Array.isArray(pixel) || !rect) return false;
        const local = this.toLocalPoint(pixel, [rect.cx, rect.cy], rect.angle);
        return Math.abs(local[0]) <= rect.width / 2 && Math.abs(local[1]) <= rect.height / 2;
    }

    setMapNavigationEnabled(enabled) {
        if (!this.dragPanInteractions) {
            this.dragPanInteractions = this.map
                .getInteractions()
                .getArray()
                .filter((interaction) => interaction?.constructor?.name === 'DragPan');
        }
        this.dragPanInteractions.forEach((interaction) => interaction.setActive(enabled));
    }

    updateSelectionRectFromCreate(state, start, current) {
        const minWidth = 1;
        const minHeight = 1;
        state.rect = {
            cx: (start[0] + current[0]) / 2,
            cy: (start[1] + current[1]) / 2,
            width: Math.max(minWidth, Math.abs(current[0] - start[0])),
            height: Math.max(minHeight, Math.abs(current[1] - start[1])),
            angle: 0,
        };
    }

    beginSelectionTransform(rect, handle, pointer) {
        const interaction = {
            type: handle === 'rotate' ? 'rotate' : (handle === 'center' ? 'move' : 'resize'),
            handle,
            pointer,
            rect0: { ...rect },
        };

        if (interaction.type === 'move') {
            interaction.offsetX = pointer[0] - rect.cx;
            interaction.offsetY = pointer[1] - rect.cy;
        } else if (interaction.type === 'rotate') {
            interaction.startPointerAngle = Math.atan2(pointer[1] - rect.cy, pointer[0] - rect.cx);
            interaction.startRectAngle = rect.angle;
        }

        return interaction;
    }

    updateSelectionRectFromTransform(state, interaction, pointer) {
        if (!state.rect) return;

        if (interaction.type === 'move') {
            state.rect.cx = pointer[0] - interaction.offsetX;
            state.rect.cy = pointer[1] - interaction.offsetY;
            return;
        }

        if (interaction.type === 'rotate') {
            const currentAngle = Math.atan2(pointer[1] - interaction.rect0.cy, pointer[0] - interaction.rect0.cx);
            state.rect.angle = interaction.startRectAngle + (currentAngle - interaction.startPointerAngle);
            return;
        }

        this.resizeSelectionRectByHandle(state, interaction, pointer);
    }

    resizeSelectionRectByHandle(state, interaction, pointer) {
        const rect0 = interaction.rect0;
        const angle = rect0.angle;
        const minSize = 24;

        const localPointer = this.toLocalPoint(pointer, [rect0.cx, rect0.cy], angle);

        let left = -rect0.width / 2;
        let right = rect0.width / 2;
        let top = -rect0.height / 2;
        let bottom = rect0.height / 2;

        const handle = interaction.handle;
        if (handle.includes('e')) right = Math.max(left + minSize, localPointer[0]);
        if (handle.includes('w')) left = Math.min(right - minSize, localPointer[0]);
        if (handle.includes('s')) bottom = Math.max(top + minSize, localPointer[1]);
        if (handle.includes('n')) top = Math.min(bottom - minSize, localPointer[1]);

        const centerLocal = [
            (left + right) / 2,
            (top + bottom) / 2,
        ];
        const centerGlobal = this.fromLocalPoint(centerLocal, [rect0.cx, rect0.cy], angle);

        state.rect = {
            cx: centerGlobal[0],
            cy: centerGlobal[1],
            width: Math.max(minSize, right - left),
            height: Math.max(minSize, bottom - top),
            angle,
        };
    }

    toLocalPoint(point, center, angle) {
        const dx = point[0] - center[0];
        const dy = point[1] - center[1];
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return [
            dx * cos + dy * sin,
            -dx * sin + dy * cos,
        ];
    }

    fromLocalPoint(local, center, angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return [
            center[0] + local[0] * cos - local[1] * sin,
            center[1] + local[0] * sin + local[1] * cos,
        ];
    }

    renderSelectionRect(state) {
        if (!state.rect) {
            state.container.hidden = true;
            return;
        }

        const rect = state.rect;
        state.container.hidden = false;
        state.container.style.left = `${rect.cx - rect.width / 2}px`;
        state.container.style.top = `${rect.cy - rect.height / 2}px`;
        state.container.style.width = `${rect.width}px`;
        state.container.style.height = `${rect.height}px`;
        state.container.style.transform = `rotate(${rect.angle}rad)`;
    }

    cropCompositeBySelection(sourceCanvas, rect, scale) {
        const outWidth = Math.max(1, Math.round(rect.width * scale));
        const outHeight = Math.max(1, Math.round(rect.height * scale));

        const out = document.createElement('canvas');
        out.width = outWidth;
        out.height = outHeight;

        const ctx = out.getContext('2d');
        ctx.translate(outWidth / 2, outHeight / 2);
        ctx.rotate(-rect.angle);
        ctx.translate(-rect.cx * scale, -rect.cy * scale);
        ctx.drawImage(sourceCanvas, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        return out;
    }

    selectionRectToExtent(rect) {
        const halfW = rect.width / 2;
        const halfH = rect.height / 2;
        const localCorners = [
            [-halfW, -halfH],
            [halfW, -halfH],
            [halfW, halfH],
            [-halfW, halfH],
        ];

        const mapCoords = localCorners
            .map((corner) => this.fromLocalPoint(corner, [rect.cx, rect.cy], rect.angle))
            .map((pixel) => this.map.getCoordinateFromPixel(pixel))
            .filter(Boolean);

        if (!mapCoords.length) return null;

        const xs = mapCoords.map((c) => c[0]);
        const ys = mapCoords.map((c) => c[1]);
        return [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
        ];
    }

    selectionPixelsToExtent(x, y, width, height) {
        const topLeft = this.map.getCoordinateFromPixel([x, y]);
        const bottomRight = this.map.getCoordinateFromPixel([x + width, y + height]);
        if (!topLeft || !bottomRight) return null;
        return [
            Math.min(topLeft[0], bottomRight[0]),
            Math.min(topLeft[1], bottomRight[1]),
            Math.max(topLeft[0], bottomRight[0]),
            Math.max(topLeft[1], bottomRight[1]),
        ];
    }

    composeExportCanvasWithFooter(sourceCanvas, options = {}) {
        const footerHeight = 54;
        const out = document.createElement('canvas');
        out.width = sourceCanvas.width;
        out.height = sourceCanvas.height + footerHeight;
        const ctx = out.getContext('2d');

        ctx.drawImage(sourceCanvas, 0, 0);

        ctx.fillStyle = 'rgba(6, 16, 12, 0.92)';
        ctx.fillRect(0, sourceCanvas.height, out.width, footerHeight);

        const center = this.view.getCenter();
        const centerLonLat = center ? toLonLat(center) : [0, 0];
        const centerText = `Center ${centerLonLat[1].toFixed(6)}, ${centerLonLat[0].toFixed(6)}`;
        const zoomText = `Zoom ${(this.view.getZoom() ?? 0).toFixed(2)}`;
        const tsText = new Date().toISOString().replace('T', ' ').slice(0, 19);

        let extentText = '';
        if (options.extent) {
            const e4326 = transformExtent(options.extent, 'EPSG:3857', 'EPSG:4326');
            extentText = `BBOX ${e4326.map((n) => n.toFixed(6)).join(',')}`;
        } else {
            const size = this.map.getSize();
            if (size) {
                const e = this.view.calculateExtent(size);
                const e4326 = transformExtent(e, 'EPSG:3857', 'EPSG:4326');
                extentText = `BBOX ${e4326.map((n) => n.toFixed(6)).join(',')}`;
            }
        }

        const layerText = `Layers: ${this.getVisibleLayerSummary()}`;

        ctx.fillStyle = '#dff7ec';
        ctx.font = '12px Segoe UI';
        ctx.textBaseline = 'top';
        ctx.fillText(`${centerText} | ${zoomText} | ${extentText}`, 10, sourceCanvas.height + 8);
        ctx.fillText(`${layerText} | ${tsText}`, 10, sourceCanvas.height + 28);

        return out;
    }

    getVisibleLayerSummary() {
        const list = [];
        if (this.elements.layerSat.checked) list.push('satellite');
        if (this.elements.layerOpenTopoMap.checked) list.push('open-topo');
        if (this.elements.layerEsriTopo.checked) list.push('esri-topo');
        if (this.elements.layerEsriRelief.checked) list.push('esri-relief');
        if (this.elements.layerOsm.checked) list.push('osm');
        if (this.elements.layerCatasto.checked) {
            if (this.state.catastoSource === 'official') {
                list.push(`catasto:${this.getVisibleCatastoWmsLayerNames().join('+')}`);
            } else {
                list.push('catasto:fallback');
            }
        }
        return list.length ? list.join(', ') : 'none';
    }

    downloadCanvasAsPng(canvas, filename) {
        try {
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = filename;
            a.click();
            return true;
        } catch (error) {
            console.error('PNG export failed:', error);
            this.setToolbarMessage(t('msg.exportImageFailed'));
            return false;
        }
    }

    importFeatures(event) {
        const [file] = event.target.files;
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const content  = String(reader.result);
                const fmt      = detectImportFormat(file.name, content);
                const imported = readImportedFeatures(content, fmt);

                if (!imported.length) throw new Error('No supported geometries found.');

                imported.forEach((f) => decorateFeature(f, this.state, this.vectorSource.getFeatures().length));
                this.vectorSource.addFeatures(imported);
                this.fitToFeatures();
                this.setToolbarMessage(t('msg.featuresImported', {
                    count:  imported.length,
                    file:   file.name,
                    format: fmt.toUpperCase(),
                }));
            } catch (err) {
                console.error('Import failed:', err);
                alert(t('alert.importFail'));
            } finally {
                event.target.value = '';
                this.updateSummary();
            }
        };
        reader.readAsText(file);
    }

    // ── View helpers ─────────────────────────────────────────────────────────────

    fitToFeatures() {
        if (!this.vectorSource.getFeatures().length) return;
        this.view.fit(this.vectorSource.getExtent(), {
            padding:  [80, 80, 80, 80],
            duration: 900,
            maxZoom:  18,
        });
    }

    geolocate() {
        if (!navigator.geolocation) {
            alert(t('alert.noGeolocation'));
            return;
        }
        const origLabel = this.elements.locateButton.textContent;
        this.elements.locateButton.disabled    = true;
        this.elements.locateButton.textContent = t('btn.locating');

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                this.view.animate({
                    center:   fromLonLat([pos.coords.longitude, pos.coords.latitude]),
                    zoom:     18,
                    duration: 1800,
                });
                this.setToolbarMessage(t('msg.locationFound'));
                this.resetLocateButton(origLabel);
            },
            (err) => {
                console.error('Geolocation error:', err);
                alert(t('alert.locationFail'));
                this.resetLocateButton(origLabel);
            },
            { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
        );
    }

    resetLocateButton(label) {
        this.elements.locateButton.disabled    = false;
        this.elements.locateButton.textContent = label;
    }

    // ── Layer helpers ────────────────────────────────────────────────────────────

    sanitizeBaseLayerKey(layerKey) {
        return BASE_LAYER_KEYS.includes(layerKey) ? layerKey : 'sat';
    }

    sanitizeAdminLayerKey(layerKey) {
        return ADMIN_LAYER_KEYS.includes(layerKey) ? layerKey : null;
    }

    bindLayerGroupToggles() {
        this.elements.baseLayerInputs.forEach((el) => {
            el.addEventListener('change', (ev) => {
                const key = ev.target.dataset.layerKey;
                if (ev.target.checked) {
                    this.state.activeBaseLayer = this.sanitizeBaseLayerKey(key);
                } else if (this.state.activeBaseLayer === key) {
                    // Keep exactly one base layer active at all times.
                    ev.target.checked = true;
                    return;
                }

                this.applyLayerGroupSelection();
                this.persistPreferences();
            });
        });

        this.elements.adminLayerInputs.forEach((el) => {
            el.addEventListener('change', (ev) => {
                const key = ev.target.dataset.layerKey;
                if (ev.target.checked) {
                    this.state.activeAdminLayer = this.sanitizeAdminLayerKey(key);
                } else if (this.state.activeAdminLayer === key) {
                    this.state.activeAdminLayer = null;
                }

                this.applyLayerGroupSelection();
                this.persistPreferences();
            });
        });
    }

    applyLayerGroupSelection() {
        this.state.activeBaseLayer = this.sanitizeBaseLayerKey(this.state.activeBaseLayer);
        this.state.activeAdminLayer = this.sanitizeAdminLayerKey(this.state.activeAdminLayer);

        const baseActive = this.state.activeBaseLayer;
        this.elements.layerSat.checked = baseActive === 'sat';
        this.elements.layerOpenTopoMap.checked = baseActive === 'openTopoMap';
        this.elements.layerEsriTopo.checked = baseActive === 'esriTopo';
        this.elements.layerEsriRelief.checked = baseActive === 'esriRelief';

        this.layers.sat.setVisible(baseActive === 'sat');
        this.layers.openTopoMap.setVisible(baseActive === 'openTopoMap');
        this.layers.esriTopo.setVisible(baseActive === 'esriTopo');
        this.layers.esriRelief.setVisible(baseActive === 'esriRelief');

        const adminActive = this.state.activeAdminLayer;
        this.elements.layerOsm.checked = adminActive === 'osm';
        this.elements.layerCatasto.checked = adminActive === 'catasto';
        this.layers.osm.setVisible(adminActive === 'osm');
        this.updateCatastoVisibility();

        this.proxyHealth?.update(this.elements.layerCatasto.checked, this.state.catastoSource);
        this.renderParcelInfo();
    }

    setCatastoSource(sourceKey) {
        this.state.catastoSource = sourceKey;
        this.updateCatastoVisibility();

        const isOfficial = sourceKey === 'official';
        this.elements.catastoHint.textContent       = t(isOfficial ? 'layer.catasto.hint.official' : 'layer.catasto.hint.fallback');
        this.elements.statCatastoSource.textContent = t(isOfficial ? 'stat.catasto.official' : 'stat.catasto.fallback');

        this.proxyHealth.update(this.elements.layerCatasto.checked, sourceKey);
        this.renderParcelInfo();
        this.persistPreferences();
    }

    updateCatastoVisibility() {
        const show       = this.elements.layerCatasto.checked;
        const isOfficial = this.state.catastoSource === 'official';
        this.applyCatastoWmsLayerSettings();
        this.layers.catastoFallback.setVisible(show && !isOfficial);
    }

    // ── Locale/unit refresh ──────────────────────────────────────────────────────

    /** Refresh all dynamic UI text after a locale change. */
    refreshUIText() {
        this.refreshSnapState();
        const modeMsg = {
            'navigate':         'msg.navigateActive',
            'draw':             'msg.drawActive',
            'edit':             'msg.editActive',
            'delete':           'msg.deleteActive',
            'measure-straight': 'msg.measureStraightActive',
            'measure-polyline': 'msg.measurePolylineActive',
        };
        this.setToolbarMessage(t(modeMsg[this.state.mode] ?? 'msg.navigateActive'));

        const isOfficial = this.state.catastoSource === 'official';
        this.elements.catastoHint.textContent       = t(isOfficial ? 'layer.catasto.hint.official' : 'layer.catasto.hint.fallback');
        this.elements.statCatastoSource.textContent = t(isOfficial ? 'stat.catasto.official' : 'stat.catasto.fallback');

        this.proxyHealth.render();
        this.layers.vector.changed();
        this.updateSummary();
        this.syncPreferenceControls();
        this.renderParcelInfo();
    }

    // ── Misc ─────────────────────────────────────────────────────────────────────

    setToolbarMessage(message) {
        this.elements.status.textContent = message;
    }

    setToolbarPanel(panelKey) {
        const panel = panelKey === 'settings' ? 'settings' : 'operate';
        this.state.toolbarPanel = panel;
        this.elements.tabButtons.forEach((button) => {
            const active = button.dataset.panel === panel;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });
        this.elements.toolbarPanels.forEach((panelEl) => {
            const active = panelEl.dataset.panel === panel;
            panelEl.classList.toggle('is-active', active);
            panelEl.hidden = !active;
        });
        this.persistPreferences();
    }

    syncPreferenceControls() {
        if (this.elements.langSwitcher) {
            this.elements.langSwitcher.value = this.state.locale;
        }
        if (this.elements.settingsLanguage) {
            this.elements.settingsLanguage.value = this.state.locale;
        }
        if (this.elements.settingsUnitSystem) {
            this.elements.settingsUnitSystem.value = this.state.unitSystem;
        }
        if (this.elements.settingsExportQuality) {
            this.elements.settingsExportQuality.value = this.state.exportImageQuality;
        }
        if (this.elements.settingsCacheTtlDays) {
            this.elements.settingsCacheTtlDays.value = String(this.state.cacheTtlDays);
        }
        if (this.elements.settingsCacheSizeMb) {
            this.elements.settingsCacheSizeMb.value = String(this.state.cacheSizeMb);
        }
        if (this.elements.settingsParcelInfoEnabled) {
            this.elements.settingsParcelInfoEnabled.checked = this.state.parcelInfoEnabled;
        }
        if (this.elements.settingsWmsLayerParts?.length) {
            this.elements.settingsWmsLayerParts.forEach((el) => {
                const settings = this.state.catastoWmsLayerSettings[el.dataset.wmsLayerPart];
                el.checked = Boolean(settings?.visible);
            });
        }
        if (this.elements.settingsWmsLayerOpacity?.length) {
            this.elements.settingsWmsLayerOpacity.forEach((el) => {
                const settings = this.state.catastoWmsLayerSettings[el.dataset.wmsLayerOpacity];
                const opacity = settings?.opacity ?? 0.9;
                el.value = String(Math.round(opacity * 100));
                const valueEl = document.querySelector(
                    `[data-wms-layer-opacity-value="${el.dataset.wmsLayerOpacity}"]`,
                );
                if (valueEl) valueEl.textContent = `${Math.round(opacity * 100)}%`;
            });
        }

        // Keep layer checkboxes synchronized with persisted group selections.
        this.applyLayerGroupSelection();
    }

    persistPreferences() {
        savePreferences({
            locale: this.state.locale,
            unitSystem: this.state.unitSystem,
            toolbarPanel: this.state.toolbarPanel,
            activeBaseLayer: this.state.activeBaseLayer,
            activeAdminLayer: this.state.activeAdminLayer,
            catastoWmsLayerSettings: this.state.catastoWmsLayerSettings,
            parcelInfoEnabled: this.state.parcelInfoEnabled,
            exportImageQuality: this.state.exportImageQuality,
            cacheTtlDays: this.state.cacheTtlDays,
            cacheSizeMb: this.state.cacheSizeMb,
        });
    }

    updateLocale(locale) {
        setLocale(locale);
        this.state.locale = locale;
        this.persistPreferences();
        this.refreshUIText();
    }

    updateUnitSystem(unitSystem) {
        this.unitSystem = new UnitSystem(unitSystem);
        this.state.unitSystem = unitSystem;
        this.layers.vector.changed();
        this.persistPreferences();
        this.updateSummary();
        this.syncPreferenceControls();
    }

    sanitizeExportImageQuality(quality) {
        if (quality === 'high' || quality === 'ultra' || quality === 'standard') {
            return quality;
        }
        return 'standard';
    }

    sanitizeCacheTtlDays(ttlDays) {
        const value = Number.parseInt(String(ttlDays), 10);
        if (!Number.isFinite(value)) return 30;
        return Math.max(1, Math.min(365, value));
    }

    sanitizeCacheSizeMb(sizeMb) {
        const value = Number.parseInt(String(sizeMb), 10);
        if (!Number.isFinite(value)) return 500;
        return Math.max(32, Math.min(4096, value));
    }

    updateExportImageQuality(quality) {
        this.state.exportImageQuality = this.sanitizeExportImageQuality(quality);
        this.syncPreferenceControls();
        this.persistPreferences();
    }

    sanitizeCatastoWmsLayerSettings(settings, legacyLayers = null, legacyOpacity = null) {
        const legacyVisible = Array.isArray(legacyLayers)
            ? new Set(legacyLayers)
            : null;
        const legacyOpacityValue = Number.isFinite(Number(legacyOpacity))
            ? Math.max(0, Math.min(1, Number(legacyOpacity)))
            : null;

        return Object.fromEntries(CATASTO_WMS_LAYER_DEFS.map((def) => {
            const raw = settings?.[def.key] ?? {};
            const rawOpacity = Number(raw.opacity);
            const opacity = Number.isFinite(rawOpacity)
                ? Math.max(0, Math.min(1, rawOpacity))
                : (legacyOpacityValue ?? def.defaultOpacity);
            const visible = typeof raw.visible === 'boolean'
                ? raw.visible
                : (legacyVisible ? legacyVisible.has(def.layerName) : def.defaultVisible);
            return [def.key, { visible, opacity }];
        }));
    }

    updateCatastoWmsLayersFromSettings() {
        const next = { ...this.state.catastoWmsLayerSettings };
        this.elements.settingsWmsLayerParts.forEach((el) => {
            const key = el.dataset.wmsLayerPart;
            next[key] = {
                ...(next[key] ?? DEFAULT_CATASTO_WMS_LAYER_SETTINGS[key]),
                visible: el.checked,
            };
        });

        if (!Object.values(next).some((settings) => settings.visible)) {
            const firstKey = CATASTO_WMS_LAYER_DEFS[0].key;
            next[firstKey] = { ...next[firstKey], visible: true };
        }

        this.state.catastoWmsLayerSettings = this.sanitizeCatastoWmsLayerSettings(next);
        this.applyCatastoWmsLayerSettings();
        this.syncPreferenceControls();
        this.persistPreferences();
        this.renderParcelInfo();
    }

    updateCatastoWmsLayerOpacityFromSettings() {
        const next = { ...this.state.catastoWmsLayerSettings };
        this.elements.settingsWmsLayerOpacity.forEach((el) => {
            const key = el.dataset.wmsLayerOpacity;
            next[key] = {
                ...(next[key] ?? DEFAULT_CATASTO_WMS_LAYER_SETTINGS[key]),
                opacity: Number(el.value) / 100,
            };
        });

        this.state.catastoWmsLayerSettings = this.sanitizeCatastoWmsLayerSettings(next);
        this.applyCatastoWmsLayerSettings();
        this.syncPreferenceControls();
        this.persistPreferences();
    }

    applyCatastoWmsLayerSettings() {
        const show = this.elements.layerCatasto.checked && this.state.catastoSource === 'official';
        CATASTO_WMS_LAYER_DEFS.forEach((def) => {
            const settings = this.state.catastoWmsLayerSettings[def.key]
                ?? DEFAULT_CATASTO_WMS_LAYER_SETTINGS[def.key];
            const layer = this.layers.catastoOfficial[def.key];
            layer.setVisible(show && settings.visible);
            layer.setOpacity(settings.opacity);
        });
        this.layers.catastoFallback.setOpacity(this.getAverageVisibleCatastoOpacity());
    }

    getAverageVisibleCatastoOpacity() {
        const visible = Object.values(this.state.catastoWmsLayerSettings)
            .filter((settings) => settings.visible);
        if (!visible.length) return 0.9;
        const total = visible.reduce((sum, settings) => sum + settings.opacity, 0);
        return total / visible.length;
    }

    getVisibleCatastoWmsLayerNames() {
        return CATASTO_WMS_LAYER_DEFS
            .filter((def) => this.state.catastoWmsLayerSettings[def.key]?.visible)
            .map((def) => def.layerName);
    }

    canQueryParcelInfo() {
        return this.state.parcelInfoEnabled &&
            this.state.catastoSource === 'official' &&
            this.elements.layerCatasto.checked &&
            this.state.catastoWmsLayerSettings.parcels?.visible &&
            this.state.mode === 'navigate' &&
            !this.state.isDrawing;
    }

    canQueryParcelFromContextMenu() {
        return this.state.parcelInfoEnabled &&
            this.state.catastoSource === 'official' &&
            this.elements.layerCatasto.checked &&
            this.state.mode === 'navigate' &&
            this.state.catastoWmsLayerSettings.parcels?.visible;
    }

    canRefreshWmsTile() {
        return this.state.catastoSource === 'official' &&
            this.elements.layerCatasto.checked &&
            this.state.mode === 'navigate' &&
            Object.values(this.layers.catastoOfficial).some((layer) => layer.getVisible());
    }

    refreshTileAtPixel(pixel) {
        if (!this.canRefreshWmsTile() || !Array.isArray(pixel) || pixel.length < 2) return;

        const view = this.map.getView();
        const coordinate = this.map.getCoordinateFromPixel(pixel);
        const resolution = view.getResolution();
        const projection = view.getProjection();
        if (!coordinate || typeof resolution !== 'number') return;

        const pixelRatio = this.map.getPixelRatio?.() ?? window.devicePixelRatio ?? 1;
        let refreshed = 0;
        const refreshedRefs = [];

        for (const [layerKey, layer] of Object.entries(this.layers.catastoOfficial)) {
            if (!layer.getVisible()) continue;

            const source = layer.getSource();
            const tileGrid = source?.getTileGridForProjection?.(projection);
            if (!tileGrid) continue;

            const tileCoord = tileGrid.getTileCoordForCoordAndResolution(coordinate, resolution);
            if (!tileCoord) continue;

            const [z, x, y] = tileCoord;
            const tile = source.getTile(z, x, y, pixelRatio, projection);
            const image = tile?.getImage?.();
            if (image instanceof HTMLImageElement && image.src) {
                const cacheBuster = `__refresh_ts=${Date.now()}`;
                const joiner = image.src.includes('?') ? '&' : '?';
                image.addEventListener('load', () => {
                    layer.changed();
                    this.map.renderSync();
                }, { once: true });
                image.addEventListener('error', () => {
                    layer.changed();
                    this.map.renderSync();
                }, { once: true });
                image.src = `${image.src}${joiner}${cacheBuster}`;
                refreshed += 1;
                refreshedRefs.push(`${layerKey}:${z}/${x}/${y}`);
            } else if (tile && typeof tile.load === 'function') {
                // Fallback for non-image tiles.
                tile.load();
                refreshed += 1;
                refreshedRefs.push(`${layerKey}:${z}/${x}/${y}`);
            }

            layer.changed();
        }

        this.map.render();
        if (refreshed > 0) {
            const refs = refreshedRefs.slice(0, 2).join(', ');
            const more = refreshedRefs.length > 2 ? ` (+${refreshedRefs.length - 2})` : '';
            this.setToolbarMessage(`WMS tile refresh ${refreshed}: ${refs}${more}`);
        }
    }

    editFeatureFromContext(feature) {
        if (!feature) return;
        this.setMode('edit');
        this.state.selectedFeature = feature;
        this.interactions.select.getFeatures().clear();
        this.interactions.select.getFeatures().push(feature);
        this.layers.vector.changed();
        this.updateSummary();
        this.setToolbarMessage(t('msg.featureSelected', { name: feature.get('featureName') }));
    }

    deleteFeatureFromContext(feature) {
        if (!feature) return;
        this.vectorSource.removeFeature(feature);
        if (this.state.selectedFeature === feature) this.clearSelection();
        this.setToolbarMessage(t('msg.featureDeleted'));
    }

    async fetchParcelInfoAtPixel(pixel) {
        if (!this.canQueryParcelFromContextMenu()) {
            this.state.parcelInfoHtml = null;
            this.state.parcelInfoLoading = false;
            this.state.parcelInfoStatusKey = this.state.parcelInfoEnabled
                ? 'parcelInfo.clickHint'
                : 'parcelInfo.disabled';
            this.state.parcelInfoAnchorPixel = null;
            this.state.parcelInfoPopoverDismissed = true;
            this.renderParcelInfo();
            return;
        }

        this.state.parcelInfoPopoverDismissed = false;
        this.state.suppressNextParcelInfoClick = false;
        this.state.parcelInfoAnchorPixel = pixel;
        this.state.parcelInfoLoading = true;
        this.state.parcelInfoHtml = null;
        this.state.parcelInfoStatusKey = 'parcelInfo.loading';
        this.renderParcelInfo();

        try {
            const result = Planimeter.FEATUREINFO_USE_JSON
                ? await this.requestParcelInfoJson(pixel)
                : await this.requestParcelInfoHtml(pixel);
            this.state.parcelInfoHtml = result.parcelInfoHtml ?? null;
            this.state.parcelInfoStatusKey = result.statusKey;
            if (result.parcelId) {
                this.state.lastParcelId = result.parcelId;
                if (this.state.selectedFeature) {
                    this.state.selectedFeature.set('parcel_id', result.parcelId);
                    const links = this.state.selectedFeature.get('links') ?? { cadastral: [] };
                    if (!links.cadastral.some((c) => c.parcel_id === result.parcelId)) {
                        links.cadastral.push({ parcel_id: result.parcelId, linkedAt: new Date().toISOString() });
                    }
                    this.state.selectedFeature.set('links', links);
                }
            }
        } catch (error) {
            console.error('Parcel info request failed:', error);
            this.state.parcelInfoHtml = null;
            this.state.parcelInfoStatusKey = 'parcelInfo.error';
        } finally {
            this.state.parcelInfoLoading = false;
            this.renderParcelInfo();
        }
    }

    // Feature flag: switch GetFeatureInfo from raw-HTML to structured-JSON mode.
    // When true, /wms-proxy returns parsed canonical fields from server.
    static FEATUREINFO_USE_JSON = true;

    async requestParcelInfoJson(pixel) {
        const rawUrl = this.buildParcelInfoUrl(pixel, 'text/html');
        if (!rawUrl) return { parcelInfoHtml: null, statusKey: 'parcelInfo.empty' };

        const url = rawUrl + '&OUTPUT=json';
        let data;
        try {
            const response = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!response.ok) return { parcelInfoHtml: null, statusKey: 'parcelInfo.error' };
            data = await response.json();
        } catch {
            return { parcelInfoHtml: null, statusKey: 'parcelInfo.error' };
        }

        if (data?.error === 'parse_failed') {
            return { parcelInfoHtml: null, statusKey: 'parcelInfo.empty', parcelId: null };
        }
        if (!data?.parcel || !Object.keys(data.parcel).length) {
            return { parcelInfoHtml: null, statusKey: 'parcelInfo.empty', parcelId: null };
        }

        const parcelId = data.parcel?.id ?? data.parcel?.local_id ?? null;
        return { parcelInfoHtml: this._buildParcelHtmlFromJson(data), statusKey: 'parcelInfo.ready', parcelId };
    }

    _buildParcelHtmlFromJson(data) {
        const p = data.parcel ?? {};
        const rows = Object.entries(data.raw ?? p)
            .filter(([, v]) => v)
            .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
            .join('');
        return `<table>${rows}</table>`;
    }

    async requestParcelInfoHtml(pixel) {
        const url = this.buildParcelInfoUrl(pixel, 'text/html');
        if (!url) return { parcelInfoHtml: null, statusKey: 'parcelInfo.empty' };

        const response = await fetch(url, {
            headers: { Accept: 'text/html, text/*;q=0.8, */*;q=0.2' },
        });
        const payload = await response.text();

        if (this.isFeatureInfoUnsupported(payload)) {
            return { parcelInfoHtml: null, statusKey: 'parcelInfo.unsupported' };
        }
        if (!response.ok) {
            return { parcelInfoHtml: null, statusKey: 'parcelInfo.error' };
        }

        const rawHtml = this.extractFeatureInfoHtmlPage(payload);
        if (!rawHtml) {
            return { parcelInfoHtml: null, statusKey: 'parcelInfo.empty' };
        }

        return { parcelInfoHtml: rawHtml, statusKey: 'parcelInfo.ready' };
    }

    extractFeatureInfoHtmlPage(payload) {
        const html = String(payload || '');
        if (!html) return null;
        if (/no\s+features\s+were\s+found/i.test(html)) return null;
        if (!/<table[\s\S]*<\/table>/i.test(html)) return null;

        // Keep upstream table markup, strip scripts for safety.
        return html.replace(/<script\b[\s\S]*?<\/script>/gi, '').trim();
    }

    buildParcelInfoUrl(pixel, infoFormat = 'text/html') {
        const source = this.layers.catastoOfficial.parcels.getSource();
        const coordinate = this.map.getCoordinateFromPixel(pixel);
        const resolution = this.view.getResolution();
        if (!coordinate || !resolution) return null;

        const url = source.getFeatureInfoUrl(
            coordinate,
            resolution,
            this.view.getProjection(),
            {
                INFO_FORMAT: infoFormat,
                FEATURE_COUNT: 10,
                LAYERS: 'CP.CadastralParcel',
                QUERY_LAYERS: 'CP.CadastralParcel',
            },
        );
        if (!url) return null;

        return url.replace('/wms-tile?', '/wms-proxy?');
    }

    isFeatureInfoUnsupported(payload) {
        return typeof payload === 'string' &&
            /ServiceException/i.test(payload) &&
            /InvalidFormat/i.test(payload) &&
            /GetFeatureInfo/i.test(payload);
    }

    closeParcelInfoPopover() {
        this.state.parcelInfoPopoverDismissed = true;
        this.state.parcelInfoAnchorPixel = null;
        this.renderParcelInfo();
    }

    syncParcelInfoFrameSize() {
        const frame = this.elements.parcelInfoPopoverFrame;
        const popover = this.elements.parcelInfoPopover;
        if (!frame || !popover || frame.hidden) return;

        try {
            const doc = frame.contentDocument;
            if (!doc?.body) return;
            const viewport = this.map?.getViewport();
            const viewportRect = viewport?.getBoundingClientRect();
            const maxHeight = Math.max(220, (viewportRect?.height || window.innerHeight) - 80);
            const maxWidth = Math.max(360, (viewportRect?.width || window.innerWidth) - 40);
            const contentHeight = Math.min(maxHeight, Math.max(180, doc.body.scrollHeight + 8));
            const contentWidth = Math.min(maxWidth, Math.max(320, doc.body.scrollWidth + 16));

            frame.style.height = `${contentHeight}px`;
            popover.style.width = `${contentWidth}px`;
        } catch {
            // ignore sizing errors and keep defaults
        }
    }

    renderParcelInfo() {
        const statusEl = this.elements.parcelInfoStatus;
        const popoverEl = this.elements.parcelInfoPopover;
        const popoverStatusEl = this.elements.parcelInfoPopoverStatus;
        const popoverFrameEl = this.elements.parcelInfoPopoverFrame;

        const setStatus = (key) => {
            const text = t(key);
            if (statusEl) statusEl.textContent = text;
            if (popoverStatusEl) popoverStatusEl.textContent = text;
        };

        const setPopoverVisible = (visible) => {
            if (!popoverEl) return;
            popoverEl.hidden = !visible;
        };

        const shouldShowPopover = () => !this.state.parcelInfoPopoverDismissed && Boolean(this.state.parcelInfoAnchorPixel);

        if (!this.state.parcelInfoEnabled) {
            setStatus('parcelInfo.disabled');
            if (popoverFrameEl) popoverFrameEl.hidden = true;
            setPopoverVisible(false);
            return;
        }

        if (!this.elements.layerCatasto.checked || this.state.catastoSource !== 'official') {
            setStatus('parcelInfo.notAvailable');
            if (popoverFrameEl) popoverFrameEl.hidden = true;
            setPopoverVisible(false);
            return;
        }

        if (this.state.parcelInfoLoading) {
            setStatus('parcelInfo.loading');
            if (popoverFrameEl) popoverFrameEl.hidden = true;
            this.positionParcelInfoPopover();
            setPopoverVisible(shouldShowPopover());
            return;
        }

        if (!this.state.parcelInfoHtml) {
            setStatus(this.state.parcelInfoStatusKey || 'parcelInfo.clickHint');
            if (popoverFrameEl) popoverFrameEl.hidden = true;
            this.positionParcelInfoPopover();
            setPopoverVisible(shouldShowPopover());
            return;
        }

        setStatus('parcelInfo.ready');
        if (popoverFrameEl) {
            popoverFrameEl.hidden = false;
            if (popoverFrameEl.srcdoc !== this.state.parcelInfoHtml) {
                popoverFrameEl.srcdoc = this.state.parcelInfoHtml;
                popoverFrameEl.onload = () => {
                    this.syncParcelInfoFrameSize();
                    this.positionParcelInfoPopover();
                };
            }
            this.syncParcelInfoFrameSize();
        }
        this.positionParcelInfoPopover();
        setPopoverVisible(shouldShowPopover());
    }

    positionParcelInfoPopover() {
        const popover = this.elements.parcelInfoPopover;
        const anchorPixel = this.state.parcelInfoAnchorPixel;
        if (!popover || !anchorPixel || !this.map) return;

        const viewport = this.map.getViewport();
        const viewportRect = viewport.getBoundingClientRect();
        const width = popover.offsetWidth || 320;
        const height = popover.offsetHeight || 180;
        const gap = 14;

        let left = anchorPixel[0] + gap;
        let top = anchorPixel[1] + gap;

        if (left + width > viewportRect.width - gap) {
            left = Math.max(gap, anchorPixel[0] - width - gap);
        }
        if (top + height > viewportRect.height - gap) {
            top = Math.max(gap, anchorPixel[1] - height - gap);
        }

        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
    }

    // ── Tile cache ────────────────────────────────────────────────────────────────

    async loadCacheStats() {
        const el = this.elements.cacheStatsDisplay;
        if (!el) return;
        try {
            const r = await fetch('/cache-stats');
            const { count, size_bytes, enabled, ttl_days, max_size_mb } = await r.json();
            if (!enabled) {
                el.textContent = t('cache.disabled');
                return;
            }
            if (Number.isFinite(ttl_days)) this.state.cacheTtlDays = this.sanitizeCacheTtlDays(ttl_days);
            if (Number.isFinite(max_size_mb)) this.state.cacheSizeMb = this.sanitizeCacheSizeMb(max_size_mb);
            this.syncPreferenceControls();
            this.persistPreferences();
            const sizeMb = (size_bytes / (1024 * 1024)).toFixed(2);
            el.textContent = t('cache.stats', { count, size: sizeMb });
        } catch {
            el.textContent = t('cache.unavailable');
        }
    }

    async updateCacheRuntimeConfig() {
        const ttl = this.sanitizeCacheTtlDays(this.state.cacheTtlDays);
        const size = this.sanitizeCacheSizeMb(this.state.cacheSizeMb);
        try {
            const response = await fetch('/cache-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ttl_days: ttl, max_size_mb: size }),
            });
            if (!response.ok) {
                throw new Error(`cache-config failed: ${response.status}`);
            }
            this.state.cacheTtlDays = ttl;
            this.state.cacheSizeMb = size;
            this.syncPreferenceControls();
            this.persistPreferences();
            this.setToolbarMessage(t('cache.configApplied', { ttl, size }));
            await this.loadCacheStats();
        } catch {
            this.setToolbarMessage(t('cache.configError'));
        }
    }

    async clearTileCache() {
        try {
            const r = await fetch('/cache-clear', { method: 'POST' });
            const { deleted } = await r.json();
            this.setToolbarMessage(t('cache.cleared', { deleted }));
            await this.loadCacheStats();
        } catch {
            this.setToolbarMessage(t('cache.clearError'));
        }
    }
}
