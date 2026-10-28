import { t } from '../i18n/i18n.js';
import { calculateIntersectionMetrics } from '../geometry/intersection.js';
import { calculateArea, calculatePerimeter } from '../geometry/calculations.js';
import { getComuneName } from '../io/belfiore.js';

// ────────────────────────────────────────────────────────────────────────────
// Column registry
// ────────────────────────────────────────────────────────────────────────────

const COLUMN_DEFS = [
    {
        id: 'feature',
        group: 'base',
        labelKey: 'summary.col.feature',
        render: (row) => `${escapeHtml(row.targetLabel || '—')}${renderSharedBadge(row)}`,
    },
    {
        id: 'area',
        group: 'base',
        labelKey: 'summary.col.area',
        render: (row) => escapeHtml(row.intersectionAreaStr),
    },
    {
        id: 'percentSubject',
        group: 'base',
        labelKey: 'summary.col.percentSubject',
        helpKey: 'summary.col.percentSubject.help',
        render: (row) => `${row.percentSubject.toFixed(1)}%`,
    },
    {
        id: 'percentTarget',
        group: 'base',
        labelKey: 'summary.col.percentTarget',
        helpKey: 'summary.col.percentTarget.help',
        render: (row) => `${row.percentTarget.toFixed(1)}%`,
    },
    {
        id: 'crop',
        group: 'base',
        labelKey: 'summary.col.crop',
        render: (row) => escapeHtml(row.cropLabel || '—'),
    },
    {
        id: 'prevCrop',
        group: 'base',
        labelKey: 'summary.col.prevCrop',
        helpKey: 'summary.col.prevCrop.help',
        render: (row) => escapeHtml(row.prevCropLabel || '—'),
    },
    {
        id: 'pacStatus',
        group: 'base',
        labelKey: 'summary.col.pacStatus',
        helpKey: 'summary.col.pacStatus.help',
        render: (row) => row.pacBadge ? `${row.pacBadge} ${escapeHtml(row.pacShortReason || '')}` : '—',
    },
    {
        id: 'comune',
        group: 'cadastral',
        labelKey: 'summary.col.comune',
        helpKey: 'summary.col.comune.help',
        render: (row) => {
            const code = row.cadastral?.comune;
            if (!code) return '—';
            const name = row.cadastral?.comuneName;
            return name ? `${escapeHtml(code)} — ${escapeHtml(name)}` : escapeHtml(code);
        },
    },
    {
        id: 'foglio',
        group: 'cadastral',
        labelKey: 'summary.col.foglio',
        render: (row) => escapeHtml(row.cadastral?.foglio || '—'),
    },
    {
        id: 'particella',
        group: 'cadastral',
        labelKey: 'summary.col.particella',
        render: (row) => escapeHtml(row.cadastral?.particella || '—'),
    },
    {
        id: 'subalterno',
        group: 'cadastral',
        labelKey: 'summary.col.subalterno',
        helpKey: 'summary.col.subalterno.help',
        render: (row) => escapeHtml(row.cadastral?.subalterno || '—'),
    },
    {
        id: 'inspireId',
        group: 'cadastral',
        labelKey: 'summary.col.inspireId',
        render: (row) => escapeHtml(row.cadastral?.inspireId || '—'),
    },
    {
        id: 'officialArea',
        group: 'cadastral',
        labelKey: 'summary.col.officialArea',
        helpKey: 'summary.col.officialArea.help',
        render: (row) => escapeHtml(row.cadastral?.officialArea || '—'),
    },
    {
        id: 'perimeter',
        group: 'geometry',
        labelKey: 'summary.col.perimeter',
        render: (row) => escapeHtml(row.perimeterStr || '—'),
    },
    {
        id: 'vertices',
        group: 'geometry',
        labelKey: 'summary.col.vertices',
        render: (row) => row.verticesCount != null ? String(row.verticesCount) : '—',
    },
    {
        id: 'possessionTitle',
        group: 'possession',
        labelKey: 'summary.col.possessionTitle',
        helpKey: 'summary.col.possessionTitle.help',
        render: (row) => escapeHtml(row.possession?.tenureLabel || '—'),
    },
    {
        id: 'possessionHolder',
        group: 'possession',
        labelKey: 'summary.col.possessionHolder',
        render: (row) => escapeHtml(row.possession?.holderName || '—'),
    },
    {
        id: 'possessionQuota',
        group: 'possession',
        labelKey: 'summary.col.possessionQuota',
        render: (row) => {
            const q = row.possession?.quotaPercent;
            return (typeof q === 'number' && Number.isFinite(q)) ? `${q}%` : '—';
        },
    },
    {
        id: 'possessionExpiry',
        group: 'possession',
        labelKey: 'summary.col.possessionExpiry',
        render: (row) => escapeHtml(row.possession?.expiryDate || '—'),
    },
];

