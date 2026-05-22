import { t } from '../i18n/i18n.js';
import { calculateIntersectionMetrics } from '../geometry/intersection.js';
import { calculateArea, calculatePerimeter } from '../geometry/calculations.js';

/**
 * Open or update a non-modal, draggable cross-layer summary panel.
 * Shows intersection metrics between selected drawn areas and property scopes (or vice versa).
 *
 * @param {{
 *   container: HTMLElement,
 *   selectedFeatures: import('ol').Feature[],
 *   allDrawnAreas: import('ol').Feature[],
 *   allPropertyScopes: import('ol').Feature[],
 *   unitSystem: { formatArea: (m2: number) => string, formatPerimeter?: (m: number) => string },
 *   getPropertyScopeLabel: (feature: import('ol').Feature) => string,
 *   getCategoryLabel?: (categoryId: string, feature: import('ol').Feature) => string,
 *   getAreaLabel?: (feature: import('ol').Feature) => string,
 *   projection?: import('ol/proj').ProjectionLike,
 *   summaryMeta?: { layerLabel?: string, featureLabel?: string },
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
        getAreaLabel = (feature) => feature?.get?.('featureName') || feature?.get?.('featureId') || t('feature.area'),
        projection,
        summaryMeta = null,
    } = options;

    if (!selectedFeatures.length) return;

    const selectedAreas = selectedFeatures.filter((f) => f.get('overlayLayer') === 'user');
    const selectedParcels = selectedFeatures.filter((f) => f.get('overlayLayer') === 'pertenenze');

    const sections = [];

    if (selectedAreas.length) {
        sections.push(buildSection({
            kind: 'areas-to-parcels',
            sectionTitleKey: 'summary.section.areasToParcels',
            sectionEmptyKey: allPropertyScopes.length ? 'summary.section.empty.noHit' : 'summary.noParcels',
            subjectFeatures: selectedAreas,
            targetPool: allPropertyScopes,
            subjectLabel: (f) => getAreaLabel(f),
            targetLabel: getPropertyScopeLabel,
            targetCropLabel: () => '—',
            projection,
            unitSystem,
        }));
    }

    if (selectedParcels.length) {
        sections.push(buildSection({
            kind: 'parcels-to-areas',
            sectionTitleKey: 'summary.section.parcelsToAreas',
            sectionEmptyKey: allDrawnAreas.length ? 'summary.section.empty.noHit' : 'summary.section.empty.noAreas',
            subjectFeatures: selectedParcels,
            targetPool: allDrawnAreas,
            subjectLabel: getPropertyScopeLabel,
            targetLabel: (f) => getAreaLabel(f),
            targetCropLabel: (f) => {
                const dsl = f.get('dsl');
                return dsl?.categoryId ? getCategoryLabel(dsl.categoryId, f) : t('dsl.category.unassigned');
            },
            projection,
            unitSystem,
        }));
    }

    const aggregateBlocks = [];
    if (selectedAreas.length) {
        aggregateBlocks.push(buildAggregateBlock({
            titleKey: 'summary.aggregate.areas',
            features: selectedAreas,
            label: (f) => getAreaLabel(f),
            cropLabel: (f) => {
                const dsl = f.get('dsl');
                return dsl?.categoryId ? getCategoryLabel(dsl.categoryId, f) : t('dsl.category.unassigned');
            },
            projection,
            unitSystem,
        }));
    }
    if (selectedParcels.length) {
        aggregateBlocks.push(buildAggregateBlock({
            titleKey: 'summary.aggregate.parcels',
            features: selectedParcels,
            label: getPropertyScopeLabel,
            cropLabel: () => '—',
            projection,
            unitSystem,
        }));
    }

    renderSummaryPanel(container, {
        aggregateBlocks,
        sections,
        summaryMeta,
    });
}

/**
 * @private
 */
