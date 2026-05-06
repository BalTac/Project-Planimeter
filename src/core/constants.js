export const LOCAL_STORAGE_KEY = 'planimeter.features.v1';
export const LOCAL_STORAGE_SCHEMA_VERSION = 1;
export const SETTINGS_LOCAL_STORAGE_KEY = 'planimeter.settings.v1';
export const SETTINGS_LOCAL_STORAGE_SCHEMA_VERSION = 1;
export const PERSISTENCE_SAVE_DELAY_MS = 250;
export const SUPPORTED_GEOMETRY_TYPES = new Set([
    'Polygon', 'MultiPolygon', 'LineString', 'MultiLineString',
]);
export const SUPPORTED_IMPORT_EXTENSIONS = new Set(['geojson', 'json', 'kml']);
