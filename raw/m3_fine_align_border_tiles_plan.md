# M3 Fine Align Border Tiles - Design Plan (No Implementation Yet)

## Goal

After coarse M3 detect, run optional fine alignment only near detected border.
Do not load all visible map tiles. Load only strip tiles along polygon edge.

## Constraints

- No server.py implementation yet (waiting bug-fix complete + explicit approval).
- Keep current coarse M3 behavior as default safe fallback.
- Fine align must be optional and measurable.

## Why This Approach

Current manual deep-zoom editing loads many viewport tiles.
Border-only refinement should reduce upstream requests while improving edge adherence.

## Proposed Architecture (target)

### Stage A - Coarse detect (already exists)

- Endpoint: POST /parcel-geometry-m3
- Output: ring + debug (touches_border, radius, etc.)

### Stage B - Optional Fine Align (new)

Input:
- coarse ring
- quality mode (fast/balanced/precise)
- request budget cap for this refinement

Process:
1. Build border corridor around coarse ring (buffer in map units/pixels).
2. Split ring into segments.
3. Sample control points along segments.
4. Request high-detail WMS tiles only intersecting corridor (not full viewport).
5. Build edge confidence map in each local patch:
   - dark-line likelihood
   - gradient magnitude
   - continuity prior
6. Refit border with constrained optimization:
   - move points only inside corridor
   - keep ring closed
   - prevent self-intersections
7. Adaptive vertex edits:
   - add vertices in high-curvature/high-error zones
   - remove redundant vertices in straight zones
8. Return refined ring + quality/debug metrics.

## Candidate Algorithms (exploration matrix)

1. Local normal snap
- Fast, simple.
- Weak on junctions/noisy labels.

2. Corridor graph shortest path (recommended baseline)
- Robust on complex borders.
- Good control with cost terms.

3. Active contour (snake)
- Smooth results.
- Harder to tune reliably.

Recommended: start with corridor graph baseline, then optional local snap post-pass.

## Cost Function (for border adherence)

For each candidate edge point p:

Cost(p) =
- w1 * (1 - edge_confidence)
- w2 * distance_from_coarse_centerline
- w3 * curvature_penalty
- w4 * seam_penalty (tile boundary)

Target: minimize total cost over closed path.

## Request Budget Strategy

Fine align must be budget-aware.

Per operation caps (initial proposal):
- fast: max 12 tile requests
- balanced: max 24
- precise: max 40

If cap reached:
- stop refinement gracefully
- return best-so-far ring + flag budget_limited=true

## Daily Quota Tracking (3000/day)

## Can WMS expose real remaining quota?

Current docs/codebase show no official endpoint for "remaining requests today".
No reliable remote quota introspection path identified.

Conclusion:
- treat remote remaining quota as unknown
- implement local request accounting + warning indicator

## Local counter model (mock but operational)

Data model (server-side persistent):
- day_key (YYYY-MM-DD local timezone)
- total_upstream_requests
- by_route counters:
  - wms_tile
  - wms_proxy_getmap
  - wms_proxy_featureinfo
  - m3_coarse
  - m3_fine
- optional by_mode counters (fast/balanced/precise)

Derived values:
- used_today
- remaining_estimate = max(0, 3000 - used_today)
- burn_rate_per_hour
- projected_exhaustion_time

UI indicator proposal:
- green: > 40% remaining
- amber: 15%-40%
- red: < 15%
- tooltip: used, remaining_estimate, burn_rate, last_reset

Important label:
- "Estimated local counter (provider real quota not exposed)"

## Metrics for Fine Align Quality

Primary geometric metrics (for test harness):
1. Mean border offset (px)
2. P95 border offset (px)
3. Symmetric Hausdorff distance (px)
4. Area delta vs coarse (% and m2)
5. Vertex count delta
6. Runtime (ms)
7. Requests consumed

Acceptance draft (first pass):
- mean offset improvement >= 35%
- p95 improvement >= 25%
- area drift within configurable threshold
- no topology errors

## API Design Draft (future)

New endpoint idea:
POST /parcel-geometry-m3-refine

Payload:
- lat, lon
- coarseRing (optional; if missing, server recomputes coarse)
- quality: fast|balanced|precise
- maxRequests (optional override)
- corridorWidthPx
- targetDpiScale

Response:
- ok
- coarseRing
- refinedRing
- metrics
- requestUsage
- budgetLimited
- durationMs
- debug

## Smoke Test Plan (parcel 402)

Extend tests/test_smoke_parcel_402_methods.py with dedicated refinement mode:

Command idea:
python tests/test_smoke_parcel_402_methods.py --method3-only --refine --lon ... --lat ... --radius 2 --quality balanced

Output additions:
- overlay image coarse vs refined
- JSON metrics block:
  - offset stats
  - requests used
  - runtime
  - budget flags

## Rollout Plan (after approval)

Phase 1:
- implement local request counter + status endpoint + UI indicator.

Phase 2:
- implement refine endpoint with corridor graph baseline.

Phase 3:
- integrate optional UI toggle and quality modes.

Phase 4:
- smoke test parcel 402, tune thresholds/weights.

## Go/No-Go Gates

Before coding server.py:
- bug-fix window complete
- approval on algorithm baseline
- approval on quota indicator wording (estimated vs real)
- approval on request caps per mode

## Validation Notes (2026-05-16)

The refine path was implemented, validated, then rolled back to the v1 baseline without antispike because the filter improved the narrow parcel 402 spike case but degraded parcel 304 by cutting valid right-side geometry.

### Test code used

```bash
# Baseline refine (no antispike)
python tests/test_smoke_parcel_402_methods.py --method3-only --radius 2 --refine --quality balanced --lon 12.562341 --lat 43.012963 --base-url http://127.0.0.1:8000

# Antispike comparison that was later reverted
python tests/test_smoke_parcel_402_methods.py --method3-only --radius 2 --refine --quality balanced --lon 12.561465 --lat 43.012393 --base-url http://127.0.0.1:8000
python tests/test_smoke_parcel_402_methods.py --method3-only --radius 2 --refine --quality balanced --antispike --lon 12.562341 --lat 43.012963 --base-url http://127.0.0.1:8000
```

### Smoke outputs archived in raw/

- `raw/parcel_smoke_m3_lon_12p561465_lat_43p012393.png`
- `raw/parcel_smoke_m3_lon_12p561465_lat_43p012393.json`
- `raw/parcel_smoke_m3_lon_12p562341_lat_43p012963.png`
- `raw/parcel_smoke_m3_lon_12p562341_lat_43p012963.json`

### Observed results

- Parcel 402 baseline refine: requests used 24, delta area about -5.94 m2 after rollback-baseline retest; antispike version had previously filtered foreign border spikes but also introduced over-cutting on the right side.
- Parcel 304 baseline refine: requests used 24, delta area about -7.35 m2.
- Parcel 304 with antispike: requests used 24, delta area about -16.36 m2, with 2 vertices filtered, which was judged too aggressive for the thin parcel geometry.

### Decision

Keep the current refine implementation as the v1 baseline without antispike.
Use manual review or a future geometry-confidence heuristic only for exceptional narrow-parcel cases.

### Update: edge-attraction snap

After the external review, the refine logic was changed from pruning-style antispike to edge-constrained vertex snapping:

- keep the coarse ring
- densify it more aggressively in meters
- search only along the vertex normal in a small local window
- score line presence, local continuity, distance transform, gradient and darkness
- keep the original vertex when confidence is low

This keeps the narrow parcels intact while still centering the border on the cadastral stroke.
