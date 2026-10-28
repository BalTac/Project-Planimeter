/**
 * PAC Crop Rotation Engine & Multi-Year Evaluation (BCAA 7, Eco-schema 4, 5-Year Rules).
 *
 * Implements CAP 2023-2027 conditionality and eco-scheme validation on a 5-year rolling window:
 * - BCAA 7 (GAEC 7): Ban on monoculture of the same botanical genus (e.g. Triticum -> Triticum),
 *   with derogation for Organic / SQNPI certified cultivation methods.
 * - Eco-schema 4: Prohibits consecutive straw cereals (depauperating -> depauperating) on arable land,
 *   requiring soil-improving legumes or renewal crops.
 * - 5-Year Rules: Monitors set-aside / fallow duration (max 4 years under Eco4), temporary forage
 *   reaching 5 consecutive years, and 5-year crop diversity (SRA01).
 */

import { calculateIntersectionMetrics } from '../geometry/intersection.js';
import { t } from '../i18n/i18n.js';

/**
 * Determine the botanical/agronomical profile of a crop category.
 * @param {object} domain
 * @param {string} categoryId
 * @returns {object|null}
 */
export function getCategoryPacProfile(domain, categoryId) {
    if (!domain || !categoryId) return null;
    const cat = domain.categories?.find((c) => c.id === categoryId);
    if (!cat) return null;
    const resolvedLabel = cat.labelKey ? t(cat.labelKey) : (cat.label || cat.id);
    return {
        id: cat.id,
        label: (resolvedLabel && resolvedLabel !== cat.labelKey) ? resolvedLabel : (cat.label || cat.id),
        botanicalGenus: cat.botanicalGenus || cat.id,
        pacGroup: cat.pacGroup || 'other',
        cycleType: cat.cycleType || 'annual',
        eco4Role: cat.eco4Role || 'exempt',
    };
}

/**
 * Normalise an OpenLayers Feature or GeoJSON Feature to EPSG:4326 for intersection against stored GeoJSON.
 * @param {any} feature
 * @returns {any}
 */
function toEpsg4326Input(feature) {
    const geom = typeof feature?.getGeometry === 'function' ? feature.getGeometry() : null;
    if (!geom || typeof geom.clone !== 'function') return feature?.geometry || feature;
    const extent = typeof geom.getExtent === 'function' ? geom.getExtent() : null;
    const isWebMercator = Array.isArray(extent) && (Math.abs(extent[0]) > 180 || Math.abs(extent[2]) > 180 || Math.abs(extent[1]) > 90 || Math.abs(extent[3]) > 90);
    if (!isWebMercator) return geom;
    const cloned = geom.clone();
    if (typeof cloned.transform === 'function') {
        cloned.transform('EPSG:3857', 'EPSG:4326');
    }
    return cloned;
}

/**
 * Extract spatial/historical crop occurrences for a feature from past campaigns.
 *
 * @param {import('ol').Feature|object} feature
 * @param {number} currentYear
 * @param {Array<object>} campaigns - array of CampaignSnapshot from CampaignStore
 * @param {object} domain
 * @returns {Array<{ campaignId: string, label: string, year: number, matches: Array<object> }>}
 */
