/**
 * History engine (P3 slice A) — undo/redo + manual snapshots + auto coalescing.
 *
 * Storage layout (localStorage key `planimeter.history.v1`):
 *
 *   {
 *     version: 1,
 *     byCampaign: {
 *       "<campaignId>": {
 *         cursor: number,          // index of the currently-active entry
 *         entries: [
 *           {
 *             id, ts, kind: "auto" | "manual",
 *             label, tags: string[],
 *             summary: { features, areaSqm },
 *             features: { type: "FeatureCollection", features: [...] }
 *           }
 *         ]
 *       }
 *     }
 *   }
 *
 * Photoshop semantics: when a new snapshot is recorded after one or more
 * undos, the "future" entries (cursor+1..end) are discarded.
 *
 * Snapshots are stored in clear (no lz-string yet). Retention drops the
 * oldest `auto` entries first when either `HISTORY_AUTO_RETENTION` or
 * `HISTORY_MAX_BYTES` is exceeded; manual entries are never auto-evicted.
 */

import GeoJSON from 'ol/format/GeoJSON.js';
import LZString from 'lz-string';
import {
    HISTORY_AUTO_RETENTION,
    HISTORY_COALESCE_MS,
    HISTORY_LOCAL_STORAGE_KEY,
    HISTORY_LOCAL_STORAGE_SCHEMA_VERSION,
    HISTORY_MAX_BYTES,
    SUPPORTED_GEOMETRY_TYPES,
} from '../core/constants.js';

const geoJsonFormat = new GeoJSON();

// ── Pub/sub ─────────────────────────────────────────────────────────────────
// Modules subscribe via HistoryEngine.subscribe(fn) to react to any mutation
// (UI popover refresh, backend mirror sync). Fired after the in-memory store
// is persisted to localStorage.
const _listeners = new Set();
function _emit(reason) {
    for (const fn of _listeners) {
        try { fn(reason); } catch (err) { console.warn('History listener failed', err); }
    }
}

function nowIso() {
    return new Date().toISOString();
}

function makeId() {
    // Compact, sortable-ish ID. Crypto-random suffix to avoid collisions
    // when two snapshots are recorded in the same millisecond.
    const rand = (typeof crypto !== 'undefined' && crypto.getRandomValues)
        ? Array.from(crypto.getRandomValues(new Uint8Array(6)),
            (b) => b.toString(16).padStart(2, '0')).join('')
        : Math.random().toString(16).slice(2, 14);
    return `h_${Date.now().toString(36)}_${rand}`;
}

function makeEmptyHistory() {
    return { version: HISTORY_LOCAL_STORAGE_SCHEMA_VERSION, byCampaign: {} };
}

function loadHistory() {
    try {
        const raw = window.localStorage.getItem(HISTORY_LOCAL_STORAGE_KEY);
        if (!raw) return makeEmptyHistory();
        const parsed = JSON.parse(raw);
        if (parsed?.version !== HISTORY_LOCAL_STORAGE_SCHEMA_VERSION) {
            return makeEmptyHistory();
        }
        if (!parsed.byCampaign || typeof parsed.byCampaign !== 'object') {
            parsed.byCampaign = {};
        }
        return parsed;
    } catch (err) {
        console.warn('History: load failed, resetting.', err);
        return makeEmptyHistory();
    }
}

function saveHistory(history) {
    try {
        window.localStorage.setItem(HISTORY_LOCAL_STORAGE_KEY, JSON.stringify(history));
    } catch (err) {
        console.warn('History: save failed (quota?).', err);
    }
}

function ensureCampaignBucket(history, campaignId) {
    const key = String(campaignId || '__default__');
    if (!history.byCampaign[key]) {
        history.byCampaign[key] = { cursor: -1, entries: [] };
    }
    return history.byCampaign[key];
}

