/**
 * History popover (P3 slice B).
 *
 * Renders the floating Cronologia panel with a mini-toolbar (undo / redo /
 * snapshot / manage), an entries list (◉ current, ○ others, 📸 manual), and
 * the “Gestisci” modal dialog (rename / delete / export single snapshot).
 *
 * Wire-up is via `initHistoryPopover(app)` where `app` exposes the methods
 * already defined on the main controller:
 *   - app.state, app.vectorSource, app.pertenenzaSource
 *   - app.undoHistory(), app.redoHistory(), app.promptManualHistorySnapshot()
 *   - app.preferences (read/write via setPreference)
 *   - app.setPreference(key, value), app.setToolbarMessage(msg)
 *
 * Position + open state are persisted via `historyPopoverOpen` and
 * `historyPopoverPosition` preferences.
 */

import { HistoryEngine } from '../io/history.js';
import { t } from '../i18n/i18n.js';

const POPOVER_ID = 'history-popover';
const TOGGLE_ID = 'btn-history-toggle';
const MANAGE_DIALOG_ID = 'history-manage-dialog';

let _bound = false;

export function initHistoryPopover(app) {
    if (_bound) return;
    _bound = true;

    const popover = document.getElementById(POPOVER_ID);
    const toggleBtn = document.getElementById(TOGGLE_ID);
    const undoBtn = document.getElementById('history-undo');
    const redoBtn = document.getElementById('history-redo');
    const snapshotBtn = document.getElementById('history-snapshot');
    const manageBtn = document.getElementById('history-manage');
    const closeBtn = document.getElementById('history-close');
    const listEl = document.getElementById('history-popover-list');
    const statusEl = document.getElementById('history-popover-status');
    const header = document.getElementById('history-popover-header');

    if (!popover || !toggleBtn || !listEl) {
        console.warn('history-popover: required DOM nodes missing.');
        return;
    }

    // ── Open / close ───────────────────────────────────────────────────────
    function setOpen(open) {
        popover.hidden = !open;
        toggleBtn.setAttribute('aria-pressed', String(open));
        if (open) {
            applyStoredPosition();
            refresh();
        }
        app.setPreference?.('historyPopoverOpen', open);
    }
    toggleBtn.addEventListener('click', () => setOpen(popover.hidden));
    closeBtn?.addEventListener('click', () => setOpen(false));

    // ── Mini-toolbar ───────────────────────────────────────────────────────
    undoBtn?.addEventListener('click', () => app.undoHistory());
    redoBtn?.addEventListener('click', () => app.redoHistory());
    snapshotBtn?.addEventListener('click', () => app.promptManualHistorySnapshot());
    manageBtn?.addEventListener('click', () => openManageDialog(app));

    // ── Draggable from header ─────────────────────────────────────────────
    if (header) wireDrag(popover, header, (pos) => {
        app.setPreference?.('historyPopoverPosition', pos);
    });

    // ── Live refresh on any engine mutation ───────────────────────────────
    HistoryEngine.subscribe(() => {
        if (!popover.hidden) refresh();
        // Update toggle badge regardless.
        refreshToggleBadge(toggleBtn, app);
    });

    // ── Initial state ─────────────────────────────────────────────────────
    const initiallyOpen = Boolean(app.preferences?.historyPopoverOpen);
    setOpen(initiallyOpen);
    refreshToggleBadge(toggleBtn, app);

    function refresh() {
        const view = HistoryEngine.inspect(app.state);
        if (!view.entries.length) {
            listEl.hidden = true;
            statusEl.hidden = false;
            statusEl.textContent = t('history.empty');
            return;
        }
        listEl.hidden = false;
        statusEl.hidden = true;
        renderEntries(listEl, view, app);
        updateMiniToolbarState(undoBtn, redoBtn, app);
    }

    function applyStoredPosition() {
        const pos = app.preferences?.historyPopoverPosition;
        if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
            popover.style.left = `${pos.left}px`;
            popover.style.top = `${pos.top}px`;
            popover.style.right = 'auto';
            popover.style.bottom = 'auto';
        }
    }
}

function refreshToggleBadge(toggleBtn, app) {
    try {
        const view = HistoryEngine.inspect(app.state);
        const count = view.entries.length;
        toggleBtn.dataset.historyCount = String(count);
        toggleBtn.title = `${t('tool.history')} (${count})`;
    } catch { /* ignore */ }
}

function updateMiniToolbarState(undoBtn, redoBtn, app) {
    if (undoBtn) undoBtn.disabled = !HistoryEngine.canUndo(app.state);
    if (redoBtn) redoBtn.disabled = !HistoryEngine.canRedo(app.state);
}

function renderEntries(listEl, view, app) {
    listEl.innerHTML = '';
    // Newest first.
    view.entries
        .map((e, idx) => ({ e, idx }))
        .reverse()
        .forEach(({ e, idx }) => {
            const li = document.createElement('li');
            li.className = 'history-popover__item';
            li.dataset.entryId = e.id;
            if (idx === view.cursor) li.classList.add('is-current');
            if (e.kind === 'manual') li.classList.add('is-manual');

            const marker = idx === view.cursor ? '◉'
                : (e.kind === 'manual' ? '📸' : '○');
            const label = resolveEntryLabel(e);
            const time = formatTime(e.ts);
            const meta = formatMeta(e.summary);

            li.innerHTML = `
                <span class="history-popover__marker">${marker}</span>
                <span class="history-popover__body">
                    <span class="history-popover__label"></span>
                    <span class="history-popover__meta">${time} · ${meta}</span>
                </span>
            `;
            li.querySelector('.history-popover__label').textContent = label;

            li.addEventListener('click', () => {
                if (idx === view.cursor) return;
                if (!window.confirm(t('history.confirm.restore', { label }))) return;
                HistoryEngine.restoreById(e.id, app.state, app.vectorSource, app.pertenenzaSource);
                app.clearSelection?.();
                app.updateSummary?.();
                app.layers?.vector?.changed?.();
                app.layers?.pertenenza?.changed?.();
                app.setToolbarMessage?.(t('history.toast.restored', { label }));
            });

            listEl.appendChild(li);
        });
}

