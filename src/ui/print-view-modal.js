import { t } from '../i18n/i18n.js';
import { listCampaigns } from '../io/persistence.js';
import { getDomain } from '../dsl/loader.js';
import { getCategoryById } from '../dsl/schema.js';
import { aggregateByCategory, totalAggArea } from '../dsl/aggregation.js';
import { resolveFeatureHistoryChain, evaluatePacRotation } from '../dsl/pac-rotation.js';
import { calculateArea } from '../geometry/calculations.js';

/**
 * Draw a rounded rectangle path on a 2D canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number|number[]} r
 */
function roundRect(ctx, x, y, w, h, r = 8) {
    const radius = typeof r === 'number' ? [r, r, r, r] : r;
    ctx.beginPath();
    ctx.moveTo(x + radius[0], y);
    ctx.lineTo(x + w - radius[1], y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius[1]);
    ctx.lineTo(x + w, y + h - radius[2]);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius[2], y + h);
    ctx.lineTo(x + radius[3], y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius[3]);
    ctx.lineTo(x, y + radius[0]);
    ctx.quadraticCurveTo(x, y, x + radius[0], y);
    ctx.closePath();
}

/**
 * Format square meters into hectares with Italian locale format.
 * @param {number} m2
 * @returns {string}
 */