const DEFAULT_VISIBLE_COLUMNS = ['feature', 'area', 'percentSubject', 'crop', 'prevCrop', 'pacStatus'];

export function getDefaultSummaryColumns() {
    return [...DEFAULT_VISIBLE_COLUMNS];
}

export function getSummaryColumnDefs() {
    return COLUMN_DEFS.map((c) => ({ id: c.id, group: c.group, labelKey: c.labelKey, helpKey: c.helpKey }));
}

function resolveColumns(visibleColumns) {
    const ids = Array.isArray(visibleColumns) && visibleColumns.length
        ? visibleColumns
        : DEFAULT_VISIBLE_COLUMNS;
    const set = new Set(ids);
    const resolved = COLUMN_DEFS.filter((c) => set.has(c.id));
    if (!resolved.some((c) => c.id === 'feature')) {
        resolved.unshift(COLUMN_DEFS.find((c) => c.id === 'feature'));
    }
    return resolved;
}

export function parseInspireLocalId(localId) {
    if (!localId || typeof localId !== 'string') return null;
    const parts = localId.split('.').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const tail = parts.length >= 5 ? parts.slice(parts.length - (parts.length >= 6 ? 4 : 3)) : parts;
    let particella = null;
    let subalterno = null;
    let foglio = null;
    let comune = null;
    let sezione = null;

    if (tail.length >= 3) {
        const last = tail[tail.length - 1];
        const prev = tail[tail.length - 2];
        if (/^\d+$/.test(last) && /^\d+$/.test(prev) && tail.length >= 4) {
            subalterno = stripLeadingZeros(last);
            particella = stripLeadingZeros(prev);
            foglio = stripLeadingZeros(tail[tail.length - 3]);
            const comuneRaw = tail[tail.length - 4];
            [comune, sezione] = splitComuneSezione(comuneRaw);
        } else {
            particella = stripLeadingZeros(last);
            foglio = stripLeadingZeros(prev);
            const comuneRaw = tail[tail.length - 3];
            [comune, sezione] = splitComuneSezione(comuneRaw);
        }
    }

    return { comune, sezione, foglio, particella, subalterno };
}

export function parseNationalCadastralReference(reference) {
    if (!reference || typeof reference !== 'string') return null;
    const trimmed = reference.trim();
    if (!trimmed) return null;

    const dotParts = trimmed.split('.').map((p) => p.trim()).filter(Boolean);
    if (dotParts.length < 2) return null;

    const head = dotParts[0];
    const particellaRaw = dotParts[1];
    const subRaw = dotParts[2] ?? null;

    const headParts = head.split('_').map((p) => p.trim()).filter(Boolean);
    if (headParts.length < 2) return null;

    const foglioRaw = headParts[headParts.length - 1];
    if (!/^\d+$/.test(foglioRaw)) return null;

    const comune = headParts[0] || null;
    const sezione = headParts.length >= 3 ? headParts.slice(1, -1).join('_') : null;

    return {
        comune,
        sezione,
        foglio: stripLeadingZeros(foglioRaw),
        particella: particellaRaw ? stripLeadingZeros(particellaRaw) : null,
        subalterno: subRaw ? stripLeadingZeros(subRaw) : null,
    };
}

