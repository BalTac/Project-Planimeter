/**
 * Attach right-click / Escape context-menu logic to the OL map viewport.
 *
 * @param {{
 *   map:            import('ol').Map,
 *   elements:       { contextMenu: HTMLElement, ctxCancelDraw: HTMLElement },
 *   getIsDrawing:   () => boolean,
 *   getMode:        () => string,
 *   abortActiveDraw: () => void,
 * }} options
 */
export function initContextMenu({ map, elements, getIsDrawing, getMode, abortActiveDraw }) {
    const viewport = map.getViewport();

    viewport.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const mode = getMode();
        if (
            (mode === 'draw' || mode === 'measure-straight' || mode === 'measure-polyline') &&
            getIsDrawing()
        ) {
            const rect = viewport.getBoundingClientRect();
            showContextMenu(
                elements.contextMenu,
                event.clientX - rect.left,
                event.clientY - rect.top,
                viewport,
            );
        }
    });

    elements.ctxCancelDraw.addEventListener('click', () => {
        abortActiveDraw();
        elements.contextMenu.hidden = true;
    });

    document.addEventListener('mousedown', (event) => {
        if (!elements.contextMenu.hidden && !elements.contextMenu.contains(event.target)) {
            elements.contextMenu.hidden = true;
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elements.contextMenu.hidden) {
            elements.contextMenu.hidden = true;
        }
    });
}

/**
 * Position and reveal the context menu, clamping to viewport edges.
 * @param {HTMLElement} menu
 * @param {number}      x      — pixel offset from viewport left
 * @param {number}      y      — pixel offset from viewport top
 * @param {HTMLElement} container
 */
function showContextMenu(menu, x, y, container) {
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    menu.hidden     = false;

    // Clamp so the menu never overflows the map viewport.
    const mW = menu.offsetWidth;
    const mH = menu.offsetHeight;
    if (x + mW > container.clientWidth)  menu.style.left = `${Math.max(0, x - mW)}px`;
    if (y + mH > container.clientHeight) menu.style.top  = `${Math.max(0, y - mH)}px`;
}
