import OLStyle from 'ol/style/Style.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import OLText from 'ol/style/Text.js';
import Point from 'ol/geom/Point.js';
import { calculateArea, calculatePerimeter, calculateLength } from './calculations.js';
import { t } from '../i18n/i18n.js';
import { getDomain } from '../dsl/loader.js';
import { getCategoryById } from '../dsl/schema.js';

// ─── Color helpers ────────────────────────────────────────────────────────────
/**
 * Parse a CSS hex color (`#rrggbb` or `#rgb`) into an rgba() string.
 * Returns null if hex is invalid.
 * @param {string} hex
 * @param {number} alpha — 0..1
 * @returns {string|null}
 */
function hexToRgba(hex, alpha) {
    if (!hex || typeof hex !== 'string') return null;
    const h = hex.replace('#', '');
    let r, g, b;
    if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 6) {
        r = parseInt(h.slice(0, 2), 16);
        g = parseInt(h.slice(2, 4), 16);
        b = parseInt(h.slice(4, 6), 16);
    } else {
        return null;
    }
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Resolve fill and stroke colors for a feature, preferring DSL category colors.
 * @param {import('ol').Feature} feature
 * @param {boolean} isSelected
 * @param {boolean} isArea
 * @param {boolean} isLine
 * @returns {{ fill: string, stroke: string }}
 */
function resolveColors(feature, isSelected, isArea, isLine, options = {}) {
    // Selected highlight always overrides
    if (isSelected) {
        return {
            fill:   isArea ? 'rgba(255,227,138,0.20)' : 'rgba(0,0,0,0)',
            stroke: '#ffe38a',
        };
    }

    const overlayLayer = feature.get('overlayLayer') ?? 'user';
    if (isArea && overlayLayer === 'pertenenze') {
        const base = options.pertenenzeColor ?? '#8a9199';
        return {
            fill: hexToRgba(base, 0.24) ?? 'rgba(138,145,153,0.24)',
            stroke: hexToRgba(base, 0.95) ?? 'rgba(138,145,153,0.95)',
        };
    }

    // Try DSL category color
    if (isArea) {
        const dsl = feature.get('dsl');
        if (dsl?.categoryId && dsl?.domainId) {
            const domain = getDomain(dsl.domainId);
            if (domain) {
                const cat = getCategoryById(domain, dsl.categoryId);
                if (cat?.color) {
                    const fill   = hexToRgba(cat.color, 0.30) ?? 'rgba(19,74,55,0.28)';
                    const stroke = cat.stroke ?? (hexToRgba(cat.color, 0.85) ?? '#73f0bf');
                    return { fill, stroke };
                }
            }
        }
        return { fill: 'rgba(19,74,55,0.28)', stroke: '#73f0bf' };
    }

    // Lines
    return { fill: 'rgba(0,0,0,0)', stroke: '#7bc7ff' };
}

function getPropertyScopeLabel(feature) {
    const explicit = String(feature.get('parcelNumber') || '').trim();
    if (explicit) return explicit;

    const name = String(feature.get('featureName') || '').trim();
    const nameMatch = /^(?:Pertinenza|Boundary|Parcel)?\s*(\d+)$/i.exec(name);
    if (nameMatch) return nameMatch[1];

    const featureId = String(feature.get('featureId') || '').trim();
    const idMatch = /^pert-(\d+)$/i.exec(featureId);
    if (idMatch) return idMatch[1];

    return name || featureId || '-';
}

function getUserAreaMapLabel(feature) {
    const dsl = feature.get('dsl');
    if (dsl?.categoryId && dsl?.domainId) {
        const domain = getDomain(dsl.domainId);
        const category = domain ? getCategoryById(domain, dsl.categoryId) : null;
        const label = String(category?.label || '').trim();
        if (label) return label;
    }

    const raw = String(feature.get('featureName') || '').trim();
    if (!raw) return t('feature.area');

    const bracketed = /^\[(.+)\]$/.exec(raw);
    return bracketed ? String(bracketed[1]).trim() : raw;
}

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
export function buildFeatureStyle(feature, selectedFeature, projection, unitSystem, options = {}) {
    const isSelected = selectedFeature === feature;
    const type = feature.getGeometry()?.getType();
    const isArea = type === 'Polygon' || type === 'MultiPolygon';
    const isLine = type === 'LineString' || type === 'MultiLineString';
    const overlayLayer = feature.get('overlayLayer') ?? 'user';
    const isPropertyScope = isArea && overlayLayer === 'pertenenze';

    const nameLabel    = isPropertyScope
        ? getPropertyScopeLabel(feature)
        : (isArea ? getUserAreaMapLabel(feature) : (feature.get('featureName') || t('feature.area')));
    const areaLabel    = unitSystem.formatArea(calculateArea(feature, projection));
    const lengthLabel  = unitSystem.formatLength(calculateLength(feature, projection));
    const measureLabel = isPropertyScope
        ? nameLabel
        : (isArea
        ? `${areaLabel}`
        : lengthLabel);

    const labelGeom = getFeatureLabelGeometry(feature);
    const { fill, stroke } = resolveColors(feature, isSelected, isArea, isLine, options);

    const styles = [
        new OLStyle({
            fill: new Fill({ color: fill }),
            stroke: new Stroke({
                color: stroke,
                width: isSelected ? 4 : 3,
                lineDash: isLine ? [8, 6] : undefined,
            }),
        }),
    ];

    if (labelGeom) {
        styles.push(new OLStyle({
            geometry: labelGeom,
            text: new OLText({
                text: isPropertyScope ? nameLabel : `${nameLabel}\n${measureLabel}`,
                textAlign: 'center',
                justify: 'center',
                font: isPropertyScope
                    ? '800 17px Aptos, "Segoe UI Variable", sans-serif'
                    : '700 14px Aptos, "Segoe UI Variable", sans-serif',
                fill: new Fill({ color: '#ffffff' }),
                stroke: new Stroke({ color: 'rgba(4,12,10,0.95)', width: 4 }),
            }),
        }));
    }

    return styles;
}
