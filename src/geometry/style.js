import OLStyle from 'ol/style/Style.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import OLText from 'ol/style/Text.js';
import Point from 'ol/geom/Point.js';
import { calculateArea, calculatePerimeter, calculateLength } from './calculations.js';
import { t } from '../i18n/i18n.js';

/**
 * Return a geometry suitable for placing a label on a feature.
 * @param {import('ol').Feature} feature
 * @returns {import('ol/geom').Geometry|null}
 */
export function getFeatureLabelGeometry(feature) {
    const geom = feature.getGeometry();
    const type = geom?.getType();

    if (type === 'Polygon') return geom.getInteriorPoint();

    if (type === 'MultiPolygon') {
        const polys = geom.getPolygons();
        if (!polys.length) return null;
        const largest = polys.reduce((a, b) => (b.getArea() > a.getArea() ? b : a));
        return largest.getInteriorPoint();
    }

    if (type === 'LineString') {
        const len = geom.getLength();
        return len ? new Point(geom.getCoordinateAt(0.5)) : null;
    }

    if (type === 'MultiLineString') {
        const lines = geom.getLineStrings();
        if (!lines.length) return null;
        const longest = lines.reduce((a, b) => (b.getLength() > a.getLength() ? b : a));
        return longest.getLength() ? new Point(longest.getCoordinateAt(0.5)) : null;
    }

    return null;
}

/**
 * Build OpenLayers style array for a single feature.
 *
 * @param {import('ol').Feature} feature
 * @param {import('ol').Feature|null} selectedFeature  — currently selected feature (for highlight)
 * @param {import('ol/proj').ProjectionLike} projection — map view projection
 * @param {import('../units/units.js').UnitSystem} unitSystem
 * @returns {OLStyle[]}
 */
export function buildFeatureStyle(feature, selectedFeature, projection, unitSystem) {
    const isSelected = selectedFeature === feature;
    const type = feature.getGeometry()?.getType();
    const isArea = type === 'Polygon' || type === 'MultiPolygon';
    const isLine = type === 'LineString' || type === 'MultiLineString';

    const nameLabel    = feature.get('featureName') || t('feature.area');
    const areaLabel    = unitSystem.formatArea(calculateArea(feature, projection));
    const perimLabel   = unitSystem.formatPerimeter(calculatePerimeter(feature, projection));
    const lengthLabel  = unitSystem.formatLength(calculateLength(feature, projection));
    const measureLabel = isArea
        ? `${areaLabel}\n${t('feature.perimPrefix')}${perimLabel}`
        : lengthLabel;

    const labelGeom = getFeatureLabelGeometry(feature);

    const styles = [
        new OLStyle({
            fill: new Fill({
                color: isArea
                    ? (isSelected ? 'rgba(255,227,138,0.20)' : 'rgba(19,74,55,0.28)')
                    : 'rgba(0,0,0,0)',
            }),
            stroke: new Stroke({
                color: isLine
                    ? (isSelected ? '#ffe38a' : '#7bc7ff')
                    : (isSelected ? '#ffe38a' : '#73f0bf'),
                width: isSelected ? 4 : 3,
                lineDash: isLine ? [8, 6] : undefined,
            }),
        }),
    ];

    if (labelGeom) {
        styles.push(new OLStyle({
            geometry: labelGeom,
            text: new OLText({
                text: `${nameLabel}\n${measureLabel}`,
                textAlign: 'center',
                justify: 'center',
                font: '700 14px Aptos, "Segoe UI Variable", sans-serif',
                fill: new Fill({ color: '#ffffff' }),
                stroke: new Stroke({ color: 'rgba(4,12,10,0.95)', width: 4 }),
            }),
        }));
    }

    return styles;
}
