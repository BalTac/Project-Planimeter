import { t } from '../i18n/i18n.js';

/**
 * Attach right-click / Escape context-menu logic to the OL map viewport.
 *
 * Context-aware: shows different items depending on current mode,
 * whether drawing is active and whether a feature is under the cursor.
 *
 * @param {{
 *   map:                import('ol').Map,
 *   elements:           { contextMenu: HTMLElement },
 *   getIsDrawing:       () => boolean,
 *   getMode:            () => string,
 *   getSelectedFeature?: () => import('ol/Feature').default | null,
 *   abortActiveDraw:    () => void,
 *   canQueryParcel:     () => boolean,
 *   editFeature:        (feature: import('ol/Feature').default) => void,
 *   assignCategory?:    (feature: import('ol/Feature').default) => void,
 *   deleteFeature:      (feature: import('ol/Feature').default) => void,
 *   resyncParcelMetadata?: (feature: import('ol/Feature').default) => void | Promise<void>,
 *   queryParcelAtPixel: (pixel: number[]) => void,
 *   detectParcelM3AtPixel?: (pixel: number[]) => void | Promise<void>,
 *   refineParcelM3ForFeature?: (feature: import('ol/Feature').default, pixel: number[]) => void | Promise<void>,
 *   startHoleDrawForFeature?: (feature: import('ol/Feature').default, pixel: number[]) => void | Promise<void>,
 *   exportView?:        () => void,
 *   exportSelection?:   () => void,
 *   exportAreas?:       () => void,
 *   canRefreshWmsTile?: () => boolean,
 *   refreshTileAtPixel?: (pixel: number[]) => void,
 *   copyCoordinatesAtPixel?: (pixel: number[]) => void | Promise<void>,
 *   resolveContextFeaturesAtPixel?: (pixel: number[]) => {
 *     feature: import('ol/Feature').default | null,
 *     candidates: import('ol/Feature').default[],
 *   },
 *   getSpecialContextMenu?: (ctx: {
 *     event: MouseEvent,
 *     pixel: number[],
 *     feature: import('ol/Feature').default | null,
 *     mode: string,
 *     isDrawing: boolean,
 *   }) => {
 *     items: Array<{key: string, action: string, danger?: boolean}>,
 *     actions?: Record<string, () => void>,
 *   } | null,
 * }} options
 */
