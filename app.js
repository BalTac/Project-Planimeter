const LOCAL_STORAGE_KEY = 'planimeter.features.v1';
const LOCAL_STORAGE_SCHEMA_VERSION = 1;
const PERSISTENCE_SAVE_DELAY_MS = 250;
const SUPPORTED_GEOMETRY_TYPES = new Set(['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString']);
const SUPPORTED_IMPORT_EXTENSIONS = new Set(['geojson', 'json', 'kml']);

class Planimeter {
    constructor() {
        this.layers = {};
        this.vectorSource = new ol.source.Vector();
        this.geoJsonFormat = new ol.format.GeoJSON();
        this.kmlFormat = new ol.format.KML({ extractStyles: false });
        this.state = {
            mode: 'draw',
            nextFeatureId: 1,
            selectedFeature: null,
            catastoSource: 'official',
            drawLockTimeoutId: null,
            isCtrlPressed: false,
            isDrawing: false,
            proxyHealthStatus: 'checking',
            proxyHealthMessage: 'Verifica iniziale in corso.',
            proxyHealthRequestPending: false,
            proxyHealthIntervalId: null,
            persistenceSaveTimeoutId: null,
            persistenceMuted: false,
        };

        this.elements = this.collectElements();
        this.initLayers();
        this.initMap();
        this.initInteractions();
        this.bindUI();
        this.initContextMenu();
        this.initProxyHealthMonitoring();
        this.restorePersistedFeatures();
        this.updateSummary();
        this.setMode('draw');
    }

    collectElements() {
        return {
            layerSat: document.getElementById('layer-sat'),
            layerOsm: document.getElementById('layer-osm'),
            layerCatasto: document.getElementById('layer-catasto'),
            catastoSource: document.getElementById('catasto-source'),
            catastoHint: document.getElementById('catasto-hint'),
            locateButton: document.getElementById('btn-locate'),
            clearButton: document.getElementById('btn-clear'),
            exportButton: document.getElementById('btn-export'),
            importButton: document.getElementById('btn-import'),
            exportFormat: document.getElementById('export-format'),
            duplicateSelectedButton: document.getElementById('btn-duplicate-selected'),
            deleteSelectedButton: document.getElementById('btn-delete-selected'),
            importInput: document.getElementById('file-import'),
            modeButtons: [...document.querySelectorAll('[data-mode]')],
            status: document.getElementById('toolbar-status'),
            statCount: document.getElementById('stat-count'),
            statTotalArea: document.getElementById('stat-total-area'),
            statTotalPerimeter: document.getElementById('stat-total-perimeter'),
            statSelectedArea: document.getElementById('stat-selected-area'),
            statZoom: document.getElementById('stat-zoom'),
            statCatastoSource: document.getElementById('stat-catasto-source'),
            statProxyHealth: document.getElementById('stat-proxy-health'),
            proxyHealthDetail: document.getElementById('proxy-health-detail'),
            snapStatus: document.getElementById('snap-status'),
            contextMenu: document.getElementById('map-context-menu'),
            ctxCancelDraw: document.getElementById('ctx-cancel-draw'),
        };
    }

    initLayers() {
        this.layers.sat = new ol.layer.Tile({
            source: new ol.source.XYZ({
                url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                maxZoom: 19,
            }),
            visible: true,
            zIndex: 1,
        });

        this.layers.osm = new ol.layer.Tile({
            source: new ol.source.OSM(),
            visible: false,
            zIndex: 2,
            opacity: 0.82,
        });

        this.layers.catastoOfficial = new ol.layer.Image({
            source: new ol.source.ImageWMS({
                url: '/wms-proxy',
                params: {
                    VERSION: '1.3.0',
                    LAYERS: 'CP.CadastralParcel',
                    STYLES: '',
                    FORMAT: 'image/png',
                    TRANSPARENT: true,
                },
                ratio: 1,
            }),
            visible: false,
            zIndex: 3,
            minZoom: 14,
            opacity: 0.9,
        });

        this.layers.catastoFallback = new ol.layer.Tile({
            source: new ol.source.XYZ({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
                crossOrigin: 'anonymous',
                maxZoom: 19,
            }),
            visible: false,
            zIndex: 3,
            opacity: 0.82,
        });

        this.layers.vector = new ol.layer.Vector({
            source: this.vectorSource,
            style: this.featureStyle.bind(this),
            zIndex: 10,
        });
    }

