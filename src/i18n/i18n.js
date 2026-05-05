import it from './it.js';
import en from './en.js';

const catalogues = { it, en };

/** @type {'it'|'en'} */
let currentLocale = 'it';
let catalogue = it;

/**
 * Detect preferred locale from browser language tag.
 * Returns 'it' for any Italian variant, otherwise 'en'.
 * @returns {'it'|'en'}
 */
export function detectLocale() {
    const lang = (navigator.language || 'en').toLowerCase();
    return lang.startsWith('it') ? 'it' : 'en';
}

/** @returns {'it'|'en'} */
export function getLocale() {
    return currentLocale;
}

/**
 * Switch active locale and update all [data-i18n] DOM nodes.
 * @param {'it'|'en'} lang
 */
export function setLocale(lang) {
    const resolved = lang in catalogues ? lang : 'en';
    currentLocale = resolved;
    catalogue = catalogues[resolved];
    document.documentElement.lang = resolved;
    applyToDOM();
}

/**
 * Look up a translation key with optional variable interpolation.
 * Missing keys fall back to the key string itself (visible in UI → easy to spot).
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars = {}) {
    let str = catalogue[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, String(v));
    }
    return str;
}

/** Replace textContent / aria-label for all annotated DOM nodes. */
function applyToDOM() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        const key = el.dataset.i18nAria;
        if (key) el.setAttribute('aria-label', t(key));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        const key = el.dataset.i18nTitle;
        if (key) el.title = t(key);
    });
}