function buildAggregateBlock({ titleKey, features, label, cropLabel, projection, unitSystem }) {
    const items = features.map((feature) => {
        const area = calculateArea(feature, projection);
        const perimeter = calculatePerimeter(feature, projection);
        return {
            feature,
            label: label(feature),
            cropLabel: cropLabel(feature),
            area,
            perimeter,
            areaStr: unitSystem.formatArea(area),
            perimeterStr: unitSystem.formatPerimeter ? unitSystem.formatPerimeter(perimeter) : `${perimeter.toFixed(1)} m`,
        };
    });

    const totalArea = items.reduce((sum, i) => sum + i.area, 0);
    const totalPerimeter = items.reduce((sum, i) => sum + i.perimeter, 0);

    return {
        titleKey,
        count: items.length,
        totalArea,
        totalPerimeter,
        totalAreaStr: unitSystem.formatArea(totalArea),
        totalPerimeterStr: unitSystem.formatPerimeter ? unitSystem.formatPerimeter(totalPerimeter) : `${totalPerimeter.toFixed(1)} m`,
        items,
    };
}

/**
 * Build a directional intersection section with AABB pre-check.
 * @private
 */
function buildSection({
    kind,
    sectionTitleKey,
    sectionEmptyKey,
    subjectFeatures,
    targetPool,
    subjectLabel,
    targetLabel,
    targetCropLabel,
    projection,
    unitSystem,
}) {
    const subjectGroups = [];

    for (const subject of subjectFeatures) {
        const subjectExtent = subject.getGeometry?.()?.getExtent?.();
        const subjectArea = calculateArea(subject, projection);

        const candidates = targetPool.filter((target) => {
            if (target === subject) return false;
            const targetExtent = target.getGeometry?.()?.getExtent?.();
            return bboxesOverlap(subjectExtent, targetExtent);
        });

        const rows = [];
        let coveredArea = 0;

        for (const target of candidates) {
            const metrics = calculateIntersectionMetrics(subject, target, {
                sourceProjection: projection,
                targetProjection: projection,
                ratioBase: 'target',
                includeIntersectionGeometry: false,
            });

            if (metrics.intersectionArea > 0.1) {
                rows.push({
                    targetFeature: target,
                    targetLabel: targetLabel(target),
                    cropLabel: targetCropLabel(target),
                    metrics,
                    intersectionAreaStr: unitSystem.formatArea(metrics.intersectionArea),
                    percentSubject: subjectArea > 0 ? (metrics.intersectionArea / subjectArea) * 100 : 0,
                    percentTarget: metrics.targetArea > 0 ? (metrics.intersectionArea / metrics.targetArea) * 100 : 0,
                });
                coveredArea += metrics.intersectionArea;
            }
        }

        const uncovered = Math.max(0, subjectArea - coveredArea);
        rows.sort((a, b) => b.metrics.intersectionArea - a.metrics.intersectionArea);

        subjectGroups.push({
            subjectFeature: subject,
            subjectLabel: subjectLabel(subject),
            subjectArea,
            subjectAreaStr: unitSystem.formatArea(subjectArea),
            rows,
            coveredArea,
            coveredAreaStr: unitSystem.formatArea(coveredArea),
            uncovered,
            uncoveredStr: unitSystem.formatArea(uncovered),
            uncoveredPercent: subjectArea > 0 ? (uncovered / subjectArea) * 100 : 0,
        });
    }

    return {
        kind,
        titleKey: sectionTitleKey,
        emptyKey: sectionEmptyKey,
        subjectGroups,
        hasAnyIntersection: subjectGroups.some((g) => g.rows.length > 0),
    };
}

/**
 * AABB overlap test for two OL extents [minX, minY, maxX, maxY].
 * @private
 */
