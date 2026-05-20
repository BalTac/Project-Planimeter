import GeoJSON from 'ol/format/GeoJSON.js';
import {
    LOCAL_STORAGE_KEY,
    LOCAL_STORAGE_SCHEMA_VERSION,
    PERSISTENCE_SAVE_DELAY_MS,
    SUPPORTED_GEOMETRY_TYPES,
} from '../core/constants.js';
import { decorateFeature } from '../geometry/decorate.js';

const geoJsonFormat = new GeoJSON();
const DEFAULT_CAMPAIGN_SEASON = 'annual';
const LOCAL_STATE_LOAD_ENDPOINT = '/local-state-load';
const LOCAL_STATE_SAVE_ENDPOINT = '/local-state-save';

let localMirrorSaveTimeoutId = null;
let lastLocalMirrorSavedAt = null;
let localMirrorStatusListener = null;

/**
 * Subscribe to local mirror status updates.
 * @param {(event: {status: 'checking'|'ok'|'degraded'|'offline', savedAt?: string|null, source?: string|null}) => void | null} listener
 */
export function setLocalMirrorStatusListener(listener) {
    localMirrorStatusListener = typeof listener === 'function' ? listener : null;
}

/**
 * @typedef {Object} CampaignSnapshot
 * @property {string} id
 * @property {string} label
 * @property {number} year
 * @property {string} season
 * @property {string} savedAt
 * @property {object} features
 */

/**
 * @typedef {Object} CampaignStore
 * @property {number} version
 * @property {string|null} activeCampaignId
 * @property {string} savedAt
 * @property {CampaignSnapshot[]} campaigns
 */

/**
 * Schedule a debounced save of vector sources to localStorage.
 * @param {object} state             — mutable app state slice
 * @param {...import('ol/source/Vector').default} vectorSources
 */
export function schedulePersistenceSync(state, ...vectorSources) {
    if (state.persistenceMuted) return;
    if (state.persistenceSaveTimeoutId) {
        window.clearTimeout(state.persistenceSaveTimeoutId);
    }
    state.persistenceSaveTimeoutId = window.setTimeout(() => {
        state.persistenceSaveTimeoutId = null;
        persistFeatures(state, ...vectorSources);
    }, PERSISTENCE_SAVE_DELAY_MS);
}

/**
 * Immediately serialise all features to localStorage.
 * No-op when persistenceMuted is true.
 */
export function persistFeatures(state, ...vectorSources) {
    if (state.persistenceMuted) return;
    try {
        const features = vectorSources.flatMap((source) => source?.getFeatures?.() ?? []);
        const featuresObject = geoJsonFormat.writeFeaturesObject(features, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
            decimals: 6,
        });

        const store = loadCampaignStore();
        const campaign = buildActiveCampaign(state, featuresObject);
        const idx = store.campaigns.findIndex((c) => c.id === campaign.id);
        if (idx >= 0) {
            store.campaigns[idx] = campaign;
        } else {
            store.campaigns.push(campaign);
        }
        store.version = LOCAL_STORAGE_SCHEMA_VERSION;
        store.activeCampaignId = campaign.id;
        store.savedAt = campaign.savedAt;

        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(store));
        scheduleLocalMirrorSave(store);
    } catch (err) {
        console.error('Persistence save failed:', err);
    }
}

/**
 * Restore features from localStorage into vector sources.
 * Calls onRestored(count) on success; silently removes corrupt data.
 *
 * @param {object} state
 * @param {import('ol/source/Vector').default} vectorSource
 * @param {import('ol/source/Vector').default} pertenenzaSource
 * @param {import('ol/View').default} view            — used for fitToFeatures (passed to onRestored)
 * @param {(count: number) => void} onRestored
 */
export function restorePersistedFeatures(state, vectorSource, pertenenzaSource, view, onRestored) {
    try {
        const store = loadCampaignStore();
        if (!store.campaigns.length) return;
        restoreFromCampaignStore(store, state, vectorSource, pertenenzaSource, onRestored);
    } catch (err) {
        console.error('Persistence restore failed:', err);
        state.persistenceMuted = false;
    }
}

/**
 * Pull campaign store from backend local mirror and apply it when newer than localStorage.
 */
