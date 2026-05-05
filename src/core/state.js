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
    };
}
