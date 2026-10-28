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
 * Normalize an angle in radians into the readable interval [-PI/2, +PI/2] so text is never upside-down.
 * @param {number} rad
 * @returns {number}
 */
function normalizeAngle(rad) {
    let a = rad;
    while (a > Math.PI / 2) a -= Math.PI;
    while (a < -Math.PI / 2) a += Math.PI;
    return a;
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
        this.surfaceFormatSelect = document.getElementById('print-preview-surface-format');

        this.optSatFade = document.getElementById('print-preview-opt-satellite-fade');
        this.optCatasto = document.getElementById('print-preview-opt-catasto');
        this.optLabels = document.getElementById('print-preview-opt-labels');
        this.optOriented = document.getElementById('print-preview-opt-oriented');
        this.optMergeContiguous = document.getElementById('print-preview-opt-merge-contiguous');
        this.optPac = document.getElementById('print-preview-opt-pac');
        this.optLegend = document.getElementById('print-preview-opt-legend');

        this.canvas = document.getElementById('print-preview-canvas');
        this.canvasWrap = document.getElementById('print-preview-canvas-wrap');
        this.btnFullscreen = document.getElementById('btn-print-preview-fullscreen');
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
        this.surfaceFormatSelect?.addEventListener('change', reRenderHandler);
        this.optSatFade?.addEventListener('change', reRenderHandler);
        this.optCatasto?.addEventListener('change', reRenderHandler);
        this.optLabels?.addEventListener('change', reRenderHandler);
        this.optOriented?.addEventListener('change', reRenderHandler);
        this.optMergeContiguous?.addEventListener('change', reRenderHandler);
        this.optPac?.addEventListener('change', reRenderHandler);
        this.optLegend?.addEventListener('change', reRenderHandler);

        this.btnFullscreen?.addEventListener('click', () => this.toggleFullscreen());
        document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
        document.addEventListener('webkitfullscreenchange', () => this.onFullscreenChange());

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
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
        this.canvasWrap?.classList.remove('is-fullscreen');
        this.updateFullscreenButtonState(false);
        if (typeof this.dialog.close === 'function') {
            this.dialog.close();
        }
        this.dialog.hidden = true;
    }

    toggleFullscreen() {
        if (!this.canvasWrap) return;

        if (document.fullscreenElement || this.canvasWrap.classList.contains('is-fullscreen')) {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
            this.canvasWrap.classList.remove('is-fullscreen');
            this.updateFullscreenButtonState(false);
        } else {
            if (typeof this.canvasWrap.requestFullscreen === 'function') {
                this.canvasWrap.requestFullscreen().catch(() => {
                    this.canvasWrap.classList.add('is-fullscreen');
                    this.updateFullscreenButtonState(true);
                });
            } else {
                this.canvasWrap.classList.add('is-fullscreen');
                this.updateFullscreenButtonState(true);
            }
        }
    }

    onFullscreenChange() {
        const isFs = document.fullscreenElement === this.canvasWrap;
        this.updateFullscreenButtonState(isFs);
        if (!isFs) {
            this.canvasWrap?.classList.remove('is-fullscreen');
        }
    }

    updateFullscreenButtonState(isFullscreen) {
        if (!this.btnFullscreen) return;
        const icon = this.btnFullscreen.querySelector('.fullscreen-icon');
        const titleText = isFullscreen
            ? (t('printView.exitFullscreen') || 'Esci da tutto schermo')
            : (t('printView.fullscreen') || 'A tutto schermo');

        this.btnFullscreen.title = titleText;
        this.btnFullscreen.setAttribute('aria-label', titleText);
        if (icon) {
            icon.textContent = isFullscreen ? '🗗' : '⛶';
        }
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
        if (this.spinner) {
            this.spinner.hidden = false;
            this.spinner.style.opacity = '1';
        }

        try {
            const format = this.formatSelect?.value || 'a4-landscape';
            const titleText = String(this.titleInput?.value || '').trim();
            const doSatFade = Boolean(this.optSatFade?.checked);
            const doHighContrastCatasto = Boolean(this.optCatasto?.checked);
            const doLabels = Boolean(this.optLabels?.checked);
            const doOriented = this.optOriented ? Boolean(this.optOriented.checked) : true;
            const doMergeContiguous = this.optMergeContiguous ? Boolean(this.optMergeContiguous.checked) : true;
            const surfaceFormat = this.surfaceFormatSelect?.value || 'compact';
            const doPac = Boolean(this.optPac?.checked);
            const doLegend = Boolean(this.optLegend?.checked);

            // Determine dimensions based on paper format
            let targetWidth = 2480; // A4 Landscape at ~214 DPI (297mm x 210mm)
            let targetHeight = 1754;

            const mapSize = this.planimeter.map.getSize() || [1200, 800];

            if (format === 'a3-landscape') {
                targetWidth = 3508;
                targetHeight = 2480;
            } else if (format === 'viewport') {
                targetWidth = Math.round(mapSize[0] * 1.5);
                targetHeight = Math.round(mapSize[1] * 1.5);
            }

            // Temporarily suppress web labels so the vector layer renders only clean fills & borders
            this.planimeter.state.suppressFeatureLabels = true;
            this.planimeter.layers.vector.changed();
            this.planimeter.layers.pertenenza?.changed?.();
            this.planimeter.map.renderSync();

            // Capture the viewport composite canvas
            const composite = this.planimeter.buildViewportCompositeCanvas(1.5, {
                attenuateSatellite: doSatFade,
                highContrastCadastral: doHighContrastCatasto,
            });

            // Restore web labels immediately
            this.planimeter.state.suppressFeatureLabels = false;
            this.planimeter.layers.vector.changed();
            this.planimeter.layers.pertenenza?.changed?.();
            this.planimeter.map.renderSync();

            if (!composite || !composite.canvas) {
                this.hideSpinner();
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

            // ── Vector Plot Labels (Oriented & Clustered) ─────────────────────────
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
                    doOriented,
                    doMergeContiguous,
                    surfaceFormat,
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
            this.hideSpinner();
        }
    }

    hideSpinner() {
        if (!this.spinner) return;
        this.spinner.style.opacity = '0';
        setTimeout(() => {
            if (this.spinner) {
                this.spinner.hidden = true;
            }
        }, 150);
    }

    /**
     * Convert map coordinates to canvas pixel coordinates.
     */
    mapCoordToCanvasPixel(coord, transformInfo) {
        const mapPixel = this.planimeter.map.getPixelFromCoordinate(coord);
        if (!mapPixel) return null;
        const compX = mapPixel[0] * transformInfo.sourceScale;
        const compY = mapPixel[1] * transformInfo.sourceScale;
        const targetX = ((compX - transformInfo.srcX) / transformInfo.srcW) * transformInfo.targetWidth;
        const targetY = ((compY - transformInfo.srcY) / transformInfo.srcH) * transformInfo.targetHeight;
        return [targetX, targetY];
    }

    /**
     * Compute geometric properties of a polygon in target canvas pixels:
     * - Principal orientation angle
     * - Longitudinal length
     * - Perpendicular thickness
     * - Centroid point
     */
    computeFeatureCanvasMetrics(feature, transformInfo) {
        const geom = feature?.getGeometry?.();
        if (!geom) return null;

        let rings;
        const type = geom.getType();
        if (type === 'Polygon') {
            rings = geom.getCoordinates();
        } else if (type === 'MultiPolygon') {
            rings = geom.getCoordinates()[0];
        }
        if (!rings || !rings.length || !rings[0].length) return null;

        const exterior = rings[0];
        const canvasPts = [];
        for (let i = 0; i < exterior.length; i++) {
            const pt = this.mapCoordToCanvasPixel(exterior[i], transformInfo);
            if (pt) canvasPts.push(pt);
        }
        if (canvasPts.length < 3) return null;

        // Find the longest edge vector to determine the strip angle
        let maxLenSq = 0;
        let dominantAngle = 0;
        for (let i = 0; i < canvasPts.length - 1; i++) {
            const dx = canvasPts[i + 1][0] - canvasPts[i][0];
            const dy = canvasPts[i + 1][1] - canvasPts[i][1];
            const lenSq = dx * dx + dy * dy;
            if (lenSq > maxLenSq) {
                maxLenSq = lenSq;
                dominantAngle = Math.atan2(dy, dx);
            }
        }

        const angle = normalizeAngle(dominantAngle);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        let minPara = Infinity,
            maxPara = -Infinity;
        let minNorm = Infinity,
            maxNorm = -Infinity;

        for (let i = 0; i < canvasPts.length; i++) {
            const x = canvasPts[i][0];
            const y = canvasPts[i][1];
            const para = x * cosA + y * sinA;
            const norm = -x * sinA + y * cosA;
            if (para < minPara) minPara = para;
            if (para > maxPara) maxPara = para;
            if (norm < minNorm) minNorm = norm;
            if (norm > maxNorm) maxNorm = norm;
        }

        const length = maxPara - minPara;
        const thickness = maxNorm - minNorm;

        const interiorCoord = getFeatureInteriorCoordinate(feature);
        const centroidPixel = interiorCoord ? this.mapCoordToCanvasPixel(interiorCoord, transformInfo) : null;
        if (!centroidPixel) return null;

        return {
            canvasPts,
            angle,
            length,
            thickness,
            centroidPixel,
        };
    }

    /**
     * Group contiguous features that share the same crop category.
     */
    buildCropClusters(features, domain, proj) {
        const assigned = [];
        features.forEach((feature) => {
            const dsl = feature.get('dsl');
            const catId = dsl?.categoryId;
            if (!catId) return;
            const areaM2 = calculateArea(feature, proj);
            const category = domain ? getCategoryById(domain, catId) : null;
            const cropName = category?.label || feature.get('featureName') || feature.get('featureId') || 'Area';
            const geom = feature.getGeometry();
            if (!geom) return;

            assigned.push({
                feature,
                catId,
                cropName,
                areaM2,
                geom,
                extent: geom.getExtent(),
            });
        });

        // Union-Find data structure for connected components
        const parent = assigned.map((_, i) => i);
        function find(i) {
            if (parent[i] === i) return i;
            parent[i] = find(parent[i]);
            return parent[i];
        }
        function union(i, j) {
            const rI = find(i);
            const rJ = find(j);
            if (rI !== rJ) parent[rI] = rJ;
        }

        const bufferMeters = 30; // Cadastral ditch / road threshold between contiguous parcels
        for (let i = 0; i < assigned.length; i++) {
            for (let j = i + 1; j < assigned.length; j++) {
                if (assigned[i].catId !== assigned[j].catId) continue;
                const eA = assigned[i].extent;
                const eB = assigned[j].extent;
                if (
                    eA[0] - bufferMeters <= eB[2] + bufferMeters &&
                    eA[2] + bufferMeters >= eB[0] - bufferMeters &&
                    eA[1] - bufferMeters <= eB[3] + bufferMeters &&
                    eA[3] + bufferMeters >= eB[1] - bufferMeters
                ) {
                    union(i, j);
                }
            }
        }

        const clusterMap = new Map();
        assigned.forEach((item, index) => {
            const root = find(index);
            if (!clusterMap.has(root)) {
                clusterMap.set(root, []);
            }
            clusterMap.get(root).push(item);
        });

        return Array.from(clusterMap.values()).map((items) => {
            // Sort descending by area: primary feature is the largest parcel in the contiguous cluster
            items.sort((a, b) => b.areaM2 - a.areaM2);
            return {
                catId: items[0].catId,
                cropName: items[0].cropName,
                primary: items[0],
                items,
            };
        });
    }

    /**
     * Render crop name and surface labels oriented along field geometry.
     */
    renderPlotLabels(ctx, transformInfo) {
        const features = this.planimeter.vectorSource.getFeatures();
        if (!features.length) return;

        const domain = getDomain(this.planimeter.state.dslActiveDomainId);
        const proj = this.planimeter.view?.getProjection();
        const clusters = this.buildCropClusters(features, domain, proj);

        // Precompute canvas geometry metrics for all assigned features
        const metricsMap = new Map();
        features.forEach((feature) => {
            const metrics = this.computeFeatureCanvasMetrics(feature, transformInfo);
            if (metrics) metricsMap.set(feature, metrics);
        });

        ctx.save();

        clusters.forEach((cluster) => {
            const isContiguousCluster = transformInfo.doMergeContiguous && cluster.items.length > 1;

            cluster.items.forEach((item) => {
                const metrics = metricsMap.get(item.feature);
                if (!metrics) return;

                const isPrimary = item === cluster.primary;
                const angle = transformInfo.doOriented ? metrics.angle : 0;
                const [cx, cy] = metrics.centroidPixel;

                // Format surface text based on chosen option
                const surfaceText =
                    transformInfo.surfaceFormat === 'compact'
                        ? Math.round(item.areaM2).toString()
                        : formatSquareMeters(item.areaM2);

                if (isContiguousCluster) {
                    // Contiguous cluster (Photoshop style):
                    // Primary / central parcel displays prominent Crop Name
                    if (isPrimary) {
                        this.drawOrientedLabel(ctx, cx, cy, angle, [cluster.cropName, surfaceText], {
                            maxFontSize: 26,
                            minFontSize: 13,
                            thickness: metrics.thickness,
                            length: metrics.length,
                            highlightCropName: true,
                        });
                    } else {
                        // All neighboring strips in the cluster show ONLY their oriented surface number
                        this.drawOrientedLabel(ctx, cx, cy, angle, [surfaceText], {
                            maxFontSize: 21,
                            minFontSize: 11,
                            thickness: metrics.thickness,
                            length: metrics.length,
                            highlightCropName: false,
                        });
                    }
                } else {
                    // Standalone field: show both crop name and surface
                    const lines = metrics.thickness > 38 ? [item.cropName, surfaceText] : [`${item.cropName} ${surfaceText}`];
                    this.drawOrientedLabel(ctx, cx, cy, angle, lines, {
                        maxFontSize: 22,
                        minFontSize: 11,
                        thickness: metrics.thickness,
                        length: metrics.length,
                        highlightCropName: true,
                    });
                }
            });
        });

        ctx.restore();
    }

    /**
     * Draw oriented text lines with adaptive font-scaling and crisp white halo.
     */
    drawOrientedLabel(ctx, x, y, angle, lines, options) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        // Adaptive font size: scale with strip thickness and fit along length
        let fontSize = Math.max(
            options.minFontSize,
            Math.min(options.maxFontSize, Math.floor(options.thickness * 0.72)),
        );

        ctx.font = `bold ${fontSize}px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        for (const line of lines) {
            let textWidth = ctx.measureText(line).width;
            while (textWidth > options.length * 0.90 && fontSize > options.minFontSize) {
                fontSize -= 1;
                ctx.font = `bold ${fontSize}px "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                textWidth = ctx.measureText(line).width;
            }
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const lineHeight = fontSize * 1.18;
        const totalHeight = lines.length * lineHeight;
        const startY = -(totalHeight / 2) + lineHeight / 2;

        lines.forEach((line, idx) => {
            const lineY = startY + idx * lineHeight;
            const isCropTitle = idx === 0 && options.highlightCropName && lines.length > 1;

            ctx.font = isCropTitle
                ? `bold ${Math.round(fontSize * 1.08)}px "Segoe UI Variable", sans-serif`
                : `600 ${fontSize}px "Segoe UI Variable", sans-serif`;

            // White halo
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(3.5, Math.round(fontSize * 0.24));
            ctx.lineJoin = 'round';
            ctx.strokeText(line, 0, lineY);

            // Dark foreground text
            ctx.fillStyle = isCropTitle ? '#091512' : '#1e293b';
            ctx.fillText(line, 0, lineY);
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