function splitComuneSezione(raw) {
    if (!raw) return [null, null];
    const m = /^([^_]+)(?:_(.+))?$/.exec(raw);
    return [m?.[1] || raw, m?.[2] || null];
}

function stripLeadingZeros(s) {
    if (!s) return s;
    return s.replace(/^0+(?=\d)/, '') || s;
}

function extractCadastralData(feature, unitSystem) {
    if (!feature?.get) return null;
    const inspireId = feature.get('inspire_local_id') || feature.get('inspireLocalId') || null;
    const parcelId = feature.get('parcel_id') || null;
    let parsed = parseInspireLocalId(inspireId);
    if (!parsed || (!parsed.comune && !parsed.foglio && !parsed.particella)) {
        const fromParcelId = parseNationalCadastralReference(parcelId);
        if (fromParcelId) parsed = fromParcelId;
    }
    parsed = parsed || {};
    const officialAreaRaw = feature.get('superficie_ufficiale')
        ?? feature.get('officialArea')
        ?? feature.get('cadastralArea');
    let officialArea = null;
    if (typeof officialAreaRaw === 'number' && Number.isFinite(officialAreaRaw)) {
        officialArea = unitSystem?.formatArea ? unitSystem.formatArea(officialAreaRaw) : `${officialAreaRaw} m²`;
    } else if (typeof officialAreaRaw === 'string' && officialAreaRaw.trim()) {
        officialArea = officialAreaRaw.trim();
    }
    return {
        inspireId: inspireId || null,
        comune: parsed.comune || null,
        comuneName: parsed.comune ? getComuneName(parsed.comune) : null,
        sezione: parsed.sezione || null,
        foglio: parsed.foglio || null,
        particella: parsed.particella || null,
        subalterno: parsed.subalterno || null,
        officialArea,
    };
}

function countVertices(feature) {
    const geom = feature?.getGeometry?.();
    if (!geom) return null;
    try {
        const coords = geom.getCoordinates?.();
        if (!coords) return null;
        let total = 0;
        const walk = (node) => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number') { total++; return; }
            for (const child of node) walk(child);
        };
        walk(coords);
        return total;
    } catch {
        return null;
    }
}

function extractPossessionData(feature, getCategoryLabel) {
    const dsl = feature?.get?.('dsl');
    if (!dsl || dsl.domainId !== 'possession') return null;
    const values = (dsl.values && typeof dsl.values === 'object') ? dsl.values : {};
    const tenureLabel = dsl.categoryId
        ? (typeof getCategoryLabel === 'function'
            ? getCategoryLabel(dsl.categoryId, feature)
            : dsl.categoryId)
        : '';
    return {
        tenureCategoryId: dsl.categoryId || null,
        tenureLabel,
        holderName: values.holder_name || '',
        holderCuaa: values.holder_cuaa || '',
        quotaPercent: (typeof values.quota_percent === 'number') ? values.quota_percent : null,
        expiryDate: values.expiry_date || '',
        documentDate: values.document_date || '',
        documentRef: values.document_ref || '',
        notes: values.notes || '',
    };
}