function bboxesOverlap(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return true;
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * @private
 */
function renderSummaryPanel(container, { aggregateBlocks, sections, summaryMeta = null }) {
    let panel = container.querySelector('#summary-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'summary-panel';
        panel.className = 'summary-panel';
        panel.innerHTML = `
            <div class="summary-panel__header">
                <h3 data-i18n="summary.title">Summary</h3>
                <div class="summary-panel__header-actions">
                    <button type="button" class="summary-panel__expand" data-state="normal" aria-label="Expand">⤢</button>
                    <button type="button" class="summary-panel__close" data-i18n-aria="summary.close" aria-label="Close">×</button>
                </div>
            </div>
            <div class="summary-panel__body">
                <div class="summary-panel__meta" id="summary-panel-meta">
                    <div class="summary-panel__meta-line">
                        <span class="summary-panel__meta-label" data-i18n="summary.layer">Layer</span>
                        <span class="summary-panel__meta-value" id="summary-layer-value"></span>
                    </div>
                    <div class="summary-panel__meta-feature" id="summary-feature-value"></div>
                </div>
                <div class="summary-panel__aggregate" id="summary-aggregate"></div>
                <div class="summary-panel__sections" id="summary-sections"></div>
            </div>
        `;
        container.appendChild(panel);

        makeElementDraggable(panel);

        panel.querySelector('.summary-panel__close').addEventListener('click', () => {
            panel.hidden = true;
        });

        const expandBtn = panel.querySelector('.summary-panel__expand');
        expandBtn?.addEventListener('click', () => {
            const isExpanded = panel.classList.toggle('summary-panel--expanded');
            expandBtn.dataset.state = isExpanded ? 'expanded' : 'normal';
            if (isExpanded) {
                panel.style.left = '';
                panel.style.top = '';
            }
        });

        const onEscape = (ev) => {
            if (ev.key === 'Escape' && !panel.hidden) {
                panel.hidden = true;
                document.removeEventListener('keydown', onEscape);
            }
        };
        document.addEventListener('keydown', onEscape);
    }

    panel.hidden = false;

    const meta = panel.querySelector('#summary-panel-meta');
    const layerValue = panel.querySelector('#summary-layer-value');
    const featureValue = panel.querySelector('#summary-feature-value');
    const hasMeta = Boolean(summaryMeta?.layerLabel || summaryMeta?.featureLabel);
    if (meta) meta.hidden = !hasMeta;
    if (layerValue) layerValue.textContent = summaryMeta?.layerLabel || '';
    if (featureValue) {
        featureValue.textContent = summaryMeta?.featureLabel || '';
        featureValue.hidden = !summaryMeta?.featureLabel;
    }

    renderAggregateBlocks(panel.querySelector('#summary-aggregate'), aggregateBlocks);
    renderSections(panel.querySelector('#summary-sections'), sections);

    panel.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        if (key) el.textContent = t(key);
    });
}