export function resolveFeatureHistoryChain(feature, currentYear, campaigns = [], domain) {
    if (!feature || !Array.isArray(campaigns)) return [];

    const pastCampaigns = campaigns
        .filter((c) => Number(c?.year) < Number(currentYear))
        .sort((a, b) => Number(b.year) - Number(a.year))
        .slice(0, 5); // Max 5 previous years

    const featureUuid = feature.get?.('uuid') || feature.properties?.uuid;
    const featureId = feature.get?.('featureId') || feature.properties?.featureId;
    const originUuid = feature.get?.('originFeatureUuid') || feature.properties?.originFeatureUuid;

    const historyChain = [];
    let cachedSubject4326 = null;

    for (const campaign of pastCampaigns) {
        const pastFeatures = (campaign.features?.features || []).filter(
            (f) => (f.properties?.overlayLayer ?? 'user') === 'user'
        );
        if (!pastFeatures.length) continue;

        const matchedEntries = [];

        // Step A: Fast path by stable UUID / originUuid / featureId
        const directHit = pastFeatures.find((pf) => {
            const p = pf.properties || {};
            return (featureUuid && p.uuid === featureUuid) ||
                   (originUuid && p.uuid === originUuid) ||
                   (featureId && p.featureId === featureId);
        });

        if (directHit) {
            const dsl = directHit.properties?.dsl;
            const categoryId = dsl?.categoryId || null;
            const profile = getCategoryPacProfile(domain, categoryId);
            matchedEntries.push({
                featureId: directHit.properties?.featureId || null,
                featureName: directHit.properties?.featureName || null,
                categoryId,
                categoryLabel: profile?.label || categoryId || t('dsl.category.unassigned'),
                variety: dsl?.values?.variety || '',
                fertilization: dsl?.values?.fertilization || '',
                coverageRatio: 1.0,
                botanicalGenus: profile?.botanicalGenus || null,
                pacGroup: profile?.pacGroup || 'other',
                cycleType: profile?.cycleType || 'annual',
                eco4Role: profile?.eco4Role || 'exempt',
            });
        } else {
            // Step B: Spatial intersection fallback for divided/merged/reshaped plots
            if (!cachedSubject4326) {
                cachedSubject4326 = toEpsg4326Input(feature);
            }
            for (const pf of pastFeatures) {
                const metrics = calculateIntersectionMetrics(cachedSubject4326, pf.geometry || pf, {
                    ratioBase: 'subject',
                    sourceProjection: 'EPSG:4326',
                    targetProjection: 'EPSG:4326',
                    includeIntersectionGeometry: false,
                });
                if (metrics && metrics.coverageRatioSubject >= 0.08) { // At least 8% coverage
                    const dsl = pf.properties?.dsl;
                    const categoryId = dsl?.categoryId || null;
                    const profile = getCategoryPacProfile(domain, categoryId);
                    matchedEntries.push({
                        featureId: pf.properties?.featureId || null,
                        featureName: pf.properties?.featureName || null,
                        categoryId,
                        categoryLabel: profile?.label || categoryId || t('dsl.category.unassigned'),
                        variety: dsl?.values?.variety || '',
                        fertilization: dsl?.values?.fertilization || '',
                        coverageRatio: metrics.coverageRatioSubject,
                        botanicalGenus: profile?.botanicalGenus || null,
                        pacGroup: profile?.pacGroup || 'other',
                        cycleType: profile?.cycleType || 'annual',
                        eco4Role: profile?.eco4Role || 'exempt',
                    });
                }
            }
            matchedEntries.sort((a, b) => b.coverageRatio - a.coverageRatio);
        }

        if (matchedEntries.length > 0) {
            historyChain.push({
                campaignId: campaign.id,
                label: campaign.label || String(campaign.year),
                year: Number(campaign.year),
                matches: matchedEntries,
            });
        }
    }

    return historyChain;
}

/**
 * Evaluate a candidate crop against an area's historical crop chain.
 *
 * @param {string} candidateCategoryId
 * @param {string} candidateFertilization - 'convenzionale' | 'integrata' | 'biologica' | ''
 * @param {Array<object>} historyChain - returned by resolveFeatureHistoryChain
 * @param {object} domain
 * @returns {{
 *   status: 'ok' | 'exempt_bio_sqnpi' | 'warning_eco4' | 'warning_5yr' | 'forbidden_bcaa7',
 *   badge: string,
 *   shortReason: string,
 *   details: string[]
 * }}
 */
