/**
 * DSL Loader — loads domain definitions and manages user overrides.
 *
 * Loading strategy (layered merge):
 *   1. Fetch built-in domain JSON from /domains/<id>.json
 *   2. Merge user overrides stored in localStorage under key `dsl:override:<id>`
 *      (user can rename categories, add custom categories, change colors)
 *   3. Validate merged result; log warnings, surface errors in strict mode
 *
 * Registry: the loader maintains an in-memory registry of loaded domains.
 * Call `registerDomain()` to add a domain at runtime (e.g. from file import).
 */

import { validateDomain, VALIDATION_FLEXIBLE } from './schema.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const LS_OVERRIDE_PREFIX  = 'dsl:override:';
const LS_REGISTRY_KEY     = 'dsl:customDomains';
const BUILTIN_DOMAIN_IDS  = ['agriculture'];

// ─── In-memory registry ───────────────────────────────────────────────────────
/** @type {Map<string, object>} domainId → merged domain object */
const _registry = new Map();

// ─── Fetch built-in domain JSON ───────────────────────────────────────────────
/**
 * Fetch a built-in domain from /domains/<id>.json.
 * Returns null if not found or fetch fails.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function fetchBuiltinDomain(id) {
    try {
        const res = await fetch(`/domains/${id}.json`);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

// ─── Load user overrides from localStorage ────────────────────────────────────
/**
 * Load and merge user overrides for a domain from localStorage.
 * Overrides can remap category labels, colors, and add new categories.
 * @param {object} base   — base domain object
 * @returns {object}      — merged domain (does not mutate base)
 */
function applyUserOverrides(base) {
    const raw = localStorage.getItem(LS_OVERRIDE_PREFIX + base.id);
    if (!raw) return base;

    let overrides;
    try {
        overrides = JSON.parse(raw);
    } catch {
        console.warn(`[DSL] invalid JSON in override for domain "${base.id}" — ignoring`);
        return base;
    }

    // Deep-clone base to avoid mutations
    const merged = structuredClone(base);

    // Merge top-level scalar fields (label, defaultCategoryId, validationMode)
    for (const key of ['label', 'defaultCategoryId', 'validationMode']) {
        if (overrides[key] !== undefined) merged[key] = overrides[key];
    }

    // Merge categories: update existing by id, append new ones
    if (Array.isArray(overrides.categories)) {
        const catMap = new Map(merged.categories.map(c => [c.id, c]));
        for (const cat of overrides.categories) {
            if (!cat.id) continue;
            if (catMap.has(cat.id)) {
                Object.assign(catMap.get(cat.id), cat);
            } else {
                catMap.set(cat.id, cat);
            }
        }
        merged.categories = [...catMap.values()];
    }

    // Merge fields: update existing by id, append new ones
    if (Array.isArray(overrides.fields)) {
        const fieldMap = new Map(merged.fields.map(f => [f.id, f]));
        for (const field of overrides.fields) {
            if (!field.id) continue;
            if (fieldMap.has(field.id)) {
                Object.assign(fieldMap.get(field.id), field);
            } else {
                fieldMap.set(field.id, field);
            }
        }
        merged.fields = [...fieldMap.values()];
    }

    return merged;
}

// ─── Persist user overrides ───────────────────────────────────────────────────
/**
 * Persist user overrides for a domain to localStorage.
 * @param {string} domainId
 * @param {object} overrides — partial domain object (only changed parts)
 */
export function saveUserOverrides(domainId, overrides) {
    localStorage.setItem(LS_OVERRIDE_PREFIX + domainId, JSON.stringify(overrides));
}

/**
 * Clear all user overrides for a domain.
 * @param {string} domainId
 */
export function clearUserOverrides(domainId) {
    localStorage.removeItem(LS_OVERRIDE_PREFIX + domainId);
    // Reload from builtin
    _registry.delete(domainId);
}

// ─── Load a domain into the registry ─────────────────────────────────────────
/**
 * Load a domain by id: fetch builtin, apply overrides, validate, register.
 * @param {string}  id
 * @param {object}  [options]
 * @param {boolean} [options.forceReload] — bypass cache
 * @returns {Promise<{ domain: object|null, errors: string[], warnings: string[] }>}
 */
