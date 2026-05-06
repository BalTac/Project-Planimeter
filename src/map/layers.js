import TileLayer  from 'ol/layer/Tile.js';
import ImageLayer from 'ol/layer/Image.js';
import VectorLayer from 'ol/layer/Vector.js';
import XYZ        from 'ol/source/XYZ.js';
import OSM        from 'ol/source/OSM.js';
import ImageWMS   from 'ol/source/ImageWMS.js';
import TileWMS    from 'ol/source/TileWMS.js';

/**
 * Build and return all map layers used by the application.
 *
 * @param {import('ol/source/Vector').default} vectorSource
 * @param {function} featureStyleFn — style function forwarded to VectorLayer
 * @returns {{ sat, openTopoMap, esriTopo, esriRelief, osm, catastoOfficial, catastoFallback, vector }}
 */
export function buildLayers(vectorSource, featureStyleFn) {
    const sat = new TileLayer({
        source: new XYZ({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            crossOrigin: 'anonymous',
            maxZoom: 19,
        }),
        visible: true,
        zIndex: 1,
    });

    const openTopoMap = new TileLayer({
        source: new XYZ({
            url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
            crossOrigin: 'anonymous',
            maxZoom: 17,
            attributions:
                'Map data: © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
                '<a href="https://viewfinderpanoramas.org">SRTM</a> | Map style: ' +
                '© <a href="https://opentopomap.org">OpenTopoMap</a> ' +
                '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        }),
        visible: false,
        zIndex: 1,
    });

    const esriTopo = new TileLayer({
        source: new XYZ({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
            crossOrigin: 'anonymous',
            maxZoom: 19,
        }),
        visible: false,
        zIndex: 1,
    });

    const esriRelief = new TileLayer({
        source: new XYZ({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
            crossOrigin: 'anonymous',
            maxZoom: 13,
        }),
        visible: false,
        zIndex: 1,
    });

    const osm = new TileLayer({
        source: new OSM({ crossOrigin: 'anonymous' }),
        visible: false,
        zIndex: 2,
        opacity: 0.82,
    });

    const catastoOfficial = new TileLayer({
        source: new TileWMS({
            url: '/wms-tile',
            params: {
                VERSION:     '1.3.0',
                LAYERS:      'CP.CadastralParcel',
                STYLES:      '',
                FORMAT:      'image/png',
                TRANSPARENT: true,
            },
            serverType: 'mapserver',
            transition:  0,
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

    return { sat, openTopoMap, esriTopo, esriRelief, osm, catastoOfficial, catastoFallback, vector };
}