    initMap() {
        this.view = new ol.View({
            center: ol.proj.fromLonLat([12.4964, 41.9028]),
            zoom: 6,
        });

        this.map = new ol.Map({
            target: 'map',
            layers: [
                this.layers.sat,
                this.layers.osm,
                this.layers.catastoOfficial,
                this.layers.catastoFallback,
                this.layers.vector,
            ],
            view: this.view,
            controls: ol.control.defaults.defaults({
                zoom: false,
                rotate: false,
            }),
        });

        this.layers.catastoOfficial.getSource().on('imageloaderror', () => {
            if (this.state.catastoSource === 'official' && this.elements.layerCatasto.checked) {
                this.setProxyHealth('ko', 'Errore caricamento layer ufficiale. Verifica proxy locale e disponibilita upstream.');
                this.setToolbarMessage('Layer ufficiale non disponibile. Avvia server.py e prova la sorgente sostitutiva se necessario.');
            }
        });

        this.view.on('change:resolution', () => this.updateSummary());
        this.vectorSource.on('addfeature', () => {
            this.updateSummary();
            this.schedulePersistenceSync();
        });
        this.vectorSource.on('removefeature', () => {
            this.updateSummary();
            this.schedulePersistenceSync();
        });
        this.vectorSource.on('changefeature', () => {
            this.updateSummary();
            this.schedulePersistenceSync();
        });
    }