export async function loadDomain(id, { forceReload = false } = {}) {
    if (!forceReload && _registry.has(id)) {
        return { domain: _registry.get(id), errors: [], warnings: [] };
    }

    const base = await fetchBuiltinDomain(id);
    if (!base) {
        const err = `Domain "${id}" not found in /domains/`;
        console.error(`[DSL] ${err}`);
        return { domain: null, errors: [err], warnings: [] };
    }

    const merged = applyUserOverrides(base);
    const { valid, errors, warnings } = validateDomain(merged);

    if (warnings.length) {
        console.warn(`[DSL] domain "${id}" loaded with warnings:`, warnings);
    }
    if (!valid) {
        console.error(`[DSL] domain "${id}" failed validation:`, errors);
        // Still register a flexible fallback if possible, but flag errors
    }

    _registry.set(id, merged);
    return { domain: valid ? merged : null, errors, warnings };
}

// ─── Register a custom domain at runtime ─────────────────────────────────────
/**
 * Register a custom domain object (e.g. from user file import).
 * Validates, persists to localStorage registry, stores in memory.
 * @param {object} domain
 * @returns {{ success: boolean, errors: string[], warnings: string[] }}
 */
export function registerDomain(domain) {
    const { valid, errors, warnings } = validateDomain(domain);
    if (!valid) return { success: false, errors, warnings };

    _registry.set(domain.id, domain);

    // Persist custom domains list
    const existing = getCustomDomainIds();
    if (!existing.includes(domain.id)) {
        localStorage.setItem(LS_REGISTRY_KEY, JSON.stringify([...existing, domain.id]));
    }
    // Persist full domain as override so it survives reload
    localStorage.setItem(LS_OVERRIDE_PREFIX + domain.id, JSON.stringify(domain));

    return { success: true, errors: [], warnings };
}

/**
 * Return list of custom domain ids saved to localStorage.
 * @returns {string[]}
 */
export function getCustomDomainIds() {
    try {
        const raw = localStorage.getItem(LS_REGISTRY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

// ─── Get a domain from the registry ──────────────────────────────────────────
/**
 * Synchronous get — only works after loadDomain() has been called.
 * @param {string} id
 * @returns {object|null}
 */
export function getDomain(id) {
    return _registry.get(id) ?? null;
}

/**
 * Return all currently loaded domains.
 * @returns {object[]}
 */
export function listLoadedDomains() {
    return [..._registry.values()];
}

// ─── Initialize default domains on startup ───────────────────────────────────
/**
 * Load all built-in domains + any custom domains from localStorage.
 * Call this once at app startup.
 * @returns {Promise<void>}
 */
export async function initDsl() {
    const results = await Promise.all(
        BUILTIN_DOMAIN_IDS.map(id => loadDomain(id))
    );
    results.forEach(({ domain, errors }) => {
        if (!domain && errors.length) {
            console.error('[DSL] failed to load builtin domain:', errors);
        }
    });

    // Load any custom domains registered by the user
    const customIds = getCustomDomainIds();
    for (const id of customIds) {
        if (!_registry.has(id)) {
            // Custom domains are stored as overrides in localStorage
            const raw = localStorage.getItem(LS_OVERRIDE_PREFIX + id);
            if (raw) {
                try {
                    const domain = JSON.parse(raw);
                    const { valid, errors } = validateDomain(domain);
                    if (valid) {
                        _registry.set(id, domain);
                    } else {
                        console.warn(`[DSL] skipping invalid custom domain "${id}":`, errors);
                    }
                } catch {
                    console.warn(`[DSL] could not parse custom domain "${id}" from localStorage`);
                }
            }
        }
    }
}

// ─── Validation mode helpers ──────────────────────────────────────────────────
/**
 * Resolve the effective validation mode for a domain, with optional override.
 * @param {object} domain
 * @param {string|null} [globalOverride]
 * @returns {'strict'|'flexible'}
 */
export function resolveValidationMode(domain, globalOverride = null) {
    if (globalOverride === 'strict' || globalOverride === 'flexible') {
        return globalOverride;
    }
    return domain?.validationMode ?? VALIDATION_FLEXIBLE;
}
