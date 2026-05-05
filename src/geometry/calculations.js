import { getArea as olGetArea, getLength as olGetLength } from 'ol/sphere.js';
import LineString from 'ol/geom/LineString.js';

/**
 * Geodesic area in square metres.
 * Returns 0 for non-polygon geometries.
 * @param {import('ol').Feature} feature
 * @param {import('ol/proj').ProjectionLike} projection
 * @returns {number}
 */
export function calculateArea(feature, projection) {
    const geom = feature.getGeometry();
    const type = geom?.getType();
    if (type !== 'Polygon' && type !== 'MultiPolygon') return 0;
    return olGetArea(geom, { projection });
}

/**
 * Geodesic perimeter of the outer ring(s) in metres.
 * Returns 0 for non-polygon geometries.
 * @param {import('ol').Feature} feature
 * @param {import('ol/proj').ProjectionLike} projection
 * @returns {number}
 */
export function calculatePerimeter(feature, projection) {
    const geom = feature.getGeometry();
    const type = geom?.getType();

    if (type === 'Polygon') {
        const ring = geom.getLinearRing(0);
        if (!ring) return 0;
        return olGetLength(new LineString(ring.getCoordinates()), { projection });
    }

    if (type === 'MultiPolygon') {
        return geom.getPolygons().reduce((sum, poly) => {
            const ring = poly.getLinearRing(0);
            return ring ? sum + olGetLength(new LineString(ring.getCoordinates()), { projection }) : sum;
        }, 0);
    }

    return 0;
}

/**
 * Geodesic length of a LineString / MultiLineString feature in metres.
 * Returns 0 for polygon or unknown geometries.
 * @param {import('ol').Feature} feature
 * @param {import('ol/proj').ProjectionLike} projection
 * @returns {number}
 */
export function calculateLength(feature, projection) {
    const geom = feature.getGeometry();
    const type = geom?.getType();
    if (type !== 'LineString' && type !== 'MultiLineString') return 0;
    return olGetLength(geom, { projection });
}