export function evaluatePacRotation(candidateCategoryId, candidateFertilization, historyChain = [], domain) {
    if (!candidateCategoryId || !domain) {
        return {
            status: 'ok',
            badge: '✅',
            shortReason: 'Nessuna verifica richiesta',
            details: [],
        };
    }

    const candidateProfile = getCategoryPacProfile(domain, candidateCategoryId);
    if (!candidateProfile) {
        return { status: 'ok', badge: '✅', shortReason: 'OK', details: [] };
    }

    // Permanent crops (vines, olives, orchards) are exempt from annual crop rotation rules
    if (candidateProfile.cycleType === 'permanent') {
        return {
            status: 'ok',
            badge: '✅',
            shortReason: 'Coltura permanente (esente da rotazione)',
            details: ['Le colture arboree/permanenti non sono soggette a obbligo di rotazione annuale.'],
        };
    }

    if (!historyChain || historyChain.length === 0) {
        return {
            status: 'ok',
            badge: '✅',
            shortReason: 'Primo anno registrato (ammesso)',
            details: ['Nessuno storico precedente registrato per questo appezzamento.'],
        };
    }

    const prevYear = historyChain[0]; // Most recent previous campaign (T-1)
    const prevMatches = (prevYear?.matches || []).filter((m) => m.categoryId && m.coverageRatio >= 0.15);

    const isBioOrSqnpi = candidateFertilization === 'biologica' || candidateFertilization === 'integrata';
    const details = [];

    // ── Check 1: BCAA 7 (Monoculture of same botanical genus) ─────────────────
    for (const prev of prevMatches) {
        const sameGenus = prev.botanicalGenus && prev.botanicalGenus === candidateProfile.botanicalGenus;
        const bothAnnualArable = prev.cycleType === 'annual' && candidateProfile.cycleType === 'annual';
        const isFallowOrForage = prev.pacGroup === 'fallow' || candidateProfile.pacGroup === 'fallow' ||
                                 prev.pacGroup === 'forage' || candidateProfile.pacGroup === 'forage';

        if (sameGenus && bothAnnualArable && !isFallowOrForage) {
            const coverageStr = prev.coverageRatio < 0.95 ? ` (${Math.round(prev.coverageRatio * 100)}% sup.)` : '';
            if (isBioOrSqnpi) {
                return {
                    status: 'exempt_bio_sqnpi',
                    badge: 'ℹ️',
                    shortReason: `Ammesso con deroga Bio/SQNPI (stesso genere ${candidateProfile.botanicalGenus} in ${prevYear.label})`,
                    details: [
                        `Nell'anno ${prevYear.label} era presente ${prev.categoryLabel}${coverageStr} (genere botanico: ${prev.botanicalGenus}).`,
                        'La BCAA 7 vieta la monosuccessione dello stesso genere botanico, ma consente la deroga per le aziende in Biologico certificato o Produzione Integrata (SQNPI).',
                    ],
                };
            }
            return {
                status: 'forbidden_bcaa7',
                badge: '⛔',
                shortReason: `Violazione BCAA 7: monosuccessione genere ${candidateProfile.botanicalGenus} da ${prevYear.label}`,
                details: [
                    `Nell'anno ${prevYear.label} era presente ${prev.categoryLabel}${coverageStr} (genere botanico: ${prev.botanicalGenus}).`,
                    'Norma BCAA 7: è obbligatorio cambiare genere botanico tra due annate consecutive sui seminativi.',
                    'Per renderla ammissibile senza sanzioni PAC occorre alternare con una diversa famiglia botanica (es. leguminose o colture da rinnovo) o adottare metodo Biologico/SQNPI.',
                ],
            };
        }
    }

    // ── Check 2: Eco-schema 4 (Consecutive straw cereals) ────────────────────
    for (const prev of prevMatches) {
        if (prev.eco4Role === 'depauperating' && candidateProfile.eco4Role === 'depauperating') {
            const coverageStr = prev.coverageRatio < 0.95 ? ` (${Math.round(prev.coverageRatio * 100)}% sup.)` : '';
            return {
                status: 'warning_eco4',
                badge: '⚠️',
                shortReason: `Attenzione Eco-schema 4: ristoppio tra cereali a paglia da ${prevYear.label}`,
                details: [
                    `BCAA 7 rispettata (generi diversi: ${prev.botanicalGenus} → ${candidateProfile.botanicalGenus}).`,
                    `Tuttavia per l'adesione a Eco-schema 4 (ECO4) è vietato far succedere due cereali a paglia depauperanti (${prev.categoryLabel}${coverageStr} → ${candidateProfile.label}).`,
                    'Per richiedere il premio Eco-schema 4 è necessario inserire nel biennio una coltura miglioratrice (leguminosa) o da rinnovo (es. girasole, sorgo, soia) o riposo.',
                ],
            };
        }
    }

    // ── Check 3: 5-Year Rules (Fallow max 4 years, Forage 5-year check, SRA01) ─
    if (candidateProfile.pacGroup === 'fallow') {
        let consecutiveFallow = 0;
        for (const year of historyChain) {
            const hasFallow = (year.matches || []).some((m) => m.pacGroup === 'fallow' && m.coverageRatio >= 0.5);
            if (hasFallow) consecutiveFallow += 1;
            else break;
        }
        if (consecutiveFallow >= 4) {
            return {
                status: 'warning_5yr',
                badge: '⚠️',
                shortReason: `Limite 5 anni: terreno a riposo consecutivo da ${consecutiveFallow} anni`,
                details: [
                    `Quest'area risulta a riposo/set-aside ininterrottamente da ${consecutiveFallow} anni.`,
                    'Eco-schema 4 ammette terreni a riposo per un massimo di 4 anni consecutivi.',
                    'Al 5° anno continuativo di riposo la superficie rischia la perdita della qualifica di seminativo ordinario.',
                ],
            };
        }
    }

    if (candidateProfile.id === 'prato') {
        let consecutiveMeadow = 0;
        for (const year of historyChain) {
            const hasMeadow = (year.matches || []).some((m) => (m.categoryId === 'prato' || m.id === 'prato') && m.coverageRatio >= 0.5);
            if (hasMeadow) consecutiveMeadow += 1;
            else break;
        }
        if (consecutiveMeadow >= 4) {
            details.push(
                `Prato presente da ${consecutiveMeadow} anni consecutivi. Al compimento del 5° anno la PAC consente di mantenerlo a seminativo o dichiararlo prato permanente.`
            );
        }
    }

    // SRA01 5-year crop diversity check (at least 3 distinct crops in 5-year window)
    if (historyChain.length >= 3 && candidateProfile.cycleType === 'annual') {
        const distinctGenera = new Set([candidateProfile.botanicalGenus]);
        for (const year of historyChain.slice(0, 4)) {
            for (const m of year.matches || []) {
                if (m.botanicalGenus && m.coverageRatio >= 0.25) {
                    distinctGenera.add(m.botanicalGenus);
                }
            }
        }
        if (distinctGenera.size < 3) {
            details.push(
                `Nota quinquennale (SRA01): nell'arco delle ultime ${historyChain.length + 1} stagioni risultano solo ${distinctGenera.size} generi colturali distinti (consigliati almeno 3 nel quinquennio).`
            );
        }
    }

    return {
        status: 'ok',
        badge: '✅',
        shortReason: 'Rotazione PAC ammessa',
        details: details.length ? details : ['La rotazione rispetta i criteri BCAA 7 ed Eco-schema 4.'],
    };
}

/**
 * Pre-evaluate all categories in domain for a given feature.
 *
 * @param {import('ol').Feature} feature
 * @param {string} candidateFertilization
 * @param {number} currentYear
 * @param {Array<object>} campaigns
 * @param {object} domain
 * @returns {{ historyChain: Array<object>, evaluations: Record<string, { status: string, badge: string, shortReason: string, details: string[] }> }}
 */
export function evaluateAllCategoriesForFeature(feature, candidateFertilization, currentYear, campaigns = [], domain) {
    const results = {};
    if (!domain || !Array.isArray(domain.categories)) {
        return { historyChain: [], evaluations: results };
    }

    const historyChain = resolveFeatureHistoryChain(feature, currentYear, campaigns, domain);

    for (const cat of domain.categories) {
        results[cat.id] = evaluatePacRotation(cat.id, candidateFertilization, historyChain, domain);
    }

    return {
        historyChain,
        evaluations: results,
    };
}
