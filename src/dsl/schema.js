/**
 * DSL Schema — domain-agnostic type definitions and validation primitives.
 *
 * A "domain" is a JSON document describing a set of categories and optional
 * per-feature fields for semantic annotation of map features.
 *
 * Domain JSON shape:
 * {
 *   id: string,           // immutable identifier, e.g. "agriculture"
 *   version: string,      // semver, e.g. "1.0.0"
 *   label: string,        // human-readable name
 *   defaultCategoryId: string | null,
 *   validationMode: "strict" | "flexible",   // domain default (can be overridden)
 *   categories: Category[],
 *   fields: FieldDef[]
 * }
 *
 * Category shape:
 * {
 *   id: string,           // immutable slug, e.g. "grano_tenero"
 *   label: string,
 *   color: string,        // CSS color for fill
 *   stroke: string        // optional stroke override
 * }
 *
 * FieldDef shape:
 * {
 *   id: string,           // e.g. "irrigated"
 *   type: "boolean" | "enum" | "string" | "number",
 *   label: string,
 *   options?: string[],   // only for type "enum"
 *   required: boolean
 * }
 *
 * Feature DSL payload (stored in feature.properties.dsl):
 * {
 *   domainId: string,
 *   categoryId: string,
 *   values: { [fieldId]: any }
 * }
 */

// ─── Field types ──────────────────────────────────────────────────────────────
export const FIELD_TYPES = Object.freeze(['boolean', 'enum', 'string', 'number']);

// ─── Validation modes ─────────────────────────────────────────────────────────
/** strict: invalid values block save/export. */
export const VALIDATION_STRICT   = 'strict';
/** flexible: invalid values produce warnings but do not block. */
export const VALIDATION_FLEXIBLE = 'flexible';
export const VALIDATION_MODES    = Object.freeze([VALIDATION_STRICT, VALIDATION_FLEXIBLE]);

// ─── Internal: validate a single FieldDef ────────────────────────────────────
function validateFieldDef(f, idx) {
    const errs = [];
    if (!f.id || typeof f.id !== 'string')      errs.push(`fields[${idx}].id missing`);
    if (!FIELD_TYPES.includes(f.type))          errs.push(`fields[${idx}].type invalid: ${f.type}`);
    if (typeof f.label !== 'string')             errs.push(`fields[${idx}].label missing`);
    if (f.type === 'enum' && !Array.isArray(f.options)) {
        errs.push(`fields[${idx}] type=enum requires options[]`);
    }
    return errs;
}

// ─── Validate domain JSON structure ──────────────────────────────────────────
/**
 * Validate a domain object against the DSL schema.
 * @param {object} domain
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateDomain(domain) {
    const errors   = [];
    const warnings = [];

    if (!domain || typeof domain !== 'object') {
        return { valid: false, errors: ['domain must be an object'], warnings };
    }

    if (!domain.id || typeof domain.id !== 'string')
        errors.push('domain.id required (string)');
    if (!domain.version || typeof domain.version !== 'string')
        errors.push('domain.version required (semver string)');
    if (!domain.label || typeof domain.label !== 'string')
        warnings.push('domain.label missing — will use id as label');
    if (!VALIDATION_MODES.includes(domain.validationMode))
        warnings.push(`domain.validationMode "${domain.validationMode}" unknown — defaulting to flexible`);

    if (!Array.isArray(domain.categories) || domain.categories.length === 0) {
        errors.push('domain.categories must be a non-empty array');
    } else {
        const ids = new Set();
        domain.categories.forEach((cat, i) => {
            if (!cat.id || typeof cat.id !== 'string')
                errors.push(`categories[${i}].id required`);
            else if (ids.has(cat.id))
                errors.push(`categories[${i}].id duplicate: ${cat.id}`);
            else
                ids.add(cat.id);
            if (!cat.label || typeof cat.label !== 'string')
                warnings.push(`categories[${i}] missing label`);
            if (!cat.color || typeof cat.color !== 'string')
                warnings.push(`categories[${i}] missing color — default will be used`);
        });

        if (domain.defaultCategoryId && !ids.has(domain.defaultCategoryId)) {
            warnings.push(`defaultCategoryId "${domain.defaultCategoryId}" not found in categories`);
        }
    }

    if (Array.isArray(domain.fields)) {
        domain.fields.forEach((f, i) => {
            validateFieldDef(f, i).forEach(e => errors.push(e));
        });
    }

    return { valid: errors.length === 0, errors, warnings };
}

// ─── Validate a feature DSL payload ──────────────────────────────────────────
/**
 * Validate a feature's dsl payload against a loaded domain.
 * @param {object|null} dsl    — feature.properties.dsl
 * @param {object}      domain — validated domain object
 * @param {string}      [mode] — override validation mode ('strict'|'flexible')
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateFeatureDsl(dsl, domain, mode) {
    const errors   = [];
    const warnings = [];
    const validationMode = mode ?? domain.validationMode ?? VALIDATION_FLEXIBLE;

    if (!dsl) {
        // Unassigned feature — always warning, never error
        warnings.push('feature has no DSL assignment');
        return { valid: true, errors, warnings };
    }

    if (dsl.domainId !== domain.id) {
        errors.push(`dsl.domainId "${dsl.domainId}" does not match domain "${domain.id}"`);
    }

    const catIds = new Set((domain.categories ?? []).map(c => c.id));
    if (!dsl.categoryId) {
        errors.push('dsl.categoryId missing');
    } else if (!catIds.has(dsl.categoryId)) {
        errors.push(`dsl.categoryId "${dsl.categoryId}" not found in domain`);
    }

    const values = dsl.values ?? {};
    if (Array.isArray(domain.fields)) {
        domain.fields.forEach(f => {
            const val = values[f.id];
            if (f.required && (val === undefined || val === null || val === '')) {
                errors.push(`required field "${f.id}" is missing`);
            }
            if (val !== undefined && val !== null) {
                if (f.type === 'boolean' && typeof val !== 'boolean') {
                    errors.push(`field "${f.id}" must be boolean`);
                } else if (f.type === 'number' && typeof val !== 'number') {
                    errors.push(`field "${f.id}" must be number`);
                } else if (f.type === 'string' && typeof val !== 'string') {
                    errors.push(`field "${f.id}" must be string`);
                } else if (f.type === 'enum' && !f.options.includes(val)) {
                    errors.push(`field "${f.id}" value "${val}" not in options [${f.options.join(', ')}]`);
                }
            }
        });
    }

    // In flexible mode, downgrade errors to warnings for feature-level check
    if (validationMode === VALIDATION_FLEXIBLE) {
        return { valid: true, errors: [], warnings: [...warnings, ...errors] };
    }

    return { valid: errors.length === 0, errors, warnings };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Return a category object by id from a domain, or null.
 * @param {object} domain
 * @param {string} categoryId
 * @returns {object|null}
 */
export function getCategoryById(domain, categoryId) {
    return domain?.categories?.find(c => c.id === categoryId) ?? null;
}

/**
 * Build an empty feature DSL payload for a given domain + category.
 * @param {string} domainId
 * @param {string} categoryId
 * @param {object[]} fields
 * @returns {object}
 */
export function buildDslPayload(domainId, categoryId, fields = []) {
    const values = {};
    fields.forEach(f => {
        if (f.type === 'boolean')      values[f.id] = false;
        else if (f.type === 'number')  values[f.id] = null;
        else if (f.type === 'enum')    values[f.id] = f.options?.[0] ?? null;
        else                           values[f.id] = '';
    });
    return { domainId, categoryId, values };
}
