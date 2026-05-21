import { t } from '../i18n/i18n.js';
import { calculateIntersectionMetrics } from '../geometry/intersection.js';

/**
 * Open or update a non-modal, draggable cross-layer summary panel.
 * Shows intersection metrics between selected drawn areas and property scopes (or vice versa).
 *
 * @param {{
 *   container: HTMLElement,
 *   selectedFeatures: import('ol').Feature[],
 *   allDrawnAreas: import('ol').Feature[],
 *   allPropertyScopes: import('ol').Feature[],
 *   unitSystem: { formatArea: (m2: number) => string },
 *   getPropertyScopeLabel: (feature: import('ol').Feature) => string,
 *   getCategoryLabel?: (categoryId: string, feature: import('ol').Feature) => string,
 *   projection?: import('ol/proj').ProjectionLike,
 * }} options
 */
export function openSummaryPanel(options) {
    const {
        container,
        selectedFeatures = [],
        allDrawnAreas = [],
        allPropertyScopes = [],
        unitSystem,
        getPropertyScopeLabel,
        getCategoryLabel = (categoryId) => categoryId || t('dsl.category.unassigned'),
        projection,
    } = options;

    if (!selectedFeatures.length) return;

    // Classify selected features: drawn areas vs property scopes
    const selectedAreas = selectedFeatures.filter((f) => f.get('overlayLayer') === 'user');
    const selectedParcels = selectedFeatures.filter((f) => f.get('overlayLayer') === 'pertenenze');

    // Compute cross-layer metrics
    const summaryRows = [];

    // Case 1: Selected areas (drawn) intersecting property scopes
    if (selectedAreas.length && allPropertyScopes.length) {
        for (const area of selectedAreas) {
            for (const parcel of allPropertyScopes) {
                const metrics = calculateIntersectionMetrics(area, parcel, {
                    sourceProjection: projection,
                    targetProjection: projection,
                    ratioBase: 'target',
                    includeIntersectionGeometry: false,
                });

                if (metrics.intersectionArea > 0.1) {
                    summaryRows.push({
                        type: 'intersection',
                        fromFeature: area,
                        toFeature: parcel,
                        toLabel: getPropertyScopeLabel(parcel),
                        metrics,
                    });
                }
            }

            // Uncovered area: total area - sum of intersections
            const intersections = allPropertyScopes
                .map((p) => calculateIntersectionMetrics(area, p, {
                    sourceProjection: projection,
                    targetProjection: projection,
                    ratioBase: 'subject',
                }))
                .filter((m) => m.intersectionArea > 0.1);
            const totalCovered = intersections.reduce((sum, m) => sum + m.intersectionArea, 0);
            const areaMetrics = calculateIntersectionMetrics(area, area, {
                sourceProjection: projection,
                targetProjection: projection,
            });
            const uncovered = areaMetrics.subjectArea - totalCovered;

            if (uncovered > 0.1) {
                summaryRows.push({
                    type: 'uncovered',
                    label: t('summary.uncoveredArea'),
                    area: uncovered,
                    parentArea: areaMetrics.subjectArea,
                });
            }
        }
    }

    // Case 2: Selected property scopes intersecting drawn areas
    if (selectedParcels.length && allDrawnAreas.length) {
        for (const parcel of selectedParcels) {
            const parcelLabel = getPropertyScopeLabel(parcel);
            let totalCoveredArea = 0;

            for (const area of allDrawnAreas) {
                const metrics = calculateIntersectionMetrics(area, parcel, {
                    sourceProjection: projection,
                    targetProjection: projection,
                    ratioBase: 'target',
                    includeIntersectionGeometry: false,
                });

                if (metrics.intersectionArea > 0.1) {
                    const dsl = area.get('dsl');
                    const cropLabel = dsl?.categoryId
                        ? getCategoryLabel(dsl.categoryId, area)
                        : t('dsl.category.unassigned');

                    summaryRows.push({
                        type: 'intersection',
                        fromFeature: area,
                        toFeature: parcel,
                        toLabel: parcelLabel,
                        cropLabel,
                        metrics,
                    });
                    totalCoveredArea += metrics.intersectionArea;
                }
            }

            // Uncovered area in parcel
            const parcelMetrics = calculateIntersectionMetrics(parcel, parcel, {
                sourceProjection: projection,
                targetProjection: projection,
            });
            const uncovered = parcelMetrics.subjectArea - totalCoveredArea;

            if (uncovered > 0.1) {
                summaryRows.push({
                    type: 'uncovered',
                    label: t('summary.uncoveredArea'),
                    area: uncovered,
                    parentArea: parcelMetrics.subjectArea,
                });
            }
        }
    }

    renderSummaryPanel(container, summaryRows, {
        selectedCount: selectedFeatures.length,
        unitSystem,
    });
}

