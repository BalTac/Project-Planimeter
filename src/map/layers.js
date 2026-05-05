import TileLayer  from 'ol/layer/Tile.js';
import ImageLayer from 'ol/layer/Image.js';
import VectorLayer from 'ol/layer/Vector.js';
import XYZ        from 'ol/source/XYZ.js';
import OSM        from 'ol/source/OSM.js';
import ImageWMS   from 'ol/source/ImageWMS.js';

/**
 * Build and return all map layers used by the application.
 *
 * @param {import('ol/source/Vector').default} vectorSource
 * @param {function} featureStyleFn — style function forwarded to VectorLayer
 * @returns {{ sat, osm, catastoOfficial, catastoFallback, vector }}
 */
export function buildLayers(vectorSource, featureStyleFn) {
    const sat = new TileLayer({
        source: new XYZ({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maxZoom: 19,
        }),
        visible: true,
        zIndex: 1,
    });

    const osm = new TileLayer({
        source: new OSM(),
        visible: false,
        zIndex: 2,
        opacity: 0.82,
    });

    const catastoOfficial = new ImageLayer({
        source: new ImageWMS({
            url: '/wms-proxy',
            hidpi: false,
            params: {
                VERSION:    '1.3.0',
                LAYERS:     'CP.CadastralParcel',
                STYLES:     '',
                FORMAT:     'image/png',
                TRANSPARENT: true,
            },
            ratio: 1,
        }),
        visible: false,
        zIndex: 3,
        minZoom: 14,
        opacity: 0.9,
    });

    const catastoFallback = new TileLayer({
        source: new XYZ({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
            crossOrigin: 'anonymous',
            maxZoom: 19,
        }),
        visible: false,
        zIndex: 3,
        opacity: 0.82,
    });

    const vector = new VectorLayer({
        source: vectorSource,
        style:  featureStyleFn,
        zIndex: 10,
    });

    return { sat, osm, catastoOfficial, catastoFallback, vector };
}
