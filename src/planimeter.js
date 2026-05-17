import Map          from 'ol/Map.js';
import View         from 'ol/View.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer  from 'ol/layer/Vector.js';
import Feature      from 'ol/Feature.js';
import { Point as PointGeom, Polygon }  from 'ol/geom.js';
import ScaleLine    from 'ol/control/ScaleLine.js';
import GeoJSON      from 'ol/format/GeoJSON.js';
import { defaults as defaultControls } from 'ol/control.js';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import OLStyle from 'ol/style/Style.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import CircleStyle from 'ol/style/Circle.js';

import { createInitialState }            from './core/state.js';
import { buildLayers }                   from './map/layers.js';
import { buildInteractions }             from './map/interactions.js';
import { calculateArea, calculatePerimeter, calculateLength } from './geometry/calculations.js';
import { calculateIntersectionMetricsWithCache } from './geometry/intersection.js';
import { buildFeatureStyle, getFeatureLabelGeometry } from './geometry/style.js';
import { decorateFeature }               from './geometry/decorate.js';
import { t, setLocale, detectLocale }    from './i18n/i18n.js';
import { UnitSystem }                    from './units/units.js';
import { ProxyHealthMonitor }            from './ui/proxy-health.js';
import { initContextMenu }               from './ui/context-menu.js';
import {
    historyAtParcel,
    historyAtPoint,
    schedulePersistenceSync,
    restorePersistedFeatures,
} from './io/persistence.js';
import { buildExportConfig, triggerDownload, requestBackendExport } from './io/export.js';
import { detectImportFormat, readImportedFeatures } from './io/import.js';
import { loadPreferences, savePreferences } from './io/preferences.js';
import { CATASTO_WMS_LAYER_DEFS, DEFAULT_CATASTO_WMS_LAYER_SETTINGS } from './core/constants.js';
import { initDsl, getDomain } from './dsl/loader.js';
import { aggregateByCategory, totalAggArea } from './dsl/aggregation.js';
import { buildDslPayload } from './dsl/schema.js';

