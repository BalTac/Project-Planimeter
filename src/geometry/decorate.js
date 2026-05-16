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
    const overlayLayer = feature.get('overlayLayer') ?? 'user';
    const isPertenenzaArea = isArea && overlayLayer === 'pertenenze';
    const nextCounterKey = isPertenenzaArea ? 'nextPertenenzaId' : 'nextFeatureId';
    const idPrefix = isPertenenzaArea ? 'pert-' : 'area-';

    const derivePertenenzaLabel = (fallback) => {
        const explicit = feature.get('parcelNumber');
        if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
            return String(explicit).trim();
        }

        const currentName = String(feature.get('featureName') || '').trim();
        const numericName = /^(?:Pertinenza|Boundary|Parcel)?\s*(\d+)$/i.exec(currentName);
        if (numericName) return numericName[1];

        const currentId = String(feature.get('featureId') || '').trim();
        const numericId = /^pert-(\d+)$/i.exec(currentId);
        if (numericId) return numericId[1];

        return String(fallback);
    };

    const prefix = isPertenenzaArea
        ? t('feature.pertenenza')
        : (isArea
        ? t('feature.area')
        : (lineType === 'straight' ? t('feature.straight') : t('feature.polyline')));

    if (!existingId) {
        // Brand-new feature from draw interaction.
        const nextId = Number(state[nextCounterKey]) || 1;
        feature.set('featureId',   `${idPrefix}${nextId}`);
        if (isPertenenzaArea) {
            feature.set('parcelNumber', String(nextId));
            feature.set('featureName', String(nextId));
        } else {
            feature.set('featureName', `${prefix} ${nextId}`);
        }
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
        state[nextCounterKey] = nextId + 1;
        return;
    }

    // Feature loaded from import or localStorage — preserve existing ID/name.
    const parsedId = Number.parseInt(String(existingId).replace(/^pert-|^area-/, ''), 10);

    if (!feature.get('featureName')) {
        const idx = Number.isFinite(parsedId) ? parsedId : (Number(state[nextCounterKey]) || 1);
        if (isPertenenzaArea) {
            const parcelNumber = derivePertenenzaLabel(idx);
            feature.set('parcelNumber', parcelNumber);
            feature.set('featureName', parcelNumber);
        } else {
            feature.set('featureName', `${prefix} ${idx}`);
        }
    } else if (isPertenenzaArea) {
        const parcelNumber = derivePertenenzaLabel(
            Number.isFinite(parsedId) ? parsedId : (Number(state[nextCounterKey]) || 1),
        );
        feature.set('parcelNumber', parcelNumber);
        feature.set('featureName', parcelNumber);
    }
    if (!isArea && !feature.get('measurementType')) {
        feature.set('measurementType', 'polyline');
    }

    // Advance nextFeatureId to avoid future collisions.
    const nameMatch    = /^(?:Area|Pertinenza|Boundary|Parcel|Retta|Line|Polyline)?\s*(\d+)$/i.exec(
        String(feature.get('featureName') || ''),
    );
    const parsedNameId = nameMatch ? Number.parseInt(nameMatch[1], 10) : NaN;
    const next = Math.max(
        Number.isFinite(parsedId) ? parsedId + 1 : 0,
        Number.isFinite(parsedNameId) ? parsedNameId + 1 : 0,
        existingCount + 2,
    );
    state[nextCounterKey] = Math.max(Number(state[nextCounterKey]) || 1, next);
}