function renderAggregateBlocks(host, blocks) {
    if (!host) return;
    host.innerHTML = '';
    if (!blocks || !blocks.length) return;

    for (const block of blocks) {
        const wrap = document.createElement('section');
        wrap.className = 'summary-aggregate-block';

        const header = document.createElement('header');
        header.className = 'summary-aggregate-block__header';
        header.innerHTML = `
            <h4>${escapeHtml(t(block.titleKey))} <span class="summary-aggregate-block__count">(${block.count})</span></h4>
            <div class="summary-aggregate-block__totals">
                <span><strong>${escapeHtml(t('summary.totalArea'))}:</strong> ${escapeHtml(block.totalAreaStr)}</span>
                <span><strong>${escapeHtml(t('summary.totalPerimeter'))}:</strong> ${escapeHtml(block.totalPerimeterStr)}</span>
            </div>
        `;
        wrap.appendChild(header);

        if (block.items.length > 1) {
            const table = document.createElement('table');
            table.className = 'summary-table summary-table--breakdown';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>${escapeHtml(t('summary.col.feature'))}</th>
                        <th>${escapeHtml(t('summary.col.area'))}</th>
                        <th>${escapeHtml(t('summary.col.perimeter'))}</th>
                        <th>${escapeHtml(t('summary.col.crop'))}</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector('tbody');
            for (const item of block.items) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${escapeHtml(item.label || '—')}</td>
                    <td>${escapeHtml(item.areaStr)}</td>
                    <td>${escapeHtml(item.perimeterStr)}</td>
                    <td>${escapeHtml(item.cropLabel || '—')}</td>
                `;
                tbody.appendChild(tr);
            }
            wrap.appendChild(table);
        }
        host.appendChild(wrap);
    }
}

function renderSections(host, sections) {
    if (!host) return;
    host.innerHTML = '';
    if (!sections || !sections.length) return;

    for (const section of sections) {
        const wrap = document.createElement('section');
        wrap.className = 'summary-section';

        const header = document.createElement('header');
        header.className = 'summary-section__header';
        header.innerHTML = `<h4>${escapeHtml(t(section.titleKey))}</h4>`;
        wrap.appendChild(header);

        if (!section.hasAnyIntersection) {
            const empty = document.createElement('p');
            empty.className = 'summary-section__empty';
            empty.textContent = t(section.emptyKey);
            wrap.appendChild(empty);
            host.appendChild(wrap);
            continue;
        }

        for (const group of section.subjectGroups) {
            const groupWrap = document.createElement('div');
            groupWrap.className = 'summary-section__group';

            const groupHeader = document.createElement('div');
            groupHeader.className = 'summary-section__group-header';
            groupHeader.innerHTML = `
                <span class="summary-section__group-title">${escapeHtml(group.subjectLabel || '—')}</span>
                <span class="summary-section__group-meta">${escapeHtml(t('summary.col.area'))}: ${escapeHtml(group.subjectAreaStr)}</span>
            `;
            groupWrap.appendChild(groupHeader);

            const table = document.createElement('table');
            table.className = 'summary-table';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>${escapeHtml(t('summary.col.feature'))}</th>
                        <th>${escapeHtml(t('summary.col.area'))}</th>
                        <th title="${escapeHtml(t('summary.col.percentSubject.help'))}">${escapeHtml(t('summary.col.percentSubject'))}</th>
                        <th title="${escapeHtml(t('summary.col.percentTarget.help'))}">${escapeHtml(t('summary.col.percentTarget'))}</th>
                        <th>${escapeHtml(t('summary.col.crop'))}</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector('tbody');

            for (const row of group.rows) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${escapeHtml(row.targetLabel || '—')}</td>
                    <td>${escapeHtml(row.intersectionAreaStr)}</td>
                    <td>${row.percentSubject.toFixed(1)}%</td>
                    <td>${row.percentTarget.toFixed(1)}%</td>
                    <td>${escapeHtml(row.cropLabel || '—')}</td>
                `;
                tbody.appendChild(tr);
            }

            if (group.uncovered > 0.1) {
                const tr = document.createElement('tr');
                tr.className = 'summary-table__uncovered';
                tr.innerHTML = `
                    <td><em>${escapeHtml(t('summary.uncoveredArea'))}</em></td>
                    <td>${escapeHtml(group.uncoveredStr)}</td>
                    <td>${group.uncoveredPercent.toFixed(1)}%</td>
                    <td>—</td>
                    <td>—</td>
                `;
                tbody.appendChild(tr);
            }

            groupWrap.appendChild(table);
            wrap.appendChild(groupWrap);
        }

        host.appendChild(wrap);
    }
}

function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * @private
 */
function makeElementDraggable(element) {
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;

    const header = element.querySelector('.summary-panel__header');
    if (!header) return;

    header.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('button')) return;
        isDragging = true;
        const rect = element.getBoundingClientRect();
        offsetX = ev.clientX - rect.left;
        offsetY = ev.clientY - rect.top;
    });

    document.addEventListener('mousemove', (ev) => {
        if (!isDragging || element.hidden) return;
        if (element.classList.contains('summary-panel--expanded')) return;

        const parent = element.parentElement;
        if (!parent) return;

        const parentRect = parent.getBoundingClientRect();
        let newX = ev.clientX - parentRect.left - offsetX;
        let newY = ev.clientY - parentRect.top - offsetY;

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