const BASE_LAYER_KEYS = ['sat', 'openTopoMap', 'esriTopo', 'esriRelief'];
const ADMIN_LAYER_KEYS = ['osm', 'catasto'];
const DSL_UNASSIGNED_CATEGORY_KEY = '__unassigned__';

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
        if (!(this.state.dslHiddenCategoryKeys instanceof Set)) {
            this.state.dslHiddenCategoryKeys = new Set(this.state.dslHiddenCategoryKeys ?? []);
        }
        this.state.locale = locale;
        this.state.unitSystem = this.unitSystem.system;
        this.state.toolbarPanel = preferences.toolbarPanel;
        this.state.activeBaseLayer = this.sanitizeBaseLayerKey(preferences.activeBaseLayer);
        this.state.activeAdminLayer = this.sanitizeAdminLayerKey(preferences.activeAdminLayer);
        this.state.activeEditingLayer = preferences.activeEditingLayer === 'pertenenze' ? 'pertenenze' : 'user';
        this.state.userAreasVisible = preferences.userAreasVisible !== false;
        this.state.pertenenzeVisible = Boolean(preferences.pertenenzeVisible);
        this.state.pertenenzeColor = this.sanitizePertenenzeColor(preferences.pertenenzeColor);
        this.state.catastoWmsLayerSettings = this.sanitizeCatastoWmsLayerSettings(
            preferences.catastoWmsLayerSettings,
            preferences.catastoWmsLayers,
            preferences.catastoOpacity,
        );
        this.state.parcelInfoEnabled = preferences.parcelInfoEnabled;
        this.state.exportImageQuality = this.sanitizeExportImageQuality(preferences.exportImageQuality);
        this.state.cacheTtlDays = this.sanitizeCacheTtlDays(preferences.cacheTtlDays);
        this.state.cacheSizeMb = this.sanitizeCacheSizeMb(preferences.cacheSizeMb);
        this.state.m3DetectStartRadius = this.sanitizeM3DetectRadius(preferences.m3DetectStartRadius, 1);
        this.state.m3DetectMaxRadius = this.sanitizeM3DetectRadius(preferences.m3DetectMaxRadius, 5);
        if (this.state.m3DetectMaxRadius < this.state.m3DetectStartRadius) {
            this.state.m3DetectMaxRadius = this.state.m3DetectStartRadius;
        }
        this.state.m3TraceToleranceM = this.sanitizeM3TraceToleranceM(preferences.m3TraceToleranceM);
        this.state.parcelInfoStatusKey = preferences.parcelInfoEnabled
            ? 'parcelInfo.clickHint'
            : 'parcelInfo.disabled';
        this.m3BusyActive = false;
        this.m3BusyMessage = '';
        this.mapTileLoadCount = 0;

        this.vectorSource = new VectorSource();
        this.pertenenzaSource = new VectorSource();
        this.editVertexSource = new VectorSource();
        this.geoJsonFormat = new GeoJSON();

        // ── DOM ───────────────────────────────────────────────────────────────
        this.elements = this.collectElements();

        // ── Layers & map ──────────────────────────────────────────────────────
        this.layers = buildLayers(this.vectorSource, this.pertenenzaSource, this.featureStyle.bind(this));
        this.editVertexLayer = new VectorLayer({
            source: this.editVertexSource,
            zIndex: 40,
            updateWhileAnimating: true,
            updateWhileInteracting: true,
            style: (feature) => new OLStyle({
                image: new CircleStyle({
                    radius: feature.get('vertexSelected') ? 7 : 5,
                    fill: new Fill({ color: feature.get('vertexSelected') ? '#0a84ff' : 'rgba(255,255,255,0.92)' }),
                    stroke: new Stroke({ color: feature.get('vertexSelected') ? '#ffffff' : '#ff6b00', width: 2.5 }),
                }),
            }),
        });
        this.initMap();

        // ── Interactions ──────────────────────────────────────────────────────
        this.allInteractions = buildInteractions(this.vectorSource, this.pertenenzaSource, this.layers.vector, this.layers.pertenenza);
        this.setActiveInteractions();
        this.addInteractionsToMap();
        this.bindInteractionEvents();

        // ── UI bindings ───────────────────────────────────────────────────────
        this.bindUI();
        this.bindPointerCoordinatesOverlay();
        initContextMenu({
            map:             this.map,
            elements:        this.elements,
            getIsDrawing:    () => this.state.isDrawing,
            getMode:         () => this.state.mode,
            abortActiveDraw: () => this.abortActiveDraw(),
            canQueryParcel:  () => this.canQueryParcelFromContextMenu(),
            canRefreshWmsTile: () => this.canRefreshWmsTile(),
            editFeature:     (feature) => this.editFeatureFromContext(feature),
            assignCategory:  (feature) => this.openCategoryAssignmentFromContext(feature),
            deleteFeature:   (feature) => this.deleteFeatureFromContext(feature),
            resyncParcelMetadata: (feature) => this.resyncParcelMetadataForFeature(feature),
            queryParcelAtPixel: (pixel) => this.fetchParcelInfoAtPixel(pixel),
            detectParcelM3AtPixel: (pixel) => this.detectParcelM3AtPixel(pixel),
            refineParcelM3ForFeature: (feature, pixel) => this.refineParcelM3ForFeature(feature, pixel),
            refreshTileAtPixel: (pixel) => this.refreshTileAtPixel(pixel),
            copyCoordinatesAtPixel: (pixel) => this.copyCoordinatesAtPixel(pixel),
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
            this.pertenenzaSource,
            this.view,
            (count) => {
                this.setToolbarMessage(t('msg.featuresRestored', { count }));
                this.fitToFeatures();
            },
        );

        // ── DSL init (async, non-blocking) ────────────────────────────────────
        initDsl().then(() => {
            this.state.dslReady = true;
            this.layers.vector.changed();
            this.layers.pertenenza.changed();
            this.updateSummary();
            this.updateDslAssignmentControls();
        }).catch((err) => {
            console.warn('[DSL] init failed:', err);
        });

        this.updateSummary();
        this.setMode('navigate');
        this.syncPreferenceControls();
        this.applyCatastoWmsLayerSettings();
        this.renderParcelInfo();
        this.setToolbarPanel(this.state.toolbarPanel);
        this.loadCacheStats();

        this.selectionExport = null;
        this.dragPanInteractions = null;
        this.pendingM3Refine = null;
    }

    // ── Interaction helpers ─────────────────────────────────────────────────────

    setActiveInteractions() {
        const isUser = this.state.activeEditingLayer === 'user';
        const userInteractions = this.allInteractions.user;
        const pertenenzeInteractions = this.allInteractions.pertenenze;

        for (const ix of Object.values(userInteractions)) {
            ix.setActive(false);
        }
        for (const ix of Object.values(pertenenzeInteractions)) {
            ix.setActive(false);
        }

        const activeSet = isUser ? userInteractions : pertenenzeInteractions;
        for (const ix of Object.values(activeSet)) {
            ix.setActive(false);
        }

        this.setMode(this.state.mode);
    }

    getActiveInteractions() {
        const isUser = this.state.activeEditingLayer === 'user';
        return isUser ? this.allInteractions.user : this.allInteractions.pertenenze;
    }

    getActiveVectorSource() {
        return this.state.activeEditingLayer === 'user' ? this.vectorSource : this.pertenenzaSource;
    }

    getActiveVectorLayer() {
        return this.state.activeEditingLayer === 'user' ? this.layers.vector : this.layers.pertenenza;
    }

    getFeatureOverlayLayer(feature) {
        return feature?.get?.('overlayLayer') === 'pertenenze' ? 'pertenenze' : 'user';
    }

    getSourceForFeature(feature) {
        return this.getFeatureOverlayLayer(feature) === 'pertenenze' ? this.pertenenzaSource : this.vectorSource;
    }

    getLayerForFeature(feature) {
        return this.getFeatureOverlayLayer(feature) === 'pertenenze' ? this.layers.pertenenza : this.layers.vector;
    }

    setEditingLayer(layerKey) {
        this.state.activeEditingLayer = layerKey === 'pertenenze' ? 'pertenenze' : 'user';
        if (this.state.activeEditingLayer === 'user') {
            this.state.userAreasVisible = true;
        }
        if (this.state.activeEditingLayer === 'pertenenze') {
            this.state.pertenenzeVisible = true;
        }
        if (this.elements.editingLayerSelect) {
            this.elements.editingLayerSelect.value = this.state.activeEditingLayer;
        }
        this.clearSelection();
        this.setActiveInteractions();
        this.applyLayerGroupSelection();
        this.persistPreferences();
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
            layerUserAreas:            document.getElementById('layer-user-areas'),
            layerPertenenze:           document.getElementById('layer-pertenenze'),
            baseLayerInputs:           [...document.querySelectorAll('[data-layer-group="base"]')],
            adminLayerInputs:          [...document.querySelectorAll('[data-layer-group="admin"]')],
            userAreaLayerInputs:       [...document.querySelectorAll('[data-layer-group="user-areas"]')],
            pertenenzaLayerInputs:     [...document.querySelectorAll('[data-layer-group="pertenenze"]')],
            editingLayerSelect:        document.getElementById('editing-layer-select'),
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
            m3BusyIndicator:           document.getElementById('m3-busy-indicator'),
            m3BusyLabel:               document.getElementById('m3-busy-label'),
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
            settingsM3DetectStartRadius: document.getElementById('settings-m3-detect-start-radius'),
            settingsM3DetectMaxRadius: document.getElementById('settings-m3-detect-max-radius'),
            settingsM3TraceToleranceM: document.getElementById('settings-m3-trace-tolerance-m'),
            settingsParcelInfoEnabled: document.getElementById('settings-parcel-info-enabled'),
            settingsPertenenzeColor:   document.getElementById('settings-pertenenze-color'),
            settingsWmsLayerParts:     [...document.querySelectorAll('[data-wms-layer-part]')],
            settingsWmsLayerOpacity:   [...document.querySelectorAll('[data-wms-layer-opacity]')],
            parcelInfoStatus:          document.getElementById('parcel-info-status'),
            parcelInfoPopover:         document.getElementById('parcel-info-popover'),
            parcelInfoPopoverStatus:   document.getElementById('parcel-info-popover-status'),
            parcelInfoPopoverFrame:    document.getElementById('parcel-info-popover-frame'),
            parcelInfoCloseButton:     document.getElementById('parcel-info-close'),
            m3RefineReport:            document.getElementById('m3-refine-report'),
            m3RefineReportTitle:       document.getElementById('m3-refine-report-title'),
            m3RefineEffectNote:        document.getElementById('m3-refine-effect-note'),
            m3RefineDiffCanvas:        document.getElementById('m3-refine-diff-canvas'),
            m3RefineBeforeArea:        document.getElementById('m3-refine-before-area'),
            m3RefineBeforePerimeter:   document.getElementById('m3-refine-before-perimeter'),
            m3RefineBeforeVertices:    document.getElementById('m3-refine-before-vertices'),
            m3RefineAfterArea:         document.getElementById('m3-refine-after-area'),
            m3RefineAfterPerimeter:    document.getElementById('m3-refine-after-perimeter'),
            m3RefineAfterVertices:     document.getElementById('m3-refine-after-vertices'),
            m3RefineDiffArea:          document.getElementById('m3-refine-diff-area'),
            m3RefineDiffRatio:         document.getElementById('m3-refine-diff-ratio'),
            m3RefineDiffPerimeter:     document.getElementById('m3-refine-diff-perimeter'),
            m3RefineSnapAccepted:      document.getElementById('m3-refine-snap-accepted'),
            m3RefineSnapRejected:      document.getElementById('m3-refine-snap-rejected'),
            m3RefineSnapKept:          document.getElementById('m3-refine-snap-kept'),
            m3RefineMeanSnap:          document.getElementById('m3-refine-mean-snap'),
            m3RefineMeanConfidence:    document.getElementById('m3-refine-mean-confidence'),
            m3RefineRejectedDistance:  document.getElementById('m3-refine-rejected-distance'),
            m3RefineRejectedWeakGain:  document.getElementById('m3-refine-rejected-weak-gain'),
            m3RefineAcceptButton:      document.getElementById('btn-m3-refine-accept'),
            m3RefineRejectButton:      document.getElementById('btn-m3-refine-reject'),
            cacheStatsDisplay:         document.getElementById('cache-stats-display'),
            btnCacheApply:             document.getElementById('btn-cache-apply'),
            btnCacheClear:             document.getElementById('btn-cache-clear'),
            pointerCoordinatesPanel:   document.getElementById('pointer-coordinates'),
            pointerCoordinatesValue:   document.getElementById('pointer-coordinates-value'),
            dslCategoriesSection:      document.getElementById('section-dsl-categories'),
            dslCategoryFilters:        document.getElementById('dsl-category-filters'),
            dslLegend:                 document.getElementById('dsl-legend'),
            dslCategoryTbody:          document.getElementById('dsl-category-tbody'),
            dslAssignSection:          document.getElementById('section-dsl-assignment'),
            dslAssignDomainValue:      document.getElementById('dsl-assign-domain-value'),
            dslAssignFeatureValue:     document.getElementById('dsl-assign-feature-value'),
            dslCategorySelect:         document.getElementById('dsl-category-select'),
            dslFieldsForm:             document.getElementById('dsl-fields-form'),
            dslAssignButton:           document.getElementById('btn-dsl-assign'),
            dslAssignHint:             document.getElementById('dsl-assign-hint'),
            dslCadastralLinks:         document.getElementById('dsl-cadastral-links'),
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
                this.layers.pertenenza,
                this.layers.vector,
                this.editVertexLayer,
            ],
            view: this.view,
            controls: defaultControls({
                zoom: false,
                rotate: false,
                attributionOptions: {
                    collapsed: false,
                    collapsible: false,
                },
            }).extend([
                new ScaleLine({ units: 'metric', minWidth: 96 }),
            ]),
        });

        Object.values(this.layers.catastoOfficial).forEach((layer) => {
            layer.getSource().on('tileloaderror', () => {
                if (this.state.catastoSource === 'official' && this.elements.layerCatasto.checked) {
                    this.proxyHealth?.setHealth('ko', t('msg.layerError'));
                    this.setToolbarMessage(t('msg.layerError'));
                }
            });
        });

        this.bindTileLoadingIndicator();

        this.view.on('change:resolution', () => this.updateSummary());
        this.vectorSource.on('addfeature',    () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource); });
        this.vectorSource.on('removefeature', () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource); });
        this.vectorSource.on('changefeature', () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource); });
        this.pertenenzaSource.on('addfeature',    () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource); });
        this.pertenenzaSource.on('removefeature', () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource); });
        this.pertenenzaSource.on('changefeature', () => { this.updateSummary(); schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource); });
    }

    addInteractionsToMap() {
        const addSet = (set) => {
            this.map.addInteraction(set.select);
            this.map.addInteraction(set.modify);
            this.map.addInteraction(set.draw);
            this.map.addInteraction(set.drawStraight);
            this.map.addInteraction(set.drawPolyline);
            this.map.addInteraction(set.snap);
        };
        addSet(this.allInteractions.user);
        addSet(this.allInteractions.pertenenze);
    }

    // ── Interaction events ───────────────────────────────────────────────────────

    bindInteractionEvents() {
        this.bindInteractionEventsForSet(this.allInteractions.user, 'user');
        this.bindInteractionEventsForSet(this.allInteractions.pertenenze, 'pertenenze');

        this.map.on('pointermove', (event) => {
            this.state.lastPointerCoordinate = event.coordinate;
        });

        this.map.on('singleclick', (event) => {
            if (this.state.mode !== 'edit') return;
            if (!this.isPolygonFeature(this.state.selectedFeature)) return;

            const picked = this.findNearestEditableVertex(this.state.selectedFeature, event.coordinate, 10);
            if (!picked) {
                this.state.selectedEditVertex = null;
                this.layers.vector.changed();
                this.layers.pertenenza.changed();
                this.refreshEditVertexOverlay();
                return;
            }

            this.state.selectedEditVertex = {
                featureId: this.state.selectedFeature.get('featureId'),
                overlayLayer: this.getFeatureOverlayLayer(this.state.selectedFeature),
                polygonIndex: picked.polygonIndex,
                ringIndex: picked.ringIndex,
                vertexIndex: picked.vertexIndex,
            };
            this.layers.vector.changed();
            this.layers.pertenenza.changed();
            this.refreshEditVertexOverlay();
        });

        this.map.getViewport().addEventListener('contextmenu', (event) => {
            if (this.state.mode !== 'edit') return;
            if (!this.state.selectedEditVertex) return;
            if (!this.isPolygonFeature(this.state.selectedFeature)) return;

            event.preventDefault();
            event.stopPropagation();
            this.requestDeleteSelectedVertex();
        });

        document.addEventListener('keydown', (ev) => {
            if (ev.ctrlKey && !this.state.isCtrlPressed) {
                this.state.isCtrlPressed = true;
                this.refreshSnapState();
            }

            if ((ev.key === 'Delete' || ev.key === 'Del') && this.state.mode === 'edit') {
                if (this.requestDeleteSelectedVertex()) {
                    ev.preventDefault();
                }
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

    bindInteractionEventsForSet(ix, setName) {
        const getSource = () => setName === 'user' ? this.vectorSource : this.pertenenzaSource;
        const getLayer = () => setName === 'user' ? this.layers.vector : this.layers.pertenenza;

        ix.draw.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage(t('msg.drawInProgress'));
        });
        ix.draw.on('drawend', (ev) => {
            this.state.isDrawing = false;
            ev.feature.set('overlayLayer', setName);
            decorateFeature(ev.feature, this.state, getSource().getFeatures().length);
            this.state.selectedFeature = ev.feature;
            getLayer().changed();
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
            ev.feature.set('overlayLayer', setName);
            decorateFeature(ev.feature, this.state, getSource().getFeatures().length);
            this.state.selectedFeature = ev.feature;
            getLayer().changed();
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
            ev.feature.set('overlayLayer', setName);
            decorateFeature(ev.feature, this.state, getSource().getFeatures().length);
            this.state.selectedFeature = ev.feature;
            getLayer().changed();
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
        ix.modify.on('modifyend', (ev) => {
            this.updateSummary();
            this.setToolbarMessage(t('msg.editDone'));
            const now = new Date().toISOString();
            for (const f of ix.select.getFeatures().getArray()) {
                f.set('version',    (f.get('version') ?? 1) + 1);
                f.set('modifiedAt', now);
            }

            if (this.state.mode === 'edit' && this.isPolygonFeature(this.state.selectedFeature)) {
                const anchor = ev?.mapBrowserEvent?.coordinate ?? this.state.lastPointerCoordinate;
                if (Array.isArray(anchor) && anchor.length >= 2) {
                    const picked = this.findNearestEditableVertex(this.state.selectedFeature, anchor, 14);
                    if (picked) {
                        this.state.selectedEditVertex = {
                            featureId: this.state.selectedFeature.get('featureId'),
                            overlayLayer: this.getFeatureOverlayLayer(this.state.selectedFeature),
                            polygonIndex: picked.polygonIndex,
                            ringIndex: picked.ringIndex,
                            vertexIndex: picked.vertexIndex,
                        };
                        this.layers.vector.changed();
                        this.layers.pertenenza.changed();
                        this.refreshEditVertexOverlay();
                    }
                }
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

        this.elements.editingLayerSelect?.addEventListener('change', (ev) => {
            this.setEditingLayer(ev.target.value);
        });

        this.elements.locateButton.addEventListener('click',  () => this.geolocate());
        this.elements.clearButton.addEventListener('click',   () => this.clearAllFeatures());
        this.elements.exportButton.addEventListener('click',  () => this.exportFeatures());
        this.elements.importButton.addEventListener('click',  () => this.elements.importInput.click());
        this.elements.duplicateSelectedButton.addEventListener('click', () => this.duplicateSelectedArea());
        this.elements.deleteSelectedButton.addEventListener('click',    () => this.deleteSelectedFeature());
        this.elements.dslAssignButton?.addEventListener('click',        () => this.applySelectedFeatureCategory());
        this.elements.dslCategorySelect?.addEventListener('change',      () => this.updateDslAssignmentControls(false));
        this.elements.importInput.addEventListener('change', (ev) => this.importFeatures(ev));
        this.elements.parcelInfoCloseButton?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.closeParcelInfoPopover();
        });

        this.elements.m3RefineAcceptButton?.addEventListener('click', () => {
            this.acceptPendingM3Refine();
        });

        this.elements.m3RefineRejectButton?.addEventListener('click', () => {
            this.rejectPendingM3Refine();
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

        this.elements.settingsM3DetectStartRadius?.addEventListener('change', (ev) => {
            this.state.m3DetectStartRadius = this.sanitizeM3DetectRadius(ev.target.value, 1);
            if (this.state.m3DetectMaxRadius < this.state.m3DetectStartRadius) {
                this.state.m3DetectMaxRadius = this.state.m3DetectStartRadius;
            }
            this.syncPreferenceControls();
            this.persistPreferences();
        });

        this.elements.settingsM3DetectMaxRadius?.addEventListener('change', (ev) => {
            this.state.m3DetectMaxRadius = this.sanitizeM3DetectRadius(ev.target.value, 5);
            if (this.state.m3DetectMaxRadius < this.state.m3DetectStartRadius) {
                this.state.m3DetectStartRadius = this.state.m3DetectMaxRadius;
            }
            this.syncPreferenceControls();
            this.persistPreferences();
        });

        this.elements.settingsM3TraceToleranceM?.addEventListener('change', (ev) => {
            this.state.m3TraceToleranceM = this.sanitizeM3TraceToleranceM(ev.target.value);
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

        this.elements.settingsPertenenzeColor?.addEventListener('input', (ev) => {
            this.state.pertenenzeColor = this.sanitizePertenenzeColor(ev.target.value);
            this.syncPreferenceControls();
            this.persistPreferences();
            this.layers.pertenenza.changed();
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
        if (this.isPolygonFeature(feature)) {
            const categoryId = this.getFeatureDslCategoryId(feature);
            if (!this.isDslCategoryVisible(categoryId)) {
                return [];
            }
        }
        return buildFeatureStyle(
            feature,
            this.state.selectedFeature,
            this.view?.getProjection(),
            this.unitSystem,
            {
                pertenenzeColor: this.state.pertenenzeColor,
                editMode: this.state.mode === 'edit',
                selectedVertex: this.state.selectedEditVertex,
            },
        );
    }

    // ── Mode management ──────────────────────────────────────────────────────────

    setMode(mode) {
        if (this.selectionExport?.active) {
            this.cancelSelectionExportMode(false);
        }

        this.state.mode = mode;
        if (mode !== 'edit' && this.state.selectedEditVertex) {
            this.state.selectedEditVertex = null;
            this.layers.vector.changed();
            this.layers.pertenenza.changed();
        }

        if (this.state.drawLockTimeoutId) {
            window.clearTimeout(this.state.drawLockTimeoutId);
            this.state.drawLockTimeoutId = null;
        }

        const ix = this.getActiveInteractions();
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
        this.layers.vector.changed();
        this.layers.pertenenza.changed();
        this.refreshEditVertexOverlay();
        this.updatePointerCoordinatesVisibility();
        this.renderParcelInfo();
    }

    isMeasureOrDrawMode(mode) {
        return mode === 'draw' || mode === 'measure-straight' || mode === 'measure-polyline';
    }

    getActiveDrawInteraction() {
        const ix = this.getActiveInteractions();
        if (this.state.mode === 'measure-straight') return ix.drawStraight;
        if (this.state.mode === 'measure-polyline') return ix.drawPolyline;
        if (this.state.mode === 'draw')             return ix.draw;
        return null;
    }

    abortActiveDraw() {
        this.getActiveDrawInteraction()?.abortDrawing();
    }

    pauseDrawAfterClose() {
        this.getActiveInteractions().draw.setActive(false);
        if (this.state.drawLockTimeoutId) window.clearTimeout(this.state.drawLockTimeoutId);
        this.state.drawLockTimeoutId = window.setTimeout(() => {
            this.state.drawLockTimeoutId = null;
            if (this.state.mode === 'draw') {
                this.getActiveInteractions().draw.setActive(true);
                this.refreshSnapState();
                this.setToolbarMessage(t('msg.drawResumed'));
            }
        }, 1000);
    }

    refreshSnapState() {
        const allowed = this.isMeasureOrDrawMode(this.state.mode) || this.state.mode === 'edit';
        this.allInteractions.user.snap.setActive(false);
        this.allInteractions.pertenenze.snap.setActive(false);
        this.getActiveInteractions().snap.setActive(allowed && !this.state.isCtrlPressed);

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
            this.state.selectedEditVertex = null;
            this.layers.vector.changed();
            this.layers.pertenenza.changed();
            this.refreshEditVertexOverlay();
            this.updateSummary();
            return;
        }

        if (this.state.mode === 'delete') {
            this.getSourceForFeature(feature).removeFeature(feature);
            this.clearSelection();
            this.setToolbarMessage(t('msg.featureDeleted'));
            return;
        }

        this.state.selectedFeature = feature;
        this.state.selectedEditVertex = null;
        this.layers.vector.changed();
        this.layers.pertenenza.changed();
        this.refreshEditVertexOverlay();
        this.updateSummary();
        this.setToolbarMessage(this.formatSelectedFeatureMessage(feature));
    }

    clearSelection() {
        this.state.selectedFeature = null;
        this.state.selectedEditVertex = null;
        this.allInteractions.user.select.getFeatures().clear();
        this.allInteractions.pertenenze.select.getFeatures().clear();
        this.layers.vector.changed();
        this.layers.pertenenza.changed();
        this.refreshEditVertexOverlay();
        this.updateSummary();
    }

    getPropertyScopeLabel(feature) {
        const explicit = String(feature?.get?.('parcelNumber') || '').trim();
        if (explicit) return explicit;

        const name = String(feature?.get?.('featureName') || '').trim();
        const nameMatch = /^(?:Pertinenza|Boundary|Parcel)?\s*(\d+)$/i.exec(name);
        if (nameMatch) return nameMatch[1];

        const featureId = String(feature?.get?.('featureId') || '').trim();
        const idMatch = /^pert-(\d+)$/i.exec(featureId);
        if (idMatch) return idMatch[1];

        return name || featureId || '-';
    }

    deriveParcelDisplayNumber(parcel) {
        const id = String(parcel?.id || '').trim();
        const localId = String(parcel?.local_id || '').trim();
        const label = String(parcel?.label || '').trim();

        const fromId = /(\d+)$/i.exec(id)?.[1];
        if (fromId) return fromId;

        const fromLocalId = /(\d+)$/i.exec(localId)?.[1];
        if (fromLocalId) return fromLocalId;

        const fromLabel = /(\d+)$/i.exec(label)?.[1];
        if (fromLabel) return fromLabel;

        return id || localId || label || '-';
    }

    async fetchParcelSummaryAtLonLat(lon, lat) {
        const proxyData = await this.fetchParcelSummaryViaProxyAtLonLat(lon, lat);
        if (proxyData?.parcel) return proxyData;

        try {
            const response = await fetch('/parcel-at-point', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({ lat, lon, includeGeometry: true }),
            });
            if (response.ok) {
                const data = await response.json();
                if (data?.parcel) return data;
            }
        } catch {
            // Fall through to WMS proxy fallback.
        }

        return this.fetchParcelSummaryViaProxyAtLonLat(lon, lat);
    }

    async fetchParcelSummaryViaProxyAtLonLat(lon, lat) {
        const coordinate = fromLonLat([lon, lat], this.view.getProjection());
        const resolution = this.view.getResolution();
        if (!coordinate || !resolution) return null;

        const source = this.layers.catastoOfficial.parcels.getSource();
        const url = source.getFeatureInfoUrl(
            coordinate,
            resolution,
            this.view.getProjection(),
            {
                INFO_FORMAT: 'text/html',
                FEATURE_COUNT: 10,
                LAYERS: 'CP.CadastralParcel',
                QUERY_LAYERS: 'CP.CadastralParcel',
            },
        );
        if (!url) return null;

        try {
            const response = await fetch(`${url.replace('/wms-tile?', '/wms-proxy?')}&OUTPUT=json`, {
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data?.parcel ? data : null;
        } catch {
            return null;
        }
    }

    applyParcelMetadataToFeature(feature, parcelData) {
        const parcel = parcelData?.parcel;
        if (!feature || !parcel) return;

        const parcelNumber = this.deriveParcelDisplayNumber(parcel);
        feature.set('parcelNumber', parcelNumber);
        feature.set('featureName', parcelNumber);
        feature.set('parcel_id', String(parcel.id || parcel.local_id || '').trim() || null);
        feature.set('inspire_local_id', String(parcel.local_id || '').trim() || null);
        feature.set('parcel_local_id', String(parcel.local_id || '').trim() || null);
        feature.set('parcel_label', String(parcel.label || '').trim() || null);
    }

    refreshEditVertexOverlay() {
        this.editVertexSource.clear();

        if (this.state.mode !== 'edit' || !this.isPolygonFeature(this.state.selectedFeature)) {
            return;
        }

        const feature = this.state.selectedFeature;
        const polygonSets = this.getFeaturePolygonCoordinateSets(feature);
        const featureId = feature.get('featureId');

        for (let polygonIndex = 0; polygonIndex < polygonSets.length; polygonIndex += 1) {
            const rings = polygonSets[polygonIndex] || [];
            for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
                const ring = rings[ringIndex] || [];
                const limit = Math.max(0, ring.length - 1);
                for (let vertexIndex = 0; vertexIndex < limit; vertexIndex += 1) {
                    const coord = ring[vertexIndex];
                    if (!Array.isArray(coord) || coord.length < 2) continue;

                    const overlayFeature = new Feature({
                        geometry: new PointGeom(coord),
                    });
                    const isSelectedVertex = Boolean(
                        this.state.selectedEditVertex
                        && this.state.selectedEditVertex.featureId === featureId
                        && this.state.selectedEditVertex.polygonIndex === polygonIndex
                        && this.state.selectedEditVertex.ringIndex === ringIndex
                        && this.state.selectedEditVertex.vertexIndex === vertexIndex,
                    );
                    overlayFeature.set('vertexSelected', isSelectedVertex);
                    this.editVertexSource.addFeature(overlayFeature);
                }
            }
        }
    }

    getFeatureInspireLocalId(feature) {
        const direct = String(
            feature?.get?.('inspire_local_id')
            || feature?.get?.('parcel_local_id')
            || feature?.get?.('parcel_id')
            || '',
        ).trim();
        if (direct) return direct;

        const cadastralLinks = feature?.get?.('links')?.cadastral;
        if (Array.isArray(cadastralLinks)) {
            const firstParcelId = String(cadastralLinks.find((entry) => entry?.parcel_id)?.parcel_id || '').trim();
            if (firstParcelId) return firstParcelId;
        }

        return '-';
    }

    formatSelectedFeatureMessage(feature) {
        if (!feature) return t('stat.selection.none');

        if (this.getFeatureOverlayLayer(feature) !== 'pertenenze' || !this.isPolygonFeature(feature)) {
            return t('msg.featureSelected', { name: feature.get('featureName') });
        }

        const projection = this.view?.getProjection();
        return t('msg.propertyScopeSelected', {
            parcel: this.getPropertyScopeLabel(feature),
            area: this.unitSystem.formatArea(calculateArea(feature, projection)),
            perimeter: this.unitSystem.formatPerimeter(calculatePerimeter(feature, projection)),
            localId: this.getFeatureInspireLocalId(feature),
        });
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    buildParcelSummaryHtml(parcel = {}, parcelGeometry = null, parcelGeometryCrs = 'EPSG:4326') {
        const label = parcel.label ?? parcel.reference ?? parcel.id ?? parcel.local_id ?? '-';
        const inspireLocalId = parcel.local_id ?? parcel.id ?? '-';
        let areaLabel = '-';
        let perimeterLabel = '-';

        if (parcelGeometry && typeof parcelGeometry === 'object') {
            try {
                const geometry = this.geoJsonFormat.readGeometry(parcelGeometry, {
                    dataProjection: parcelGeometryCrs,
                    featureProjection: this.view.getProjection(),
                });
                if (geometry) {
                    const feature = new Feature({ geometry });
                    areaLabel = this.unitSystem.formatArea(calculateArea(feature, this.view?.getProjection()));
                    perimeterLabel = this.unitSystem.formatPerimeter(calculatePerimeter(feature, this.view?.getProjection()));
                }
            } catch (error) {
                console.warn('Unable to build parcel summary metrics:', error);
            }
        }

        return `
            <section class="parcel-summary">
                <h3>${this.escapeHtml(t('parcelInfo.summaryTitle'))}</h3>
                <dl>
                    <div><dt>${this.escapeHtml(t('parcelInfo.label'))}</dt><dd>${this.escapeHtml(label)}</dd></div>
                    <div><dt>${this.escapeHtml(t('parcelInfo.area'))}</dt><dd>${this.escapeHtml(areaLabel)}</dd></div>
                    <div><dt>${this.escapeHtml(t('parcelInfo.perimeter'))}</dt><dd>${this.escapeHtml(perimeterLabel)}</dd></div>
                    <div><dt>${this.escapeHtml(t('parcelInfo.inspireLocalId'))}</dt><dd>${this.escapeHtml(inspireLocalId)}</dd></div>
                </dl>
            </section>`;
    }

    extractParcelFieldsFromHtmlTable(rawHtml) {
        const rows = Array.from(String(rawHtml || '').matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>(.*?)<\/th>\s*<td\b[^>]*>(.*?)<\/td>\s*<\/tr>/gis));
        const fields = {};
        for (const [, keyRaw, valueRaw] of rows) {
            const key = String(keyRaw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const value = String(valueRaw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (key && value) {
                fields[key] = value;
            }
        }
        return fields;
    }

    getFeaturePolygonCoordinateSets(feature) {
        const geometry = feature?.getGeometry?.();
        const type = geometry?.getType?.();
        if (type === 'Polygon') return [geometry.getCoordinates()];
        if (type === 'MultiPolygon') return geometry.getCoordinates();
        return [];
    }

    findNearestEditableVertex(feature, coordinate, pixelTolerance = 12) {
        if (!this.isPolygonFeature(feature) || !Array.isArray(coordinate) || coordinate.length < 2) return null;

        const targetPixel = this.map.getPixelFromCoordinate(coordinate);
        if (!targetPixel) return null;

        let best = null;
        let bestDist2 = Number.POSITIVE_INFINITY;
        const tolerance2 = pixelTolerance * pixelTolerance;

        const polygonSets = this.getFeaturePolygonCoordinateSets(feature);
        for (let polygonIndex = 0; polygonIndex < polygonSets.length; polygonIndex += 1) {
            const rings = polygonSets[polygonIndex] || [];
            for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
                const ring = rings[ringIndex] || [];
                const limit = Math.max(0, ring.length - 1); // skip closure duplicate
                for (let vertexIndex = 0; vertexIndex < limit; vertexIndex += 1) {
                    const vertexCoord = ring[vertexIndex];
                    if (!Array.isArray(vertexCoord) || vertexCoord.length < 2) continue;
                    const vertexPixel = this.map.getPixelFromCoordinate(vertexCoord);
                    if (!vertexPixel) continue;

                    const dx = vertexPixel[0] - targetPixel[0];
                    const dy = vertexPixel[1] - targetPixel[1];
                    const dist2 = dx * dx + dy * dy;
                    if (dist2 <= tolerance2 && dist2 < bestDist2) {
                        bestDist2 = dist2;
                        best = { polygonIndex, ringIndex, vertexIndex };
                    }
                }
            }
        }

        return best;
    }

    requestDeleteSelectedVertex() {
        if (this.state.mode !== 'edit') return false;
        if (!this.state.selectedFeature || !this.state.selectedEditVertex) {
            this.setToolbarMessage(t('msg.vertexDeleteNoSel'));
            return false;
        }

        const confirmed = window.confirm(t('confirm.deleteVertex'));
        if (!confirmed) return true;

        const deleted = this.deleteSelectedVertexFromFeature();
        if (!deleted) {
            this.setToolbarMessage(t('msg.vertexDeleteMin'));
            return true;
        }

        this.setToolbarMessage(t('msg.vertexDeleted'));
        return true;
    }

    deleteSelectedVertexFromFeature() {
        const feature = this.state.selectedFeature;
        const sel = this.state.selectedEditVertex;
        if (!feature || !sel || !this.isPolygonFeature(feature)) return false;

        const geometry = feature.getGeometry();
        const type = geometry?.getType?.();
        const now = new Date().toISOString();

        if (type === 'Polygon') {
            const coords = geometry.getCoordinates();
            const ring = coords[sel.ringIndex];
            if (!Array.isArray(ring)) return false;
            const openRing = ring.slice(0, -1);
            if (openRing.length <= 3) return false;

            openRing.splice(sel.vertexIndex, 1);
            coords[sel.ringIndex] = [...openRing, openRing[0]];
            geometry.setCoordinates(coords);
        } else if (type === 'MultiPolygon') {
            const coords = geometry.getCoordinates();
            const polygon = coords[sel.polygonIndex];
            const ring = polygon?.[sel.ringIndex];
            if (!Array.isArray(ring)) return false;
            const openRing = ring.slice(0, -1);
            if (openRing.length <= 3) return false;

            openRing.splice(sel.vertexIndex, 1);
            polygon[sel.ringIndex] = [...openRing, openRing[0]];
            geometry.setCoordinates(coords);
        } else {
            return false;
        }

        feature.set('version', (feature.get('version') ?? 1) + 1);
        feature.set('modifiedAt', now);

        this.state.selectedEditVertex = null;
        this.layers.vector.changed();
        this.layers.pertenenza.changed();
        this.refreshEditVertexOverlay();
        this.updateSummary();
        return true;
    }

    // ── Summary ──────────────────────────────────────────────────────────────────

    updateSummary() {
        const features = [
            ...this.vectorSource.getFeatures(),
            ...this.pertenenzaSource.getFeatures(),
        ];
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

        this.renderDslSummary(this.vectorSource.getFeatures().filter((f) => {
            const type = f.getGeometry()?.getType();
            return type === 'Polygon' || type === 'MultiPolygon';
        }));
        this.updateDslAssignmentControls();
    }

    /**
     * Render the DSL categories section: legend swatches + aggregation table.
     * Shows the section only when DSL is ready and there are polygon features.
     * @param {import('ol').Feature[]} [areaFeatures]
     */
    renderDslSummary(areaFeatures) {
        const section = this.elements.dslCategoriesSection;
        if (!section) return;

        if (!this.state.dslReady) {
            section.hidden = true;
            return;
        }

        const features = areaFeatures ?? this.vectorSource.getFeatures().filter((f) => {
            const type = f.getGeometry()?.getType();
            return type === 'Polygon' || type === 'MultiPolygon';
        });

        if (features.length === 0) {
            section.hidden = true;
            return;
        }

        const domain  = getDomain(this.state.dslActiveDomainId);
        const proj    = this.view?.getProjection();
        const rows    = aggregateByCategory(features, domain, proj);
        this.renderDslCategoryFilters(rows);

        const visibleRows = rows.filter((row) => this.isDslCategoryVisible(row.categoryId ?? null));
        const grandTotal = totalAggArea(visibleRows);
        const visibleCount = visibleRows.reduce((sum, row) => sum + row.count, 0);

        section.hidden = false;

        // ── Legend ────────────────────────────────────────────────────────────
        const legend = this.elements.dslLegend;
        if (legend) {
            legend.innerHTML = '';
            for (const row of visibleRows) {
                const label = row.label ?? t('dsl.category.unassigned');
                const item  = document.createElement('div');
                item.className = 'dsl-legend-item';
                item.setAttribute('role', 'listitem');
                item.innerHTML = `<span class="dsl-legend-swatch" style="background:${row.color};border-color:${row.stroke ?? row.color}"></span><span>${label}</span>`;
                legend.appendChild(item);
            }
        }

        // ── Table ─────────────────────────────────────────────────────────────
        const tbody = this.elements.dslCategoryTbody;
        if (tbody) {
            tbody.innerHTML = '';
            for (const row of visibleRows) {
                const label   = row.label ?? t('dsl.category.unassigned');
                const pct     = grandTotal > 0 ? ((row.areaM2 / grandTotal) * 100).toFixed(1) : '0.0';
                const areaStr = this.unitSystem.formatArea(row.areaM2);
                const tr      = document.createElement('tr');
                if (row.categoryId === null) tr.className = 'dsl-row-unassigned';
                tr.innerHTML = `
                    <td><div class="dsl-table-cat"><span class="dsl-table-swatch" style="background:${row.color};border-color:${row.stroke ?? row.color}"></span>${label}</div></td>
                    <td>${areaStr}</td>
                    <td>${pct}%</td>
                    <td>${row.count}</td>`;
                tbody.appendChild(tr);
            }

            // Total row via tfoot
            let tfoot = section.querySelector('tfoot');
            if (!tfoot) {
                tfoot = document.createElement('tfoot');
                section.querySelector('table')?.appendChild(tfoot);
            }
            tfoot.innerHTML = `<tr><td>${t('dsl.table.total')}</td><td>${this.unitSystem.formatArea(grandTotal)}</td><td>100%</td><td>${visibleCount}</td></tr>`;
        }
    }

    getFeatureDslCategoryId(feature) {
        if (!this.isPolygonFeature(feature)) return null;
        const dsl = feature.get('dsl');
        if (!dsl || dsl.domainId !== this.state.dslActiveDomainId) return null;
        const categoryId = dsl.categoryId;
        return categoryId ? String(categoryId) : null;
    }

    getDslCategoryVisibilityKey(categoryId) {
        return categoryId ?? DSL_UNASSIGNED_CATEGORY_KEY;
    }

    isDslCategoryVisible(categoryId) {
        const hidden = this.state.dslHiddenCategoryKeys;
        const key = this.getDslCategoryVisibilityKey(categoryId);
        return !(hidden instanceof Set && hidden.has(key));
    }

    setDslCategoryVisibility(categoryId, visible) {
        const key = this.getDslCategoryVisibilityKey(categoryId);
        if (!(this.state.dslHiddenCategoryKeys instanceof Set)) {
            this.state.dslHiddenCategoryKeys = new Set();
        }

        if (visible) {
            this.state.dslHiddenCategoryKeys.delete(key);
        } else {
            this.state.dslHiddenCategoryKeys.add(key);
        }

        this.layers.vector.changed();
        this.updateSummary();
    }

    renderDslCategoryFilters(rows) {
        const container = this.elements.dslCategoryFilters;
        if (!container) return;

        container.innerHTML = '';
        for (const row of rows) {
            const label = row.label ?? t('dsl.category.unassigned');
            const categoryId = row.categoryId ?? null;

            const item = document.createElement('label');
            item.className = 'dsl-filter-chip';

            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = this.isDslCategoryVisible(categoryId);
            check.addEventListener('change', () => {
                this.setDslCategoryVisibility(categoryId, check.checked);
            });

            const swatch = document.createElement('span');
            swatch.className = 'dsl-legend-swatch';
            swatch.style.background = row.color;
            swatch.style.borderColor = row.stroke ?? row.color;

            const text = document.createElement('span');
            text.textContent = label;

            item.append(check, swatch, text);
            container.appendChild(item);
        }
    }

    /**
     * Render/refresh controls used to assign a DSL category
     * to the currently selected polygon feature.
     *
     * @param {boolean} [rebuildOptions=true]
     */
    updateDslAssignmentControls(rebuildOptions = true) {
        const section = this.elements.dslAssignSection;
        const select = this.elements.dslCategorySelect;
        const button = this.elements.dslAssignButton;
        if (!section || !select || !button) return;

        const domain = this.state.dslReady ? getDomain(this.state.dslActiveDomainId) : null;
        if (!domain) {
            section.hidden = true;
            return;
        }

        section.hidden = false;
        if (this.elements.dslAssignDomainValue) {
            this.elements.dslAssignDomainValue.textContent = domain.label ?? domain.id;
        }

        const feature = this.state.selectedFeature;
        const featureIsPolygon = this.isPolygonFeature(feature);
        const currentDsl = featureIsPolygon ? feature.get('dsl') : null;

        if (rebuildOptions) {
            select.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = t('dsl.assign.selectCategory');
            select.appendChild(placeholder);

            for (const cat of domain.categories ?? []) {
                const opt = document.createElement('option');
                opt.value = cat.id;
                opt.textContent = cat.label ?? cat.id;
                select.appendChild(opt);
            }
        }

        const selectedCategoryId = (featureIsPolygon && currentDsl?.domainId === domain.id)
            ? String(currentDsl?.categoryId ?? '')
            : '';

        if (rebuildOptions || !select.value) {
            select.value = selectedCategoryId;
        }

        const selectedLabel = featureIsPolygon
            ? String(feature.get('featureName') || feature.get('featureId') || '-')
            : t('dsl.assign.noFeature');

        if (this.elements.dslAssignFeatureValue) {
            this.elements.dslAssignFeatureValue.textContent = selectedLabel;
        }

        this.renderSelectedFeatureCadastralLinks(featureIsPolygon ? feature : null);

        const categoryChosen = Boolean(select.value);
        select.disabled = !featureIsPolygon;
        button.disabled = !featureIsPolygon || !categoryChosen;
        button.textContent = selectedCategoryId ? t('dsl.category.change') : t('dsl.category.assign');

        if (this.elements.dslAssignHint) {
            this.elements.dslAssignHint.textContent = featureIsPolygon
                ? (categoryChosen ? t('dsl.assign.hintReady') : t('dsl.assign.hintSelect'))
                : t('dsl.assign.hintNoFeature');
        }

        // Render dynamic field form if category is chosen and feature is valid
        if (featureIsPolygon && categoryChosen) {
            this.renderDslFieldForm(feature, domain, select.value);
        } else {
            this.renderDslFieldForm(null, null, null);
        }
    }

    getOrCreateFeatureLinks(feature) {
        const raw = feature?.get('links');
        const links = (raw && typeof raw === 'object') ? raw : {};
        if (!Array.isArray(links.cadastral)) {
            links.cadastral = [];
        }
        return links;
    }

    renderSelectedFeatureCadastralLinks(feature) {
        const container = this.elements.dslCadastralLinks;
        if (!container) return;

        container.innerHTML = '';

        if (!feature) {
            const empty = document.createElement('p');
            empty.className = 'dsl-cadastral-link-empty';
            empty.textContent = t('dsl.links.noFeature');
            container.appendChild(empty);
            return;
        }

        const links = this.getOrCreateFeatureLinks(feature).cadastral;
        if (!links.length) {
            const empty = document.createElement('p');
            empty.className = 'dsl-cadastral-link-empty';
            empty.textContent = t('dsl.links.none');
            container.appendChild(empty);
            return;
        }

        links.forEach((link, index) => {
            const parcelId = String(link?.parcel_id ?? '').trim();
            if (!parcelId) return;

            const row = document.createElement('div');
            row.className = 'dsl-cadastral-link-row';

            const main = document.createElement('div');
            main.className = 'dsl-cadastral-link-main';

            const idEl = document.createElement('span');
            idEl.className = 'dsl-cadastral-link-id';
            idEl.textContent = parcelId;

            const meta = document.createElement('span');
            meta.className = 'dsl-cadastral-link-meta';
            const coverageValue = Number.isFinite(link?.coverage_ratio)
                ? (link.coverage_ratio * 100).toFixed(2)
                : 'n/a';
            const intersectionValue = Number.isFinite(link?.intersection_area)
                ? this.unitSystem.formatArea(link.intersection_area)
                : 'n/a';
            meta.textContent = t('dsl.links.meta', {
                coverage: coverageValue,
                intersection: intersectionValue,
            });

            main.append(idEl, meta);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'dsl-cadastral-unlink-btn';
            removeBtn.textContent = t('dsl.links.remove');
            removeBtn.addEventListener('click', () => this.unlinkSelectedFeatureCadastralByIndex(index));

            row.append(main, removeBtn);
            container.appendChild(row);
        });
    }

    unlinkSelectedFeatureCadastralByIndex(index) {
        const feature = this.state.selectedFeature;
        if (!this.isPolygonFeature(feature)) return;

        const links = this.getOrCreateFeatureLinks(feature);
        const removed = links.cadastral.splice(index, 1)[0];
        if (!removed) return;

        feature.set('links', links);
        feature.set('version', (feature.get('version') ?? 1) + 1);
        feature.set('modifiedAt', new Date().toISOString());

        schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource);
        this.getLayerForFeature(feature).changed();
        this.updateSummary();
        this.setToolbarMessage(t('msg.parcelUnlinked', {
            parcelId: removed.parcel_id,
            name: feature.get('featureName') || feature.get('featureId') || '-',
        }));
    }

    isPolygonFeature(feature) {
        const type = feature?.getGeometry?.()?.getType?.();
        return type === 'Polygon' || type === 'MultiPolygon';
    }

    openCategoryAssignmentFromContext(feature) {
        if (!this.isPolygonFeature(feature)) return;
        this.setEditingLayer(this.getFeatureOverlayLayer(feature));
        this.clearSelection();
        this.state.selectedFeature = feature;
        this.getActiveInteractions().select.getFeatures().push(feature);
        this.setToolbarPanel('operate');
        this.getLayerForFeature(feature).changed();
        this.updateSummary();
        this.updateDslAssignmentControls();
        this.elements.dslCategorySelect?.focus();
        this.setToolbarMessage(t('msg.categoryPanelReady', {
            name: feature.get('featureName') || feature.get('featureId') || '-',
        }));
    }

    applySelectedFeatureCategory() {
        const feature = this.state.selectedFeature;
        if (!this.isPolygonFeature(feature)) {
            alert(t('alert.noSelection'));
            return;
        }

        const domain = getDomain(this.state.dslActiveDomainId);
        if (!domain) {
            this.setToolbarMessage(t('dsl.domain.none'));
            return;
        }

        const categoryId = String(this.elements.dslCategorySelect?.value || '').trim();
        if (!categoryId) {
            this.setToolbarMessage(t('dsl.assign.hintSelect'));
            return;
        }

        // Validate required fields
        const formContainer = this.elements.dslFieldsForm;
        if (formContainer) {
            const requiredInputs = formContainer.querySelectorAll('[required]');
            for (const input of requiredInputs) {
                if (!input.value || (input.type === 'checkbox' && !input.checked)) {
                    const fieldLabel = input.previousElementSibling?.textContent || input.id;
                    this.setToolbarMessage(t('alert.requiredFieldMissing', { field: fieldLabel }) ?? `Campo obbligatorio: ${fieldLabel}`);
                    input.focus();
                    return;
                }
            }
        }

        const basePayload = buildDslPayload(domain.id, categoryId, domain.fields ?? []);
        const existing = feature.get('dsl');
        if (existing && existing.domainId === domain.id && existing.values && typeof existing.values === 'object') {
            for (const field of domain.fields ?? []) {
                if (Object.prototype.hasOwnProperty.call(existing.values, field.id)) {
                    basePayload.values[field.id] = existing.values[field.id];
                }
            }
        }

        feature.set('dsl', basePayload);
        feature.set('version', (feature.get('version') ?? 1) + 1);
        feature.set('modifiedAt', new Date().toISOString());

        const categoryLabel = domain.categories?.find((cat) => cat.id === categoryId)?.label ?? categoryId;
        this.layers.vector.changed();
        this.updateSummary();
        this.updateDslAssignmentControls(false);
        this.setToolbarMessage(t('msg.categoryAssigned', {
            category: categoryLabel,
            name: feature.get('featureName') || feature.get('featureId') || '-',
        }));
    }

    buildFieldControl(field, currentValue = null, featureDsl = null) {
        const fieldId = field.id;
        const label = field.label ?? fieldId;
        const isRequired = field.required ?? false;
        const requiredMark = isRequired ? ' *' : '';

        let input;
        if (field.type === 'boolean') {
            const container = document.createElement('label');
            container.className = 'dsl-field-wrapper dsl-field-boolean' + (isRequired ? ' dsl-field-required' : '');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `dsl-field-${fieldId}`;
            checkbox.checked = Boolean(currentValue);
            checkbox.dataset.fieldId = fieldId;
            if (isRequired) checkbox.required = true;
            checkbox.addEventListener('change', (e) => this.updateFeatureDslFieldValue(fieldId, e.target.checked));
            container.appendChild(checkbox);
            const labelSpan = document.createElement('span');
            labelSpan.className = 'dsl-field-label';
            labelSpan.textContent = label + requiredMark;
            container.appendChild(labelSpan);
            return container;
        } else if (field.type === 'enum') {
            const container = document.createElement('div');
            container.className = 'dsl-field-wrapper dsl-field-enum' + (isRequired ? ' dsl-field-required' : '');
            const labelEl = document.createElement('label');
            labelEl.htmlFor = `dsl-field-${fieldId}`;
            labelEl.className = 'dsl-field-label';
            labelEl.textContent = label + requiredMark;
            container.appendChild(labelEl);
            input = document.createElement('select');
            input.id = `dsl-field-${fieldId}`;
            input.className = 'dsl-field-input';
            input.dataset.fieldId = fieldId;
            if (isRequired) input.required = true;
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.textContent = '— ' + (label ?? 'Select') + ' —';
            input.appendChild(emptyOpt);
            for (const option of field.options ?? []) {
                const opt = document.createElement('option');
                opt.value = option;
                opt.textContent = option;
                input.appendChild(opt);
            }
            if (currentValue) input.value = String(currentValue);
            input.addEventListener('change', (e) => this.updateFeatureDslFieldValue(fieldId, e.target.value));
            container.appendChild(input);
            return container;
        } else if (field.type === 'number') {
            const container = document.createElement('div');
            container.className = 'dsl-field-wrapper dsl-field-number' + (isRequired ? ' dsl-field-required' : '');
            const labelEl = document.createElement('label');
            labelEl.htmlFor = `dsl-field-${fieldId}`;
            labelEl.className = 'dsl-field-label';
            labelEl.textContent = label + requiredMark;
            container.appendChild(labelEl);
            input = document.createElement('input');
            input.type = 'number';
            input.id = `dsl-field-${fieldId}`;
            input.className = 'dsl-field-input';
            input.dataset.fieldId = fieldId;
            input.step = 'any';
            if (isRequired) input.required = true;
            if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
                input.value = String(currentValue);
            }
            input.addEventListener('change', (e) => {
                const val = e.target.value ? parseFloat(e.target.value) : null;
                this.updateFeatureDslFieldValue(fieldId, val);
            });
            container.appendChild(input);
            return container;
        } else {
            // type === 'string' or default
            const container = document.createElement('div');
            container.className = 'dsl-field-wrapper dsl-field-string' + (isRequired ? ' dsl-field-required' : '');
            const labelEl = document.createElement('label');
            labelEl.htmlFor = `dsl-field-${fieldId}`;
            labelEl.className = 'dsl-field-label';
            labelEl.textContent = label + requiredMark;
            container.appendChild(labelEl);
            input = document.createElement('input');
            input.type = 'text';
            input.id = `dsl-field-${fieldId}`;
            input.className = 'dsl-field-input';
            input.dataset.fieldId = fieldId;
            if (isRequired) input.required = true;
            if (currentValue) input.value = String(currentValue);
            input.addEventListener('change', (e) => this.updateFeatureDslFieldValue(fieldId, e.target.value));
            container.appendChild(input);
            return container;
        }
    }

    renderDslFieldForm(feature, domain, categoryId) {
        const formContainer = this.elements.dslFieldsForm;
        if (!formContainer) return;

        formContainer.innerHTML = '';

        if (!feature || !domain || !categoryId) return;

        const currentDsl = feature.get('dsl');
        const fields = domain.fields ?? [];

        if (fields.length === 0) return;

        for (const field of fields) {
            const currentValue = currentDsl?.values?.[field.id] ?? null;
            const control = this.buildFieldControl(field, currentValue, currentDsl);
            formContainer.appendChild(control);
        }
    }

    updateFeatureDslFieldValue(fieldId, value) {
        const feature = this.state.selectedFeature;
        if (!this.isPolygonFeature(feature)) return;

        let dsl = feature.get('dsl');
        if (!dsl || typeof dsl !== 'object' || !dsl.values || typeof dsl.values !== 'object') {
            return;
        }

        dsl.values[fieldId] = value;
        feature.set('dsl', dsl);
        feature.set('version', (feature.get('version') ?? 1) + 1);
        feature.set('modifiedAt', new Date().toISOString());

        schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource);
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
        const targetSource = this.getSourceForFeature(this.state.selectedFeature);
        clone.set('overlayLayer', this.getFeatureOverlayLayer(this.state.selectedFeature));
        decorateFeature(clone, this.state, targetSource.getFeatures().length);
        targetSource.addFeature(clone);

        this.getLayerForFeature(clone).changed();
        this.clearSelection();
        this.state.selectedFeature = clone;
        this.getActiveInteractions().select.getFeatures().push(clone);
        this.updateSummary();
        this.setToolbarMessage(t('msg.featureDuplicated'));
    }

    deleteSelectedFeature() {
        if (!this.state.selectedFeature) {
            alert(t('alert.noSelection'));
            return;
        }
        this.getSourceForFeature(this.state.selectedFeature).removeFeature(this.state.selectedFeature);
        this.clearSelection();
        this.setToolbarMessage(t('msg.featureDeletedSelected'));
    }

    clearAllFeatures() {
        const source = this.getActiveVectorSource();
        if (!source.getFeatures().length) {
            this.setToolbarMessage(t('msg.nothingToClear'));
            return;
        }
        if (!window.confirm(t('confirm.clearAll'))) return;
        source.clear();
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

                let semanticReport = null;
                if (fmt === 'bundle' && this.state.dslReady) {
                    const domain = getDomain(this.state.dslActiveDomainId);
                    if (domain) {
                        const aggs = aggregateByCategory(features, domain, this.map.getView().getProjection());
                        const totalArea = totalAggArea(aggs);
                        // Add percentage to each aggregation row
                        const aggregationsWithPercentages = aggs.map(row => ({
                            ...row,
                            percentageArea: totalArea > 0 ? Math.round((row.areaM2 / totalArea) * 10000) / 100 : 0,
                        }));
                        semanticReport = {
                            domainId: domain.id,
                            domainLabel: domain.label,
                            domainVersion: domain.version,
                            aggregations: aggregationsWithPercentages,
                            totalAreaM2: totalArea,
                            timestamp: new Date().toISOString(),
                        };
                    }
                }

                await requestBackendExport(
                    /** @type {'geotiff'|'pgw'|'bundle'} */ (fmt),
                    {
                        bbox: [south, west, north, east],
                        width: size[0],
                        height: size[1],
                        layers: this.getVisibleCatastoWmsLayerNames(),
                    },
                    features,
                    semanticReport,
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
        if (this.elements.layerPertenenze?.checked) list.push('pertenenze');
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

                const targetSource = this.getActiveVectorSource();
                imported.forEach((f, index) => {
                    f.set('overlayLayer', this.state.activeEditingLayer);
                    decorateFeature(f, this.state, targetSource.getFeatures().length + index);
                });
                targetSource.addFeatures(imported);
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
        const extents = [this.vectorSource, this.pertenenzaSource]
            .map((source) => source.getFeatures().length ? source.getExtent() : null)
            .filter(Boolean);
        if (!extents.length) return;

        const mergedExtent = extents.reduce((acc, extent) => [
            Math.min(acc[0], extent[0]),
            Math.min(acc[1], extent[1]),
            Math.max(acc[2], extent[2]),
            Math.max(acc[3], extent[3]),
        ]);

        this.view.fit(mergedExtent, {
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
        return BASE_LAYER_KEYS.includes(layerKey) ? layerKey : null;
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
                    this.state.activeBaseLayer = null;
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

        this.elements.pertenenzaLayerInputs.forEach((el) => {
            el.addEventListener('change', (ev) => {
                this.state.pertenenzeVisible = ev.target.checked;
                this.applyLayerGroupSelection();
                this.persistPreferences();
            });
        });

        this.elements.userAreaLayerInputs.forEach((el) => {
            el.addEventListener('change', (ev) => {
                this.state.userAreasVisible = ev.target.checked;
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

        const showUserAreas = Boolean(this.state.userAreasVisible);
        if (this.elements.layerUserAreas) {
            this.elements.layerUserAreas.checked = showUserAreas;
        }
        this.layers.vector.setVisible(showUserAreas);

        const showPertinenze = Boolean(this.state.pertenenzeVisible);
        if (this.elements.layerPertenenze) {
            this.elements.layerPertenenze.checked = showPertinenze;
        }
        this.layers.pertenenza.setVisible(showPertinenze);

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
        this.layers.pertenenza.changed();
        this.updateSummary();
        this.syncPreferenceControls();
        this.updatePointerCoordinatesVisibility();
        this.renderParcelInfo();
    }

    // ── Misc ─────────────────────────────────────────────────────────────────────

    setToolbarMessage(message) {
        this.elements.status.textContent = message;
    }

    setM3BusyVisible(visible, message = null) {
        this.m3BusyActive = Boolean(visible);
        if (message) {
            this.m3BusyMessage = message;
        }
        this.updateBusyOverlay();
    }

    bindTileLoadingIndicator() {
        const register = (source) => {
            if (!source?.on) return;
            source.on('tileloadstart', () => {
                this.mapTileLoadCount += 1;
                this.updateBusyOverlay();
            });
            const finish = () => {
                this.mapTileLoadCount = Math.max(0, this.mapTileLoadCount - 1);
                this.updateBusyOverlay();
            };
            source.on('tileloadend', finish);
            source.on('tileloaderror', finish);
        };

        register(this.layers.sat.getSource());
        register(this.layers.openTopoMap.getSource());
        register(this.layers.esriTopo.getSource());
        register(this.layers.esriRelief.getSource());
        register(this.layers.osm.getSource());
        register(this.layers.catastoFallback.getSource());
        Object.values(this.layers.catastoOfficial).forEach((layer) => register(layer.getSource()));
    }

    updateBusyOverlay() {
        const indicator = this.elements.m3BusyIndicator;
        const label = this.elements.m3BusyLabel;
        if (!indicator || !label) return;

        const visible = this.m3BusyActive || this.mapTileLoadCount > 0;
        if (!visible) {
            indicator.hidden = true;
            return;
        }

        indicator.hidden = false;
        label.textContent = this.m3BusyActive
            ? (this.m3BusyMessage || t('m3.wait'))
            : t('map.loadingTiles');
    }

    bindPointerCoordinatesOverlay() {
        const panel = this.elements.pointerCoordinatesPanel;
        if (!panel) return;

        this.updatePointerCoordinatesVisibility();
        this.map.on('pointermove', (event) => {
            if (event.dragging || this.state.mode !== 'navigate') return;
            const lonLat = toLonLat(event.coordinate);
            this.elements.pointerCoordinatesValue.textContent = `${lonLat[0].toFixed(6)}, ${lonLat[1].toFixed(6)}`;
        });

        this.map.getViewport().addEventListener('mouseleave', () => {
            if (this.state.mode === 'navigate') {
                this.elements.pointerCoordinatesValue.textContent = t('coords.placeholder');
            }
        });
    }

    updatePointerCoordinatesVisibility() {
        const panel = this.elements.pointerCoordinatesPanel;
        const value = this.elements.pointerCoordinatesValue;
        if (!panel || !value) return;

        const visible = this.state.mode === 'navigate';
        panel.hidden = !visible;
        if (!visible) {
            value.textContent = t('coords.placeholder');
        }
    }

    async copyCoordinatesAtPixel(pixel) {
        if (this.state.mode !== 'navigate' || !Array.isArray(pixel) || pixel.length < 2) return;

        const coordinate = this.map.getCoordinateFromPixel(pixel);
        if (!coordinate) return;

        const lonLat = toLonLat(coordinate);
        const text = `${lonLat[0].toFixed(6)}, ${lonLat[1].toFixed(6)}`;

        try {
            await this.writeTextToClipboard(text);
            this.setToolbarMessage(t('msg.coordinatesCopied', { coords: text }));
        } catch {
            this.setToolbarMessage(t('msg.coordinatesCopyFailed'));
        }
    }

    async writeTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const helper = document.createElement('textarea');
        helper.value = text;
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        helper.style.left = '-9999px';
        document.body.appendChild(helper);
        helper.focus();
        helper.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(helper);
        if (!ok) throw new Error('copy failed');
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
        if (this.elements.settingsM3DetectStartRadius) {
            this.elements.settingsM3DetectStartRadius.value = String(this.state.m3DetectStartRadius);
        }
        if (this.elements.settingsM3DetectMaxRadius) {
            this.elements.settingsM3DetectMaxRadius.value = String(this.state.m3DetectMaxRadius);
        }
        if (this.elements.settingsM3TraceToleranceM) {
            this.elements.settingsM3TraceToleranceM.value = String(this.state.m3TraceToleranceM);
        }
        if (this.elements.settingsParcelInfoEnabled) {
            this.elements.settingsParcelInfoEnabled.checked = this.state.parcelInfoEnabled;
        }
        if (this.elements.settingsPertenenzeColor) {
            this.elements.settingsPertenenzeColor.value = this.state.pertenenzeColor;
        }
        if (this.elements.editingLayerSelect) {
            this.elements.editingLayerSelect.value = this.state.activeEditingLayer;
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
            activeEditingLayer: this.state.activeEditingLayer,
            userAreasVisible: this.state.userAreasVisible,
            pertenenzeVisible: this.state.pertenenzeVisible,
            pertenenzeColor: this.state.pertenenzeColor,
            catastoWmsLayerSettings: this.state.catastoWmsLayerSettings,
            parcelInfoEnabled: this.state.parcelInfoEnabled,
            exportImageQuality: this.state.exportImageQuality,
            cacheTtlDays: this.state.cacheTtlDays,
            cacheSizeMb: this.state.cacheSizeMb,
            m3DetectStartRadius: this.state.m3DetectStartRadius,
            m3DetectMaxRadius: this.state.m3DetectMaxRadius,
            m3TraceToleranceM: this.state.m3TraceToleranceM,
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
        this.layers.pertenenza.changed();
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

    sanitizeM3DetectRadius(radius, fallback = 1) {
        const value = Number.parseInt(String(radius), 10);
        if (!Number.isFinite(value)) return fallback;
        return Math.max(1, Math.min(5, value));
    }

    sanitizeM3TraceToleranceM(valueRaw) {
        const value = Number.parseFloat(String(valueRaw));
        if (!Number.isFinite(value)) return 0.35;
        return Math.max(0.05, Math.min(2.5, value));
    }

    sanitizePertenenzeColor(color) {
        const value = String(color ?? '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#8a9199';
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
        this.setEditingLayer(this.getFeatureOverlayLayer(feature));
        this.setMode('edit');
        this.state.selectedFeature = feature;
        this.state.selectedEditVertex = null;
        this.getActiveInteractions().select.getFeatures().clear();
        this.getActiveInteractions().select.getFeatures().push(feature);
        this.getLayerForFeature(feature).changed();
        this.refreshEditVertexOverlay();
        this.updateSummary();
        this.setToolbarMessage(this.formatSelectedFeatureMessage(feature));
    }

    deleteFeatureFromContext(feature) {
        if (!feature) return;
        this.getSourceForFeature(feature).removeFeature(feature);
        if (this.state.selectedFeature === feature) this.clearSelection();
        this.setToolbarMessage(t('msg.featureDeleted'));
    }

    async resyncParcelMetadataForFeature(feature) {
        if (!this.isPolygonFeature(feature) || this.getFeatureOverlayLayer(feature) !== 'pertenenze') {
            return;
        }

        const labelPoint = getFeatureLabelGeometry(feature);
        const coord = labelPoint?.getCoordinates?.();
        if (!Array.isArray(coord) || coord.length < 2) {
            this.setToolbarMessage(t('msg.parcelResyncUnavailable'));
            return;
        }

        const [lon, lat] = toLonLat(coord, this.view.getProjection());
        const parcelSummary = await this.fetchParcelSummaryAtLonLat(lon, lat);
        if (!parcelSummary?.parcel) {
            this.setToolbarMessage(t('msg.parcelResyncUnavailable'));
            return;
        }

        this.applyParcelMetadataToFeature(feature, parcelSummary);
        const parcelId = String(parcelSummary.parcel.id || parcelSummary.parcel.local_id || '').trim();
        if (parcelId) {
            const links = this.getOrCreateFeatureLinks(feature);
            if (!links.cadastral.some((entry) => String(entry?.parcel_id || '').trim() === parcelId)) {
                links.cadastral.push({
                    parcel_id: parcelId,
                    intersection_area: null,
                    coverage_ratio: null,
                    linkedAt: new Date().toISOString(),
                });
                feature.set('links', links);
            }
        }

        feature.set('version', (feature.get('version') ?? 1) + 1);
        feature.set('modifiedAt', new Date().toISOString());
        this.getLayerForFeature(feature).changed();
        schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource);
        this.updateSummary();
        this.setToolbarMessage(t('msg.parcelResyncDone', {
            parcel: this.getPropertyScopeLabel(feature),
            localId: this.getFeatureInspireLocalId(feature),
        }));
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
                if (this.isPolygonFeature(this.state.selectedFeature)) {
                    const feature = this.state.selectedFeature;
                    feature.set('parcel_id', result.parcelId);
                    if (result.parcelData?.parcel) {
                        this.applyParcelMetadataToFeature(feature, result.parcelData);
                    }
                    const links = this.getOrCreateFeatureLinks(feature);
                    let existing = links.cadastral.find((c) => c.parcel_id === result.parcelId);
                    let isNewLink = false;
                    let changed = false;
                    if (!existing) {
                        existing = {
                            parcel_id: result.parcelId,
                            intersection_area: null,
                            coverage_ratio: null,
                            linkedAt: new Date().toISOString(),
                        };
                        links.cadastral.push(existing);
                        isNewLink = true;
                        changed = true;
                    }

                    const metricsChanged = this.populateCadastralLinkMetrics(
                        feature,
                        existing,
                        result.parcelGeometry,
                        result.parcelGeometryCrs,
                    );
                    changed = changed || metricsChanged;

                    if (changed) {
                        feature.set('links', links);
                        feature.set('version', (feature.get('version') ?? 1) + 1);
                        feature.set('modifiedAt', new Date().toISOString());
                        schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource);
                        this.getLayerForFeature(feature).changed();
                        this.updateDslAssignmentControls(false);
                    }

                    if (isNewLink) {
                        this.setToolbarMessage(t('msg.parcelLinked', {
                            parcelId: result.parcelId,
                            name: feature.get('featureName') || feature.get('featureId') || '-',
                        }));
                    }
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

    // Prefer proxy JSON mode because it is more stable against Agenzia WMS quirks.
    static FEATUREINFO_USE_JSON = false;

    async requestParcelInfoJson(pixel) {
        return this.requestParcelInfoJsonViaProxy(pixel);
    }

    async requestParcelInfoJsonViaProxy(pixel) {
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
        return { parcelInfoHtml: this._buildParcelHtmlFromJson(data), statusKey: 'parcelInfo.ready', parcelId, parcelData: data };
    }

    populateCadastralLinkMetrics(feature, link, parcelGeometry, parcelGeometryCrs = 'EPSG:4326') {
        if (!feature || !link || !parcelGeometry || typeof parcelGeometry !== 'object') {
            return false;
        }

        try {
            const parcelGeom = this.geoJsonFormat.readGeometry(parcelGeometry, {
                dataProjection: parcelGeometryCrs,
                featureProjection: this.view.getProjection(),
            });
            if (!parcelGeom) return false;

            const parcelKey = String(link.parcel_id ?? '').trim();
            const metrics = calculateIntersectionMetricsWithCache(
                feature,
                parcelKey || `parcel-${Date.now()}`,
                () => parcelGeom,
                { ratioBase: 'target' },
            );

            const nextIntersection = Number.isFinite(metrics.intersectionArea)
                ? metrics.intersectionArea
                : null;
            const nextCoverage = Number.isFinite(metrics.coverageRatioTarget)
                ? metrics.coverageRatioTarget
                : null;

            const changed = link.intersection_area !== nextIntersection || link.coverage_ratio !== nextCoverage;
            if (!changed) return false;

            link.intersection_area = nextIntersection;
            link.coverage_ratio = nextCoverage;
            return true;
        } catch (error) {
            console.warn('Unable to compute cadastral metrics:', error);
            return false;
        }
    }

    _buildParcelHtmlFromJson(data) {
        const p = data.parcel ?? {};
        const rows = Object.entries(data.raw ?? p)
            .filter(([, v]) => v)
            .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
            .join('');
        const summaryHtml = this.buildParcelSummaryHtml(
            p,
            data.parcelGeometry ?? null,
            data.parcelGeometryCrs ?? 'EPSG:4326',
        );
        return `${summaryHtml}<table>${rows}</table>`;
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

        let summaryHtml = '';
        try {
            const coordinate = this.map.getCoordinateFromPixel(pixel);
            if (coordinate) {
                const [lon, lat] = toLonLat(coordinate, this.view.getProjection());
                const summaryData = await this.fetchParcelSummaryAtLonLat(lon, lat);
                if (summaryData?.parcel) {
                    summaryHtml = this.buildParcelSummaryHtml(
                        summaryData.parcel,
                        summaryData.parcelGeometry ?? null,
                        summaryData.parcelGeometryCrs ?? 'EPSG:4326',
                    );
                }
            }
        } catch {
            const fields = this.extractParcelFieldsFromHtmlTable(rawHtml);
            summaryHtml = this.buildParcelSummaryHtml({
                label: fields.Label ?? fields.label ?? fields.NationalCadastralReference ?? '-',
                local_id: fields.InspireId_localId ?? fields.InspireId_localid ?? fields.InspireIdlocalId ?? '-',
            });
        }

        return { parcelInfoHtml: `${summaryHtml}${rawHtml}`, statusKey: 'parcelInfo.ready' };
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

    async detectParcelM3AtPixel(pixel) {
        /**
         * M3 Raster Segmentation: detect parcel boundary at clicked location with progressive expansion.
         * Shows live preview of each detection before asking to expand.
         * 1. Convert pixel to map coordinates (Web Mercator)
         * 2. Convert to lon/lat (EPSG:4326)
         * 3. Call /parcel-geometry-m3 endpoint (start with radius 1)
         * 4. Display detected feature on map (live preview)
         * 5. If detection succeeds and touches border, ask user to expand radius
         * 6. If YES: remove preview feature, retry with incremented radius (repeat from 3)
         * 7. If NO or no border touch: keep feature and finish
         * 8. Switch layer selector to "Pertinenze" and show success message
         */
        
        const coordinate = this.map.getCoordinateFromPixel(pixel);
        if (!coordinate) {
            this.setToolbarMessage(t('m3.error.coordinate'));
            return;
        }

        const [lon, lat] = toLonLat(coordinate);
        const parcelSummaryPromise = this.fetchParcelSummaryAtLonLat(lon, lat);

        this.setM3BusyVisible(true, t('m3.wait'));
        this.setToolbarMessage(t('m3.detecting'));

        try {
            const startRadius = this.sanitizeM3DetectRadius(this.state.m3DetectStartRadius, 1);
            const maxRadius = Math.max(startRadius, this.sanitizeM3DetectRadius(this.state.m3DetectMaxRadius, 5));
            let currentRadius = startRadius;
            let bestFeature = null;
            let bestResult = null;

            // Progressive expansion loop
            while (currentRadius <= maxRadius) {
                const response = await fetch('/parcel-geometry-m3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lat, lon, radius: currentRadius }),
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    if (currentRadius === 1) {
                        // First attempt failed
                        this.setToolbarMessage(errorData.message || t('m3.error.request'));
                    }
                    // Use previous successful result if available
                    break;
                }

                const result = await response.json();
                if (!result.ok || !result.ring) {
                    if (currentRadius === 1) {
                        // First attempt failed
                        this.setToolbarMessage(result.message || t('m3.error.detection'));
                    }
                    // Use previous successful result if available
                    break;
                }

                // Success at this radius: create feature and add to map for preview
                const ringInMapProj = result.ring.map((pt) => fromLonLat(pt));
                const feature = new Feature({
                    geometry: new Polygon([ringInMapProj]),
                });

                // Tag feature with overlay provenance
                feature.set('overlayLayer', 'pertenenze');
                
                // Decorate feature with standard properties
                decorateFeature(feature, this.state, this.pertenenzaSource.getFeatures().length);

                const parcelSummary = await parcelSummaryPromise;
                if (parcelSummary?.parcel) {
                    this.applyParcelMetadataToFeature(feature, parcelSummary);
                }

                // Add to pertinenze source for live preview
                this.pertenenzaSource.addFeature(feature);
                this.setEditingLayer('pertenenze');

                // Show preview with current radius
                const areaM2 = calculateArea(feature, this.view?.getProjection());
                const vertexCount = Math.max(0, ringInMapProj.length - 1);
                const previewMsg = t('m3.preview.detected', {
                    area: this.unitSystem.formatArea(areaM2),
                    vertices: vertexCount,
                    radius: currentRadius,
                });
                this.setToolbarMessage(previewMsg);

                // Store current result as best
                bestFeature = feature;
                bestResult = result;

                // Check if touches border and can expand
                if (result.debug?.touches_border && currentRadius < maxRadius) {
                    this.layers.pertenenza.changed();
                    this.map.renderSync();
                    await new Promise((resolve) => {
                        window.requestAnimationFrame(() => {
                            window.setTimeout(resolve, 0);
                        });
                    });
                    const nextRadius = currentRadius + 1;
                    const confirmMsg = t('m3.confirm.expandRadius', {
                        currentRadius,
                        newRadius: nextRadius,
                    });
                    if (window.confirm(confirmMsg)) {
                        // User wants to try a larger radius: remove current preview and retry
                        this.pertenenzaSource.removeFeature(feature);
                        bestFeature = null;
                        currentRadius = nextRadius;
                        this.setToolbarMessage(t('m3.detecting'));
                        continue;
                    }
                }

                // Stop expanding (either no border touch or user declined)
                // Feature remains on map
                break;
            }

            if (!bestFeature || !bestResult) {
                this.setToolbarMessage(t('m3.error.detection'));
                return;
            }

            // Show final success message (feature already on map from preview loop)
            const areaM2 = calculateArea(bestFeature, this.view?.getProjection());
            const vertexCount = Math.max(0, bestFeature.getGeometry().getCoordinates()[0].length - 1);
            const message = t('m3.success.detected', {
                area: this.unitSystem.formatArea(areaM2),
                vertices: vertexCount,
            });
            this.setToolbarMessage(message);

        } catch (error) {
            console.error('M3 detection error:', error);
            this.setToolbarMessage(t('m3.error.internal'));
        } finally {
            this.setM3BusyVisible(false);
            this.updateBusyOverlay();
        }
    }

    featureToCoarseRingLonLat(feature) {
        if (!this.isPolygonFeature(feature)) return null;
        const geometry = feature.getGeometry();
        const type = geometry?.getType?.();
        const projection = this.view?.getProjection();
        if (!projection) return null;

        let ringMap = null;
        if (type === 'Polygon') {
            ringMap = geometry.getCoordinates()?.[0] ?? null;
        } else if (type === 'MultiPolygon') {
            const polygons = geometry.getCoordinates() ?? [];
            let bestRing = null;
            let bestScore = -1;
            for (const polygon of polygons) {
                const outer = polygon?.[0];
                if (!Array.isArray(outer) || outer.length < 4) continue;
                const areaScore = Math.abs(new Polygon([outer]).getArea());
                if (areaScore > bestScore) {
                    bestScore = areaScore;
                    bestRing = outer;
                }
            }
            ringMap = bestRing;
        }

        if (!Array.isArray(ringMap) || ringMap.length < 4) return null;
        const ringLonLat = ringMap.map((coord) => toLonLat(coord, projection));
        const first = ringLonLat[0];
        const last = ringLonLat[ringLonLat.length - 1];
        if (!first || !last) return null;
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ringLonLat.push([...first]);
        }
        return ringLonLat;
    }

    getFeatureReferenceLonLat(feature, pixel = null) {
        const projection = this.view?.getProjection();
        if (!projection) return null;

        if (Array.isArray(pixel) && pixel.length >= 2) {
            const coordinate = this.map.getCoordinateFromPixel(pixel);
            if (Array.isArray(coordinate) && coordinate.length >= 2) {
                return toLonLat(coordinate, projection);
            }
        }

        const labelPoint = getFeatureLabelGeometry(feature);
        const coord = labelPoint?.getCoordinates?.();
        if (!Array.isArray(coord) || coord.length < 2) return null;
        return toLonLat(coord, projection);
    }

    async refineParcelM3ForFeature(feature, pixel) {
        if (!this.isPolygonFeature(feature)) return;

        this.rejectPendingM3Refine(false);

        const coarseRing = this.featureToCoarseRingLonLat(feature);
        if (!coarseRing) {
            this.setToolbarMessage(t('m3.error.detection'));
            return;
        }

        const referenceLonLat = this.getFeatureReferenceLonLat(feature, pixel);
        if (!referenceLonLat) {
            this.setToolbarMessage(t('m3.error.coordinate'));
            return;
        }

        const [lon, lat] = referenceLonLat;
        this.setM3BusyVisible(true, t('m3.refine.wait'));
        this.setToolbarMessage(t('m3.refine.running'));

        try {
            const response = await fetch('/parcel-geometry-m3-trace', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lat,
                    lon,
                    coarseRing,
                    toleranceM: this.state.m3TraceToleranceM,
                }),
            });

            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result?.ok || !Array.isArray(result?.ring) || result.ring.length < 4) {
                this.setToolbarMessage(result?.message || t('m3.refine.error'));
                return;
            }

            const projection = this.view.getProjection();
            const ringInMapProj = result.ring.map((pt) => fromLonLat(pt, projection));
            const geometry = feature.getGeometry();
            const type = geometry?.getType?.();

            const originalCoordinates = this.cloneGeometryCoordinates(feature.getGeometry());
            const beforePrimaryRing = this.extractPrimaryOuterRingFromCoordinates(originalCoordinates, type);
            const beforeAreaM2 = calculateArea(feature, projection);
            const beforePerimeterM = calculatePerimeter(feature, projection);
            const beforeVertices = this.countFeatureVertices(feature);

            if (type === 'Polygon') {
                geometry.setCoordinates([ringInMapProj]);
            } else {
                geometry.setCoordinates([[ringInMapProj]]);
            }

            const layer = this.getLayerForFeature(feature);
            layer.changed();
            const areaM2 = calculateArea(feature, projection);
            const perimeterM = calculatePerimeter(feature, projection);
            const vertexCount = Math.max(0, ringInMapProj.length - 1);
            const deltaAreaM2 = areaM2 - beforeAreaM2;
            const deltaAreaRatio = beforeAreaM2 > 1e-9 ? (deltaAreaM2 / beforeAreaM2) : 0;
            const deltaPerimeterM = perimeterM - beforePerimeterM;
            const snapAccepted = Number(result?.debug?.snapAcceptedVertices ?? result?.debug?.snap_accepted_vertices ?? 0);
            // Per il trace endpoint snapAccepted e sempre 0 (campo non emesso): il giudizio
            // "no visible change" si basa solo sui delta geometrici.
            const noVisibleChange = Math.abs(deltaAreaM2) < 1.0
                && Math.abs(deltaPerimeterM) < 0.20
                && snapAccepted <= 0;

            this.pendingM3Refine = {
                feature,
                originalCoordinates,
                overlayLayer: this.getFeatureOverlayLayer(feature),
                report: {
                    beforeAreaM2,
                    beforePerimeterM,
                    beforeVertices,
                    afterAreaM2: areaM2,
                    afterPerimeterM: perimeterM,
                    afterVertices: vertexCount,
                    deltaAreaM2,
                    deltaAreaRatio,
                    deltaPerimeterM,
                    beforePrimaryRing,
                    afterPrimaryRing: ringInMapProj,
                    noVisibleChange,
                    debug: (result.debug && typeof result.debug === 'object') ? result.debug : {},
                },
            };

            this.updateSummary();
            this.map.renderSync();
            this.renderM3RefineReport();
            this.setToolbarMessage(t(noVisibleChange ? 'm3.refine.preview.noChange' : 'm3.refine.preview'));
        } catch (error) {
            console.error('M3 refine error:', error);
            this.setToolbarMessage(t('m3.refine.error'));
        } finally {
            this.setM3BusyVisible(false);
            this.updateBusyOverlay();
        }
    }

    cloneGeometryCoordinates(geometry) {
        const type = geometry?.getType?.();
        if (type === 'Polygon' || type === 'MultiPolygon') {
            return JSON.parse(JSON.stringify(geometry.getCoordinates()));
        }
        return null;
    }

    countFeatureVertices(feature) {
        if (!this.isPolygonFeature(feature)) return 0;
        const sets = this.getFeaturePolygonCoordinateSets(feature);
        let total = 0;
        for (const polygon of sets) {
            const outer = polygon?.[0];
            if (Array.isArray(outer) && outer.length > 1) {
                total += Math.max(0, outer.length - 1);
            }
        }
        return total;
    }

    formatSignedNumber(value, digits = 2) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '-';
        const sign = n >= 0 ? '+' : '';
        return `${sign}${n.toFixed(digits)}`;
    }

    extractPrimaryOuterRingFromCoordinates(coordinates, geometryType) {
        if (!Array.isArray(coordinates)) return null;

        if (geometryType === 'Polygon') {
            const outer = coordinates[0];
            return Array.isArray(outer) ? outer : null;
        }

        if (geometryType === 'MultiPolygon') {
            let bestRing = null;
            let bestArea = -1;
            for (const polygon of coordinates) {
                const outer = polygon?.[0];
                if (!Array.isArray(outer) || outer.length < 4) continue;
                const areaScore = Math.abs(new Polygon([outer]).getArea());
                if (areaScore > bestArea) {
                    bestArea = areaScore;
                    bestRing = outer;
                }
            }
            return bestRing;
        }

        return null;
    }

    renderM3RefineDiffCanvas(beforeRing, afterRing) {
        const canvas = this.elements.m3RefineDiffCanvas;
        if (!(canvas instanceof HTMLCanvasElement)) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(6,16,12,0.95)';
        ctx.fillRect(0, 0, width, height);

        const validBefore = Array.isArray(beforeRing) && beforeRing.length >= 4;
        const validAfter = Array.isArray(afterRing) && afterRing.length >= 4;
        if (!validBefore && !validAfter) {
            ctx.fillStyle = '#9cb7aa';
            ctx.font = '12px Aptos';
            ctx.fillText('No geometry preview', 10, 18);
            return;
        }

        const allPoints = [
            ...(validBefore ? beforeRing : []),
            ...(validAfter ? afterRing : []),
        ].filter((pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));

        if (!allPoints.length) return;

        const xs = allPoints.map((p) => p[0]);
        const ys = allPoints.map((p) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const pad = 12;
        const spanX = Math.max(1e-9, maxX - minX);
        const spanY = Math.max(1e-9, maxY - minY);
        const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
        const offsetX = (width - spanX * scale) * 0.5;
        const offsetY = (height - spanY * scale) * 0.5;

        const project = (pt) => [
            offsetX + (pt[0] - minX) * scale,
            height - (offsetY + (pt[1] - minY) * scale),
        ];

        const drawRing = (ring, fill, stroke, lineWidth = 1.8) => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            ctx.beginPath();
            const [x0, y0] = project(ring[0]);
            ctx.moveTo(x0, y0);
            for (let i = 1; i < ring.length; i += 1) {
                const [x, y] = project(ring[i]);
                ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lineWidth;
            ctx.fill();
            ctx.stroke();
        };

        drawRing(beforeRing, 'rgba(255, 90, 90, 0.22)', 'rgba(255, 140, 140, 0.95)');
        drawRing(afterRing, 'rgba(115, 240, 191, 0.24)', 'rgba(115, 240, 191, 0.98)', 2.2);

        ctx.fillStyle = '#dff7ec';
        ctx.font = '11px Aptos';
        ctx.fillText('Before', 10, 16);
        ctx.fillStyle = 'rgba(115, 240, 191, 0.98)';
        ctx.fillText('After', 58, 16);
    }

    renderM3RefineReport() {
        const pending = this.pendingM3Refine;
        const panel = this.elements.m3RefineReport;
        if (!panel) return;
        if (!pending || !pending.report) {
            panel.hidden = true;
            return;
        }

        const report = pending.report;
        const debug = report.debug || {};

        if (this.elements.m3RefineReportTitle) {
            const featureName = String(pending.feature?.get?.('featureName') || pending.feature?.get?.('featureId') || '-').trim() || '-';
            this.elements.m3RefineReportTitle.textContent = t('m3.refine.report.title', { name: featureName });
        }

        this.elements.m3RefineBeforeArea.textContent = this.unitSystem.formatArea(report.beforeAreaM2);
        this.elements.m3RefineBeforePerimeter.textContent = this.unitSystem.formatPerimeter(report.beforePerimeterM);
        this.elements.m3RefineBeforeVertices.textContent = String(report.beforeVertices);

        this.elements.m3RefineAfterArea.textContent = this.unitSystem.formatArea(report.afterAreaM2);
        this.elements.m3RefineAfterPerimeter.textContent = this.unitSystem.formatPerimeter(report.afterPerimeterM);
        this.elements.m3RefineAfterVertices.textContent = String(report.afterVertices);

        this.elements.m3RefineDiffArea.textContent = `${this.formatSignedNumber(report.deltaAreaM2, 2)} m2`;
        this.elements.m3RefineDiffRatio.textContent = `${this.formatSignedNumber(report.deltaAreaRatio * 100, 2)}%`;
        this.elements.m3RefineDiffPerimeter.textContent = `${this.formatSignedNumber(report.deltaPerimeterM, 2)} m`;

        const numOrDash = (value, digits = null) => {
            const n = Number(value);
            if (!Number.isFinite(n)) return '-';
            if (typeof digits === 'number') return n.toFixed(digits);
            return String(Math.round(n));
        };

        this.elements.m3RefineSnapAccepted.textContent = numOrDash(debug.snapAcceptedVertices ?? debug.snap_accepted_vertices);
        this.elements.m3RefineSnapRejected.textContent = numOrDash(debug.snapRejectedVertices ?? debug.snap_rejected_vertices);
        this.elements.m3RefineSnapKept.textContent = numOrDash(debug.snapKeptVertices ?? debug.snap_kept_vertices);
        this.elements.m3RefineMeanSnap.textContent = `${numOrDash(debug.meanSnapMeters ?? debug.mean_snap_meters, 2)} m`;
        this.elements.m3RefineMeanConfidence.textContent = numOrDash(debug.meanConfidence ?? debug.mean_confidence, 3);
        this.elements.m3RefineRejectedDistance.textContent = numOrDash(debug.rejectedByDistance);
        this.elements.m3RefineRejectedWeakGain.textContent = numOrDash(debug.rejectedByWeakGain);
        this.renderM3RefineDiffCanvas(report.beforePrimaryRing, report.afterPrimaryRing);

        if (this.elements.m3RefineEffectNote) {
            const noteKey = report.noVisibleChange
                ? 'm3.refine.report.effect.unchanged'
                : 'm3.refine.report.effect.changed';
            this.elements.m3RefineEffectNote.textContent = t(noteKey);
            this.elements.m3RefineEffectNote.classList.toggle('is-unchanged', Boolean(report.noVisibleChange));
        }

        panel.hidden = false;
    }

    hideM3RefineReport() {
        const panel = this.elements.m3RefineReport;
        if (panel) panel.hidden = true;
    }

    acceptPendingM3Refine() {
        if (!this.pendingM3Refine) return;

        const { feature, overlayLayer, report } = this.pendingM3Refine;
        const now = new Date().toISOString();
        feature.set('version', (feature.get('version') ?? 1) + 1);
        feature.set('modifiedAt', now);

        const layer = overlayLayer === 'pertenenze' ? this.layers.pertenenza : this.layers.vector;
        layer.changed();
        this.map.renderSync();
        schedulePersistenceSync(this.state, this.vectorSource, this.pertenenzaSource);
        this.updateSummary();
        this.hideM3RefineReport();
        this.pendingM3Refine = null;

        this.setToolbarMessage(t('m3.refine.success', {
            area: this.unitSystem.formatArea(report.afterAreaM2),
            vertices: report.afterVertices,
        }));
    }

    rejectPendingM3Refine(showMessage = true) {
        const pending = this.pendingM3Refine;
        if (!pending) return;

        const { feature, originalCoordinates, overlayLayer } = pending;
        const geometry = feature.getGeometry();
        if (geometry && originalCoordinates) {
            geometry.setCoordinates(originalCoordinates);
        }

        const layer = overlayLayer === 'pertenenze' ? this.layers.pertenenza : this.layers.vector;
        layer.changed();
        this.map.renderSync();
        this.updateSummary();
        this.hideM3RefineReport();
        this.pendingM3Refine = null;
        if (showMessage) {
            this.setToolbarMessage(t('m3.refine.rejected'));
        }
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

    historyAtPoint(lon, lat) {
        return historyAtPoint([lon, lat]);
    }

    historyAtPointFromPixel(pixel) {
        const coordinate = this.map?.getCoordinateFromPixel(pixel);
        if (!coordinate) return [];
        const [lon, lat] = toLonLat(coordinate);
        return historyAtPoint([lon, lat]);
    }

    historyAtParcel(parcelId) {
        return historyAtParcel(parcelId);
    }
}