/**
 * Render the summary panel HTML.
 * @private
 */
function renderSummaryPanel(container, rows, { selectedCount, unitSystem }) {
    let panel = container.querySelector('#summary-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'summary-panel';
        panel.className = 'summary-panel';
        panel.innerHTML = `
            <div class="summary-panel__header">
                <h3 data-i18n="summary.title">Summary</h3>
                <button type="button" class="summary-panel__close" data-i18n-aria="summary.close" aria-label="Close">×</button>
            </div>
            <div class="summary-panel__body">
                <table class="summary-table">
                    <thead>
                        <tr>
                            <th data-i18n="summary.col.feature">Feature</th>
                            <th data-i18n="summary.col.area">Area</th>
                            <th data-i18n="summary.col.percentage">%</th>
                            <th data-i18n="summary.col.crop">Crop</th>
                        </tr>
                    </thead>
                    <tbody id="summary-table-body">
                    </tbody>
                </table>
            </div>
        `;
        container.appendChild(panel);

        // Make panel draggable
        makeElementDraggable(panel);

        // Close button
        panel.querySelector('.summary-panel__close').addEventListener('click', () => {
            panel.hidden = true;
        });

        // Close on Escape
        const onEscape = (ev) => {
            if (ev.key === 'Escape' && !panel.hidden) {
                panel.hidden = true;
                document.removeEventListener('keydown', onEscape);
            }
        };
        document.addEventListener('keydown', onEscape);

        // Close on external click
        document.addEventListener('mousedown', (ev) => {
            if (!panel.hidden && !panel.contains(ev.target) && ev.target !== container) {
                panel.hidden = true;
            }
        });
    }

    panel.hidden = false;

    // Populate table
    const tbody = panel.querySelector('#summary-table-body');
    tbody.innerHTML = '';

    for (const row of rows) {
        const tr = document.createElement('tr');

        if (row.type === 'intersection') {
            const featureName = row.fromFeature?.get('featureName') || row.fromFeature?.get('featureId') || '-';
            const areaStr = unitSystem.formatArea(row.metrics.intersectionArea);
            const percentageStr = (row.metrics.coverageRatioTarget * 100).toFixed(1);
            const cropStr = row.cropLabel || '';

            tr.innerHTML = `
                <td>${featureName}</td>
                <td>${areaStr}</td>
                <td>${percentageStr}%</td>
                <td>${cropStr}</td>
            `;
        } else if (row.type === 'uncovered') {
            const areaStr = unitSystem.formatArea(row.area);
            const parentArea = row.parentArea || 1;
            const percentageStr = parentArea > 0 ? ((row.area / parentArea) * 100).toFixed(1) : '0';

            tr.innerHTML = `
                <td><em>${row.label}</em></td>
                <td>${areaStr}</td>
                <td>${percentageStr}%</td>
                <td>—</td>
            `;
        }

        tbody.appendChild(tr);
    }

    // Refresh i18n
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        if (key) el.textContent = t(key);
    });
}

/**
 * Approximate total area from rows for percentage calculation.
 * @private
 */
function calculateApproxTotalArea(rows) {
    let total = 0;
    for (const row of rows) {
        if (row.type === 'intersection') {
            total += row.metrics.intersectionArea;
        } else if (row.type === 'uncovered') {
            total += row.area;
        }
    }
    return Math.max(total, 1);
}

/**
 * Make an element draggable within its parent container.
 * @private
 */
function makeElementDraggable(element) {
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;

    const header = element.querySelector('.summary-panel__header');
    if (!header) return;

    header.addEventListener('mousedown', (ev) => {
        isDragging = true;
        const rect = element.getBoundingClientRect();
        offsetX = ev.clientX - rect.left;
        offsetY = ev.clientY - rect.top;
    });

    document.addEventListener('mousemove', (ev) => {
        if (!isDragging || element.hidden) return;

        const parent = element.parentElement;
        if (!parent) return;

        const parentRect = parent.getBoundingClientRect();
        let newX = ev.clientX - parentRect.left - offsetX;
        let newY = ev.clientY - parentRect.top - offsetY;

        // Clamp to parent bounds
        newX = Math.max(0, Math.min(newX, parentRect.width - element.offsetWidth));
        newY = Math.max(0, Math.min(newY, parentRect.height - element.offsetHeight));

        element.style.position = 'absolute';
        element.style.left = `${newX}px`;
        element.style.top = `${newY}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

/**
 * Close the summary panel.
 */
export function closeSummaryPanel(container) {
    const panel = container?.querySelector('#summary-panel');
    if (panel) {
        panel.hidden = true;
    }
}