export async function syncPersistenceFromLocalMirror(state, vectorSource, pertenenzaSource, onRestored = () => {}) {
    if (typeof window.fetch !== 'function') {
        emitLocalMirrorStatus('offline', { source: 'fetch-unavailable' });
        return false;
    }
    emitLocalMirrorStatus('checking', { source: 'load' });
    try {
        const response = await window.fetch(LOCAL_STATE_LOAD_ENDPOINT, {
            method: 'GET',
            cache: 'no-store',
            headers: {
                'Accept': 'application/json',
            },
        });
        if (!response.ok) {
            emitLocalMirrorStatus('degraded', { source: 'load' });
            return false;
        }

        const payload = await response.json();
        if (!payload || payload.ok !== true || !payload.store || typeof payload.store !== 'object') {
            emitLocalMirrorStatus('degraded', { source: 'load' });
            return false;
        }

        const incomingStore = normalizeCampaignStore(payload.store);
        const localStore = loadCampaignStore();
        if (!isIncomingStoreNewer(incomingStore, localStore)) {
            emitLocalMirrorStatus('ok', {
                source: 'load',
                savedAt: incomingStore?.savedAt ?? payload?.store?.savedAt ?? null,
            });
            return false;
        }

        state.activeCampaignId = incomingStore.activeCampaignId ?? null;
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(incomingStore));
        restoreFromCampaignStore(incomingStore, state, vectorSource, pertenenzaSource, onRestored);
        emitLocalMirrorStatus('ok', {
            source: 'load',
            savedAt: incomingStore?.savedAt ?? payload?.store?.savedAt ?? null,
        });
        return true;
    } catch (err) {
        console.warn('Local mirror sync failed:', err);
        emitLocalMirrorStatus('degraded', { source: 'load' });
        return false;
    }
}

/**
 * Return historical feature matches at a lon/lat point across all campaigns.
 *
 * @param {[number, number]} lonLat
 * @returns {Array<object>}
 */
export function historyAtPoint(lonLat) {
    const store = loadCampaignStore();
    const out = [];
    for (const campaign of store.campaigns) {
        for (const feature of campaign.features?.features ?? []) {
            if (!isPointInGeometry(lonLat, feature?.geometry)) continue;
            out.push(toHistoryRecord(campaign, feature));
        }
    }
    return sortHistoryRecords(out);
}

/**
 * Return historical feature matches linked to a cadastral parcel across campaigns.
 *
 * @param {string} parcelId
 * @returns {Array<object>}
 */
export function historyAtParcel(parcelId) {
    const needle = String(parcelId || '').trim();
    if (!needle) return [];

    const store = loadCampaignStore();
    const out = [];
    for (const campaign of store.campaigns) {
        for (const feature of campaign.features?.features ?? []) {
            const links = feature?.properties?.links?.cadastral;
            if (!Array.isArray(links)) continue;
            if (!links.some((entry) => String(entry?.parcel_id || '') === needle)) continue;
            out.push(toHistoryRecord(campaign, feature, needle));
        }
    }
    return sortHistoryRecords(out);
}

function createEmptyFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function scheduleLocalMirrorSave(store) {
    if (typeof window.fetch !== 'function') {
        emitLocalMirrorStatus('offline', { source: 'fetch-unavailable' });
        return;
    }

    const savedAt = String(store?.savedAt || '').trim();
    if (!savedAt || savedAt === lastLocalMirrorSavedAt) return;

    if (localMirrorSaveTimeoutId) {
        window.clearTimeout(localMirrorSaveTimeoutId);
    }

    localMirrorSaveTimeoutId = window.setTimeout(async () => {
        localMirrorSaveTimeoutId = null;
        try {
            const response = await window.fetch(LOCAL_STATE_SAVE_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ store }),
            });
            if (!response.ok) {
                emitLocalMirrorStatus('degraded', { source: 'save' });
                return;
            }
            lastLocalMirrorSavedAt = savedAt;
            emitLocalMirrorStatus('ok', { source: 'save', savedAt });
        } catch {
            // Keep browser-local persistence functional even if local mirror fails.
            emitLocalMirrorStatus('degraded', { source: 'save' });
        }
    }, 180);
}

function emitLocalMirrorStatus(status, meta = {}) {
    if (typeof localMirrorStatusListener === 'function') {
        localMirrorStatusListener({
            status,
            savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : null,
            source: typeof meta.source === 'string' ? meta.source : null,
        });
    }
}