function resolveEntryLabel(entry) {
    const raw = entry.label || '';
    if (raw.startsWith('history.') || raw.startsWith('action.')) {
        const translated = t(raw);
        // i18n fallback returns the key itself; show it cleaner if unresolved.
        return translated === raw ? raw.replace(/^history\.entry\.[a-z]+\./, '') : translated;
    }
    return raw || t('history.entry.manual.default');
}

function formatTime(ts) {
    try {
        return new Date(ts).toLocaleTimeString();
    } catch { return ts || ''; }
}

function formatMeta(summary) {
    const n = summary?.features ?? 0;
    const a = summary?.areaSqm ?? 0;
    return `${n} f · ${a.toLocaleString()} m²`;
}

// ── Draggable from header ──────────────────────────────────────────────────
function wireDrag(popover, header, onEnd) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.style.cursor = 'move';

    header.addEventListener('pointerdown', (ev) => {
        // Don’t hijack clicks on buttons inside the header.
        if (ev.target.closest('button')) return;
        dragging = true;
        const rect = popover.getBoundingClientRect();
        startX = ev.clientX;
        startY = ev.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        popover.style.right = 'auto';
        popover.style.bottom = 'auto';
        header.setPointerCapture(ev.pointerId);
    });
    header.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - 100, startLeft + (ev.clientX - startX)));
        const top = Math.max(0, Math.min(window.innerHeight - 60, startTop + (ev.clientY - startY)));
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
    });
    const finish = (ev) => {
        if (!dragging) return;
        dragging = false;
        try { header.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        const rect = popover.getBoundingClientRect();
        onEnd?.({ left: Math.round(rect.left), top: Math.round(rect.top) });
    };
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
}

// ── Manage dialog ──────────────────────────────────────────────────────────
function openManageDialog(app) {
    const dialog = document.getElementById(MANAGE_DIALOG_ID);
    if (!dialog) return;
    const list = document.getElementById('history-manage-list');
    const summary = document.getElementById('history-manage-summary');
    const closeBtn = document.getElementById('history-manage-close');

    function render() {
        const view = HistoryEngine.inspect(app.state);
        const autoN = view.entries.filter((e) => e.kind === 'auto').length;
        const manualN = view.entries.filter((e) => e.kind === 'manual').length;
        summary.textContent = t('history.manage.summary', {
            total: view.entries.length, auto: autoN, manual: manualN,
        });
        list.innerHTML = '';
        view.entries.slice().reverse().forEach((e) => {
            const li = document.createElement('li');
            li.className = 'history-manage-dialog__item';
            if (e.kind === 'manual') li.classList.add('is-manual');
            const label = resolveEntryLabel(e);
            li.innerHTML = `
                <div class="history-manage-dialog__entry">
                    <span class="history-manage-dialog__icon">${e.kind === 'manual' ? '📸' : '○'}</span>
                    <span class="history-manage-dialog__label"></span>
                    <span class="history-manage-dialog__meta"></span>
                </div>
                <div class="history-manage-dialog__row-actions">
                    <button type="button" class="action-button" data-action="rename"></button>
                    <button type="button" class="action-button" data-action="export"></button>
                    <button type="button" class="action-button action-button-danger" data-action="delete"></button>
                </div>
            `;
            li.querySelector('.history-manage-dialog__label').textContent = label;
            li.querySelector('.history-manage-dialog__meta').textContent =
                `${formatTime(e.ts)} · ${formatMeta(e.summary)}`;
            const renameBtn = li.querySelector('[data-action="rename"]');
            const exportBtn = li.querySelector('[data-action="export"]');
            const deleteBtn = li.querySelector('[data-action="delete"]');
            renameBtn.textContent = t('history.manage.rename');
            exportBtn.textContent = t('history.manage.export');
            deleteBtn.textContent = t('history.manage.delete');

            renameBtn.addEventListener('click', () => {
                const next = window.prompt(t('history.manage.renamePrompt'), label);
                if (next === null) return;
                HistoryEngine.renameEntry(e.id, next, app.state);
                render();
            });
            exportBtn.addEventListener('click', () => {
                const dump = HistoryEngine.exportEntry(e.id, app.state);
                if (!dump) return;
                const blob = new Blob([JSON.stringify(dump.featureCollection, null, 2)],
                    { type: 'application/geo+json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'snapshot';
                a.href = url;
                a.download = `history_${safeLabel}_${e.id}.geojson`;
                a.click();
                URL.revokeObjectURL(url);
            });
            deleteBtn.addEventListener('click', () => {
                if (!window.confirm(t('history.manage.deleteConfirm', { label }))) return;
                const res = HistoryEngine.deleteEntry(e.id, app.state);
                if (!res.ok && res.reason === 'baselineProtected') {
                    window.alert(t('history.manage.baselineProtected'));
                    return;
                }
                render();
            });
            list.appendChild(li);
        });
    }

    closeBtn?.addEventListener('click', () => dialog.close('close'), { once: true });
    render();
    if (typeof dialog.showModal === 'function') {
        dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
    }
}
