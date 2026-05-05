import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import { SUPPORTED_GEOMETRY_TYPES, SUPPORTED_IMPORT_EXTENSIONS } from '../core/constants.js';

const geoJsonFormat = new GeoJSON();
const kmlFormat     = new KML({ extractStyles: false });

/**
 * Detect import format from filename extension and/or content sniffing.
 * @param {string} fileName
 * @param {string} content
 * @returns {'geojson'|'kml'}
 */
export function detectImportFormat(fileName, content) {
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    if (SUPPORTED_IMPORT_EXTENSIONS.has(ext)) {
        return ext === 'kml' ? 'kml' : 'geojson';
    }
    return content.trimStart().startsWith('<') ? 'kml' : 'geojson';
}

/**
 * Parse features from raw text content, filtering to supported geometry types.
 * @param {string}           content
 * @param {'geojson'|'kml'}  format
 * @returns {import('ol').Feature[]}
 */
export function readImportedFeatures(content, format) {
    const features = format === 'kml'
        ? kmlFormat.readFeatures(content, { featureProjection: 'EPSG:3857' })
        : geoJsonFormat.readFeatures(content, {
            dataProjection:    'EPSG:4326',
            featureProjection: 'EPSG:3857',
        });

    return features.filter((f) => SUPPORTED_GEOMETRY_TYPES.has(f.getGeometry()?.getType()));
}