function serializeFeatures(vectorSource, pertenenzaSource) {
    const all = [
        ...(vectorSource?.getFeatures?.() ?? []),
        ...(pertenenzaSource?.getFeatures?.() ?? []),
    ];
    return geoJsonFormat.writeFeaturesObject(all, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
        decimals: 6,
    });
}

/**
 * Compress a FeatureCollection to UTF-16 string (efficient localStorage
 * footprint). Returns null if compression fails — caller falls back to
 * embedding the raw object.
 */
function compressFeatures(fc) {
    try {
        const json = JSON.stringify(fc);
        const z = LZString.compressToUTF16(json);
        return z || null;
    } catch (err) {
        console.warn('History: compression failed.', err);
        return null;
    }
}

function decompressFeatures(z) {
    try {
        const json = LZString.decompressFromUTF16(z);
        if (!json) return null;
        return JSON.parse(json);
    } catch (err) {
        console.warn('History: decompression failed.', err);
        return null;
    }
}

/** Read either the compressed `featuresZ` or the legacy raw `features`. */
function readEntryFeatures(entry) {
    if (entry?.featuresZ) {
        return decompressFeatures(entry.featuresZ)
            || { type: 'FeatureCollection', features: [] };
    }
    return entry?.features ?? { type: 'FeatureCollection', features: [] };
}

function makeEntryPayload(fc) {
    const z = compressFeatures(fc);
    return z ? { featuresZ: z } : { features: fc };
}

function summarizeFeatureCollection(fc) {
    const features = fc?.features ?? [];
    let areaSqm = 0;
    for (const f of features) {
        const a = Number(f?.properties?.area_sqm);
        if (Number.isFinite(a)) areaSqm += a;
    }
    return { features: features.length, areaSqm: Math.round(areaSqm) };
}

