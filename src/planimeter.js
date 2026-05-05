import Map          from 'ol/Map.js';
import View         from 'ol/View.js';
import VectorSource from 'ol/source/Vector.js';
import { defaults as defaultControls } from 'ol/control.js';
import { fromLonLat } from 'ol/proj.js';

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
import { buildExportConfig, triggerDownload } from './io/export.js';
import { detectImportFormat, readImportedFeatures } from './io/import.js';

export default class Planimeter {
    constructor() {
        // ── Locale & units ────────────────────────────────────────────────────
        const locale = detectLocale();
        setLocale(locale);
        this.unitSystem = new UnitSystem(UnitSystem.autoDetect(navigator.language));

        // ── State & source ────────────────────────────────────────────────────
        this.state        = createInitialState();
        this.state.locale = locale;
        this.state.unitSystem = this.unitSystem.system;

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
        this.setMode('draw');
    }

    // ── DOM helpers ─────────────────────────────────────────────────────────────

    collectElements() {
        return {
            layerSat:                  document.getElementById('layer-sat'),
            layerOsm:                  document.getElementById('layer-osm'),
            layerCatasto:              document.getElementById('layer-catasto'),
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
            ctxCancelDraw:             document.getElementById('ctx-cancel-draw'),
            langSwitcher:              document.getElementById('lang-switcher'),
            unitSwitcher:              document.getElementById('unit-system'),
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
            layers: [
                this.layers.sat,
                this.layers.osm,
                this.layers.catastoOfficial,
                this.layers.catastoFallback,
                this.layers.vector,
            ],
            view: this.view,
            controls: defaultControls({ zoom: false, rotate: false }),
        });

        this.layers.catastoOfficial.getSource().on('imageloaderror', () => {
            if (this.state.catastoSource === 'official' && this.elements.layerCatasto.checked) {
                this.proxyHealth?.setHealth('ko', t('msg.layerError'));
                this.setToolbarMessage(t('msg.layerError'));
            }
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
        this.bindLayerToggle(this.elements.layerSat, 'sat');
        this.bindLayerToggle(this.elements.layerOsm, 'osm');

        this.elements.layerCatasto.addEventListener('change', () => {
            this.updateCatastoVisibility();
            this.proxyHealth.update(
                this.elements.layerCatasto.checked,
                this.state.catastoSource,
            );
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

        this.elements.langSwitcher?.addEventListener('change', (ev) => {
            setLocale(ev.target.value);
            this.state.locale = ev.target.value;
            this.refreshUIText();
        });

        this.elements.unitSwitcher?.addEventListener('change', (ev) => {
            this.unitSystem = new UnitSystem(ev.target.value);
            this.state.unitSystem = ev.target.value;
            this.layers.vector.changed();
            this.updateSummary();
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
        this.state.mode = mode;

        if (this.state.drawLockTimeoutId) {
            window.clearTimeout(this.state.drawLockTimeoutId);
            this.state.drawLockTimeoutId = null;
        }

        const ix = this.interactions;
        ix.draw.setActive(mode === 'draw');
        ix.drawStraight.setActive(mode === 'measure-straight');
        ix.drawPolyline.setActive(mode === 'measure-polyline');
        ix.select.setActive(mode === 'edit' || mode === 'delete');
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
            'draw':             'msg.drawActive',
            'edit':             'msg.editActive',
            'delete':           'msg.deleteActive',
            'measure-straight': 'msg.measureStraightActive',
            'measure-polyline': 'msg.measurePolylineActive',
        };
        this.setToolbarMessage(t(modeMsg[mode] ?? 'msg.drawActive'));
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

        if (this.state.mode === 'delete') {
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

    exportFeatures() {
        const features = this.vectorSource.getFeatures();
        if (!features.length) {
            alert(t('alert.noExport'));
            return;
        }
        const fmt    = this.elements.exportFormat.value;
        const config = buildExportConfig(features, fmt);
        triggerDownload(
            config.payload,
            config.mimeType,
            `planimeter-${new Date().toISOString().slice(0, 10)}.${config.extension}`,
        );
        this.setToolbarMessage(t('msg.exportDone', { format: config.label }));
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

    bindLayerToggle(el, layerKey) {
        el.addEventListener('change', (ev) => this.layers[layerKey].setVisible(ev.target.checked));
    }

    setCatastoSource(sourceKey) {
        this.state.catastoSource = sourceKey;
        this.updateCatastoVisibility();

        const isOfficial = sourceKey === 'official';
        this.elements.catastoHint.textContent       = t(isOfficial ? 'layer.catasto.hint.official' : 'layer.catasto.hint.fallback');
        this.elements.statCatastoSource.textContent = t(isOfficial ? 'stat.catasto.official' : 'stat.catasto.fallback');

        this.proxyHealth.update(this.elements.layerCatasto.checked, sourceKey);
    }

    updateCatastoVisibility() {
        const show       = this.elements.layerCatasto.checked;
        const isOfficial = this.state.catastoSource === 'official';
        this.layers.catastoOfficial.setVisible(show && isOfficial);
        this.layers.catastoFallback.setVisible(show && !isOfficial);
    }

    // ── Locale/unit refresh ──────────────────────────────────────────────────────

    /** Refresh all dynamic UI text after a locale change. */
    refreshUIText() {
        this.refreshSnapState();
        const modeMsg = {
            'draw':             'msg.drawActive',
            'edit':             'msg.editActive',
            'delete':           'msg.deleteActive',
            'measure-straight': 'msg.measureStraightActive',
            'measure-polyline': 'msg.measurePolylineActive',
        };
        this.setToolbarMessage(t(modeMsg[this.state.mode] ?? 'msg.drawActive'));

        const isOfficial = this.state.catastoSource === 'official';
        this.elements.catastoHint.textContent       = t(isOfficial ? 'layer.catasto.hint.official' : 'layer.catasto.hint.fallback');
        this.elements.statCatastoSource.textContent = t(isOfficial ? 'stat.catasto.official' : 'stat.catasto.fallback');

        this.proxyHealth.render();
        this.layers.vector.changed();
        this.updateSummary();
    }

    // ── Misc ─────────────────────────────────────────────────────────────────────

    setToolbarMessage(message) {
        this.elements.status.textContent = message;
    }
}