function normalizeCampaignStore(rawStore) {
    const migrated = migrateLegacyPayload(rawStore);
    const campaigns = (migrated.campaigns ?? [])
        .map((c, idx) => sanitizeCampaign(c, idx))
        .filter(Boolean);

    return {
        version: LOCAL_STORAGE_SCHEMA_VERSION,
        activeCampaignId: migrated.activeCampaignId ?? campaigns.at(-1)?.id ?? null,
        savedAt: migrated.savedAt ?? new Date().toISOString(),
        campaigns,
    };
}

function restoreFromCampaignStore(store, state, vectorSource, pertenenzaSource, onRestored) {
    const activeCampaign = resolveActiveCampaign(store, state);
    if (!activeCampaign) return;

    state.activeCampaignId = activeCampaign.id;
    state.activeCampaignYear = activeCampaign.year;
    state.activeCampaignSeason = activeCampaign.season;

    const restored = geoJsonFormat
        .readFeatures(activeCampaign.features, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
        })
        .filter((f) => SUPPORTED_GEOMETRY_TYPES.has(f.getGeometry()?.getType()));

    state.persistenceMuted = true;
    try {
        vectorSource.clear();
        pertenenzaSource.clear();

        const userFeatures = [];
        const pertenenzaFeatures = [];

        restored.forEach((f, index) => {
            const targetSource = f.get('overlayLayer') === 'pertenenze' ? pertenenzaSource : vectorSource;
            decorateFeature(f, state, targetSource.getFeatures().length + index);
            if (targetSource === pertenenzaSource) {
                pertenenzaFeatures.push(f);
            } else {
                userFeatures.push(f);
            }
        });

        vectorSource.addFeatures(userFeatures);
        pertenenzaSource.addFeatures(pertenenzaFeatures);
    } finally {
        state.persistenceMuted = false;
    }

    onRestored(restored.length);
}

function toEpochMs(value) {
    const ts = Date.parse(String(value || ''));
    return Number.isFinite(ts) ? ts : 0;
}

function isIncomingStoreNewer(incomingStore, localStore) {
    const incomingTs = toEpochMs(incomingStore?.savedAt);
    const localTs = toEpochMs(localStore?.savedAt);
    return incomingTs > localTs;
}

/**
 * @returns {CampaignStore}
 */
function loadCampaignStore() {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return makeEmptyStore();

    const parsed = JSON.parse(raw);
    const migrated = migrateLegacyPayload(parsed);
    const campaigns = (migrated.campaigns ?? [])
        .map((c, idx) => sanitizeCampaign(c, idx))
        .filter(Boolean);

    return {
        version: LOCAL_STORAGE_SCHEMA_VERSION,
        activeCampaignId: migrated.activeCampaignId ?? campaigns.at(-1)?.id ?? null,
        savedAt: migrated.savedAt ?? new Date().toISOString(),
        campaigns,
    };
}

function makeEmptyStore() {
    return {
        version: LOCAL_STORAGE_SCHEMA_VERSION,
        activeCampaignId: null,
        savedAt: new Date().toISOString(),
        campaigns: [],
    };
}

function migrateLegacyPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Incompatible persistence schema.');
    }
    if (Array.isArray(payload.campaigns)) {
        return payload;
    }

    // Legacy fallback: direct FeatureCollection payload (no wrapper/version).
    if (payload.type === 'FeatureCollection' && Array.isArray(payload.features)) {
        payload = {
            version: 1,
            savedAt: new Date().toISOString(),
            features: payload,
        };
    }

    // Legacy fallback: wrapped payload with features but without explicit version.
    if (payload.features && typeof payload.version !== 'number') {
        payload = {
            ...payload,
            version: 1,
        };
    }

    if (!payload.features || typeof payload.version !== 'number') {
        throw new Error('Incompatible persistence schema.');
    }

    const migratedFeatures = migrateFeatures(payload.features);
    const now = payload.savedAt ?? new Date().toISOString();
    const year = Number.parseInt(String(now).slice(0, 4), 10) || new Date().getFullYear();
    const id = `legacy-${year}`;

    return {
        version: LOCAL_STORAGE_SCHEMA_VERSION,
        activeCampaignId: id,
        savedAt: now,
        campaigns: [{
            id,
            label: `Legacy ${year}`,
            year,
            season: DEFAULT_CAMPAIGN_SEASON,
            savedAt: now,
            features: migratedFeatures,
        }],
    };
}

