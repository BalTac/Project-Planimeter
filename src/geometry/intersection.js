import * as polygonClippingModule from 'https://esm.sh/polygon-clipping?bundle';

const polygonClipping = polygonClippingModule.default ?? polygonClippingModule;
const cadastralGeometryCache = new Map();
const cacheStats = {
    hits: 0,
    misses: 0,
};

function cloneValue(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function ringArea(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length < 3) return 0;
    let sum = 0;
    for (let index = 0; index < coordinates.length; index += 1) {
        const current = coordinates[index];
        const next = coordinates[(index + 1) % coordinates.length];
        if (!Array.isArray(current) || !Array.isArray(next)) continue;
        sum += (current[0] * next[1]) - (next[0] * current[1]);
    }
    return Math.abs(sum) / 2;
}

function polygonArea(polygonCoordinates) {
    if (!Array.isArray(polygonCoordinates) || !polygonCoordinates.length) return 0;
    const [outerRing, ...holes] = polygonCoordinates;
    if (!Array.isArray(outerRing)) return 0;

    const outerArea = ringArea(outerRing);
    const holeArea = holes.reduce((sum, hole) => sum + ringArea(hole), 0);
    return Math.max(0, outerArea - holeArea);
}

function multiPolygonArea(multiPolygonCoordinates) {
    if (!Array.isArray(multiPolygonCoordinates) || !multiPolygonCoordinates.length) return 0;
    return multiPolygonCoordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

function toMultiPolygonCoordinates(input, options = {}) {
    const geometry = typeof input?.getGeometry === 'function' ? input.getGeometry() : input;
    if (!geometry) return null;

    if (Array.isArray(geometry)) {
        if (!geometry.length) return null;
        // Raw MultiPolygon coordinates: [polygon][ring][position]
        if (Array.isArray(geometry[0]?.[0]?.[0])) {
            return geometry;
        }
        // Raw Polygon coordinates: [ring][position]
        if (Array.isArray(geometry[0]?.[0])) {
            return [geometry];
        }
    }

    if (typeof geometry.getType === 'function' && typeof geometry.getCoordinates === 'function') {
        const clone = geometry.clone ? geometry.clone() : geometry;
        const sourceProjection = options.sourceProjection;
        const targetProjection = options.targetProjection;
        if (sourceProjection && targetProjection && sourceProjection !== targetProjection && typeof clone.transform === 'function') {
            clone.transform(sourceProjection, targetProjection);
        }

        const type = clone.getType();
        const coordinates = clone.getCoordinates();
        if (type === 'Polygon') return [coordinates];
        if (type === 'MultiPolygon') return coordinates;
        return null;
    }

    if (typeof geometry === 'object' && typeof geometry.type === 'string') {
        if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
            return [geometry.coordinates];
        }
        if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
            return geometry.coordinates;
        }
    }

    return null;
}

function readCachedCadastralGeometry(cacheKey) {
    const entry = cadastralGeometryCache.get(cacheKey);
    return entry ? cloneValue(entry) : null;
}

/**
 * Store a cadastral geometry in the in-memory cache.
 *
 * @param {string} cacheKey
 * @param {import('ol').Feature|import('ol/geom/Geometry').default|{type:string,coordinates:any}} geometry
 * @param {{ sourceProjection?: string, targetProjection?: string }} [options]
 * @returns {{ geometry: any, area: number, storedAt: string } | null}
 */
export function cacheCadastralGeometry(cacheKey, geometry, options = {}) {
    const coordinates = toMultiPolygonCoordinates(geometry, options);
    if (!coordinates) return null;

    const entry = {
        geometry: coordinates,
        area: multiPolygonArea(coordinates),
        storedAt: new Date().toISOString(),
    };
    cadastralGeometryCache.set(cacheKey, entry);
    return cloneValue(entry);
}

/**
 * Retrieve a cached cadastral geometry if present.
 *
 * @param {string} cacheKey
 * @returns {{ geometry: any, area: number, storedAt: string } | null}
 */
export function getCachedCadastralGeometry(cacheKey) {
    return readCachedCadastralGeometry(cacheKey);
}

/**
 * Return cache metrics for geometry reuse.
 *
 * @returns {{ count: number, hits: number, misses: number }}
 */
export function getCadastralGeometryCacheStats() {
    return {
        count: cadastralGeometryCache.size,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
    };
}