function formatHectares(m2) {
    const ha = m2 / 10000;
    return `${ha.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}

/**
 * Format square meters with integer thousands separator.
 * @param {number} m2
 * @returns {string}
 */
function formatSquareMeters(m2) {
    return `${Math.round(m2).toLocaleString('it-IT')} m²`;
}

/**
 * Calculate the interior/anchor coordinate for a polygon/multipolygon feature.
 * @param {import('ol').Feature} feature
 * @returns {import('ol/coordinate').Coordinate|null}
 */
function getFeatureInteriorCoordinate(feature) {
    const geom = feature?.getGeometry?.();
    if (!geom) return null;
    const type = geom.getType();
    if (type === 'Polygon') {
        return geom.getInteriorPoint().getCoordinates();
    }
    if (type === 'MultiPolygon') {
        const interiorPoints = geom.getInteriorPoints();
        const coords = interiorPoints?.getCoordinates?.();
        if (coords && coords.length > 0) return coords[0];
    }
    const extent = geom.getExtent();
    return [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
}

/**
 * Controller for the Printable View Modal and Canvas Composition.
 */
export class PrintViewModalController {
    /**
     * @param {import('../planimeter.js').PlanimeterApp} planimeter
     */
    constructor(planimeter) {
        this.planimeter = planimeter;

        // DOM elements
        this.dialog = document.getElementById('print-preview-modal');
        this.btnClose = document.getElementById('btn-print-preview-close');
        this.btnCancel = document.getElementById('btn-print-preview-cancel');
        this.btnTrigger = document.getElementById('btn-print-view');
        this.btnPrint = document.getElementById('btn-print-preview-print');
        this.btnDownload = document.getElementById('btn-print-preview-download');

        this.formatSelect = document.getElementById('print-preview-format');
        this.titleInput = document.getElementById('print-preview-title');

        this.optSatFade = document.getElementById('print-preview-opt-satellite-fade');
        this.optCatasto = document.getElementById('print-preview-opt-catasto');
        this.optLabels = document.getElementById('print-preview-opt-labels');
        this.optPac = document.getElementById('print-preview-opt-pac');
        this.optLegend = document.getElementById('print-preview-opt-legend');

        this.canvas = document.getElementById('print-preview-canvas');
        this.spinner = document.getElementById('print-preview-spinner');
        this.printSheet = document.getElementById('printable-print-sheet');
        this.printImg = document.getElementById('printable-print-img');

        this.renderedCanvas = null;
        this.renderDebounceTimer = null;

        this.bindEvents();
    }

    bindEvents() {
        if (this.btnTrigger) {
            this.btnTrigger.addEventListener('click', () => this.open());
        }

        const closeHandler = () => this.close();
        this.btnClose?.addEventListener('click', closeHandler);
        this.btnCancel?.addEventListener('click', closeHandler);

        // Re-render when any option or control changes
        const reRenderHandler = () => this.scheduleRender();
        this.formatSelect?.addEventListener('change', reRenderHandler);
        this.titleInput?.addEventListener('input', reRenderHandler);
        this.optSatFade?.addEventListener('change', reRenderHandler);
        this.optCatasto?.addEventListener('change', reRenderHandler);
        this.optLabels?.addEventListener('change', reRenderHandler);
        this.optPac?.addEventListener('change', reRenderHandler);
        this.optLegend?.addEventListener('change', reRenderHandler);

        this.btnDownload?.addEventListener('click', () => this.downloadPng());
        this.btnPrint?.addEventListener('click', () => this.print());

        // Close on ESC
        this.dialog?.addEventListener('cancel', () => {
            this.close();
        });
    }

    open() {
        if (!this.dialog) return;

        // Auto-generate title from active campaign and current date
        const campaigns = listCampaigns();
        const activeCampaign = campaigns.find((c) => c.id === this.planimeter.state.activeCampaignId);
        const currYear = Number(this.planimeter.state.activeCampaignYear) || new Date().getFullYear();
        const seasonName = activeCampaign?.label || `${currYear}-${currYear + 1}`;
        const monthName = new Date().toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
        const capMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

        if (this.titleInput && (!this.titleInput.value || this.titleInput.value.startsWith('Coltivazioni'))) {
            this.titleInput.value = `Coltivazioni ${seasonName} (${capMonth})`;
        }

        this.dialog.hidden = false;
        if (typeof this.dialog.showModal === 'function') {
            this.dialog.showModal();
        }

        // Render preview canvas
        this.renderPreview();
    }

    close() {
        if (!this.dialog) return;
        if (typeof this.dialog.close === 'function') {
            this.dialog.close();
        }
        this.dialog.hidden = true;
    }

    scheduleRender() {
        if (this.renderDebounceTimer) {
            clearTimeout(this.renderDebounceTimer);
        }
        this.renderDebounceTimer = setTimeout(() => {
            this.renderPreview();
        }, 120);
    }

    /**
     * Compose and render the high-resolution printable map canvas.
     */
    renderPreview() {
        if (!this.canvas) return;
        if (this.spinner) this.spinner.hidden = false;

        try {
            const format = this.formatSelect?.value || 'a4-landscape';
            const titleText = String(this.titleInput?.value || '').trim();
            const doSatFade = Boolean(this.optSatFade?.checked);
            const doHighContrastCatasto = Boolean(this.optCatasto?.checked);
            const doLabels = Boolean(this.optLabels?.checked);
            const doPac = Boolean(this.optPac?.checked);
            const doLegend = Boolean(this.optLegend?.checked);

            // Determine dimensions based on paper format
            let targetWidth = 2480; // A4 Landscape at ~214 DPI (297mm x 210mm)
            let targetHeight = 1754;

            const mapSize = this.planimeter.map.getSize() || [1200, 800];
            const viewportRatio = mapSize[0] / mapSize[1];

            if (format === 'a3-landscape') {
                targetWidth = 3508;
                targetHeight = 2480;
            } else if (format === 'viewport') {
                targetWidth = Math.round(mapSize[0] * 1.5);
                targetHeight = Math.round(mapSize[1] * 1.5);
            }

            // Capture the viewport composite canvas
            const composite = this.planimeter.buildViewportCompositeCanvas(1.5, {
                attenuateSatellite: doSatFade,
                highContrastCadastral: doHighContrastCatasto,
            });

            if (!composite || !composite.canvas) {
                if (this.spinner) this.spinner.hidden = true;
                return;
            }

            const sourceCanvas = composite.canvas;

            // Prepare target canvas
            this.canvas.width = targetWidth;
            this.canvas.height = targetHeight;
            const ctx = this.canvas.getContext('2d');
            if (!ctx) return;

            // Fill clean white background
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetWidth, targetHeight);

            // Cover/Fill drawing calculation to avoid distortion
            const targetRatio = targetWidth / targetHeight;
            let srcW = sourceCanvas.width;
            let srcH = sourceCanvas.height;
            let srcX = 0;
            let srcY = 0;

            if (format === 'viewport') {
                ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
            } else if (sourceCanvas.width / sourceCanvas.height > targetRatio) {
                // Source is wider than target paper: crop horizontally centered
                srcW = Math.round(sourceCanvas.height * targetRatio);
                srcX = Math.round((sourceCanvas.width - srcW) / 2);
                ctx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, targetWidth, targetHeight);
            } else {
                // Source is taller than target paper: crop vertically centered
                srcH = Math.round(sourceCanvas.width / targetRatio);
                srcY = Math.round((sourceCanvas.height - srcH) / 2);
                ctx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, targetWidth, targetHeight);
            }

            // Subtle outer border
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
            ctx.lineWidth = 2;
            ctx.strokeRect(1, 1, targetWidth - 2, targetHeight - 2);

            // ── Vector Plot Labels ──────────────────────────────────────────────
            if (doLabels) {
                this.renderPlotLabels(ctx, {
                    targetWidth,
                    targetHeight,
                    sourceWidth: sourceCanvas.width,
                    sourceHeight: sourceCanvas.height,
                    srcX,
                    srcY,
                    srcW,
                    srcH,
                    sourceScale: composite.scale,
                });
            }

            // ── Title Cartouche ─────────────────────────────────────────────────
            if (titleText) {
                this.renderTitleCartouche(ctx, titleText, targetWidth);
            }

            // ── PAC & Surface Cartouche ─────────────────────────────────────────
            if (doPac) {
                this.renderPacSurfaceCartouche(ctx, targetWidth, targetHeight);
            }

            // ── Color Legend Cartouche ──────────────────────────────────────────
            if (doLegend) {
                this.renderColorLegendCartouche(ctx, targetWidth, targetHeight);
            }

            // ── Metadata Stamp (Bottom Right) ───────────────────────────────────
            this.renderMetadataStamp(ctx, targetWidth, targetHeight);

            this.renderedCanvas = this.canvas;
        } catch (error) {
            console.error('Failed to render printable preview canvas:', error);
        } finally {
            if (this.spinner) this.spinner.hidden = true;
        }
    }

    /**
     * Render crop name and surface labels at the centroid of each field polygon.
     */
    renderPlotLabels(ctx, transformInfo) {
        const features = this.planimeter.vectorSource.getFeatures();
        if (!features.length) return;

        const map = this.planimeter.map;
        const domain = getDomain(this.planimeter.state.dslActiveDomainId);
        const proj = this.planimeter.view?.getProjection();

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        features.forEach((feature) => {
            const coord = getFeatureInteriorCoordinate(feature);
            if (!coord) return;

            const mapPixel = map.getPixelFromCoordinate(coord);
            if (!mapPixel) return;

            // Map pixel to composite source canvas
            const compX = mapPixel[0] * transformInfo.sourceScale;
            const compY = mapPixel[1] * transformInfo.sourceScale;

            // Check if within source crop window
            if (
                compX < transformInfo.srcX ||
                compX > transformInfo.srcX + transformInfo.srcW ||
                compY < transformInfo.srcY ||
                compY > transformInfo.srcY + transformInfo.srcH
            ) {
                return;
            }

            // Map to target canvas coordinates
            const targetX = ((compX - transformInfo.srcX) / transformInfo.srcW) * transformInfo.targetWidth;
            const targetY = ((compY - transformInfo.srcY) / transformInfo.srcH) * transformInfo.targetHeight;

            // Extract label info
            const dsl = feature.get('dsl');
            const category = domain && dsl?.categoryId ? getCategoryById(domain, dsl.categoryId) : null;
            const cropName = category?.label || feature.get('featureName') || feature.get('featureId') || 'Area';
            const areaM2 = calculateArea(feature, proj);
            const areaText = `${Math.round(areaM2).toLocaleString('it-IT')} m²`;

            // Draw crisp high-contrast label (double stroke for readability)
            ctx.font = 'bold 22px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

            // Background text halo
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.lineWidth = 6;
            ctx.lineJoin = 'round';
            ctx.strokeText(cropName, targetX, targetY - 12);

            ctx.font = '600 19px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.strokeText(areaText, targetX, targetY + 14);

            // Dark foreground text
            ctx.font = 'bold 22px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#0f172a';
            ctx.fillText(cropName, targetX, targetY - 12);

            ctx.font = '600 19px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#1e293b';
            ctx.fillText(areaText, targetX, targetY + 14);
        });

        ctx.restore();
    }

    /**
     * Render the elegant title cartouche at the top center.
     */
    renderTitleCartouche(ctx, titleText, targetWidth) {
        ctx.save();
        ctx.font = 'bold 26px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const textMetrics = ctx.measureText(titleText);
        const boxWidth = Math.max(480, textMetrics.width + 60);
        const boxHeight = 62;
        const boxX = (targetWidth - boxWidth) / 2;
        const boxY = 28;

        // Soft drop shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 6;

        // Card background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
        roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 14);
        ctx.fill();

        // Reset shadow for border and text
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 14);
        ctx.stroke();

        // Title text
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#091512';
        ctx.fillText(titleText, targetWidth / 2, boxY + boxHeight / 2 + 1);

        ctx.restore();
    }

    /**
     * Render the "Superfici Approssimative & Conformità PAC" cartouche at top right.
     */
    renderPacSurfaceCartouche(ctx, targetWidth, _targetHeight) {
        const features = this.planimeter.vectorSource.getFeatures();
        const domain = getDomain(this.planimeter.state.dslActiveDomainId);
        const proj = this.planimeter.view?.getProjection();

        // Calculate surface aggregations
        const rows = domain ? aggregateByCategory(features, domain, proj) : [];
        const totalAreaM2 = totalAggArea(rows);

        // Calculate PAC rotation evaluations
        const campaigns = listCampaigns();
        const currYear = Number(this.planimeter.state.activeCampaignYear) || new Date().getFullYear();
        let totalAssigned = 0;
        let bcaa7Issues = 0;
        let eco4Warnings = 0;

        features.forEach((feature) => {
            const dsl = feature.get('dsl');
            const catId = dsl?.categoryId;
            if (!catId) return;
            totalAssigned += 1;

            const fertilization = dsl?.values?.fertilization || '';
            const historyChain = resolveFeatureHistoryChain(feature, currYear, campaigns, domain);
            const res = evaluatePacRotation(catId, fertilization, historyChain, domain);
            if (res.status === 'forbidden_bcaa7') bcaa7Issues += 1;
            else if (res.status === 'warning_eco4') eco4Warnings += 1;
        });

        const boxWidth = 440;
        const rowHeight = 28;
        const headerHeight = 44;
        const pacHeaderHeight = 36;
        const pacRowsHeight = 56;
        const padding = 20;

        const calculatedHeight =
            headerHeight +
            Math.max(1, rows.length) * rowHeight +
            36 + // Total row
            pacHeaderHeight +
            pacRowsHeight +
            padding * 2;

        const boxX = targetWidth - boxWidth - 30;
        const boxY = 28;

        ctx.save();

        // Card drop shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 6;

        // Card background (clean parchment / light warm background like the Photoshop reference)
        ctx.fillStyle = 'rgba(255, 254, 245, 0.96)';
        roundRect(ctx, boxX, boxY, boxWidth, calculatedHeight, 12);
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(120, 100, 60, 0.40)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, boxX, boxY, boxWidth, calculatedHeight, 12);
        ctx.stroke();

        // Header Title
        let currY = boxY + padding + 16;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 18px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#1e293b';
        ctx.fillText('SUPERFICI APPROSSIMATIVE', boxX + padding, currY);

        currY += 24;

        // Separator line
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(boxX + padding, currY);
        ctx.lineTo(boxX + boxWidth - padding, currY);
        ctx.stroke();

        currY += 16;

        // Crop Rows
        ctx.font = '16px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        if (rows.length === 0) {
            ctx.fillStyle = '#64748b';
            ctx.fillText('Nessuna coltura assegnata', boxX + padding, currY);
            currY += rowHeight;
        } else {
            rows.forEach((row) => {
                const swatchSize = 14;
                ctx.fillStyle = row.color || '#4caf50';
                ctx.fillRect(boxX + padding, currY - swatchSize / 2, swatchSize, swatchSize);
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
                ctx.lineWidth = 1;
                ctx.strokeRect(boxX + padding, currY - swatchSize / 2, swatchSize, swatchSize);

                // Crop name
                ctx.fillStyle = '#1e293b';
                ctx.textAlign = 'left';
                ctx.font = '600 16px "Segoe UI Variable", sans-serif';
                ctx.fillText(row.label, boxX + padding + swatchSize + 10, currY);

                // Area and percentage
                const pct = totalAreaM2 > 0 ? ((row.areaM2 / totalAreaM2) * 100).toFixed(1) : '0.0';
                const areaStr = `${formatHectares(row.areaM2)} (${pct}%)`;

                ctx.textAlign = 'right';
                ctx.font = '500 16px "Segoe UI Variable", sans-serif';
                ctx.fillText(areaStr, boxX + boxWidth - padding, currY);

                currY += rowHeight;
            });
        }

        // Total Surface Row
        ctx.beginPath();
        ctx.moveTo(boxX + padding, currY);
        ctx.lineTo(boxX + boxWidth - padding, currY);
        ctx.stroke();

        currY += 18;
        ctx.textAlign = 'left';
        ctx.font = 'bold 17px "Segoe UI Variable", sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.fillText('TOTALE SUPERFICIE', boxX + padding, currY);

        ctx.textAlign = 'right';
        ctx.fillText(formatHectares(totalAreaM2), boxX + boxWidth - padding, currY);

        currY += 26;

        // PAC Section Header
        ctx.beginPath();
        ctx.moveTo(boxX + padding, currY);
        ctx.lineTo(boxX + boxWidth - padding, currY);
        ctx.stroke();

        currY += 18;
        ctx.textAlign = 'left';
        ctx.font = 'bold 15px "Segoe UI Variable", sans-serif';
        ctx.fillStyle = '#1e293b';
        ctx.fillText('CONFORMITÀ PAC 2023-2027', boxX + padding, currY);

        currY += 22;

        // BCAA 7 Status
        const bcaa7Ok = bcaa7Issues === 0;
        ctx.fillStyle = bcaa7Ok ? '#16a34a' : '#dc2626';
        ctx.beginPath();
        ctx.arc(boxX + padding + 6, currY, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.textAlign = 'left';
        ctx.font = '15px "Segoe UI Variable", sans-serif';
        ctx.fillStyle = '#1e293b';
        ctx.fillText(
            bcaa7Ok ? 'BCAA 7 (Rotazione): Conforme' : `BCAA 7: Non conforme (${bcaa7Issues} appezzamenti)`,
            boxX + padding + 18,
            currY,
        );

        currY += 22;

        // Eco-schema 4 Status
        const eco4Ok = eco4Warnings === 0;
        ctx.fillStyle = eco4Ok ? '#16a34a' : '#d97706';
        ctx.beginPath();
        ctx.arc(boxX + padding + 6, currY, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#1e293b';
        ctx.fillText(
            eco4Ok ? 'Eco-schema 4: Conforme' : `Eco-schema 4: Verificare avvicendamento (${eco4Warnings})`,
            boxX + padding + 18,
            currY,
        );

        ctx.restore();
    }

    /**
     * Render the color legend cartouche at bottom left.
     */
    renderColorLegendCartouche(ctx, _targetWidth, targetHeight) {
        const features = this.planimeter.vectorSource.getFeatures();
        const domain = getDomain(this.planimeter.state.dslActiveDomainId);
        const proj = this.planimeter.view?.getProjection();
        const rows = domain ? aggregateByCategory(features, domain, proj) : [];

        if (rows.length === 0) return;

        const boxWidth = 340;
        const rowHeight = 26;
        const padding = 16;
        const calculatedHeight = 42 + rows.length * rowHeight + padding * 2;
        const boxX = 30;
        const boxY = targetHeight - calculatedHeight - 30;

        ctx.save();

        // Card shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 6;

        // Card background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
        roundRect(ctx, boxX, boxY, boxWidth, calculatedHeight, 12);
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, boxX, boxY, boxWidth, calculatedHeight, 12);
        ctx.stroke();

        // Header Title
        let currY = boxY + padding + 12;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 16px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.fillText('LEGENDA COLTURE', boxX + padding, currY);

        currY += 20;

        // Divider
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(boxX + padding, currY);
        ctx.lineTo(boxX + boxWidth - padding, currY);
        ctx.stroke();

        currY += 16;

        // Rows
        rows.forEach((row) => {
            const swatchW = 20;
            const swatchH = 14;

            ctx.fillStyle = row.color || '#4caf50';
            ctx.fillRect(boxX + padding, currY - swatchH / 2, swatchW, swatchH);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.lineWidth = 1;
            ctx.strokeRect(boxX + padding, currY - swatchH / 2, swatchW, swatchH);

            ctx.textAlign = 'left';
            ctx.font = '600 15px "Segoe UI Variable", sans-serif';
            ctx.fillStyle = '#1e293b';
            ctx.fillText(row.label, boxX + padding + swatchW + 12, currY);

            currY += rowHeight;
        });

        ctx.restore();
    }

    /**
     * Render the metadata and attribution stamp at bottom right.
     */
    renderMetadataStamp(ctx, targetWidth, targetHeight) {
        const boxWidth = 320;
        const boxHeight = 44;
        const boxX = targetWidth - boxWidth - 30;
        const boxY = targetHeight - boxHeight - 30;

        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 8);
        ctx.fill();

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.20)';
        ctx.lineWidth = 1;
        roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 8);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '600 13px "Segoe UI Variable", sans-serif';
        ctx.fillStyle = '#334155';
        const nowStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
        ctx.fillText(`Planimeter · Progetto BALTAC | Data: ${nowStr}`, boxX + boxWidth / 2, boxY + boxHeight / 2);

        ctx.restore();
    }

    /**
     * Download the rendered canvas as high-resolution PNG image.
     */
    downloadPng() {
        if (!this.renderedCanvas) return;
        const filename = `planimeter-mappa-stampabile-${new Date().toISOString().slice(0, 10)}.png`;
        const success = this.planimeter.downloadCanvasAsPng(this.renderedCanvas, filename);
        if (success) {
            this.planimeter.showToast(t('printView.downloadSuccess') || 'Immagine scaricata con successo', 'success');
        }
    }

    /**
     * Trigger browser print dialog with the printable sheet.
     */
    print() {
        if (!this.renderedCanvas || !this.printImg || !this.printSheet) return;

        try {
            const dataUrl = this.renderedCanvas.toDataURL('image/png');
            this.printImg.src = dataUrl;
            this.printSheet.hidden = false;

            // Give the browser image decoder a split second to prepare image
            setTimeout(() => {
                window.print();
                // Clean up after print window closes
                setTimeout(() => {
                    this.printSheet.hidden = true;
                }, 1000);
            }, 100);
        } catch (error) {
            console.error('Failed to trigger print:', error);
            this.planimeter.showToast('Impossibile avviare la stampa: ' + error.message, 'warning');
        }
    }
}