export function initContextMenu({
    map,
    elements,
    getIsDrawing,
    getMode,
    getSelectedFeature,
    abortActiveDraw,
    canQueryParcel,
    editFeature,
    assignCategory,
    deleteFeature,
    resyncParcelMetadata,
    queryParcelAtPixel,
    detectParcelM3AtPixel,
    refineParcelM3ForFeature,
    startHoleDrawForFeature,
    exportView,
    exportSelection,
    exportAreas,
    canRefreshWmsTile,
    refreshTileAtPixel,
    copyCoordinatesAtPixel,
    resolveContextFeaturesAtPixel,
    getSpecialContextMenu,
}) {
    const { contextMenu } = elements;
    const viewport = map.getViewport();

    viewport.addEventListener('contextmenu', (event) => {
        event.preventDefault();

        const mode      = getMode();
        const isDrawing = getIsDrawing();
        const pixel     = map.getEventPixel(event);
        const resolved  = resolveContextFeaturesAtPixel?.(pixel);
        const candidates = Array.isArray(resolved?.candidates) ? resolved.candidates : [];
        const selectedFeature = getSelectedFeature?.() ?? null;
        const feature   = resolved?.feature ?? candidates[0] ?? map.forEachFeatureAtPixel(pixel, (f) => f) ?? selectedFeature ?? null;

        const specialMenu = getSpecialContextMenu?.({
            event,
            pixel,
            feature,
            mode,
            isDrawing,
        });

        if (specialMenu?.items?.length) {
            renderMenu(contextMenu, specialMenu.items, {
                ...specialMenu.actions,
                abortActiveDraw,
                editFeature:        () => editFeature(feature, pixel, candidates),
                assignCategory:     () => assignCategory?.(feature, pixel, candidates),
                deleteFeature:      () => deleteFeature(feature, pixel, candidates),
                resyncParcelMetadata: () => resyncParcelMetadata?.(feature, pixel, candidates),
                queryParcelAtPixel: () => queryParcelAtPixel(pixel),
                detectParcelM3AtPixel: () => detectParcelM3AtPixel?.(pixel),
                refineParcelM3ForFeature: () => refineParcelM3ForFeature?.(feature, pixel, candidates),
                startHoleDrawForFeature: () => startHoleDrawForFeature?.(feature, pixel, candidates),
                refreshTileAtPixel: () => refreshTileAtPixel?.(pixel),
                copyCoordinatesAtPixel: () => copyCoordinatesAtPixel?.(pixel),
                exportView,
                exportSelection,
                exportAreas,
            });
            const rect = viewport.getBoundingClientRect();
            showContextMenu(contextMenu, event.clientX - rect.left, event.clientY - rect.top, viewport);
            return;
        }

        const items = buildMenuItems({
            mode,
            isDrawing,
            feature,
            canQueryParcel,
            canRefreshWmsTile,
            canCopyCoordinates: typeof copyCoordinatesAtPixel === 'function',
            detectParcelM3AtPixel: typeof detectParcelM3AtPixel === 'function',
            refineParcelM3ForFeature: typeof refineParcelM3ForFeature === 'function',
            startHoleDrawForFeature: typeof startHoleDrawForFeature === 'function',
        });
        if (!items.length) return;

        renderMenu(contextMenu, items, {
            abortActiveDraw,
            editFeature:        () => editFeature(feature, pixel, candidates),
            assignCategory:     () => assignCategory?.(feature, pixel, candidates),
            deleteFeature:      () => deleteFeature(feature, pixel, candidates),
            resyncParcelMetadata: () => resyncParcelMetadata?.(feature, pixel, candidates),
            queryParcelAtPixel: () => queryParcelAtPixel(pixel),
            detectParcelM3AtPixel: () => detectParcelM3AtPixel?.(pixel),
            refineParcelM3ForFeature: () => refineParcelM3ForFeature?.(feature, pixel, candidates),
            startHoleDrawForFeature: () => startHoleDrawForFeature?.(feature, pixel, candidates),
            refreshTileAtPixel: () => refreshTileAtPixel?.(pixel),
            copyCoordinatesAtPixel: () => copyCoordinatesAtPixel?.(pixel),
            exportView,
            exportSelection,
            exportAreas,
        });

        const rect = viewport.getBoundingClientRect();
        showContextMenu(contextMenu, event.clientX - rect.left, event.clientY - rect.top, viewport);
    });

    document.addEventListener('mousedown', (event) => {
        if (!contextMenu.hidden && !contextMenu.contains(event.target)) {
            contextMenu.hidden = true;
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !contextMenu.hidden) {
            contextMenu.hidden = true;
        }
    });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Determine which menu items to show based on current application state.
 * @returns {Array<{key: string, action: string, danger?: boolean}>}
 */
function buildMenuItems({ mode, isDrawing, feature, canQueryParcel, canRefreshWmsTile, canCopyCoordinates, detectParcelM3AtPixel, refineParcelM3ForFeature, startHoleDrawForFeature }) {
    // During active drawing: single "cancel" item
    if (isDrawing && (mode === 'draw' || mode === 'measure-straight' || mode === 'measure-polyline')) {
        return [{ key: 'ctx.cancelDraw', action: 'abortActiveDraw' }];
    }

    // Navigate mode: context-sensitive actions
    if (mode === 'navigate') {
        const items = [];
        if (feature) {
            const type = feature.getGeometry?.()?.getType?.();
            const isPolygon = type === 'Polygon' || type === 'MultiPolygon';
            items.push({ key: 'ctx.editFeature',   action: 'editFeature' });
            if (isPolygon) {
                if (startHoleDrawForFeature) {
                    items.push({ key: 'ctx.drawHole', action: 'startHoleDrawForFeature' });
                }
                items.push({ key: 'ctx.assignCategory', action: 'assignCategory' });
                if (refineParcelM3ForFeature) {
                    items.push({ key: 'ctx.refineParcelM3', action: 'refineParcelM3ForFeature' });
                }
                if (feature.get('overlayLayer') === 'pertenenze') {
                    items.push({ key: 'ctx.resyncParcelMetadata', action: 'resyncParcelMetadata' });
                }
            }
            items.push({ key: 'ctx.deleteFeature', action: 'deleteFeature', danger: true });
        }
        if (canQueryParcel()) {
            items.push({ key: 'ctx.queryParcel', action: 'queryParcelAtPixel' });
            if (!feature && detectParcelM3AtPixel) {
                items.push({ key: 'ctx.detectParcelM3', action: 'detectParcelM3AtPixel' });
            }
        }
        if (canRefreshWmsTile?.()) {
            items.push({ key: 'ctx.refreshTile', action: 'refreshTileAtPixel' });
        }
        if (canCopyCoordinates) {
            items.push({ key: 'ctx.copyCoordinates', action: 'copyCoordinatesAtPixel' });
        }
        items.push({ key: 'ctx.exportView', action: 'exportView' });
        items.push({ key: 'ctx.exportSelection', action: 'exportSelection' });
        items.push({ key: 'ctx.exportAreas', action: 'exportAreas' });
        return items;
    }

    if (mode === 'edit') {
        const items = [];
        const type = feature?.getGeometry?.()?.getType?.();
        const isPolygon = type === 'Polygon' || type === 'MultiPolygon';
        if (isPolygon && startHoleDrawForFeature) {
            items.push({ key: 'ctx.drawHole', action: 'startHoleDrawForFeature' });
        }
        return items;
    }

    return [];
}

/**
 * Clear and re-render the context menu's item list.
 */
function renderMenu(menu, items, actions) {
    let list = menu.querySelector('ul');
    if (!list) {
        list = document.createElement('ul');
        list.className = 'context-menu-list';
        menu.appendChild(list);
    }
    list.innerHTML = '';

    for (const item of items) {
        const li  = document.createElement('li');
        const btn = document.createElement('button');
        btn.type        = 'button';
        btn.className   = 'context-menu-item' + (item.danger ? ' context-menu-item--danger' : '');
        btn.textContent = t(item.key);
        btn.addEventListener('click', () => {
            menu.hidden = true;
            Promise.resolve(actions[item.action]?.())
                .catch((error) => {
                    console.error('Context menu action failed:', item.action, error);
                });
        });
        li.appendChild(btn);
        list.appendChild(li);
    }
}

/**
 * Position and reveal the context menu, clamping to viewport edges.
 */
function showContextMenu(menu, x, y, container) {
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    menu.hidden     = false;

    const mW = menu.offsetWidth;
    const mH = menu.offsetHeight;
    if (x + mW > container.clientWidth)  menu.style.left = `${Math.max(0, x - mW)}px`;
    if (y + mH > container.clientHeight) menu.style.top  = `${Math.max(0, y - mH)}px`;
}
