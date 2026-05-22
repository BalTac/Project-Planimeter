/**
 * Belfiore (Italian comune) code lookup.
 *
 * Loads the static asset `domains/belfiore-codes.json` once on demand and
 * exposes a synchronous `getComuneName(code)` accessor for UI rendering.
 *
 * Source: matteocontrini/comuni-json (regenerated via
 * `python scripts/build_belfiore_codes.py`).
 *
 * The asset is ~216 KB (~50 KB gzip). Loaded lazily so it doesn't block
 * the initial render; callers should `loadBelfioreCodes()` at boot to
 * have the names available when the summary panel first opens.
 */

const ASSET_URL = '/domains/belfiore-codes.json';

/** @type {Record<string,string>|null} */
let codeIndex = null;
/** @type {Promise<Record<string,string>>|null} */
let loadingPromise = null;

/**
 * Idempotent loader. Returns a cached promise on subsequent calls.
 * @returns {Promise<Record<string,string>>}
 */
export function loadBelfioreCodes() {
    if (codeIndex) return Promise.resolve(codeIndex);
    if (loadingPromise) return loadingPromise;
    loadingPromise = fetch(ASSET_URL, { cache: 'force-cache' })
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then((data) => {
            codeIndex = (data && typeof data === 'object') ? data : {};
            return codeIndex;
        })
        .catch((err) => {
            console.warn('[Planimeter] failed to load Belfiore codes:', err?.message ?? err);
            codeIndex = {};
            return codeIndex;
        });
    return loadingPromise;
}

/**
 * Synchronous lookup. Returns the comune display string
 * (e.g. "Cannara (PG)") for a Belfiore code, or `null` when the asset
 * hasn't loaded yet or the code is unknown.
 *
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
export function getComuneName(code) {
    if (!code || typeof code !== 'string') return null;
    if (!codeIndex) return null;
    return codeIndex[code.trim().toUpperCase()] ?? null;
}
