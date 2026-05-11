import GeoJSON from 'ol/format/GeoJSON.js';
import {
    LOCAL_STORAGE_KEY,
    LOCAL_STORAGE_SCHEMA_VERSION,
    PERSISTENCE_SAVE_DELAY_MS,
    SUPPORTED_GEOMETRY_TYPES,
} from '../core/constants.js';
import { decorateFeature } from '../geometry/decorate.js';

const geoJsonFormat = new GeoJSON();

/**
 * Schedule a debounced save of vectorSource features to localStorage.
 * @param {object} state             — mutable app state slice
 * @param {import('ol/source/Vector').default} vectorSource
 */
export function schedulePersistenceSync(state, vectorSource) {
    if (state.persistenceMuted) return;
    if (state.persistenceSaveTimeoutId) {
        window.clearTimeout(state.persistenceSaveTimeoutId);
    }
    state.persistenceSaveTimeoutId = window.setTimeout(() => {
        state.persistenceSaveTimeoutId = null;
        persistFeatures(state, vectorSource);
    }, PERSISTENCE_SAVE_DELAY_MS);
}

/**
 * Immediately serialise all features to localStorage.
 * No-op when persistenceMuted is true.
 */
export function persistFeatures(state, vectorSource) {
    if (state.persistenceMuted) return;
    try {
        const features = vectorSource.getFeatures();
        if (!features.length) {
            window.localStorage.removeItem(LOCAL_STORAGE_KEY);
            return;
        }
        const payload = {
            version: LOCAL_STORAGE_SCHEMA_VERSION,
            savedAt: new Date().toISOString(),
            features: geoJsonFormat.writeFeaturesObject(features, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857',
                decimals: 6,
            }),
        };
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
        console.error('Persistence save failed:', err);
    }
}

/**
 * Restore features from localStorage into vectorSource.
 * Calls onRestored(count) on success; silently removes corrupt data.
 *
 * @param {object} state
 * @param {import('ol/source/Vector').default} vectorSource
 * @param {import('ol/View').default} view            — used for fitToFeatures (passed to onRestored)
 * @param {(count: number) => void} onRestored
 */
export function restorePersistedFeatures(state, vectorSource, view, onRestored) {
    try {
        const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
        if (!raw) return;

        const payload = JSON.parse(raw);
        if (!payload.features || typeof payload.version !== 'number') {
            throw new Error('Incompatible persistence schema.');
        }
        // Migrate v1 → current schema in-place.
        if (payload.version < LOCAL_STORAGE_SCHEMA_VERSION) {
            payload.features = migrateFeatures(payload.features);
            payload.version = LOCAL_STORAGE_SCHEMA_VERSION;
        } else if (payload.version > LOCAL_STORAGE_SCHEMA_VERSION) {
            throw new Error('Persistence schema too new — please reload.');
        }

        const restored = geoJsonFormat
            .readFeatures(payload.features, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857',
            })
            .filter((f) => SUPPORTED_GEOMETRY_TYPES.has(f.getGeometry()?.getType()));

        if (!restored.length) {
            window.localStorage.removeItem(LOCAL_STORAGE_KEY);
            return;
        }

        state.persistenceMuted = true;
        try {
            restored.forEach((f) => decorateFeature(f, state, vectorSource.getFeatures().length));
            vectorSource.addFeatures(restored);
        } finally {
            state.persistenceMuted = false;
        }

        onRestored(restored.length);
    } catch (err) {
        console.error('Persistence restore failed:', err);
        window.localStorage.removeItem(LOCAL_STORAGE_KEY);
        state.persistenceMuted = false;
    }
}

/**
 * Upgrade a raw GeoJSON FeatureCollection from any previous schema version
 * to the current one by back-filling missing fields on each feature.
 *
 * @param {object} featureCollection — raw GeoJSON object
 * @returns {object}                 — mutated featureCollection
 */
function migrateFeatures(featureCollection) {
    const now = new Date().toISOString();
    for (const f of featureCollection?.features ?? []) {
        const p = f.properties ?? {};
        if (!p.uuid)      p.uuid      = crypto.randomUUID();
        if (!p.createdAt) p.createdAt = now;
        if (!p.version)   p.version   = 1;
        if (!p.links)     p.links     = { cadastral: [] };
        f.properties = p;
    }
    return featureCollection;
}
