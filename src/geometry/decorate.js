import { t } from '../i18n/i18n.js';

/**
 * Assign a stable featureId and human-readable featureName to a feature
 * if it does not already have one, and advance the nextFeatureId counter.
 *
 * Mutates: feature properties + state.nextFeatureId.
 *
 * @param {import('ol').Feature} feature
 * @param {{ nextFeatureId: number }} state          — mutable state slice
 * @param {number}                   existingCount   — current number of features in source
 */
export function decorateFeature(feature, state, existingCount) {
    const existingId  = feature.get('featureId');
    const type        = feature.getGeometry()?.getType();
    const isArea      = type === 'Polygon' || type === 'MultiPolygon';
    const lineType    = feature.get('measurementType') || 'polyline';

    const prefix = isArea
        ? t('feature.area')
        : (lineType === 'straight' ? t('feature.straight') : t('feature.polyline'));

    if (!existingId) {
        // Brand-new feature from draw interaction.
        feature.set('featureId',   `area-${state.nextFeatureId}`);
        feature.set('featureName', `${prefix} ${state.nextFeatureId}`);
        if (!isArea && !feature.get('measurementType')) {
            feature.set('measurementType', 'polyline');
        }
        feature.set('uuid',      crypto.randomUUID());
        feature.set('createdAt', new Date().toISOString());
        feature.set('version',   1);
        if (!feature.get('links')) {
            feature.set('links', { cadastral: [] });
        }
        if (feature.get('dsl') === undefined) {
            feature.set('dsl', null);
        }
        state.nextFeatureId += 1;
        return;
    }

    // Feature loaded from import or localStorage — preserve existing ID/name.
    const parsedId = Number.parseInt(String(existingId).replace('area-', ''), 10);

    if (!feature.get('featureName')) {
        const idx = Number.isFinite(parsedId) ? parsedId : state.nextFeatureId;
        feature.set('featureName', `${prefix} ${idx}`);
    }
    if (!isArea && !feature.get('measurementType')) {
        feature.set('measurementType', 'polyline');
    }

    // Advance nextFeatureId to avoid future collisions.
    const nameMatch    = /^(?:Area|Retta|Line|Polyline)\s+(\d+)$/i.exec(
        String(feature.get('featureName') || ''),
    );
    const parsedNameId = nameMatch ? Number.parseInt(nameMatch[1], 10) : NaN;
    const next = Math.max(
        Number.isFinite(parsedId) ? parsedId + 1 : 0,
        Number.isFinite(parsedNameId) ? parsedNameId + 1 : 0,
        existingCount + 2,
    );
    state.nextFeatureId = Math.max(state.nextFeatureId, next);
}
