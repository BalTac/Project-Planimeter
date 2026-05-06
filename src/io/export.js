import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';

const geoJsonFormat = new GeoJSON();
const kmlFormat     = new KML({ extractStyles: false });

/**
 * Build export payload and metadata for the given features and format.
 *
 * @param {import('ol').Feature[]} features
 * @param {'geojson'|'kml'|'geotiff'|'pgw'|'bundle'} format
 * @returns {{ payload: string|null, mimeType: string, extension: string, label: string, requiresBackend?: boolean }}
 */
export function buildExportConfig(features, format) {
    if (['geotiff', 'pgw', 'bundle'].includes(format)) {
        return {
            payload: null,
            mimeType: 'application/octet-stream',
            extension: format === 'geotiff' ? 'tif' : 'zip',
            label: format === 'geotiff' ? 'GeoTIFF' : (format === 'pgw' ? 'PNG+PGW' : 'Dataset Bundle'),
            requiresBackend: true,
        };
    }

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

/**
 * Request backend export (GeoTIFF, PNG+PGW, Dataset bundle).
 *
 * @param {'geotiff'|'pgw'|'bundle'} format
 * @param {{ bbox: number[], width: number, height: number, layers?: string[] }} viewportData
 * @param {import('ol').Feature[]} features
 */
export async function requestBackendExport(format, viewportData, features = []) {
    const formatMap = {
        geotiff: '/export-geotiff',
        pgw: '/export-pgw',
        bundle: '/export-bundle',
    };
    const endpoint = formatMap[format];
    if (!endpoint) {
        throw new Error(`Unknown export format: ${format}`);
    }

    const payload = {
        bbox: viewportData.bbox,
        width: viewportData.width,
        height: viewportData.height,
        crs: 'EPSG:4258',
        layers: viewportData.layers ?? ['CP.CadastralParcel'],
    };

    if (format === 'bundle') {
        payload.features = geoJsonFormat.writeFeatures(features, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
            decimals: 6,
        });
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Export failed: ${response.status}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planimeter-${new Date().toISOString().slice(0, 10)}.${format === 'geotiff' ? 'tif' : 'zip'}`;
    a.click();
    URL.revokeObjectURL(url);
}
