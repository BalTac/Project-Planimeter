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
 *     mergeWithDefault?: boolean,
 *     position?: 'before' | 'after',
 *     insertAfterAction?: string,
 *   } | null,
 * }} options
 */
export function initContextMenu({
    map,
    elements,
    getIsDrawing,
    getMode,
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
        const feature   = resolved?.feature ?? candidates[0] ?? map.forEachFeatureAtPixel(pixel, (f) => f) ?? null;

        const specialMenu = getSpecialContextMenu?.({
            event,
            pixel,
            feature,
            mode,
            isDrawing,
        });

        const defaultItems = buildMenuItems({
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

        const baseActions = {
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
        };

        if (specialMenu?.items?.length) {
            const mergedItems = specialMenu.mergeWithDefault
                ? mergeSpecialItems(defaultItems, specialMenu.items, {
                    position: specialMenu.position,
                    insertAfterAction: specialMenu.insertAfterAction,
                })
                : specialMenu.items;

            renderMenu(contextMenu, mergedItems, {
                ...baseActions,
                ...specialMenu.actions,
            });
            const rect = viewport.getBoundingClientRect();
            showContextMenu(contextMenu, event.clientX - rect.left, event.clientY - rect.top, viewport);
            return;
        }

        if (!defaultItems.length) return;

        renderMenu(contextMenu, defaultItems, baseActions);

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

function appendSeparator(items) {
    if (!items.length) return;
    const last = items[items.length - 1];
    if (last?.separator) return;
    items.push({ separator: true });
}

function mergeSpecialItems(defaultItems, specialItems, options = {}) {
    const { position = 'before', insertAfterAction } = options;
    const cleanDefault = defaultItems.filter(Boolean);
    const cleanSpecial = specialItems.filter(Boolean);

    if (!cleanDefault.length) return cleanSpecial;
    if (!cleanSpecial.length) return cleanDefault;

    if (insertAfterAction) {
        const idx = cleanDefault.findIndex((item) => item?.action === insertAfterAction);
        if (idx >= 0) {
            return [
                ...cleanDefault.slice(0, idx + 1),
                ...cleanSpecial,
                ...cleanDefault.slice(idx + 1),
            ];
        }
    }

    return position === 'after'
        ? [...cleanDefault, ...cleanSpecial]
        : [...cleanSpecial, ...cleanDefault];
}

/**
 * Determine which menu items to show based on current application state.
 * @returns {Array<{key?: string, action?: string, danger?: boolean, separator?: boolean}>}
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
            appendSeparator(items);
        }
        const infoStartIndex = items.length;
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
        if (items.length > infoStartIndex) {
            appendSeparator(items);
        }
        items.push({ key: 'ctx.exportView', action: 'exportView' });
        items.push({ key: 'ctx.exportSelection', action: 'exportSelection' });
        items.push({ key: 'ctx.exportAreas', action: 'exportAreas' });
        if (items[items.length - 1]?.separator) {
            items.pop();
        }
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
 *
 * Supported item shapes:
 *  - { separator: true }
 *  - { key, action, danger?, disabled?, tooltipKey?, tooltip?, label? }
 *  - { key, children: Item[], disabled?, tooltipKey?, tooltip?, label? }   // submenu
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
        list.appendChild(buildMenuListItem(item, actions, menu));
    }
}

function buildMenuListItem(item, actions, rootMenu) {
    const li = document.createElement('li');

    if (item.separator) {
        li.className = 'context-menu-separator';
        li.setAttribute('role', 'separator');
        return li;
    }

    const label = item.label ?? (item.key ? t(item.key, item.labelVars ?? {}) : '');
    const tooltip = item.tooltip ?? (item.tooltipKey ? t(item.tooltipKey) : null);
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;

    if (hasChildren) {
        li.className = 'context-menu-item-wrapper context-menu-has-children';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'context-menu-item'
            + (item.disabled ? ' context-menu-item--disabled' : '')
            + (item.danger ? ' context-menu-item--danger' : '');
        btn.innerHTML = `<span class="context-menu-item__label">${escapeText(label)}</span><span class="context-menu-item__chevron" aria-hidden="true">\u25B8</span>`;
        if (tooltip) btn.title = tooltip;
        if (item.disabled) {
            btn.setAttribute('aria-disabled', 'true');
            btn.disabled = true;
        }
        li.appendChild(btn);

        if (!item.disabled) {
            const submenu = document.createElement('ul');
            submenu.className = 'context-menu-list context-menu-submenu';
            for (const child of item.children) {
                submenu.appendChild(buildMenuListItem(child, actions, rootMenu));
            }
            li.appendChild(submenu);
        }
        return li;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item'
        + (item.danger ? ' context-menu-item--danger' : '')
        + (item.disabled ? ' context-menu-item--disabled' : '');
    btn.textContent = label;
    if (tooltip) btn.title = tooltip;

    if (item.disabled) {
        btn.setAttribute('aria-disabled', 'true');
        btn.disabled = true;
    } else {
        btn.addEventListener('click', () => {
            rootMenu.hidden = true;
            Promise.resolve(actions[item.action]?.(item))
                .catch((error) => {
                    console.error('Context menu action failed:', item.action, error);
                });
        });
    }
    li.appendChild(btn);
    return li;
}

function escapeText(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
