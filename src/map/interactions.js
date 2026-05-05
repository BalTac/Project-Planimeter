import Select  from 'ol/interaction/Select.js';
import Modify  from 'ol/interaction/Modify.js';
import Draw    from 'ol/interaction/Draw.js';
import Snap    from 'ol/interaction/Snap.js';
import OLStyle from 'ol/style/Style.js';
import Fill    from 'ol/style/Fill.js';
import Stroke  from 'ol/style/Stroke.js';

const DRAW_POLYGON_STYLE = new OLStyle({
    fill:   new Fill({ color: 'rgba(115,240,191,0.18)' }),
    stroke: new Stroke({ color: '#73f0bf', lineDash: [10, 8], width: 2 }),
});

const DRAW_LINE_STYLE = new OLStyle({
    stroke: new Stroke({ color: '#7bc7ff', lineDash: [8, 6], width: 3 }),
});

/**
 * Instantiate all OL interactions used by the application.
 *
 * @param {import('ol/source/Vector').default} vectorSource
 * @param {import('ol/layer/Vector').default}  vectorLayer
 * @returns {{ select, modify, draw, drawStraight, drawPolyline, snap }}
 */
export function buildInteractions(vectorSource, vectorLayer) {
    const select = new Select({
        layers: [vectorLayer],
        hitTolerance: 8,
    });

    const modify = new Modify({
        features: select.getFeatures(),
    });

    const draw = new Draw({
        source:    vectorSource,
        type:      'Polygon',
        stopClick: true,
        style:     DRAW_POLYGON_STYLE,
    });

    const drawStraight = new Draw({
        source:    vectorSource,
        type:      'LineString',
        maxPoints: 2,
        stopClick: true,
        style:     DRAW_LINE_STYLE,
    });

    const drawPolyline = new Draw({
        source:    vectorSource,
        type:      'LineString',
        stopClick: true,
        style:     DRAW_LINE_STYLE,
    });

    const snap = new Snap({
        source:         vectorSource,
        edge:           true,
        vertex:         true,
        pixelTolerance: 12,
    });

    return { select, modify, draw, drawStraight, drawPolyline, snap };
}