function renderSharedBadge(row) {
    if (!row || !row.sharedCount || row.sharedCount <= 1) return '';
    const label = t('summary.shared.badge', { count: row.sharedCount });
    return ` <span class="summary-table__shared-badge" title="${escapeHtml(label)}">↔${row.sharedCount}</span>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function openSummaryPanel(options) {
    const {
        container,
        selectedFeatures = [],
        allDrawnAreas = [],
        allPropertyScopes = [],
        unitSystem,
        getPropertyScopeLabel,
        getCategoryLabel = (categoryId) => categoryId || t('dsl.category.unassigned'),
        getPrevCropLabel = () => '—',
        getPacStatus = () => null,
        getAreaLabel = (feature) => feature?.get?.('featureName') || feature?.get?.('featureId') || t('feature.area'),
        projection,
        summaryMeta = null,
        visibleColumns = DEFAULT_VISIBLE_COLUMNS,
        onColumnsChange = null,
    } = options;

    if (!selectedFeatures.length) return;

    const selectedAreas = selectedFeatures.filter((f) => f.get('overlayLayer') === 'user');
    const selectedParcels = selectedFeatures.filter((f) => f.get('overlayLayer') === 'pertenenze');

    const parcelSharedCounts = computeSharedCountMap(allPropertyScopes, allDrawnAreas, projection);

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
            targetPrevCropLabel: (_target, subject) => getPrevCropLabel(subject) || '—',
            targetPacStatus: (_target, subject) => getPacStatus(subject),
            sharedCountFor: (target) => parcelSharedCounts.get(target) ?? 0,
            projection,
            unitSystem,
            getCategoryLabel,
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
            targetPrevCropLabel: (target) => getPrevCropLabel(target) || '—',
            targetPacStatus: (target) => getPacStatus(target),
            sharedCountFor: () => 0,
            projection,
            unitSystem,
            getCategoryLabel,
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
            prevCropLabel: (f) => getPrevCropLabel(f) || '—',
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
            prevCropLabel: () => '—',
            projection,
            unitSystem,
        }));
    }

    renderSummaryPanel(container, {
        aggregateBlocks,
        sections,
        summaryMeta,
        visibleColumns: [...visibleColumns],
        onColumnsChange,
    });
}

function computeSharedCountMap(propertyScopes, drawnAreas, projection) {
    const map = new Map();
    for (const parcel of propertyScopes) {
        const parcelExtent = parcel.getGeometry?.()?.getExtent?.();
        let count = 0;
        for (const area of drawnAreas) {
            const areaExtent = area.getGeometry?.()?.getExtent?.();
            if (!bboxesOverlap(parcelExtent, areaExtent)) continue;
            const m = calculateIntersectionMetrics(area, parcel, {
                sourceProjection: projection,
                targetProjection: projection,
                ratioBase: 'target',
                includeIntersectionGeometry: false,
            });
            if (m.intersectionArea > 0.1) count++;
        }
        map.set(parcel, count);
    }
    return map;
}

function buildAggregateBlock({ titleKey, features, label, cropLabel, prevCropLabel = () => '—', projection, unitSystem }) {
    const items = features.map((feature) => {
        const area = calculateArea(feature, projection);
        const perimeter = calculatePerimeter(feature, projection);
        return {
            feature,
            label: label(feature),
            cropLabel: cropLabel(feature),
            prevCropLabel: prevCropLabel(feature),
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

function buildSection({
    kind,
    sectionTitleKey,
    sectionEmptyKey,
    subjectFeatures,
    targetPool,
    subjectLabel,
    targetLabel,
    targetCropLabel,
    targetPrevCropLabel = () => '—',
    targetPacStatus = () => null,
    sharedCountFor,
    projection,
    unitSystem,
    getCategoryLabel,
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
                const perimeter = calculatePerimeter(target, projection);
                const pac = targetPacStatus(target, subject);
                rows.push({
                    targetFeature: target,
                    targetLabel: targetLabel(target),
                    cropLabel: targetCropLabel(target),
                    prevCropLabel: targetPrevCropLabel(target, subject),
                    pacBadge: pac?.badge || '',
                    pacShortReason: pac?.shortReason || '',
                    metrics,
                    intersectionAreaStr: unitSystem.formatArea(metrics.intersectionArea),
                    percentSubject: subjectArea > 0 ? (metrics.intersectionArea / subjectArea) * 100 : 0,
                    percentTarget: metrics.targetArea > 0 ? (metrics.intersectionArea / metrics.targetArea) * 100 : 0,
                    cadastral: extractCadastralData(target, unitSystem),
                    possession: extractPossessionData(target, getCategoryLabel),
                    sharedCount: sharedCountFor ? sharedCountFor(target) : 0,
                    perimeterStr: unitSystem.formatPerimeter ? unitSystem.formatPerimeter(perimeter) : `${perimeter.toFixed(1)} m`,
                    verticesCount: countVertices(target),
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

function bboxesOverlap(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return true;
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function renderSummaryPanel(container, { aggregateBlocks, sections, summaryMeta = null, visibleColumns, onColumnsChange }) {
    let panel = container.querySelector('#summary-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'summary-panel';
        panel.className = 'summary-panel';
        panel.innerHTML = `
            <div class="summary-panel__header">
                <h3 data-i18n="summary.title">Summary</h3>
                <div class="summary-panel__header-actions">
                    <button type="button" class="summary-panel__columns" data-i18n-aria="summary.columns.toggle" aria-label="Columns" title="Columns">▦</button>
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
            <div class="summary-columns-popover" id="summary-columns-popover" hidden></div>
        `;
        container.appendChild(panel);

        makeElementDraggable(panel);

        panel.querySelector('.summary-panel__close').addEventListener('click', () => {
            panel.hidden = true;
            hidePopover(panel);
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

        const columnsBtn = panel.querySelector('.summary-panel__columns');
        columnsBtn?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            togglePopover(panel);
        });

        document.addEventListener('click', (ev) => {
            const popover = panel.querySelector('#summary-columns-popover');
            if (!popover || popover.hidden) return;
            if (!popover.contains(ev.target) && !columnsBtn.contains(ev.target)) {
                hidePopover(panel);
            }
        });

        const onEscape = (ev) => {
            if (ev.key !== 'Escape') return;
            const popover = panel.querySelector('#summary-columns-popover');
            if (popover && !popover.hidden) {
                hidePopover(panel);
                return;
            }
            if (!panel.hidden) {
                panel.hidden = true;
                document.removeEventListener('keydown', onEscape);
            }
        };
        document.addEventListener('keydown', onEscape);
    }

    panel.hidden = false;

    panel._summaryState = {
        aggregateBlocks,
        sections,
        summaryMeta,
        visibleColumns: [...visibleColumns],
        onColumnsChange,
    };

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
    renderSections(panel.querySelector('#summary-sections'), sections, panel._summaryState.visibleColumns);
    renderColumnsPopover(panel);

    panel.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        if (key) el.textContent = t(key);
    });
    panel.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        const key = el.dataset.i18nAria;
        if (key) {
            const label = t(key);
            el.setAttribute('aria-label', label);
            if (!el.title || el.title === el.getAttribute('aria-label')) el.title = label;
        }
    });
}

function togglePopover(panel) {
    const popover = panel.querySelector('#summary-columns-popover');
    if (!popover) return;
    if (popover.hidden) {
        renderColumnsPopover(panel);
        popover.hidden = false;
    } else {
        popover.hidden = true;
    }
}

function hidePopover(panel) {
    const popover = panel.querySelector('#summary-columns-popover');
    if (popover) popover.hidden = true;
}

function renderColumnsPopover(panel) {
    const popover = panel.querySelector('#summary-columns-popover');
    if (!popover) return;
    const state = panel._summaryState;
    if (!state) return;

    const visibleSet = new Set(state.visibleColumns);
    const groups = new Map();
    for (const col of COLUMN_DEFS) {
        if (!groups.has(col.group)) groups.set(col.group, []);
        groups.get(col.group).push(col);
    }

    let html = `<div class="summary-columns-popover__header">
        <strong>${escapeHtml(t('summary.columns.title'))}</strong>
        <button type="button" class="summary-columns-popover__reset">${escapeHtml(t('summary.columns.reset'))}</button>
    </div>`;

    for (const [groupId, cols] of groups) {
        html += `<fieldset class="summary-columns-popover__group">
            <legend>${escapeHtml(t(`summary.columns.group.${groupId}`))}</legend>`;
        for (const col of cols) {
            const checked = visibleSet.has(col.id) ? 'checked' : '';
            const disabled = col.id === 'feature' ? 'disabled' : '';
            html += `<label class="summary-columns-popover__item">
                <input type="checkbox" data-column-id="${escapeHtml(col.id)}" ${checked} ${disabled}>
                <span>${escapeHtml(t(col.labelKey))}</span>
            </label>`;
        }
        html += `</fieldset>`;
    }

    html += `<p class="summary-columns-popover__hint">${escapeHtml(t('summary.columns.hint'))}</p>`;
    popover.innerHTML = html;

    popover.querySelectorAll('input[type="checkbox"][data-column-id]').forEach((input) => {
        input.addEventListener('change', () => {
            const id = input.dataset.columnId;
            const current = new Set(panel._summaryState.visibleColumns);
            if (input.checked) current.add(id); else current.delete(id);
            const ordered = COLUMN_DEFS.filter((c) => current.has(c.id)).map((c) => c.id);
            panel._summaryState.visibleColumns = ordered;
            renderSections(panel.querySelector('#summary-sections'), panel._summaryState.sections, ordered);
            panel._summaryState.onColumnsChange?.(ordered);
        });
    });

    popover.querySelector('.summary-columns-popover__reset')?.addEventListener('click', () => {
        const defaults = [...DEFAULT_VISIBLE_COLUMNS];
        panel._summaryState.visibleColumns = defaults;
        renderColumnsPopover(panel);
        renderSections(panel.querySelector('#summary-sections'), panel._summaryState.sections, defaults);
        panel._summaryState.onColumnsChange?.(defaults);
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

        if (block.items.length >= 1) {
            const table = document.createElement('table');
            table.className = 'summary-table summary-table--breakdown';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>${escapeHtml(t('summary.col.feature'))}</th>
                        <th>${escapeHtml(t('summary.col.area'))}</th>
                        <th>${escapeHtml(t('summary.col.perimeter'))}</th>
                        <th>${escapeHtml(t('summary.col.crop'))}</th>
                        <th>${escapeHtml(t('summary.col.prevCrop'))}</th>
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
                    <td>${escapeHtml(item.prevCropLabel || '—')}</td>
                `;
                tbody.appendChild(tr);
            }
            wrap.appendChild(table);
        }
        host.appendChild(wrap);
    }
}

