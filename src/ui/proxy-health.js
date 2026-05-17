import { t } from '../i18n/i18n.js';

/**
 * Monitors the Python WMS proxy health endpoint (/proxy-health) and
 * reflects status in the sidebar stats panel.
 */
export class ProxyHealthMonitor {
    /**
     * @param {{
     *   elements: { statProxyHealth: HTMLElement, proxyHealthDetail: HTMLElement },
     *   onHealthChange?: (status: string, message: string) => void
     * }} options
     */
    constructor({ elements, onHealthChange }) {
        this.elements        = elements;
        this.onHealthChange  = onHealthChange ?? null;
        this.status          = 'checking';
        this.message         = '';
        this.requestPending  = false;
        this.intervalId      = null;
    }

    /**
     * Called whenever the catasto checkbox or source selector changes.
     * Starts or stops the polling interval accordingly.
     *
     * @param {boolean} catastoChecked  — whether the catasto layer toggle is on
     * @param {string}  catastoSource   — 'official' | 'fallback'
     */
    update(catastoChecked, catastoSource) {
        if (!catastoChecked || catastoSource !== 'official') {
            this.stop();
            this.setHealth('checking', t('proxy.awaitCatasto'));
            return;
        }
        if (!this.intervalId) {
            this.intervalId = window.setInterval(() => this.check({ silent: true }), 45_000);
        }
        this.check();
    }

    stop() {
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.requestPending = false;
    }

    /**
     * Run a single health check against /proxy-health.
     * @param {{ silent?: boolean }} [options]
     */
    async check(options = {}) {
        if (this.requestPending) return;
        this.requestPending = true;
        if (!options.silent) this.setHealth('checking', t('proxy.checkInProgress'));

        try {
            const res = await fetch(
                new URL('/proxy-health', window.location.origin),
                { cache: 'no-store', headers: { Accept: 'application/json' } },
            );
            let payload = null;
            try { payload = await res.json(); } catch (_) { /* ignore parse error */ }

            if (!res.ok || !payload?.ok) {
                throw new Error(payload?.message ?? `HTTP ${res.status}`);
            }

            const detail = typeof payload.durationMs === 'number'
                ? `${payload.message} — ${payload.durationMs} ms`
                : payload.message;
            const quotaSuffix = await this.fetchQuotaSuffix();
            this.setHealth('ok', quotaSuffix ? `${detail} · ${quotaSuffix}` : detail);
        } catch (err) {
            const detail = err instanceof Error ? err.message : t('proxy.unreachable');
            this.setHealth('ko', detail);
        } finally {
            this.requestPending = false;
        }
    }

    async fetchQuotaSuffix() {
        try {
            const res = await fetch(
                new URL('/request-quota-status', window.location.origin),
                { cache: 'no-store', headers: { Accept: 'application/json' } },
            );
            if (!res.ok) return '';
            const payload = await res.json();
            if (!payload?.ok) return '';

            const used = Number(payload.used);
            const limit = Number(payload.limit);
            const remaining = Number(payload.remaining_estimate);
            if (!Number.isFinite(used) || !Number.isFinite(limit) || !Number.isFinite(remaining)) return '';

            return t('quota.estimate', {
                used: Math.max(0, Math.floor(used)),
                limit: Math.max(1, Math.floor(limit)),
                remaining: Math.max(0, Math.floor(remaining)),
            });
        } catch {
            return '';
        }
    }

    /**
     * Update internal state and re-render.
     * @param {'ok'|'ko'|'checking'} status
     * @param {string} message
     */
    setHealth(status, message) {
        this.status  = status;
        this.message = message;
        this.render();
        this.onHealthChange?.(status, message);
    }

    /** Sync DOM to current status/message. Safe to call at any time. */
    render() {
        const labelMap = {
            ok:       t('proxy.ok'),
            ko:       t('proxy.ko'),
            checking: t('proxy.checking'),
        };
        const el  = this.elements.statProxyHealth;
        const det = this.elements.proxyHealthDetail;

        el.textContent = labelMap[this.status] ?? t('proxy.checking');
        el.classList.remove('status-ok', 'status-ko', 'status-checking');
        el.classList.add(`status-${this.status === 'ok' ? 'ok' : this.status === 'ko' ? 'ko' : 'checking'}`);
        if (det) det.textContent = this.message;
    }
}