    initInteractions() {
        this.selectInteraction = new ol.interaction.Select({
            layers: [this.layers.vector],
            hitTolerance: 8,
        });

        this.modifyInteraction = new ol.interaction.Modify({
            features: this.selectInteraction.getFeatures(),
        });

        this.drawInteraction = new ol.interaction.Draw({
            source: this.vectorSource,
            type: 'Polygon',
            stopClick: true,
            style: new ol.style.Style({
                fill: new ol.style.Fill({ color: 'rgba(115, 240, 191, 0.18)' }),
                stroke: new ol.style.Stroke({
                    color: '#73f0bf',
                    lineDash: [10, 8],
                    width: 2,
                }),
            }),
        });

        this.drawStraightDistanceInteraction = new ol.interaction.Draw({
            source: this.vectorSource,
            type: 'LineString',
            maxPoints: 2,
            stopClick: true,
            style: new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: '#7bc7ff',
                    lineDash: [8, 6],
                    width: 3,
                }),
            }),
        });

        this.drawPolylineDistanceInteraction = new ol.interaction.Draw({
            source: this.vectorSource,
            type: 'LineString',
            stopClick: true,
            style: new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: '#7bc7ff',
                    lineDash: [8, 6],
                    width: 3,
                }),
            }),
        });

        this.snapInteraction = new ol.interaction.Snap({
            source: this.vectorSource,
            edge: true,
            vertex: true,
            pixelTolerance: 12,
        });

        this.map.addInteraction(this.selectInteraction);
        this.map.addInteraction(this.modifyInteraction);
        this.map.addInteraction(this.drawInteraction);
        this.map.addInteraction(this.drawStraightDistanceInteraction);
        this.map.addInteraction(this.drawPolylineDistanceInteraction);
        this.map.addInteraction(this.snapInteraction);

        this.drawInteraction.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage('Disegno in corso. Doppio clic per chiudere il poligono. Tasto destro per annullare.');
        });

        this.drawInteraction.on('drawend', (event) => {
            this.state.isDrawing = false;
            this.decorateFeature(event.feature);
            this.state.selectedFeature = event.feature;
            this.layers.vector.changed();
            this.updateSummary();
            this.setToolbarMessage('Area creata. Nuovo disegno disponibile tra 1 secondo.');
            this.pauseDrawAfterClose();
        });

        this.drawInteraction.on('drawabort', () => {
            this.state.isDrawing = false;
            this.setToolbarMessage('Disegno annullato. Modalita disegno attiva.');
        });

        this.drawStraightDistanceInteraction.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage('Misura retta in corso. Clic punto iniziale e finale. Tasto destro per annullare.');
        });

        this.drawStraightDistanceInteraction.on('drawend', (event) => {
            this.state.isDrawing = false;
            event.feature.set('measurementType', 'straight');
            this.decorateFeature(event.feature);
            this.state.selectedFeature = event.feature;
            this.layers.vector.changed();
            this.updateSummary();
            this.setToolbarMessage('Distanza retta misurata.');
        });

        this.drawStraightDistanceInteraction.on('drawabort', () => {
            this.state.isDrawing = false;
            this.setToolbarMessage('Misura retta annullata.');
        });

        this.drawPolylineDistanceInteraction.on('drawstart', () => {
            this.state.isDrawing = true;
            this.clearSelection();
            this.setToolbarMessage('Misura polyline in corso. Clic per aggiungere vertici, doppio clic per chiudere.');
        });

        this.drawPolylineDistanceInteraction.on('drawend', (event) => {
            this.state.isDrawing = false;
            event.feature.set('measurementType', 'polyline');
            this.decorateFeature(event.feature);
            this.state.selectedFeature = event.feature;
            this.layers.vector.changed();
            this.updateSummary();
            this.setToolbarMessage('Distanza polyline misurata.');
        });

        this.drawPolylineDistanceInteraction.on('drawabort', () => {
            this.state.isDrawing = false;
            this.setToolbarMessage('Misura polyline annullata.');
        });

        this.selectInteraction.on('select', (event) => this.handleFeatureSelection(event));

        this.modifyInteraction.on('modifystart', () => {
            this.setToolbarMessage('Modifica vertici attiva. Trascina i punti della geometria selezionata.');
        });

        this.modifyInteraction.on('modifyend', () => {
            this.updateSummary();
            this.setToolbarMessage('Geometria aggiornata.');
        });

        document.addEventListener('keydown', (event) => {
            if (!event.ctrlKey) {
                return;
            }

            if (!this.state.isCtrlPressed) {
                this.state.isCtrlPressed = true;
                this.refreshSnapState();
            }
        });

        document.addEventListener('keyup', (event) => {
            if (event.ctrlKey) {
                return;
            }

            if (this.state.isCtrlPressed) {
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

    bindUI() {
        this.bindLayerToggle(this.elements.layerSat, 'sat');
        this.bindLayerToggle(this.elements.layerOsm, 'osm');
        this.elements.layerCatasto.addEventListener('change', () => {
            this.updateCatastoVisibility();
            if (this.elements.layerCatasto.checked && this.state.catastoSource === 'official') {
                this.checkProxyHealth();
            }
        });
        this.elements.catastoSource.addEventListener('change', (event) => {
            this.setCatastoSource(event.target.value);
        });

        this.elements.modeButtons.forEach((button) => {
            button.addEventListener('click', () => this.setMode(button.dataset.mode));
        });

        this.elements.locateButton.addEventListener('click', () => this.geolocate());
        this.elements.clearButton.addEventListener('click', () => this.clearAllFeatures());
        this.elements.exportButton.addEventListener('click', () => this.exportFeatures());
        this.elements.importButton.addEventListener('click', () => this.elements.importInput.click());
        this.elements.duplicateSelectedButton.addEventListener('click', () => this.duplicateSelectedArea());
        this.elements.deleteSelectedButton.addEventListener('click', () => this.deleteSelectedFeature());
        this.elements.importInput.addEventListener('change', (event) => this.importFeatures(event));
    }

    initContextMenu() {
        const viewport = this.map.getViewport();

        viewport.addEventListener('contextmenu', (event) => {
            event.preventDefault();

            if (this.isMeasureOrDrawMode(this.state.mode) && this.state.isDrawing) {
                const rect = viewport.getBoundingClientRect();
                this.showContextMenu(event.clientX - rect.left, event.clientY - rect.top);
            }
        });

        this.elements.ctxCancelDraw.addEventListener('click', () => {
            this.abortActiveDraw();
            this.hideContextMenu();
        });

        document.addEventListener('mousedown', (event) => {
            if (!this.elements.contextMenu.hidden && !this.elements.contextMenu.contains(event.target)) {
                this.hideContextMenu();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.elements.contextMenu.hidden) {
                this.hideContextMenu();
            }
        });
    }

    showContextMenu(x, y) {
        const menu = this.elements.contextMenu;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.hidden = false;

        const menuW = menu.offsetWidth;
        const menuH = menu.offsetHeight;
        const containerW = this.map.getViewport().clientWidth;
        const containerH = this.map.getViewport().clientHeight;

        if (x + menuW > containerW) {
            menu.style.left = `${Math.max(0, x - menuW)}px`;
        }

        if (y + menuH > containerH) {
            menu.style.top = `${Math.max(0, y - menuH)}px`;
        }
    }

    hideContextMenu() {
        this.elements.contextMenu.hidden = true;
    }

    initProxyHealthMonitoring() {
        this.renderProxyHealth();
        this.checkProxyHealth();
        this.state.proxyHealthIntervalId = window.setInterval(() => {
            this.checkProxyHealth({ silent: true });
        }, 45000);
    }

    async checkProxyHealth(options = {}) {
        const { silent = false } = options;

        if (this.state.proxyHealthRequestPending) {
            return;
        }

        this.state.proxyHealthRequestPending = true;

        if (!silent) {
            this.setProxyHealth('checking', 'Verifica proxy WMS in corso...');
        }

        try {
            const response = await fetch('/proxy-health', {
                cache: 'no-store',
                headers: {
                    Accept: 'application/json',
                },
            });

            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }

            if (!response.ok || !payload?.ok) {
                throw new Error(payload?.message || `Health check HTTP ${response.status}.`);
            }

            const detail = typeof payload.durationMs === 'number'
                ? `${payload.message} Ultimo check: ${payload.durationMs} ms.`
                : payload.message;
            this.setProxyHealth('ok', detail);
        } catch (error) {
            const detail = error instanceof Error ? error.message : 'Proxy WMS non raggiungibile.';
            this.setProxyHealth('ko', detail);
        } finally {
            this.state.proxyHealthRequestPending = false;
        }
    }

    setProxyHealth(status, detail) {
        this.state.proxyHealthStatus = status;
        this.state.proxyHealthMessage = detail;
        this.renderProxyHealth();
    }

    renderProxyHealth() {
        const statusMap = {
            ok: 'OK',
            ko: 'KO',
            checking: 'Verifica...',
        };

        this.elements.statProxyHealth.textContent = statusMap[this.state.proxyHealthStatus] || 'N/D';
        this.elements.statProxyHealth.classList.remove('status-ok', 'status-ko', 'status-checking');
        this.elements.statProxyHealth.classList.add(`status-${this.state.proxyHealthStatus}`);
        this.elements.proxyHealthDetail.textContent = this.state.proxyHealthMessage;
    }

    bindLayerToggle(element, layerKey) {
        element.addEventListener('change', (event) => {
            this.layers[layerKey].setVisible(event.target.checked);
        });
    }

    setCatastoSource(sourceKey) {
        this.state.catastoSource = sourceKey;
        this.updateCatastoVisibility();

        if (sourceKey === 'official') {
            this.elements.catastoHint.textContent = 'Sorgente ufficiale WMS Agenzia Entrate. Potrebbe risultare non visibile in alcune zone/scale.';
            this.elements.statCatastoSource.textContent = 'Ufficiale';
            this.checkProxyHealth();
            return;
        }

        this.elements.catastoHint.textContent = 'Sorgente sostitutiva non catastale: confini amministrativi per supporto visuale.';
        this.elements.statCatastoSource.textContent = 'Sostitutivo';
    }

    updateCatastoVisibility() {
        const shouldShow = this.elements.layerCatasto.checked;
        const useOfficial = this.state.catastoSource === 'official';

        this.layers.catastoOfficial.setVisible(shouldShow && useOfficial);
        this.layers.catastoFallback.setVisible(shouldShow && !useOfficial);
    }

    setMode(mode) {
        this.state.mode = mode;

        if (this.state.drawLockTimeoutId) {
            window.clearTimeout(this.state.drawLockTimeoutId);
            this.state.drawLockTimeoutId = null;
        }

        this.drawInteraction.setActive(mode === 'draw');
        this.drawStraightDistanceInteraction.setActive(mode === 'measure-straight');
        this.drawPolylineDistanceInteraction.setActive(mode === 'measure-polyline');
        this.selectInteraction.setActive(mode === 'edit' || mode === 'delete');
        this.modifyInteraction.setActive(mode === 'edit');
        this.refreshSnapState();

        if (this.isMeasureOrDrawMode(mode)) {
            this.selectInteraction.getFeatures().clear();
        } else if (this.state.selectedFeature) {
            const selectedFeatures = this.selectInteraction.getFeatures();
            selectedFeatures.clear();
            selectedFeatures.push(this.state.selectedFeature);
        }

        this.elements.modeButtons.forEach((button) => {
            const isActive = button.dataset.mode === mode;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });

        if (mode === 'draw') {
            this.setToolbarMessage('Modalita disegno attiva. Clicca sulla mappa per tracciare una nuova area.');
        }

        if (mode === 'edit') {
            this.setToolbarMessage('Modalita modifica attiva. Seleziona un poligono per modificarne i vertici.');
        }

        if (mode === 'delete') {
            this.setToolbarMessage('Modalita elimina attiva. Un clic su una feature la rimuove.');
        }

        if (mode === 'measure-straight') {
            this.setToolbarMessage('Misura retta attiva. Clicca punto iniziale e finale.');
        }

        if (mode === 'measure-polyline') {
            this.setToolbarMessage('Misura polyline attiva. Clicca i vertici e doppio clic per chiudere la misura.');
        }
    }

    isMeasureOrDrawMode(mode) {
        return mode === 'draw' || mode === 'measure-straight' || mode === 'measure-polyline';
    }

    getActiveDrawInteraction() {
        if (this.state.mode === 'measure-straight') {
            return this.drawStraightDistanceInteraction;
        }

        if (this.state.mode === 'measure-polyline') {
            return this.drawPolylineDistanceInteraction;
        }

        if (this.state.mode === 'draw') {
            return this.drawInteraction;
        }

        return null;
    }

    abortActiveDraw() {
        const activeDrawInteraction = this.getActiveDrawInteraction();
        if (!activeDrawInteraction) {
            return;
        }

        activeDrawInteraction.abortDrawing();
    }

    pauseDrawAfterClose() {
        this.drawInteraction.setActive(false);

        if (this.state.drawLockTimeoutId) {
            window.clearTimeout(this.state.drawLockTimeoutId);
        }

        this.state.drawLockTimeoutId = window.setTimeout(() => {
            this.state.drawLockTimeoutId = null;

            if (this.state.mode === 'draw') {
                this.drawInteraction.setActive(true);
                this.refreshSnapState();
                this.setToolbarMessage('Modalita disegno riattivata.');
            }
        }, 1000);
    }

    refreshSnapState() {
        const snapAllowedByMode = this.isMeasureOrDrawMode(this.state.mode) || this.state.mode === 'edit';
        const snapActive = snapAllowedByMode && !this.state.isCtrlPressed;

        this.snapInteraction.setActive(snapActive);

        if (this.state.mode === 'delete') {
            this.elements.snapStatus.textContent = 'Magnete: OFF in modalita elimina.';
            return;
        }

        if (this.state.isCtrlPressed) {
            this.elements.snapStatus.textContent = 'Magnete: OFF (Ctrl premuto).';
            return;
        }

        this.elements.snapStatus.textContent = 'Magnete: ON. Tieni premuto Ctrl per disattivarlo temporaneamente.';
    }

    handleFeatureSelection(event) {
        const selectedFeature = event.selected[0] || null;

        if (!selectedFeature) {
            this.state.selectedFeature = null;
            this.layers.vector.changed();
            this.updateSummary();
            return;
        }

        if (this.state.mode === 'delete') {
            this.vectorSource.removeFeature(selectedFeature);
            this.clearSelection();
            this.setToolbarMessage('Area eliminata.');
            return;
        }

        this.state.selectedFeature = selectedFeature;
        this.layers.vector.changed();
        this.updateSummary();
        this.setToolbarMessage(`${selectedFeature.get('featureName')} selezionata.`);
    }

    clearSelection() {
        this.state.selectedFeature = null;
        this.selectInteraction.getFeatures().clear();
        this.layers.vector.changed();
        this.updateSummary();
    }

    decorateFeature(feature) {
        const existingFeatureId = feature.get('featureId');
        const geometryType = feature.getGeometry()?.getType();
        const isArea = geometryType === 'Polygon' || geometryType === 'MultiPolygon';
        const isLine = geometryType === 'LineString' || geometryType === 'MultiLineString';
        const lineType = feature.get('measurementType') || 'polyline';

        const defaultLabelPrefix = isArea
            ? 'Area'
            : (lineType === 'straight' ? 'Retta' : 'Polyline');

        if (!existingFeatureId) {
            feature.set('featureId', `area-${this.state.nextFeatureId}`);
            feature.set('featureName', `${defaultLabelPrefix} ${this.state.nextFeatureId}`);

            if (isLine && !feature.get('measurementType')) {
                feature.set('measurementType', 'polyline');
            }

            this.state.nextFeatureId += 1;
            return;
        }

        const parsedFeatureId = Number.parseInt(String(existingFeatureId).replace('area-', ''), 10);
        if (!feature.get('featureName')) {
            const fallbackIndex = Number.isFinite(parsedFeatureId) ? parsedFeatureId : this.state.nextFeatureId;
            feature.set('featureName', `${defaultLabelPrefix} ${fallbackIndex}`);
        }

        if (isLine && !feature.get('measurementType')) {
            feature.set('measurementType', 'polyline');
        }

        const nameMatch = /^Area\s+(\d+)$/i.exec(String(feature.get('featureName') || ''));
        const parsedNameId = nameMatch ? Number.parseInt(nameMatch[1], 10) : NaN;
        const nextCandidate = Math.max(
            Number.isFinite(parsedFeatureId) ? parsedFeatureId + 1 : 0,
            Number.isFinite(parsedNameId) ? parsedNameId + 1 : 0,
            this.vectorSource.getFeatures().length + 2,
        );
        this.state.nextFeatureId = Math.max(this.state.nextFeatureId, nextCandidate);
    }

    schedulePersistenceSync() {
        if (this.state.persistenceMuted) {
            return;
        }

        if (this.state.persistenceSaveTimeoutId) {
            window.clearTimeout(this.state.persistenceSaveTimeoutId);
        }

        this.state.persistenceSaveTimeoutId = window.setTimeout(() => {
            this.state.persistenceSaveTimeoutId = null;
            this.persistFeatures();
        }, PERSISTENCE_SAVE_DELAY_MS);
    }

    persistFeatures() {
        if (this.state.persistenceMuted) {
            return;
        }

        try {
            const features = this.vectorSource.getFeatures();

            if (!features.length) {
                window.localStorage.removeItem(LOCAL_STORAGE_KEY);
                return;
            }

            const payload = {
                version: LOCAL_STORAGE_SCHEMA_VERSION,
                savedAt: new Date().toISOString(),
                features: this.geoJsonFormat.writeFeaturesObject(features, {
                    dataProjection: 'EPSG:4326',
                    featureProjection: 'EPSG:3857',
                    decimals: 6,
                }),
            };

            window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.error('Persistenza localStorage fallita:', error);
        }
    }

    restorePersistedFeatures() {
        try {
            const rawPayload = window.localStorage.getItem(LOCAL_STORAGE_KEY);

            if (!rawPayload) {
                return;
            }

            const payload = JSON.parse(rawPayload);
            if (payload.version !== LOCAL_STORAGE_SCHEMA_VERSION || !payload.features) {
                throw new Error('Schema persistenza non compatibile.');
            }

            const restoredFeatures = this.geoJsonFormat.readFeatures(payload.features, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857',
            }).filter((feature) => SUPPORTED_GEOMETRY_TYPES.has(feature.getGeometry()?.getType()));

            if (!restoredFeatures.length) {
                window.localStorage.removeItem(LOCAL_STORAGE_KEY);
                return;
            }

            this.state.persistenceMuted = true;
            try {
                restoredFeatures.forEach((feature) => this.decorateFeature(feature));
                this.vectorSource.addFeatures(restoredFeatures);
            } finally {
                this.state.persistenceMuted = false;
            }

            this.updateSummary();
            this.fitToFeatures();
            this.setToolbarMessage(`${restoredFeatures.length} aree ripristinate dal salvataggio locale.`);
        } catch (error) {
            console.error('Ripristino localStorage fallito:', error);
            window.localStorage.removeItem(LOCAL_STORAGE_KEY);
            this.state.persistenceMuted = false;
        }
    }

    calculateArea(feature) {
        const geometry = feature.getGeometry();
        const geometryType = geometry?.getType();
        if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
            return 0;
        }

        return ol.sphere.getArea(geometry, { projection: this.view.getProjection() });
    }

    formatArea(squareMeters) {
        return `${(squareMeters / 10000).toFixed(4)} ha`;
    }

    calculatePerimeter(feature) {
        const geometry = feature.getGeometry();
        const geometryType = geometry?.getType();

        if (geometryType === 'Polygon') {
            const outerRing = geometry.getLinearRing(0);
            if (!outerRing) {
                return 0;
            }

            return ol.sphere.getLength(new ol.geom.LineString(outerRing.getCoordinates()), {
                projection: this.view.getProjection(),
            });
        }

        if (geometryType === 'MultiPolygon') {
            return geometry.getPolygons().reduce((sum, polygon) => {
                const outerRing = polygon.getLinearRing(0);
                if (!outerRing) {
                    return sum;
                }

                return sum + ol.sphere.getLength(new ol.geom.LineString(outerRing.getCoordinates()), {
                    projection: this.view.getProjection(),
                });
            }, 0);
        }

        return 0;
    }

    calculateLength(feature) {
        const geometry = feature.getGeometry();
        const geometryType = geometry?.getType();
        if (geometryType !== 'LineString' && geometryType !== 'MultiLineString') {
            return 0;
        }

        return ol.sphere.getLength(geometry, { projection: this.view.getProjection() });
    }

    formatLength(meters) {
        if (meters >= 1000) {
            return `${(meters / 1000).toFixed(3)} km`;
        }

        return `${meters.toFixed(2)} m`;
    }

    formatPerimeter(meters) {
        return this.formatLength(meters);
    }

    getFeatureLabelGeometry(feature) {
        const geometry = feature.getGeometry();
        const geometryType = geometry?.getType();

        if (geometryType === 'Polygon') {
            return geometry.getInteriorPoint();
        }

        if (geometryType === 'MultiPolygon') {
            const polygons = geometry.getPolygons();
            if (!polygons.length) {
                return null;
            }

            const largestPolygon = polygons.reduce((largest, current) => {
                return current.getArea() > largest.getArea() ? current : largest;
            });

            return largestPolygon.getInteriorPoint();
        }

        if (geometryType === 'LineString') {
            const geometryLength = geometry.getLength();
            if (!geometryLength) {
                return null;
            }

            return new ol.geom.Point(geometry.getCoordinateAt(0.5));
        }

        if (geometryType === 'MultiLineString') {
            const lineStrings = geometry.getLineStrings();
            if (!lineStrings.length) {
                return null;
            }

            const longestLine = lineStrings.reduce((longest, current) => {
                return current.getLength() > longest.getLength() ? current : longest;
            });

            if (!longestLine.getLength()) {
                return null;
            }

            return new ol.geom.Point(longestLine.getCoordinateAt(0.5));
        }

        return null;
    }

    featureStyle(feature) {
        const isSelected = this.state.selectedFeature === feature;
        const geometryType = feature.getGeometry()?.getType();
        const isArea = geometryType === 'Polygon' || geometryType === 'MultiPolygon';
        const isLine = geometryType === 'LineString' || geometryType === 'MultiLineString';
        const nameLabel = feature.get('featureName') || 'Area';
        const areaLabel = this.formatArea(this.calculateArea(feature));
        const perimeterLabel = this.formatPerimeter(this.calculatePerimeter(feature));
        const lengthLabel = this.formatLength(this.calculateLength(feature));
        const measureLabel = isArea
            ? `${areaLabel}\nPerim: ${perimeterLabel}`
            : lengthLabel;
        const labelGeometry = this.getFeatureLabelGeometry(feature);
        const styles = [
            new ol.style.Style({
                fill: new ol.style.Fill({
                    color: isArea
                        ? (isSelected ? 'rgba(255, 227, 138, 0.2)' : 'rgba(19, 74, 55, 0.28)')
                        : 'rgba(0, 0, 0, 0)',
                }),
                stroke: new ol.style.Stroke({
                    color: isLine
                        ? (isSelected ? '#ffe38a' : '#7bc7ff')
                        : (isSelected ? '#ffe38a' : '#73f0bf'),
                    width: isSelected ? 4 : 3,
                    lineDash: isLine ? [8, 6] : undefined,
                }),
            }),
        ];

        if (labelGeometry) {
            styles.push(new ol.style.Style({
                geometry: labelGeometry,
                text: new ol.style.Text({
                    text: `${nameLabel}\n${measureLabel}`,
                    textAlign: 'center',
                    justify: 'center',
                    font: '700 14px Aptos, "Segoe UI Variable", sans-serif',
                    fill: new ol.style.Fill({ color: '#ffffff' }),
                    stroke: new ol.style.Stroke({ color: 'rgba(4, 12, 10, 0.95)', width: 4 }),
                }),
            }));
        }

        return styles;
    }

    updateSummary() {
        const features = this.vectorSource.getFeatures();
        const areaFeatures = features.filter((feature) => {
            const geometryType = feature.getGeometry()?.getType();
            return geometryType === 'Polygon' || geometryType === 'MultiPolygon';
        });
        const totalArea = areaFeatures.reduce((sum, feature) => sum + this.calculateArea(feature), 0);
        const totalPerimeter = areaFeatures.reduce((sum, feature) => sum + this.calculatePerimeter(feature), 0);
        const selectedGeometryType = this.state.selectedFeature?.getGeometry()?.getType();
        const selectedMeasure = !this.state.selectedFeature
            ? 'Nessuna'
            : ((selectedGeometryType === 'Polygon' || selectedGeometryType === 'MultiPolygon')
                ? `${this.formatArea(this.calculateArea(this.state.selectedFeature))} | Perim: ${this.formatPerimeter(this.calculatePerimeter(this.state.selectedFeature))}`
                : this.formatLength(this.calculateLength(this.state.selectedFeature)));
        const zoom = this.view.getZoom() || 0;

        this.elements.statCount.textContent = String(areaFeatures.length);
        this.elements.statTotalArea.textContent = this.formatArea(totalArea);
        this.elements.statTotalPerimeter.textContent = this.formatPerimeter(totalPerimeter);
        this.elements.statSelectedArea.textContent = selectedMeasure;
        this.elements.statZoom.textContent = zoom.toFixed(1);
    }

    duplicateSelectedArea() {
        if (!this.state.selectedFeature) {
            alert('Seleziona prima un\'area da duplicare.');
            return;
        }

        const selectedGeometryType = this.state.selectedFeature.getGeometry()?.getType();
        const isArea = selectedGeometryType === 'Polygon' || selectedGeometryType === 'MultiPolygon';

        if (!isArea) {
            alert('La duplicazione e disponibile solo per aree poligonali.');
            return;
        }

        const duplicatedFeature = this.state.selectedFeature.clone();
        const duplicatedGeometry = duplicatedFeature.getGeometry();

        if (!duplicatedGeometry) {
            return;
        }

        const resolution = this.view.getResolution() || 1;
        const offset = resolution * 24;
        duplicatedGeometry.translate(offset, -offset);

        duplicatedFeature.unset('featureId', true);
        duplicatedFeature.unset('featureName', true);

        this.decorateFeature(duplicatedFeature);
        this.vectorSource.addFeature(duplicatedFeature);

        this.state.selectedFeature = duplicatedFeature;
        this.layers.vector.changed();

        const selectedFeatures = this.selectInteraction.getFeatures();
        selectedFeatures.clear();
        selectedFeatures.push(duplicatedFeature);

        this.updateSummary();
        this.setToolbarMessage('Area duplicata con successo.');
    }

    setToolbarMessage(message) {
        this.elements.status.textContent = message;
    }

    deleteSelectedFeature() {
        if (!this.state.selectedFeature) {
            alert('Seleziona prima un poligono oppure entra in modalita elimina.');
            return;
        }

        this.vectorSource.removeFeature(this.state.selectedFeature);
        this.clearSelection();
        this.setToolbarMessage('Feature selezionata eliminata.');
    }

    clearAllFeatures() {
        if (!this.vectorSource.getFeatures().length) {
            this.setToolbarMessage('Nessuna area da eliminare.');
            return;
        }

        const confirmed = window.confirm('Vuoi rimuovere tutte le aree disegnate o importate?');
        if (!confirmed) {
            return;
        }

        this.vectorSource.clear();
        this.clearSelection();
        this.setToolbarMessage('Tutte le aree sono state rimosse.');
    }

    exportFeatures() {
        const features = this.vectorSource.getFeatures();

        if (!features.length) {
            alert('Non ci sono aree da esportare.');
            return;
        }

        const exportFormat = this.elements.exportFormat.value;
        const exportConfig = this.buildExportConfig(features, exportFormat);
        const blob = new Blob([exportConfig.payload], { type: exportConfig.mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `planimeter-${new Date().toISOString().slice(0, 10)}.${exportConfig.extension}`;
        link.click();
        URL.revokeObjectURL(url);
        this.setToolbarMessage(`Esportazione ${exportConfig.label} completata.`);
    }

    buildExportConfig(features, exportFormat) {
        if (exportFormat === 'kml') {
            return {
                payload: this.kmlFormat.writeFeatures(features, {
                    featureProjection: 'EPSG:3857',
                }),
                mimeType: 'application/vnd.google-earth.kml+xml;charset=utf-8',
                extension: 'kml',
                label: 'KML',
            };
        }

        return {
            payload: this.geoJsonFormat.writeFeatures(features, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857',
                decimals: 6,
            }),
            mimeType: 'application/geo+json;charset=utf-8',
            extension: 'geojson',
            label: 'GeoJSON',
        };
    }

    detectImportFormat(fileName, content) {
        const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        if (SUPPORTED_IMPORT_EXTENSIONS.has(extension)) {
            return extension === 'kml' ? 'kml' : 'geojson';
        }

        const trimmed = content.trim();
        if (trimmed.startsWith('<')) {
            return 'kml';
        }

        return 'geojson';
    }

    readImportedFeatures(content, importFormat) {
        if (importFormat === 'kml') {
            return this.kmlFormat.readFeatures(content, {
                featureProjection: 'EPSG:3857',
            });
        }

        return this.geoJsonFormat.readFeatures(content, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
        });
    }

    importFeatures(event) {
        const [file] = event.target.files;

        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const importFormat = this.detectImportFormat(file.name, String(reader.result));
                const importedFeatures = this.readImportedFeatures(String(reader.result), importFormat)
                    .filter((feature) => SUPPORTED_GEOMETRY_TYPES.has(feature.getGeometry()?.getType()));

                if (!importedFeatures.length) {
                    throw new Error('Il file non contiene geometrie valide di tipo Polygon o MultiPolygon in formato GeoJSON o KML.');
                }

                importedFeatures.forEach((feature) => this.decorateFeature(feature));
                this.vectorSource.addFeatures(importedFeatures);
                this.fitToFeatures();
                this.setToolbarMessage(`${importedFeatures.length} aree importate da ${file.name} (${importFormat.toUpperCase()}).`);
            } catch (error) {
                console.error('Import GeoJSON fallito:', error);
                alert('Import non riuscito. Verifica che il file sia un GeoJSON o KML valido con feature Polygon o MultiPolygon.');
            } finally {
                event.target.value = '';
                this.updateSummary();
            }
        };

        reader.readAsText(file);
    }

    fitToFeatures() {
        if (!this.vectorSource.getFeatures().length) {
            return;
        }

        this.view.fit(this.vectorSource.getExtent(), {
            padding: [80, 80, 80, 80],
            duration: 900,
            maxZoom: 18,
        });
    }

    geolocate() {
        if (!navigator.geolocation) {
            alert('Questo browser non supporta la geolocalizzazione.');
            return;
        }

        const originalLabel = this.elements.locateButton.textContent;
        this.elements.locateButton.disabled = true;
        this.elements.locateButton.textContent = 'Ricerca...';

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const coordinates = [position.coords.longitude, position.coords.latitude];
                this.view.animate({
                    center: ol.proj.fromLonLat(coordinates),
                    zoom: 18,
                    duration: 1800,
                });
                this.setToolbarMessage('Posizione trovata e vista aggiornata.');
                this.resetLocateButton(originalLabel);
            },
            (error) => {
                console.error('Errore GPS:', error);
                alert('Impossibile ottenere la posizione. Verifica i permessi del browser.');
                this.resetLocateButton(originalLabel);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0,
            }
        );
    }

    resetLocateButton(label) {
        this.elements.locateButton.disabled = false;
        this.elements.locateButton.textContent = label;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new Planimeter();
});