function renderSections(host, sections, visibleColumns) {
    if (!host) return;
    host.innerHTML = '';
    if (!sections || !sections.length) return;

    const columns = resolveColumns(visibleColumns);

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

            const headRow = columns.map((col) => {
                const label = escapeHtml(t(col.labelKey));
                const title = col.helpKey ? ` title="${escapeHtml(t(col.helpKey))}"` : '';
                return `<th${title}>${label}</th>`;
            }).join('');
            table.innerHTML = `<thead><tr>${headRow}</tr></thead><tbody></tbody>`;
            const tbody = table.querySelector('tbody');

            for (const row of group.rows) {
                const tr = document.createElement('tr');
                tr.innerHTML = columns.map((col) => `<td>${col.render(row)}</td>`).join('');
                tbody.appendChild(tr);
            }

            if (group.uncovered > 0.1) {
                const tr = document.createElement('tr');
                tr.className = 'summary-table__uncovered';
                tr.innerHTML = columns.map((col) => {
                    if (col.id === 'feature') return `<td><em>${escapeHtml(t('summary.uncoveredArea'))}</em></td>`;
                    if (col.id === 'area') return `<td>${escapeHtml(group.uncoveredStr)}</td>`;
                    if (col.id === 'percentSubject') return `<td>${group.uncoveredPercent.toFixed(1)}%</td>`;
                    return `<td>—</td>`;
                }).join('');
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

export function closeSummaryPanel(container) {
    const panel = container?.querySelector('#summary-panel');
    if (panel) {
        panel.hidden = true;
    }
}
