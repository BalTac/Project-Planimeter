import { t } from '../i18n/i18n.js';

/**
 * Command palette overlay (Ctrl+K). Builds a runtime registry of
 * `view | mode | action | toggle` commands by scraping the toolbar
 * DOM so it stays in sync as new buttons are added.
 *
 * @param {object} app — the Planimeter instance (needs setMode,
 *                       setToolbarPanel, setSnapEnabled, state).
 */
export function initCommandPalette(app) {
    const overlay = document.getElementById('command-palette');
    const input   = document.getElementById('command-palette-input');
    const list    = document.getElementById('command-palette-list');
    const empty   = document.getElementById('command-palette-empty');
    if (!overlay || !input || !list || !empty) return;

    let activeIndex = 0;
    let filtered = [];

    function buildRegistry() {
        const cmds = [];

        document.querySelectorAll('.toolbar-tab[data-panel]').forEach((btn) => {
            cmds.push({
                id: `view.${btn.dataset.panel}`,
                label: `${t('palette.group.view')}: ${btn.textContent.trim()}`,
                run: () => app.setToolbarPanel(btn.dataset.panel),
            });
        });

        document.querySelectorAll('[data-mode]').forEach((btn) => {
            cmds.push({
                id: `mode.${btn.dataset.mode}`,
                label: `${t('palette.group.mode')}: ${btn.textContent.trim()}`,
                run: () => app.setMode(btn.dataset.mode),
            });
        });

        document
            .querySelectorAll('#panel-operate button[id^="btn-"], #panel-settings button[id^="btn-"]')
            .forEach((btn) => {
                if (btn.disabled || btn.hidden) return;
                cmds.push({
                    id: btn.id,
                    label: `${t('palette.group.action')}: ${btn.textContent.trim()}`,
                    run: () => btn.click(),
                });
            });

        cmds.push({
            id: 'toggle.snap',
            label: `${t('palette.group.toggle')}: ${t('snap.toggle.label')} (${app.state.snapEnabled ? 'ON → OFF' : 'OFF → ON'})`,
            run: () => app.setSnapEnabled(!app.state.snapEnabled),
        });

        return cmds;
    }

    function render(query) {
        const q = query.trim().toLowerCase();
        const all = buildRegistry();
        filtered = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;

        list.innerHTML = '';
        filtered.forEach((cmd, idx) => {
            const li = document.createElement('li');
            li.className = 'command-palette__item' + (idx === activeIndex ? ' is-active' : '');
            li.textContent = cmd.label;
            li.setAttribute('role', 'option');
            li.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                executeAt(idx);
            });
            list.appendChild(li);
        });
        empty.hidden = filtered.length > 0;
    }

    function setActive(idx) {
        if (!filtered.length) return;
        activeIndex = (idx + filtered.length) % filtered.length;
        [...list.children].forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
        list.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    function executeAt(idx) {
        const cmd = filtered[idx];
        if (!cmd) return;
        close();
        cmd.run();
    }

    function open() {
        overlay.hidden = false;
        input.value = '';
        activeIndex = 0;
        render('');
        setTimeout(() => input.focus(), 0);
    }

    function close() {
        overlay.hidden = true;
    }

    function toggle() {
        if (overlay.hidden) open(); else close();
    }

    input.addEventListener('input', () => {
        activeIndex = 0;
        render(input.value);
    });

    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(activeIndex + 1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(activeIndex - 1); }
        else if (ev.key === 'Enter')  { ev.preventDefault(); executeAt(activeIndex); }
        else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    });

    overlay.querySelectorAll('[data-cp-close]').forEach((el) => el.addEventListener('click', close));

    document.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
            ev.preventDefault();
            toggle();
        }
    });
}

/**
 * Static keyboard shortcuts overlay (toggled by `?`).
 */
export function initShortcutsOverlay() {
    const overlay = document.getElementById('shortcuts-overlay');
    if (!overlay) return;
    const close  = () => { overlay.hidden = true; };
    const toggle = () => { overlay.hidden = !overlay.hidden; };

    overlay.querySelectorAll('[data-shortcuts-close]').forEach((el) => el.addEventListener('click', close));

    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !overlay.hidden) {
            ev.preventDefault();
            close();
            return;
        }
        if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) {
            const target = ev.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            ev.preventDefault();
            toggle();
        }
    });
}
