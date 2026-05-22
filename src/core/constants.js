export const LOCAL_STORAGE_KEY = 'planimeter.features.v1';
export const LOCAL_STORAGE_SCHEMA_VERSION = 3;
export const SETTINGS_LOCAL_STORAGE_KEY = 'planimeter.settings.v1';
export const SETTINGS_LOCAL_STORAGE_SCHEMA_VERSION = 1;
export const HISTORY_LOCAL_STORAGE_KEY = 'planimeter.history.v1';
export const HISTORY_LOCAL_STORAGE_SCHEMA_VERSION = 1;
/** Auto-snapshots of the same `label` within this window are coalesced. */
export const HISTORY_COALESCE_MS = 2000;
/** Maximum number of `kind: "auto"` entries kept per campaign (FIFO eviction). */
export const HISTORY_AUTO_RETENTION = 50;
/** Soft cap on total bytes stored in localStorage (oldest autos evicted first). */
export const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
export const PERSISTENCE_SAVE_DELAY_MS = 250;
export const SUPPORTED_GEOMETRY_TYPES = new Set([
    'Polygon', 'MultiPolygon', 'LineString', 'MultiLineString',
]);
export const SUPPORTED_IMPORT_EXTENSIONS = new Set(['geojson', 'json', 'kml']);

export const CATASTO_WMS_LAYER_DEFS = [
    {
        key: 'parcels',
        layerName: 'CP.CadastralParcel',
        labelKey: 'settings.wms.part.parcels',
        defaultVisible: true,
        defaultOpacity: 0.9,
    },
    {
        key: 'numbers',
        layerName: 'codice_plla',
        labelKey: 'settings.wms.part.numbers',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
    {
        key: 'buildings',
        layerName: 'fabbricati',
        labelKey: 'settings.wms.part.buildings',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
    {
        key: 'roads',
        layerName: 'strade',
        labelKey: 'settings.wms.part.roads',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
    {
        key: 'waters',
        layerName: 'acque',
        labelKey: 'settings.wms.part.waters',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
    {
        key: 'province',
        layerName: 'province',
        labelKey: 'settings.wms.part.province',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
    {
        key: 'zoning',
        layerName: 'CP.CadastralZoning',
        labelKey: 'settings.wms.part.zoning',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
    {
        key: 'vestizioni',
        layerName: 'vestizioni',
        labelKey: 'settings.wms.part.vestizioni',
        defaultVisible: false,
        defaultOpacity: 0.9,
    },
];

export const DEFAULT_CATASTO_WMS_LAYER_SETTINGS = Object.fromEntries(
    CATASTO_WMS_LAYER_DEFS.map((def) => [
        def.key,
        {
            visible: def.defaultVisible,
            opacity: def.defaultOpacity,
        },
    ]),
);
