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
const LOCAL_STORAGE_KEY_PREV = `${LOCAL_STORAGE_KEY}.prev`;
const MAX_FEATURE_BBOX_DIAGONAL_METERS = 100_000;

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

        // Geometry validation: skip features whose bbox is out of EPSG:4326
        // bounds or whose diagonal exceeds MAX_FEATURE_BBOX_DIAGONAL_METERS.
        // Defends against corrupted geometries from mid-drag persistence races.
        const originalCount = featuresObject.features.length;
        featuresObject.features = featuresObject.features.filter((f) => {
            if (isFeatureGeometryValid(f)) return true;
            console.warn('Persistence: skipping invalid feature geometry',
                f?.properties?.uuid ?? '<no-uuid>');
            return false;
        });
        if (featuresObject.features.length !== originalCount) {
            console.warn(`Persistence: dropped ${originalCount - featuresObject.features.length} invalid feature(s) at save time.`);
        }

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
 * Pull campaign store from backend local mirror.
 *
 * Behavior matrix (P2):
 * - local empty + mirror empty → no-op.
 * - local empty + mirror non-empty:
 *     - if `options.onPromptEmptyLocal` is provided, defer to UI prompt
 *       (modal: load backup / start fresh / cancel). The callback receives
 *       `{ apply, dismiss, incomingStore, incomingCount }`.
 *     - otherwise auto-apply (legacy behavior).
 * - local non-empty + mirror newer non-empty:
 *     - if `options.onBannerMirrorNewer` is provided, defer to UI banner
 *       (non-intrusive, default = ignore). Callback receives same shape.
 *     - otherwise auto-apply (legacy behavior).
 * - local non-empty + mirror older/same → no-op.
 *
 * Anti-wipe guard inside `isIncomingStoreNewer` still blocks empty-mirror
 * overwriting non-empty local in any path.
 *
 * @param {object} state
 * @param {import('ol/source/Vector').default} vectorSource
 * @param {import('ol/source/Vector').default} pertenenzaSource
 * @param {(count: number) => void} [onRestored]
 * @param {{ onPromptEmptyLocal?: Function, onBannerMirrorNewer?: Function }} [options]
 */
export async function syncPersistenceFromLocalMirror(state, vectorSource, pertenenzaSource, onRestored = () => {}, options = {}) {
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
        const incomingCount = countCampaignStoreFeatures(incomingStore);
        const localCount = countCampaignStoreFeatures(localStore);

        const emitOk = () => emitLocalMirrorStatus('ok', {
            source: 'load',
            savedAt: incomingStore?.savedAt ?? payload?.store?.savedAt ?? null,
        });

        const apply = () => {
            state.activeCampaignId = incomingStore.activeCampaignId ?? null;
            window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(incomingStore));
            restoreFromCampaignStore(incomingStore, state, vectorSource, pertenenzaSource, onRestored);
            emitOk();
        };

        if (!isIncomingStoreNewer(incomingStore, localStore)) {
            emitOk();
            return false;
        }

        // Empty local + non-empty mirror → prompt user when handler is wired.
        if (localCount === 0 && incomingCount > 0 && typeof options.onPromptEmptyLocal === 'function') {
            emitOk();
            options.onPromptEmptyLocal({
                apply,
                dismiss: () => {},
                incomingStore,
                incomingCount,
            });
            return false;
        }

        // Non-empty local + newer non-empty mirror → non-intrusive banner.
        if (localCount > 0 && incomingCount > 0 && typeof options.onBannerMirrorNewer === 'function') {
            emitOk();
            options.onBannerMirrorNewer({
                apply,
                dismiss: () => {},
                incomingStore,
                incomingCount,
            });
            return false;
        }

        apply();
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
        snapshotLastKnownGood();
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
    // Anti-wipe guard: never overwrite a non-empty local store with an empty
    // incoming one, regardless of savedAt. Handles the race where a second
    // tab cleared the mirror while the first tab still has data in memory.
    const incomingCount = countCampaignStoreFeatures(incomingStore);
    const localCount = countCampaignStoreFeatures(localStore);
    if (incomingCount === 0 && localCount > 0) return false;

    const incomingTs = toEpochMs(incomingStore?.savedAt);
    const localTs = toEpochMs(localStore?.savedAt);
    return incomingTs > localTs;
}

function countCampaignStoreFeatures(store) {
    let n = 0;
    for (const campaign of store?.campaigns ?? []) {
        n += campaign?.features?.features?.length ?? 0;
    }
    return n;
}

function snapshotLastKnownGood() {
    try {
        const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
        if (raw) window.localStorage.setItem(LOCAL_STORAGE_KEY_PREV, raw);
    } catch {
        // Quota or storage unavailable: do not block restore on snapshot failure.
    }
}

function collectGeoJsonCoordinates(geometry) {
    const out = [];
    const visit = (node) => {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'number') { out.push(node); return; }
        for (const child of node) visit(child);
    };
    visit(geometry?.coordinates);
    return out;
}

function haversineMeters(lon1, lat1, lon2, lat2) {
    const R = 6_371_000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function isFeatureGeometryValid(feature) {
    const coords = collectGeoJsonCoordinates(feature?.geometry);
    if (!coords.length) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        if (x < -180 || x > 180 || y < -90 || y > 90) return false;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    const diag = haversineMeters(minX, minY, maxX, maxY);
    if (!Number.isFinite(diag) || diag > MAX_FEATURE_BBOX_DIAGONAL_METERS) return false;
    return true;
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