/**
 * Clear the cadastral geometry cache.
 *
 * @returns {number} removed entries
 */
export function clearCadastralGeometryCache() {
    const removed = cadastralGeometryCache.size;
    cadastralGeometryCache.clear();
    cacheStats.hits = 0;
    cacheStats.misses = 0;
    return removed;
}

/**
 * Compute intersection metrics between two polygonal geometries.
 *
 * @param {import('ol').Feature|import('ol/geom/Geometry').default|{type:string,coordinates:any}} subject
 * @param {import('ol').Feature|import('ol/geom/Geometry').default|{type:string,coordinates:any}} target
 * @param {{
 *   sourceProjection?: string,
 *   targetProjection?: string,
 *   ratioBase?: 'subject'|'target'|'smaller'|'union',
 *   includeIntersectionGeometry?: boolean,
 * }} [options]
 * @returns {{
 *   subjectArea: number,
 *   targetArea: number,
 *   intersectionArea: number,
 *   coverageRatio: number,
 *   coverageRatioSubject: number,
 *   coverageRatioTarget: number,
 *   intersectionGeometry?: any,
 * }}
 */
export function calculateIntersectionMetrics(subject, target, options = {}) {
    const subjectCoordinates = toMultiPolygonCoordinates(subject, options);
    const targetCoordinates = toMultiPolygonCoordinates(target, options);

    if (!subjectCoordinates || !targetCoordinates) {
        return {
            subjectArea: 0,
            targetArea: 0,
            intersectionArea: 0,
            coverageRatio: 0,
            coverageRatioSubject: 0,
            coverageRatioTarget: 0,
        };
    }

    const subjectArea = multiPolygonArea(subjectCoordinates);
    const targetArea = multiPolygonArea(targetCoordinates);
    const intersectionGeometry = polygonClipping.intersection(subjectCoordinates, targetCoordinates);
    const intersectionArea = multiPolygonArea(intersectionGeometry);

    let ratioDenominator = targetArea;
    if (options.ratioBase === 'subject') {
        ratioDenominator = subjectArea;
    } else if (options.ratioBase === 'smaller') {
        ratioDenominator = Math.min(subjectArea, targetArea);
    } else if (options.ratioBase === 'union') {
        ratioDenominator = subjectArea + targetArea - intersectionArea;
    }

    return {
        subjectArea,
        targetArea,
        intersectionArea,
        coverageRatio: ratioDenominator > 0 ? intersectionArea / ratioDenominator : 0,
        coverageRatioSubject: subjectArea > 0 ? intersectionArea / subjectArea : 0,
        coverageRatioTarget: targetArea > 0 ? intersectionArea / targetArea : 0,
        ...(options.includeIntersectionGeometry ? { intersectionGeometry } : {}),
    };
}

/**
 * Compute intersection metrics while reusing cached cadastral geometries.
 * The cache key should be a stable cadastral identifier (for example parcel_id).
 *
 * @param {import('ol').Feature|import('ol/geom/Geometry').default|{type:string,coordinates:any}} subject
 * @param {string} cacheKey
 * @param {() => (import('ol').Feature|import('ol/geom/Geometry').default|{type:string,coordinates:any}|null)} geometryProvider
 * @param {{
 *   sourceProjection?: string,
 *   targetProjection?: string,
 *   ratioBase?: 'subject'|'target'|'smaller'|'union',
 *   includeIntersectionGeometry?: boolean,
 * }} [options]
 * @returns {{
 *   subjectArea: number,
 *   targetArea: number,
 *   intersectionArea: number,
 *   coverageRatio: number,
 *   coverageRatioSubject: number,
 *   coverageRatioTarget: number,
 *   intersectionGeometry?: any,
 * }}
 */
export function calculateIntersectionMetricsWithCache(subject, cacheKey, geometryProvider, options = {}) {
    let entry = readCachedCadastralGeometry(cacheKey);
    if (entry) {
        cacheStats.hits += 1;
    } else {
        cacheStats.misses += 1;
        const geometry = geometryProvider?.();
        if (!geometry) {
            return calculateIntersectionMetrics(subject, null, options);
        }
        entry = cacheCadastralGeometry(cacheKey, geometry, options);
    }

    return calculateIntersectionMetrics(subject, entry.geometry, options);
}