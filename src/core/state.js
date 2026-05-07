import { DEFAULT_CATASTO_WMS_LAYER_SETTINGS } from './constants.js';

/** Factory — returns a fresh state object for each Planimeter instance. */
export function createInitialState() {
    return {
        mode: 'draw',
        nextFeatureId: 1,
        selectedFeature: null,
        catastoSource: 'official',
        drawLockTimeoutId: null,
        isCtrlPressed: false,
        isDrawing: false,
        proxyHealthStatus: 'checking',
        proxyHealthMessage: '',
        proxyHealthRequestPending: false,
        proxyHealthIntervalId: null,
        persistenceSaveTimeoutId: null,
        persistenceMuted: false,
        locale: 'it',
        unitSystem: 'metric',
        toolbarPanel: 'operate',
        activeBaseLayer: 'sat',
        activeAdminLayer: null,
        catastoWmsLayerSettings: structuredClone(DEFAULT_CATASTO_WMS_LAYER_SETTINGS),
        parcelInfoEnabled: false,
        exportImageQuality: 'standard',
        cacheTtlDays: 30,
        cacheSizeMb: 500,
        parcelInfoLoading: false,
        parcelInfoHtml: null,
        parcelInfoStatusKey: 'parcelInfo.disabled',
        parcelInfoAnchorPixel: null,
        parcelInfoPopoverDismissed: false,
        suppressNextParcelInfoClick: false,
    };
}
