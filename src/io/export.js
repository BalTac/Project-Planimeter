import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';

const geoJsonFormat = new GeoJSON();
const kmlFormat     = new KML({ extractStyles: false });

/**
 * Build export payload and metadata for the given features and format.
 *
 * @param {import('ol').Feature[]} features
 * @param {'geojson'|'kml'} format
 * @returns {{ payload: string, mimeType: string, extension: string, label: string }}
 */
export function buildExportConfig(features, format) {
    if (format === 'kml') {
        return {
            payload:   kmlFormat.writeFeatures(features, { featureProjection: 'EPSG:3857' }),
            mimeType:  'application/vnd.google-earth.kml+xml;charset=utf-8',
            extension: 'kml',
            label:     'KML',
        };
    }

    return {
        payload: geoJsonFormat.writeFeatures(features, {
            dataProjection:    'EPSG:4326',
            featureProjection: 'EPSG:3857',
            decimals:          6,
        }),
        mimeType:  'application/geo+json;charset=utf-8',
        extension: 'geojson',
        label:     'GeoJSON',
    };
}

/**
 * Trigger a browser download for a text payload.
 * @param {string} payload
 * @param {string} mimeType
 * @param {string} filename
 */
export function triggerDownload(payload, mimeType, filename) {
    const blob = new Blob([payload], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
