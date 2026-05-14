/**
 * DSL Aggregation — semantic grouping of map features by category.
 *
 * Computes per-category totals (area, count) from the current feature set.
 * Domain-agnostic: works with any loaded DSL domain.
 */

import { calculateArea } from '../geometry/calculations.js';
import { getCategoryById } from './schema.js';

// ─── Main aggregation ─────────────────────────────────────────────────────────
/**
 * Aggregate polygon features by DSL category.
 *
 * Features without a dsl assignment are collected under a synthetic
 * "unassigned" bucket (categoryId === null).
 *
 * @param {import('ol').Feature[]} features    — OL feature array (EPSG:3857)
 * @param {object|null}            domain      — loaded DSL domain, or null
 * @param {import('ol/proj').ProjectionLike} projection
 * @returns {AggRow[]}  sorted by areaM2 desc; unassigned bucket last
 */
export function aggregateByCategory(features, domain, projection) {
    const areaFeatures = features.filter((f) => {
        const type = f.getGeometry()?.getType();
        return type === 'Polygon' || type === 'MultiPolygon';
    });

    /** @type {Map<string|null, AggRow>} */
    const buckets = new Map();

    for (const f of areaFeatures) {
        const dsl   = f.get('dsl');
        const catId = dsl?.categoryId ?? null;
        const area  = calculateArea(f, projection);

        if (!buckets.has(catId)) {
            const cat = catId && domain ? getCategoryById(domain, catId) : null;
            buckets.set(catId, {
                categoryId: catId,
                label:      cat?.label ?? catId ?? null,
                color:      cat?.color ?? '#b0bec5',
                stroke:     cat?.stroke ?? null,
                areaM2:     0,
                count:      0,
            });
        }
        const row = buckets.get(catId);
        row.areaM2 += area;
        row.count  += 1;
    }

    // Sort: assigned categories by area desc, unassigned last
    return [...buckets.values()].sort((a, b) => {
        if (a.categoryId === null) return 1;
        if (b.categoryId === null) return -1;
        return b.areaM2 - a.areaM2;
    });
}

/**
 * Return the total area (m²) from an aggregation result set.
 * @param {AggRow[]} rows
 * @returns {number}
 */
export function totalAggArea(rows) {
    return rows.reduce((s, r) => s + r.areaM2, 0);
}

/**
 * @typedef {Object} AggRow
 * @property {string|null} categoryId
 * @property {string|null} label
 * @property {string}      color
 * @property {string|null} stroke
 * @property {number}      areaM2
 * @property {number}      count
 */
