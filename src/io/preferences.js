import {
    SETTINGS_LOCAL_STORAGE_KEY,
    SETTINGS_LOCAL_STORAGE_SCHEMA_VERSION,
} from '../core/constants.js';

export const DEFAULT_PREFERENCES = {
    locale: null,
    unitSystem: null,
    toolbarPanel: 'operate',
    catastoOpacity: 0.9,
    catastoWmsLayers: ['CP.CadastralParcel'],
    parcelInfoEnabled: false,
    exportImageQuality: 'standard',
    cacheTtlDays: 30,
    cacheSizeMb: 500,
};

export function loadPreferences() {
    try {
        const raw = window.localStorage.getItem(SETTINGS_LOCAL_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_PREFERENCES };
        const parsed = JSON.parse(raw);
        if (parsed?.version !== SETTINGS_LOCAL_STORAGE_SCHEMA_VERSION) {
            return { ...DEFAULT_PREFERENCES };
        }
        return {
            ...DEFAULT_PREFERENCES,
            ...(parsed.preferences || {}),
        };
    } catch {
        return { ...DEFAULT_PREFERENCES };
    }
}

export function savePreferences(preferences) {
    const payload = {
        version: SETTINGS_LOCAL_STORAGE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        preferences,
    };
    window.localStorage.setItem(SETTINGS_LOCAL_STORAGE_KEY, JSON.stringify(payload));
}