function sanitizeCampaign(campaign, index) {
    if (!campaign || typeof campaign !== 'object') return null;

    const year = Number.parseInt(String(campaign.year), 10) || new Date().getFullYear();
    const season = String(campaign.season || DEFAULT_CAMPAIGN_SEASON).trim() || DEFAULT_CAMPAIGN_SEASON;
    const id = String(campaign.id || `${year}-${season}-${index + 1}`);
    const label = String(campaign.label || `${year} (${season})`);

    return {
        id,
        label,
        year,
        season,
        savedAt: String(campaign.savedAt || new Date().toISOString()),
        features: sanitizeFeatureCollection(campaign.features),
    };
}

function sanitizeFeatureCollection(featureCollection) {
    const out = featureCollection?.type === 'FeatureCollection'
        ? featureCollection
        : createEmptyFeatureCollection();
    out.features = (out.features ?? []).map((feature) => {
        const next = { ...feature };
        next.properties = next.properties ?? {};
        const props = next.properties;
        if (!props.uuid)      props.uuid      = crypto.randomUUID();
        if (!props.createdAt) props.createdAt = new Date().toISOString();
        if (!props.version)   props.version   = 1;
        if (!props.links)     props.links     = { cadastral: [] };
        return next;
    });
    return out;
}

function buildActiveCampaign(state, featureCollection) {
    const year = Number.parseInt(String(state.activeCampaignYear), 10) || new Date().getFullYear();
    const season = String(state.activeCampaignSeason || DEFAULT_CAMPAIGN_SEASON).trim() || DEFAULT_CAMPAIGN_SEASON;
    const id = String(state.activeCampaignId || `${year}-${season}`);
    const savedAt = new Date().toISOString();

    state.activeCampaignId = id;
    state.activeCampaignYear = year;
    state.activeCampaignSeason = season;

    return {
        id,
        label: `${year} (${season})`,
        year,
        season,
        savedAt,
        dslActiveDomainId: state.dslActiveDomainId ?? null,
        features: sanitizeFeatureCollection(featureCollection),
    };
}

function resolveActiveCampaign(store, state) {
    const preferredId = state.activeCampaignId || store.activeCampaignId;
    if (preferredId) {
        const hit = store.campaigns.find((c) => c.id === preferredId);
        if (hit && hasCampaignFeatures(hit)) return hit;
    }

    const newestNonEmpty = [...store.campaigns].reverse().find((c) => hasCampaignFeatures(c));
    if (newestNonEmpty) return newestNonEmpty;

    return store.campaigns.at(-1) ?? null;
}

function hasCampaignFeatures(campaign) {
    return Array.isArray(campaign?.features?.features) && campaign.features.features.length > 0;
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

function toHistoryRecord(campaign, feature, parcelId = null) {
    const props = feature?.properties ?? {};
    return {
        campaignId: campaign.id,
        campaignLabel: campaign.label,
        year: campaign.year,
        season: campaign.season,
        snapshotSavedAt: campaign.savedAt,
        featureId: props.featureId ?? null,
        featureName: props.featureName ?? null,
        featureUuid: props.uuid ?? null,
        dsl: props.dsl ?? null,
        parcelId,
    };
}

function sortHistoryRecords(records) {
    return records.sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year;
        return String(b.snapshotSavedAt).localeCompare(String(a.snapshotSavedAt));
    });
}

function isPointInGeometry(point, geometry) {
    if (!geometry || !Array.isArray(point) || point.length !== 2) return false;
    if (geometry.type === 'Polygon') {
        return isPointInPolygon(point, geometry.coordinates);
    }
    if (geometry.type === 'MultiPolygon') {
        return (geometry.coordinates ?? []).some((polygon) => isPointInPolygon(point, polygon));
    }
    return false;
}

function isPointInPolygon(point, polygonCoords) {
    if (!Array.isArray(polygonCoords) || polygonCoords.length === 0) return false;
    const [outer, ...holes] = polygonCoords;
    if (!isPointInRing(point, outer)) return false;
    return !holes.some((hole) => isPointInRing(point, hole));
}

function isPointInRing(point, ring) {
    if (!Array.isArray(ring) || ring.length < 4) return false;

    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];

        const intersect = ((yi > y) !== (yj > y))
            && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
