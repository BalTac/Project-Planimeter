/**
 * History backend mirror (P3 slice B).
 *
 * Mirrors `planimeter.history.v1` localStorage to `.planimeter_history_store.json`
 * on the dev server, so a user can recover undo/redo history across browser
 * profiles or after wiping site data.
 *
 * Wire-up:
 *   import { initHistoryBackendSync } from './io/history-sync.js';
 *   initHistoryBackendSync(); // attaches to HistoryEngine.subscribe()
 *
 * The first call triggers a load attempt: if the local history is empty
 * (only baseline) and the mirror is non-empty, we adopt the mirror.
 */

import { HistoryEngine } from './history.js';

const SAVE_DEBOUNCE_MS = 1000;
let _saveTimer = null;
let _statusListener = null;
let _suspended = false;

function setStatus(state) {
    if (typeof _statusListener === 'function') {
        try { _statusListener(state); } catch (err) { console.warn('history-sync listener', err); }
    }
}

async function pushToMirror() {
    if (_suspended) return;
    const store = HistoryEngine._dumpRaw();
    const payload = { ...store, savedAt: new Date().toISOString() };
    try {
        const res = await fetch('/local-history-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store: payload }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setStatus({ ok: true, savedAt: payload.savedAt });
    } catch (err) {
        // Backend offline / sandbox / file:// — non-fatal, the local store
        // is still authoritative.
        setStatus({ ok: false, error: String(err?.message || err) });
    }
}

function scheduleMirrorSave() {
    if (_suspended) return;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(pushToMirror, SAVE_DEBOUNCE_MS);
}

/**
 * Pull the mirror at boot. Adopts it only if local history holds nothing
 * but the baseline entry — never overwrites a user that has already begun
 * editing in this browser. Resolves with `{adopted, reason}`.
 */
export async function pullMirrorIfLocalBaselineOnly(state) {
    try {
        const res = await fetch('/local-history-load', { method: 'GET' });
        if (!res.ok) return { adopted: false, reason: 'http' };
        const data = await res.json();
        const remote = data?.store;
        if (!remote || typeof remote !== 'object') {
            return { adopted: false, reason: 'empty' };
        }
        const local = HistoryEngine._dumpRaw();
        const bucketKey = String(state?.activeCampaignId || '__default__');
        const localBucket = local?.byCampaign?.[bucketKey];
        const isLocalBaselineOnly = !localBucket || localBucket.entries?.length <= 1;
        const remoteBucket = remote?.byCampaign?.[bucketKey];
        const remoteRicher = (remoteBucket?.entries?.length || 0)
            > (localBucket?.entries?.length || 0);
        if (isLocalBaselineOnly && remoteRicher) {
            // Adopt remote silently and refresh listeners.
            _suspended = true;
            try {
                HistoryEngine._replaceRaw(remote);
            } finally {
                _suspended = false;
            }
            return { adopted: true, reason: 'mirrorRicher' };
        }
        return { adopted: false, reason: 'localPreferred' };
    } catch (err) {
        return { adopted: false, reason: String(err?.message || err) };
    }
}

/**
 * Hook up automatic mirroring. Idempotent: calling twice is a no-op aside
 * from the latest `statusListener` winning.
 */
let _initialized = false;
let _unsubscribe = null;
export function initHistoryBackendSync({ statusListener } = {}) {
    _statusListener = statusListener || _statusListener;
    if (_initialized) return;
    _initialized = true;
    _unsubscribe = HistoryEngine.subscribe((reason) => {
        // Skip the noisy bootstrap that fires before user activity. Replace
        // (mirror adoption) doesn't need to be re-pushed either.
        if (reason === 'bootstrap' || reason === 'replace') return;
        scheduleMirrorSave();
    });
}

export function teardownHistoryBackendSync() {
    if (_unsubscribe) _unsubscribe();
    _unsubscribe = null;
    _initialized = false;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = null;
}