function shapesEqual(a, b) {
    // Cheap structural equality on the serialized FeatureCollection. JSON
    // string comparison is enough: when nothing changed we want to skip
    // the snapshot to avoid filling history with identical entries.
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function approxBytes(history) {
    try {
        return JSON.stringify(history).length;
    } catch {
        return 0;
    }
}

/**
 * Drop oldest `auto` entries until both retention caps are respected.
 * Manual entries are never auto-evicted. The cursor is adjusted to point
 * to the same logical entry (or clamped to the last kept entry).
 */
function enforceRetention(bucket, history) {
    // Cap on auto count.
    let autoCount = bucket.entries.filter((e) => e.kind === 'auto').length;
    while (autoCount > HISTORY_AUTO_RETENTION) {
        const idx = bucket.entries.findIndex((e) => e.kind === 'auto');
        if (idx < 0) break;
        bucket.entries.splice(idx, 1);
        if (idx <= bucket.cursor) bucket.cursor -= 1;
        autoCount -= 1;
    }
    // Soft byte cap across the whole history payload.
    let guard = 0;
    while (approxBytes(history) > HISTORY_MAX_BYTES && guard < 1000) {
        const idx = bucket.entries.findIndex((e) => e.kind === 'auto');
        if (idx < 0) break;
        bucket.entries.splice(idx, 1);
        if (idx <= bucket.cursor) bucket.cursor -= 1;
        guard += 1;
    }
    if (bucket.cursor >= bucket.entries.length) {
        bucket.cursor = bucket.entries.length - 1;
    }
    if (bucket.cursor < -1) bucket.cursor = -1;
}

/**
 * Stateless API. All operations read/write `planimeter.history.v1` and
 * mutate the supplied OL sources directly when restoring.
 */
export const HistoryEngine = {
    /** Subscribe to mutations. Returns an unsubscribe function. */
    subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        _listeners.add(fn);
        return () => _listeners.delete(fn);
    },

    /**
     * Take an initial baseline snapshot for the campaign if its bucket is
     * empty. Idempotent: subsequent calls are no-ops once a baseline exists.
     */
    bootstrap(state, vectorSource, pertenenzaSource) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        if (bucket.entries.length === 0) {
            const fc = serializeFeatures(vectorSource, pertenenzaSource);
            bucket.entries.push({
                id: makeId(),
                ts: nowIso(),
                kind: 'auto',
                label: 'history.entry.auto.baseline',
                tags: [],
                summary: summarizeFeatureCollection(fc),
                ...makeEntryPayload(fc),
            });
            bucket.cursor = 0;
            saveHistory(history);
            _emit('bootstrap');
        } else {
            _emit('bootstrap');
        }
    },

    /**
     * Record a snapshot of the current OL sources.
     * @param {object} opts
     * @param {object} opts.state — active campaign id is read from here
     * @param {object} opts.vectorSource
     * @param {object} opts.pertenenzaSource
     * @param {"auto"|"manual"} [opts.kind="auto"]
     * @param {string} [opts.label]
     * @param {string[]} [opts.tags]
     * @returns {{ recorded: boolean, coalesced: boolean, entryId?: string }}
     */
    record({ state, vectorSource, pertenenzaSource, kind = 'auto', label = '', tags = [] }) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        const fc = serializeFeatures(vectorSource, pertenenzaSource);

        // Truncate any "future" entries (Photoshop semantics).
        if (bucket.cursor >= 0 && bucket.cursor < bucket.entries.length - 1) {
            bucket.entries = bucket.entries.slice(0, bucket.cursor + 1);
        }

        const current = bucket.entries[bucket.cursor];

        // Skip identical snapshots. Compare against the decoded current state
        // so compressed and raw payloads behave consistently.
        if (current && shapesEqual(readEntryFeatures(current), fc)) {
            return { recorded: false, coalesced: false };
        }

        // Coalesce: auto + same label + within window → overwrite current.
        if (kind === 'auto' && current && current.kind === 'auto' && current.label === label) {
            const ageMs = Date.now() - Date.parse(current.ts || 0);
            if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= HISTORY_COALESCE_MS) {
                current.ts = nowIso();
                current.summary = summarizeFeatureCollection(fc);
                delete current.features;
                delete current.featuresZ;
                Object.assign(current, makeEntryPayload(fc));
                enforceRetention(bucket, history);
                saveHistory(history);
                _emit('coalesce');
                return { recorded: true, coalesced: true, entryId: current.id };
            }
        }

        const entry = {
            id: makeId(),
            ts: nowIso(),
            kind,
            label,
            tags: Array.isArray(tags) ? tags.slice(0, 16).map(String) : [],
            summary: summarizeFeatureCollection(fc),
            ...makeEntryPayload(fc),
        };
        bucket.entries.push(entry);
        bucket.cursor = bucket.entries.length - 1;
        enforceRetention(bucket, history);
        saveHistory(history);
        _emit('record');
        return { recorded: true, coalesced: false, entryId: entry.id };
    },

    canUndo(state) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        return bucket.cursor > 0;
    },

    canRedo(state) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        return bucket.cursor >= 0 && bucket.cursor < bucket.entries.length - 1;
    },

    undo(state, vectorSource, pertenenzaSource) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        if (bucket.cursor <= 0) return { ok: false, reason: 'noPrevious' };
        bucket.cursor -= 1;
        const entry = bucket.entries[bucket.cursor];
        applyEntry(entry, state, vectorSource, pertenenzaSource);
        saveHistory(history);
        _emit('undo');
        return { ok: true, entry };
    },

    redo(state, vectorSource, pertenenzaSource) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        if (bucket.cursor < 0 || bucket.cursor >= bucket.entries.length - 1) {
            return { ok: false, reason: 'noNext' };
        }
        bucket.cursor += 1;
        const entry = bucket.entries[bucket.cursor];
        applyEntry(entry, state, vectorSource, pertenenzaSource);
        saveHistory(history);
        _emit('redo');
        return { ok: true, entry };
    },

    /**
     * Restore a specific entry by id, regardless of its position. Cursor is
     * moved to that entry; redo/undo stack remains intact (future entries
     * past the cursor stay reachable via Ctrl+Y until a new record arrives).
     */
    restoreById(entryId, state, vectorSource, pertenenzaSource) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        const idx = bucket.entries.findIndex((e) => e.id === entryId);
        if (idx < 0) return { ok: false, reason: 'notFound' };
        bucket.cursor = idx;
        applyEntry(bucket.entries[idx], state, vectorSource, pertenenzaSource);
        saveHistory(history);
        _emit('restoreById');
        return { ok: true, entry: bucket.entries[idx] };
    },

    /** Rename a single entry (manual snapshots — but allowed on any). */
    renameEntry(entryId, newLabel, state) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        const entry = bucket.entries.find((e) => e.id === entryId);
        if (!entry) return { ok: false, reason: 'notFound' };
        entry.label = String(newLabel || '').slice(0, 200);
        saveHistory(history);
        _emit('rename');
        return { ok: true };
    },

    /**
     * Delete a single entry. Cursor is adjusted; the baseline (index 0) is
     * protected so undo always has somewhere to land.
     */
    deleteEntry(entryId, state) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        const idx = bucket.entries.findIndex((e) => e.id === entryId);
        if (idx < 0) return { ok: false, reason: 'notFound' };
        if (idx === 0 && bucket.entries.length > 1) {
            return { ok: false, reason: 'baselineProtected' };
        }
        bucket.entries.splice(idx, 1);
        if (idx < bucket.cursor) bucket.cursor -= 1;
        if (bucket.cursor >= bucket.entries.length) {
            bucket.cursor = bucket.entries.length - 1;
        }
        saveHistory(history);
        _emit('delete');
        return { ok: true };
    },

    /** Export a single entry as a stand-alone GeoJSON FeatureCollection. */
    exportEntry(entryId, state) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        const entry = bucket.entries.find((e) => e.id === entryId);
        if (!entry) return null;
        return {
            entry: { id: entry.id, ts: entry.ts, kind: entry.kind, label: entry.label,
                tags: [...(entry.tags || [])], summary: { ...(entry.summary || {}) } },
            featureCollection: readEntryFeatures(entry),
        };
    },

    /**
     * Read-only snapshot of the per-campaign history bucket (defensive copy
     * for UI consumption). Returns `{ cursor: -1, entries: [] }` when empty.
     */
    inspect(state) {
        const history = loadHistory();
        const bucket = ensureCampaignBucket(history, state.activeCampaignId);
        return { cursor: bucket.cursor, entries: bucket.entries.map((e) => ({
            id: e.id, ts: e.ts, kind: e.kind, label: e.label,
            tags: [...(e.tags || [])], summary: { ...(e.summary || {}) },
        })) };
    },

    /** Raw store accessor for sync layers. Treat as read-only. */
    _dumpRaw() { return loadHistory(); },
    /** Replace the entire store; used by mirror restore. */
    _replaceRaw(store) {
        if (!store || store.version !== HISTORY_LOCAL_STORAGE_SCHEMA_VERSION) return false;
        saveHistory(store);
        _emit('replace');
        return true;
    },
};

/**
 * Replace the contents of the two OL sources with the features stored in
 * `entry`. Mirrors the persistence-side restore path so feature ids and
 * `overlayLayer` routing stay consistent.
 */
function applyEntry(entry, state, vectorSource, pertenenzaSource) {
    const fc = readEntryFeatures(entry);
    const restored = geoJsonFormat
        .readFeatures(fc, {
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
        for (const f of restored) {
            if (f.get('overlayLayer') === 'pertenenze') {
                pertenenzaFeatures.push(f);
            } else {
                userFeatures.push(f);
            }
        }
        vectorSource.addFeatures(userFeatures);
        pertenenzaSource.addFeatures(pertenenzaFeatures);
    } finally {
        state.persistenceMuted = false;
    }
}
