/**
 * Measurement unit systems supported by the application.
 * @typedef {'metric'|'imperial'} UnitSystemId
 */

/** Locale tags whose primary unit system is imperial. */
const IMPERIAL_LOCALES = new Set(['en-US', 'en-LR', 'my']);

export class UnitSystem {
    /** @param {UnitSystemId} system */
    constructor(system = 'metric') {
        this.system = system;
    }

    /**
     * Infer unit system from a BCP 47 locale string.
     * @param {string} [locale]
     * @returns {UnitSystemId}
     */
    static autoDetect(locale = navigator.language) {
        const tag = (locale || 'en').split('-').slice(0, 2).join('-');
        return IMPERIAL_LOCALES.has(tag) ? 'imperial' : 'metric';
    }

    /**
     * Format a square-metre value as an area string.
     * @param {number} sqm
     * @returns {string}
     */
    formatArea(sqm) {
        if (this.system === 'imperial') {
            return `${(sqm / 4046.8564224).toFixed(4)} ac`;
        }
        return `${(sqm / 10000).toFixed(4)} ha`;
    }

    /**
     * Format a metre value as a linear distance string.
     * @param {number} m
     * @returns {string}
     */
    formatLength(m) {
        if (this.system === 'imperial') {
            const ft = m * 3.280839895;
            if (ft >= 5280) return `${(ft / 5280).toFixed(3)} mi`;
            return `${ft.toFixed(2)} ft`;
        }
        if (m >= 1000) return `${(m / 1000).toFixed(3)} km`;
        return `${m.toFixed(2)} m`;
    }

    /** Alias — perimeter uses the same formatting rules as linear distance. */
    formatPerimeter(m) {
        return this.formatLength(m);
    }
}
