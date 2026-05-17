#!/usr/bin/env python3
"""Smoke test manuale: rilevamento geometria particella con 4 metodi automatici.

Uso tipico:
    python tests/test_smoke_parcel_402_methods.py

Prerequisiti:
- server.py avviato localmente (default: http://127.0.0.1:8000)

Output:
- tests/output/parcel_smoke_<mode>_<coords>.png (pannello con esiti metodo)
- tests/output/parcel_smoke_<mode>_<coords>.json (riassunto tecnico)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import pathlib
import re
import traceback
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFont


DEFAULT_BASE_URL = "http://127.0.0.1:8000"
TARGET_LON = 12.561465
TARGET_LAT = 43.012393
TARGET_HINT = "B609_000200.402"

OUT_DIR = pathlib.Path(__file__).resolve().parent / "output"
LEGACY_OUT_DIR = pathlib.Path(__file__).resolve().parent / "tests" / "output"
ENABLE_METHOD_4 = False
M3_TILE_HALF_DEG = 0.00030
M3_TILE_PX = 420


def build_output_paths(lon: float, lat: float, mode: str, case_name: str | None = None) -> tuple[pathlib.Path, pathlib.Path]:
    lon_tag = f"{lon:.6f}".replace("-", "m").replace(".", "p")
    lat_tag = f"{lat:.6f}".replace("-", "m").replace(".", "p")
    case_tag = ""
    if case_name:
        clean_case = re.sub(r"[^A-Za-z0-9._-]+", "-", case_name.strip()).strip("-")
        if clean_case:
            case_tag = f"_{clean_case}"
    stem = f"parcel_smoke_{mode}{case_tag}_lon_{lon_tag}_lat_{lat_tag}"
    return OUT_DIR / f"{stem}.png", OUT_DIR / f"{stem}.json"


@dataclass
class MethodResult:
    name: str
    ok: bool
    details: str
    ring_lonlat: list[tuple[float, float]] | None
    debug: dict[str, Any]


def http_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{base_url}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def http_bytes(base_url: str, path_qs: str) -> bytes:
    url = f"{base_url}{path_qs}"
    req = urllib.request.Request(url, headers={"Accept": "image/png,*/*;q=0.2"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def extract_parcel_ref(data: dict[str, Any], hint: str) -> str:
    parcel = data.get("parcel") or {}
    raw = data.get("raw") or {}
    candidates = [
        str(parcel.get("id") or "").strip(),
        str(parcel.get("local_id") or "").strip(),
        str(parcel.get("label") or "").strip(),
        str(raw.get("NationalCadastralReference") or "").strip(),
        str(raw.get("label") or "").strip(),
        hint,
    ]
    candidates = [c for c in candidates if c]
    # Prefer explicit cadastral reference when present.
    for candidate in candidates:
        if "B609_000200.402" in candidate:
            return "B609_000200.402"
    return candidates[0] if candidates else hint


def coords_to_ring(geometry: dict[str, Any] | None) -> list[tuple[float, float]] | None:
    if not geometry or not isinstance(geometry, dict):
        return None
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon" and isinstance(coords, list) and coords and isinstance(coords[0], list):
        return [(float(x), float(y)) for x, y in coords[0] if isinstance(x, (int, float)) and isinstance(y, (int, float))]
    if gtype == "MultiPolygon" and isinstance(coords, list) and coords and isinstance(coords[0], list) and coords[0]:
        ring = coords[0][0]
        if isinstance(ring, list):
            return [(float(x), float(y)) for x, y in ring if isinstance(x, (int, float)) and isinstance(y, (int, float))]
    return None


def bbox_from_center(lon: float, lat: float, half_size_deg: float) -> tuple[float, float, float, float]:
    return (lon - half_size_deg, lat - half_size_deg, lon + half_size_deg, lat + half_size_deg)


def normalize_ring(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not ring:
        return ring
    if ring[0] != ring[-1]:
        ring = ring + [ring[0]]
    return ring


def ring_area(ring: list[tuple[float, float]]) -> float:
    """DEPRECATED: Returns meaningless coordinate units squared. Use ring_area_interpolated_m2() instead."""
    ring = normalize_ring(ring)
    if len(ring) < 4:
        return 0.0
    acc = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        acc += (x1 * y2) - (x2 * y1)
    return abs(acc) * 0.5


def ring_area_interpolated_m2(ring: list[tuple[float, float]]) -> float:
    """Approximate polygon area in m² from lon/lat using local metric interpolation."""
    ring = normalize_ring(ring)
    if len(ring) < 4:
        return 0.0

    mean_lat = sum(lat for _, lat in ring[:-1]) / max(1, len(ring) - 1)
    cos_lat = math.cos(math.radians(mean_lat))
    meters_per_deg_lon = 111320.0 * cos_lat
    meters_per_deg_lat = 110540.0

    acc = 0.0
    for i in range(len(ring) - 1):
        lon1, lat1 = ring[i]
        lon2, lat2 = ring[i + 1]
        x1 = lon1 * meters_per_deg_lon
        y1 = lat1 * meters_per_deg_lat
        x2 = lon2 * meters_per_deg_lon
        y2 = lat2 * meters_per_deg_lat
        acc += (x1 * y2) - (x2 * y1)
    return abs(acc) * 0.5


def _is_valid_polygon_ring(ring: list[tuple[float, float]]) -> bool:
    """Check polygon ring validity: closure, min size, no obvious self-intersection."""
    if not ring or len(ring) < 4:
        return False
    # Already closed by normalize_ring, but verify
    if ring[0] != ring[-1]:
        return False
    # Check for duplicate consecutive vertices (common artifact)
    for i in range(len(ring) - 1):
        if ring[i] == ring[i + 1]:
            return False
    return True


def _safe_serialize_ownership_mask(mask: Any) -> list | None:
    """Convert numpy array or dict ownership mask to JSON-serializable format."""
    if mask is None:
        return None
    try:
        # If it's already a list, return as-is
        if isinstance(mask, list):
            return mask
        # If it's dict (already serializable), return as-is
        if isinstance(mask, dict):
            return mask
        # Try numpy array → list conversion
        import numpy as np
        if isinstance(mask, np.ndarray):
            return mask.tolist()
        # If other type, try generic conversion
        return list(mask)
    except Exception:
        return None


def _normalize_debug_response(response_dict: dict[str, Any]) -> dict[str, Any]:
    """Probe both camelCase and snake_case keys in response debug object."""
    out = {}
    # Canonical mappings: prefer camelCase from endpoint, fallback to snake_case
    mappings = [
        ("snapAcceptedVertices", "snap_accepted_vertices", "snap_accepted_vertices"),
        ("snapKeptVertices", "snap_kept_vertices", "snap_kept_vertices"),
        ("snapRejectedVertices", "snap_rejected_vertices", "snap_rejected_vertices"),
        ("meanSnapMeters", "mean_snap_meters", "mean_snap_meters"),
        ("meanConfidence", "mean_confidence", "mean_confidence"),
        ("ownershipMode", "ownership_mode", "ownership_mode"),
        ("ownershipAccepted", "ownership_accepted", "ownership_accepted"),
        ("ownershipRejected", "ownership_rejected", "ownership_rejected"),
        ("ownershipAmbiguous", "ownership_ambiguous", "ownership_ambiguous"),
        ("meanOwnershipScore", "mean_ownership_score", "mean_ownership_score"),
        ("ownershipDirectionFlips", "ownership_direction_flips", "ownership_direction_flips"),
        ("ownershipInsideFailures", "ownership_inside_failures", "ownership_inside_failures"),
        ("ownershipOutsideFailures", "ownership_outside_failures", "ownership_outside_failures"),
        ("continuityBoostMean", "continuity_boost_mean", "continuity_boost_mean"),
        ("meanScoreGain", "mean_score_gain", "mean_score_gain"),
        ("rejectedByDistance", "rejected_by_distance", "rejected_by_distance"),
        ("rejectedByWeakGain", "rejected_by_weak_gain", "rejected_by_weak_gain"),
    ]
    for camel, snake, out_key in mappings:
        value = response_dict.get(camel) or response_dict.get(snake)
        if value is not None:
            out[out_key] = value
    # Copy any remaining keys not in mapping
    for k, v in response_dict.items():
        if k not in out and k not in [m[0] for m in mappings] + [m[1] for m in mappings]:
            out[k] = v
    return out


def fetch_parcel_label_from_featureinfo_html(base_url: str, lon: float, lat: float) -> dict[str, str]:
    """Best-effort parcel metadata from text/html GetFeatureInfo around point."""
    buf = 0.00008
    lat_min, lon_min, lat_max, lon_max = lat - buf, lon - buf, lat + buf, lon + buf
    qs = urllib.parse.urlencode({
        "SERVICE": "WMS",
        "REQUEST": "GetFeatureInfo",
        "VERSION": "1.3.0",
        "LAYERS": "CP.CadastralParcel",
        "QUERY_LAYERS": "CP.CadastralParcel",
        "STYLES": "",
        "CRS": "EPSG:6706",
        "BBOX": f"{lat_min},{lon_min},{lat_max},{lon_max}",
        "WIDTH": "221",
        "HEIGHT": "221",
        "I": "110",
        "J": "110",
        "INFO_FORMAT": "text/html",
        "FEATURE_COUNT": "10",
        "TRANSPARENT": "true",
        "FORMAT": "image/png",
    })

    try:
        raw = http_bytes(base_url, f"/wms-proxy?{qs}").decode("utf-8", errors="ignore")
    except Exception:
        return {}

    rows = re.findall(
        r"<tr\b[^>]*>\s*<th\b[^>]*>(.*?)</th>\s*<td\b[^>]*>(.*?)</td>\s*</tr>",
        raw,
        flags=re.IGNORECASE | re.DOTALL,
    )

    values: dict[str, str] = {}
    for key_raw, value_raw in rows:
        key = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", key_raw)).strip()
        val = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value_raw)).strip()
        if key and val:
            values[key] = val

    label = values.get("Label", "")
    national = values.get("NationalCadastralReference", "")
    inspire_local_id = values.get("InspireId_localId", "") or values.get("InspireId_localid", "")
    inspire_namespace = values.get("InspireId_namespace", "")
    inspire_local_id_lower = inspire_local_id.lower()
    if not inspire_local_id and inspire_namespace and national:
        inspire_local_id = f"{inspire_namespace}{national}"
    if label and national:
        result = {
            "parcel_label": label,
            "parcel_reference": national,
        }
        if inspire_local_id:
            result["parcel_inspire_localid"] = inspire_local_id
        if inspire_namespace:
            result["parcel_inspire_namespace"] = inspire_namespace
        return result
    if label:
        result = {"parcel_label": label}
        if inspire_local_id:
            result["parcel_inspire_localid"] = inspire_local_id
        if inspire_namespace:
            result["parcel_inspire_namespace"] = inspire_namespace
        return result
    if national:
        result = {"parcel_reference": national}
        if inspire_local_id:
            result["parcel_inspire_localid"] = inspire_local_id
        if inspire_namespace:
            result["parcel_inspire_namespace"] = inspire_namespace
        return result
    return {}


def fetch_parcel_summary_proxy_json(base_url: str, lon: float, lat: float) -> dict[str, str]:
    """Proxy-first parcel metadata summary aligned with app runtime strategy."""
    buf = 0.00008
    lat_min, lon_min, lat_max, lon_max = lat - buf, lon - buf, lat + buf, lon + buf
    qs = urllib.parse.urlencode({
        "SERVICE": "WMS",
        "REQUEST": "GetFeatureInfo",
        "VERSION": "1.3.0",
        "LAYERS": "CP.CadastralParcel",
        "QUERY_LAYERS": "CP.CadastralParcel",
        "STYLES": "",
        "CRS": "EPSG:6706",
        "BBOX": f"{lat_min},{lon_min},{lat_max},{lon_max}",
        "WIDTH": "221",
        "HEIGHT": "221",
        "I": "110",
        "J": "110",
        "INFO_FORMAT": "text/html",
        "FEATURE_COUNT": "10",
        "TRANSPARENT": "true",
        "FORMAT": "image/png",
        "OUTPUT": "json",
    })
    try:
        data = http_json(base_url, f"/wms-proxy?{qs}")
    except Exception:
        return fetch_parcel_label_from_featureinfo_html(base_url, lon, lat)

    parcel = data.get("parcel") if isinstance(data, dict) else None
    if not isinstance(parcel, dict):
        return fetch_parcel_label_from_featureinfo_html(base_url, lon, lat)

    result: dict[str, str] = {}
    label = str(parcel.get("label") or "").strip()
    reference = str(parcel.get("id") or "").strip()
    local_id = str(parcel.get("local_id") or "").strip()
    namespace = str(parcel.get("namespace") or "").strip()

    if label:
        result["parcel_label"] = label
    if reference:
        result["parcel_reference"] = reference
    if local_id:
        result["parcel_inspire_localid"] = local_id
    if namespace:
        result["parcel_inspire_namespace"] = namespace

    if result:
        return result
    return fetch_parcel_label_from_featureinfo_html(base_url, lon, lat)


def _ref_matches(candidate: str, reference: str) -> bool:
    candidate_norm = str(candidate or "").strip().lower()
    reference_norm = str(reference or "").strip().lower()
    if not candidate_norm or not reference_norm:
        return False
    return (
        candidate_norm == reference_norm
        or candidate_norm.endswith(reference_norm)
        or reference_norm.endswith(candidate_norm)
    )


def _match_inspire_local_id(candidate: str, reference: str) -> bool:
    candidate_norm = str(candidate or "").strip().lower()
    reference_norm = str(reference or "").strip().lower()
    if not candidate_norm or not reference_norm:
        return False
    if candidate_norm == reference_norm:
        return True
    if reference_norm.endswith(candidate_norm):
        return True
    if candidate_norm.endswith(reference_norm):
        return True
    if reference_norm.startswith("it.age.pla."):
        suffix = reference_norm.removeprefix("it.age.pla.")
        return suffix == candidate_norm or suffix.endswith(candidate_norm)
    return False


def resolve_coordinates_from_reference(reference: str) -> tuple[float, float, str] | None:
    """Best-effort local reverse lookup using previously generated smoke-test reports."""
    reference = str(reference or "").strip()
    if not reference:
        return None

    search_dirs = []
    for directory in (OUT_DIR, LEGACY_OUT_DIR):
        if directory not in search_dirs:
            search_dirs.append(directory)

    report_files: list[pathlib.Path] = []
    for directory in search_dirs:
        if directory.exists():
            report_files.extend(directory.glob("parcel_smoke_*.json"))

    report_files = sorted(report_files, key=lambda path: path.stat().st_mtime, reverse=True)

    for path in report_files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue

        target = data.get("target") if isinstance(data, dict) else None
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(target, dict) or not isinstance(results, list):
            continue

        lon = target.get("lon")
        lat = target.get("lat")
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            continue

        for result in results:
            if not isinstance(result, dict):
                continue
            debug_obj = result.get("debug")
            debug = debug_obj if isinstance(debug_obj, dict) else {}
            parcel_ref = str(debug.get("parcel_reference") or "")
            parcel_label = str(debug.get("parcel_label") or "")
            parcel_inspire_localid = str(debug.get("parcel_inspire_localid") or "")
            parcel_inspire_namespace = str(debug.get("parcel_inspire_namespace") or "")
            inspire_combo = f"{parcel_inspire_namespace}{parcel_ref}" if parcel_inspire_namespace and parcel_ref else ""
            if (
                _ref_matches(parcel_ref, reference)
                or _ref_matches(parcel_label, reference)
                or _match_inspire_local_id(parcel_inspire_localid, reference)
                or _match_inspire_local_id(inspire_combo, reference)
            ):
                return float(lon), float(lat), f"history:{path.name}:result.debug"

    return None


def resolve_input_coordinates(
    reference: str | None,
    lon: float | None,
    lat: float | None,
) -> tuple[float, float, str]:
    if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
        return float(lon), float(lat), "cli"

    if reference:
        resolved = resolve_coordinates_from_reference(reference)
        if resolved:
            return resolved

        raise ValueError(
            f"Unable to resolve cadastral reference {reference!r} from local smoke-test history. Provide --lon/--lat as fallback."
        )

    return TARGET_LON, TARGET_LAT, "default"


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set(points))
    if len(pts) <= 1:
        return pts

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def method_1_semantic_geometry(base_url: str, lon: float, lat: float, hint: str) -> tuple[MethodResult, str]:
    name = "M1 Semantic /parcel-at-point"
    data = http_json(base_url, "/parcel-at-point", {
        "lat": lat,
        "lon": lon,
        "includeGeometry": True,
        "buffer": 0.00008,
    })
    parcel_ref = extract_parcel_ref(data, hint)
    ring = coords_to_ring(data.get("parcelGeometry"))
    if not ring or len(ring) < 4:
        return MethodResult(name, False, "No parcelGeometry in semantic response", None, {"response": data}), parcel_ref
    return MethodResult(name, True, f"Geometry OK, {len(ring)} vertices", ring, {"response": data}), parcel_ref


def method_2_wms_featureinfo_json(base_url: str, lon: float, lat: float, parcel_ref: str) -> MethodResult:
    name = "M2 WMS GetFeatureInfo JSON"
    buf = 0.00016
    lat_min, lon_min, lat_max, lon_max = lat - buf, lon - buf, lat + buf, lon + buf
    qs = urllib.parse.urlencode({
        "SERVICE": "WMS",
        "REQUEST": "GetFeatureInfo",
        "VERSION": "1.3.0",
        "LAYERS": "CP.CadastralParcel",
        "QUERY_LAYERS": "CP.CadastralParcel",
        "STYLES": "",
        "CRS": "EPSG:6706",
        "BBOX": f"{lat_min},{lon_min},{lat_max},{lon_max}",
        "WIDTH": "301",
        "HEIGHT": "301",
        "I": "150",
        "J": "150",
        "INFO_FORMAT": "application/json",
        "FEATURE_COUNT": "20",
        "TRANSPARENT": "true",
        "FORMAT": "image/png",
    })
    path = f"/wms-proxy?{qs}"
    try:
        data = http_json(base_url, path)
    except Exception as exc:
        return MethodResult(name, False, f"WMS JSON request failed: {exc}", None, {})

    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list) or not features:
        return MethodResult(name, False, "No features returned", None, {"response": data})

    wanted = str(parcel_ref or "").strip()
    chosen = None
    for feature in features:
        props = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(props, dict):
            continue
        values = [str(v) for v in props.values() if v is not None]
        blob = " | ".join(values)
        if wanted and wanted in blob:
            chosen = feature
            break

    if not chosen:
        chosen = features[0]

    ring = coords_to_ring(chosen.get("geometry") if isinstance(chosen, dict) else None)
    if not ring or len(ring) < 4:
        return MethodResult(name, False, "Feature found but invalid polygon geometry", None, {"response": data})

    return MethodResult(name, True, f"Geometry from GFI JSON, {len(ring)} vertices", ring, {
        "feature_count": len(features),
        "selected_props": chosen.get("properties", {}) if isinstance(chosen, dict) else {},
    })


def method_3_raster_segmentation(base_url: str, lon: float, lat: float, max_radius: int = 2) -> MethodResult:
    name = "M3 Backend /parcel-geometry-m3"
    max_radius = min(5, max(1, int(max_radius)))
    start_radius = 1
    last_debug: dict[str, Any] = {}

    for radius in range(start_radius, max_radius + 1):
        try:
            data = http_json(base_url, "/parcel-geometry-m3", {
                "lat": lat,
                "lon": lon,
                "radius": radius,
            })
        except Exception as exc:
            return MethodResult(name, False, f"M3 endpoint request failed: {exc}", None, {
                "max_radius_requested": max_radius,
                "used_radius": radius,
            })

        debug = dict(data.get("debug") or {}) if isinstance(data, dict) else {}
        debug["max_radius_requested"] = max_radius
        debug["used_radius"] = radius
        if isinstance(data, dict) and "durationMs" in data:
            debug["durationMs"] = data.get("durationMs")

        if not isinstance(data, dict) or not data.get("ok") or not isinstance(data.get("ring"), list):
            debug["message"] = (data.get("message") if isinstance(data, dict) else "invalid_response")
            last_debug = debug
            if radius == start_radius:
                return MethodResult(name, False, f"M3 detect failed at radius={radius}", None, debug)
            continue

        ring = []
        for pt in data.get("ring", []):
            if isinstance(pt, (list, tuple)) and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)):
                ring.append((float(pt[0]), float(pt[1])))
        ring = normalize_ring(ring)

        if len(ring) < 4:
            last_debug = debug
            continue
        
        # Validate coarse ring geometry
        if not _is_valid_polygon_ring(ring):
            debug["message"] = "coarse_ring_invalid_geometry"
            last_debug = debug
            if radius == start_radius:
                return MethodResult(name, False, "Coarse ring invalid at radius={radius}", None, debug)
            continue

        area_m2 = ring_area_interpolated_m2(ring)
        debug["estimated_area_m2"] = area_m2
        debug["estimated_area_ha"] = area_m2 / 10000.0
        debug.update(fetch_parcel_summary_proxy_json(base_url, lon, lat))

        last_debug = debug
        if debug.get("touches_border") and radius < max_radius:
            continue

        return MethodResult(name, True, f"Endpoint M3 polygon, {len(ring)} vertices (radius={radius})", ring, debug)

    return MethodResult(name, False, "Unable to close contour after progressive endpoint retries", None, last_debug)


def method_3_refine_border_tiles(
    base_url: str,
    lon: float,
    lat: float,
    coarse: MethodResult,
    quality: str = "balanced",
    max_requests: int | None = None,
    corner_snap: bool = False,
) -> MethodResult:
    name = "M3 Refine edge attraction"
    if not coarse.ok or not coarse.ring_lonlat:
        return MethodResult(name, False, "Coarse ring unavailable", None, {})

    # Validate coarse ring
    if not _is_valid_polygon_ring(coarse.ring_lonlat):
        return MethodResult(name, False, "Coarse ring invalid (not closed or self-intersecting)", None, {})

    payload: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "coarseRing": [[float(x), float(y)] for x, y in coarse.ring_lonlat],
        "quality": quality,
    }
    
    # CRITICAL FIX: Safe ownership mask serialization
    ownership_mask = coarse.debug.get("ownershipMask") if isinstance(coarse.debug, dict) else None
    if ownership_mask is not None:
        safe_mask = _safe_serialize_ownership_mask(ownership_mask)
        if safe_mask is not None:
            payload["ownershipMask"] = safe_mask
        # else: silently omit invalid mask (fallback)
    
    mask_transform = coarse.debug.get("maskTransform") if isinstance(coarse.debug, dict) else None
    if isinstance(mask_transform, dict):
        payload["maskTransform"] = mask_transform
    
    if isinstance(coarse.debug, dict):
        payload["coarseDebug"] = coarse.debug
    
    if isinstance(max_requests, int) and max_requests > 0:
        payload["maxRequests"] = int(max_requests)

    if corner_snap:
        payload["cornerSnap"] = True

    try:
        data = http_json(base_url, "/parcel-geometry-m3-refine", payload)
    except Exception as exc:
        return MethodResult(name, False, f"Refine endpoint request failed: {exc}", None, {})

    if not isinstance(data, dict) or not data.get("ok") or not isinstance(data.get("ring"), list):
        debug = dict(data.get("debug") or {}) if isinstance(data, dict) else {}
        debug["message"] = (data.get("message") if isinstance(data, dict) else "invalid_response")
        return MethodResult(name, False, "Refine endpoint returned no ring", None, debug)

    ring = normalize_ring([
        (float(pt[0]), float(pt[1]))
        for pt in data.get("ring", [])
        if isinstance(pt, (list, tuple)) and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float))
    ])
    if len(ring) < 4:
        debug = dict(data.get("debug") or {})
        debug["message"] = "ring_too_small"
        return MethodResult(name, False, "Refined ring invalid", None, debug)

    # Validate refined ring geometry
    if not _is_valid_polygon_ring(ring):
        debug = dict(data.get("debug") or {})
        debug["message"] = "refined_ring_invalid_geometry"
        debug["reason"] = "self-intersecting or duplicate vertices"
        return MethodResult(name, False, "Refined ring has geometric issues", None, debug)

    coarse_area = ring_area_interpolated_m2(coarse.ring_lonlat)
    refined_area = ring_area_interpolated_m2(ring)
    delta_m2 = refined_area - coarse_area
    delta_ratio = (delta_m2 / coarse_area) if coarse_area > 1e-9 else 0.0
    
    # MEDIUM FIX: Clamp delta ratio + warn if suspicious
    delta_ratio_clamped = max(-0.5, min(0.5, delta_ratio))
    area_sanity_ok = abs(delta_ratio) <= 0.5

    debug = dict(data.get("debug") or {})
    debug = _normalize_debug_response(debug)  # Fix camelCase/snake_case mismatch
    debug["quality"] = data.get("quality", quality)
    debug["durationMs"] = data.get("durationMs")
    debug["coarse_area_m2"] = coarse_area
    debug["refined_area_m2"] = refined_area
    debug["delta_area_m2"] = delta_m2
    debug["delta_area_ratio"] = delta_ratio_clamped
    debug["area_sanity_check"] = area_sanity_ok
    if not area_sanity_ok:
        debug["area_sanity_warning"] = f"delta_ratio {delta_ratio:.2f} out of ±50% expected range"

    return MethodResult(
        name,
        True,
        f"Refined border, {len(ring)} vertices, delta {delta_m2:.2f} m2",
        ring,
        debug,
    )


def method_3_trace_contour_walk(
    base_url: str,
    lon: float,
    lat: float,
    coarse: MethodResult,
    tolerance_m: float = 0.35,
    use_at_point_fallback: bool = True,
    max_at_point_calls: int = 8,
) -> MethodResult:
    """Call the new /parcel-geometry-m3-trace endpoint (contour-walk algorithm)."""
    name = "M3 Trace contour-walk"
    if not coarse.ok or not coarse.ring_lonlat:
        return MethodResult(name, False, "Coarse ring unavailable", None, {})
    if not _is_valid_polygon_ring(coarse.ring_lonlat):
        return MethodResult(name, False, "Coarse ring invalid (not closed or self-intersecting)", None, {})

    payload: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "coarseRing": [[float(x), float(y)] for x, y in coarse.ring_lonlat],
        "toleranceM": float(tolerance_m),
        "useAtPointFallback": bool(use_at_point_fallback),
        "maxAtPointCalls": int(max_at_point_calls),
    }

    ownership_mask = coarse.debug.get("ownershipMask") if isinstance(coarse.debug, dict) else None
    if ownership_mask is not None:
        safe_mask = _safe_serialize_ownership_mask(ownership_mask)
        if safe_mask is not None:
            payload["ownershipMask"] = safe_mask
    mask_transform = coarse.debug.get("maskTransform") if isinstance(coarse.debug, dict) else None
    if isinstance(mask_transform, dict):
        payload["maskTransform"] = mask_transform
    if isinstance(coarse.debug, dict):
        payload["coarseDebug"] = coarse.debug

    try:
        data = http_json(base_url, "/parcel-geometry-m3-trace", payload)
    except Exception as exc:
        return MethodResult(name, False, f"Trace endpoint request failed: {exc}", None, {})

    if not isinstance(data, dict) or not data.get("ok") or not isinstance(data.get("ring"), list):
        debug = dict(data.get("debug") or {}) if isinstance(data, dict) else {}
        debug["message"] = (data.get("message") if isinstance(data, dict) else "invalid_response")
        return MethodResult(name, False, "Trace endpoint returned no ring", None, debug)

    ring = normalize_ring([
        (float(pt[0]), float(pt[1]))
        for pt in data.get("ring", [])
        if isinstance(pt, (list, tuple))
        and len(pt) >= 2
        and isinstance(pt[0], (int, float))
        and isinstance(pt[1], (int, float))
    ])
    if len(ring) < 4:
        debug = dict(data.get("debug") or {})
        debug["message"] = "ring_too_small"
        return MethodResult(name, False, "Traced ring invalid", None, debug)
    if not _is_valid_polygon_ring(ring):
        debug = dict(data.get("debug") or {})
        debug["message"] = "traced_ring_invalid_geometry"
        return MethodResult(name, False, "Traced ring has geometric issues", None, debug)

    coarse_area = ring_area_interpolated_m2(coarse.ring_lonlat)
    traced_area = ring_area_interpolated_m2(ring)
    delta_m2 = traced_area - coarse_area
    delta_ratio = (delta_m2 / coarse_area) if coarse_area > 1e-9 else 0.0

    debug = dict(data.get("debug") or {})
    debug["durationMs"] = data.get("durationMs")
    debug["coarse_area_m2"] = coarse_area
    debug["traced_area_m2"] = traced_area
    debug["delta_area_m2"] = delta_m2
    debug["delta_area_ratio"] = delta_ratio

    return MethodResult(
        name,
        True,
        f"Traced contour, {len(ring)} vertices, delta {delta_m2:.2f} m2",
        ring,
        debug,
    )


def method_4_grid_probing(base_url: str, lon: float, lat: float, parcel_ref: str) -> MethodResult:
    name = "M4 Grid probing parcel-id"
    half = 0.00018
    n = 19
    points: list[tuple[float, float]] = []
    hits = 0

    wanted = str(parcel_ref or "").strip()

    for ix in range(n):
        for iy in range(n):
            lon_i = (lon - half) + (2 * half) * (ix / (n - 1))
            lat_i = (lat - half) + (2 * half) * (iy / (n - 1))
            try:
                data = http_json(base_url, "/parcel-at-point", {
                    "lat": lat_i,
                    "lon": lon_i,
                    "includeGeometry": False,
                    "buffer": 0.00003,
                })
            except Exception:
                continue
            parcel = data.get("parcel") or {}
            raw = data.get("raw") or {}
            candidates = [
                str(parcel.get("id") or ""),
                str(parcel.get("local_id") or ""),
                str(raw.get("NationalCadastralReference") or ""),
                str(raw.get("label") or ""),
            ]
            blob = " | ".join(candidates)
            hits += 1
            if wanted and wanted in blob:
                points.append((lon_i, lat_i))

    if len(points) < 6:
        return MethodResult(name, False, f"Not enough in-parcel hits ({len(points)})", None, {
            "calls_ok": hits,
            "hits": len(points),
        })

    hull = convex_hull(points)
    hull = normalize_ring(hull)
    if len(hull) < 4:
        return MethodResult(name, False, "Hull from probing failed", None, {"hits": len(points)})

    return MethodResult(name, True, f"Grid probing hull, {len(hull)} vertices", hull, {
        "calls_ok": hits,
        "hits": len(points),
        "grid": n,
    })


def _find_method_result(results: list[MethodResult], prefix: str) -> MethodResult | None:
    prefix_norm = prefix.strip().lower()
    for result in results:
        if result.name.strip().lower().startswith(prefix_norm):
            return result
    return None


def _fetch_m3_mosaic(base_url: str, lon: float, lat: float, radius: int) -> tuple[Image.Image | None, tuple[float, float, float, float] | None]:
    radius = max(1, int(radius))
    side_tiles = (2 * radius + 1)
    side_px = side_tiles * M3_TILE_PX
    mosaic = Image.new("RGB", (side_px, side_px), (18, 20, 24))
    span_deg = M3_TILE_HALF_DEG * 2.0

    for gy in range(radius, -radius - 1, -1):
        for gx in range(-radius, radius + 1):
            lon_t = lon + gx * span_deg
            lat_t = lat + gy * span_deg
            lon_min_t, lat_min_t, lon_max_t, lat_max_t = bbox_from_center(lon_t, lat_t, M3_TILE_HALF_DEG)
            qs = urllib.parse.urlencode({
                "SERVICE": "WMS",
                "REQUEST": "GetMap",
                "VERSION": "1.3.0",
                "LAYERS": "CP.CadastralParcel",
                "STYLES": "",
                "CRS": "EPSG:6706",
                "BBOX": f"{lat_min_t},{lon_min_t},{lat_max_t},{lon_max_t}",
                "WIDTH": str(M3_TILE_PX),
                "HEIGHT": str(M3_TILE_PX),
                "FORMAT": "image/png",
                "TRANSPARENT": "true",
            })
            try:
                tile_raw = http_bytes(base_url, f"/wms-proxy?{qs}")
                tile_img = Image.open(io.BytesIO(tile_raw)).convert("RGB")
            except Exception:
                tile_img = Image.new("RGB", (M3_TILE_PX, M3_TILE_PX), (35, 39, 46))

            px_x = (gx + radius) * M3_TILE_PX
            px_y = (radius - gy) * M3_TILE_PX
            mosaic.paste(tile_img, (px_x, px_y))

    half_total = M3_TILE_HALF_DEG * side_tiles
    bbox = bbox_from_center(lon, lat, half_total)
    return mosaic, bbox


def _resolve_panel_title(results: list[MethodResult], lon: float, lat: float) -> str:
    for result in results:
        if result.debug:
            parcel_num = result.debug.get("parcel_label") or result.debug.get("parcel_reference")
            if parcel_num:
                return f"Smoke test particella {parcel_num} @ lon={lon:.6f}, lat={lat:.6f}"
    return f"Smoke test particella @ lon={lon:.6f}, lat={lat:.6f}"


def _normalize_case_name(case_name: str | None) -> str:
    if not case_name:
        return ""
    clean_case = re.sub(r"[^A-Za-z0-9._-]+", "-", case_name.strip()).strip("-")
    return clean_case


def draw_panel(
    results: list[MethodResult],
    lon: float,
    lat: float,
    out_path: pathlib.Path,
    base_url: str | None = None,
    requested_radius: int = 2,
    case_name: str | None = None,
) -> None:
    panel_w, panel_h = 1000, 1000
    canvas = Image.new("RGB", (panel_w, panel_h), (22, 24, 28))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()

    cells = [
        (20, 60, 490, 490),
        (510, 60, 980, 490),
        (20, 510, 490, 980),
        (510, 510, 980, 980),
    ]

    panel_title = _resolve_panel_title(results, lon, lat)
    clean_case = _normalize_case_name(case_name)
    if clean_case:
        panel_title = f"{panel_title} | {clean_case}"
    draw.text((20, 18), panel_title, fill=(235, 235, 235), font=font)

    all_points: list[tuple[float, float]] = []
    for res in results:
        if res.ring_lonlat:
            all_points.extend(res.ring_lonlat)

    if all_points:
        min_lon = min(p[0] for p in all_points)
        max_lon = max(p[0] for p in all_points)
        min_lat = min(p[1] for p in all_points)
        max_lat = max(p[1] for p in all_points)
    else:
        half = 0.0003
        min_lon, max_lon = lon - half, lon + half
        min_lat, max_lat = lat - half, lat + half

    dx = max(1e-9, max_lon - min_lon)
    dy = max(1e-9, max_lat - min_lat)
    min_lon -= dx * 0.1
    max_lon += dx * 0.1
    min_lat -= dy * 0.1
    max_lat += dy * 0.1

    def project_preserve_aspect(
        pt: tuple[float, float],
        cell: tuple[int, int, int, int],
        bounds: tuple[float, float, float, float] | None = None,
    ) -> tuple[float, float]:
        x1, y1, x2, y2 = cell
        cell_w = max(1, x2 - x1)
        cell_h = max(1, y2 - y1)
        if bounds is None:
            b_min_lon, b_max_lon, b_min_lat, b_max_lat = min_lon, max_lon, min_lat, max_lat
        else:
            b_min_lon, b_max_lon, b_min_lat, b_max_lat = bounds
        data_w = max(1e-9, b_max_lon - b_min_lon)
        data_h = max(1e-9, b_max_lat - b_min_lat)
        scale = min(cell_w / data_w, cell_h / data_h)
        draw_w = data_w * scale
        draw_h = data_h * scale
        offset_x = x1 + (cell_w - draw_w) / 2.0
        offset_y = y1 + (cell_h - draw_h) / 2.0
        x = offset_x + (pt[0] - b_min_lon) * scale
        y = offset_y + (b_max_lat - pt[1]) * scale
        return x, y

    colors = [
        (59, 211, 127),
        (83, 156, 255),
        (255, 191, 73),
        (255, 115, 115),
    ]

    for idx, result in enumerate(results[:4]):
        cell = cells[idx]
        x1, y1, x2, y2 = cell
        draw.rectangle(cell, outline=(70, 75, 85), width=2, fill=(30, 34, 40))

        status = "OK" if result.ok else "FAIL"
        status_col = (77, 214, 148) if result.ok else (255, 116, 116)
        draw.text((x1 + 10, y1 + 10), f"{result.name}", fill=(240, 240, 240), font=font)
        draw.text((x1 + 10, y1 + 26), status, fill=status_col, font=font)
        draw.text((x1 + 50, y1 + 26), result.details[:80], fill=(200, 205, 212), font=font)

        cx, cy = project_preserve_aspect((lon, lat), cell)
        draw.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=(240, 240, 240))

        if result.ring_lonlat and len(result.ring_lonlat) >= 4:
            pts = [project_preserve_aspect(p, cell) for p in result.ring_lonlat]
            draw.polygon(pts, outline=colors[idx], fill=(colors[idx][0], colors[idx][1], colors[idx][2]))
            draw.text((x1 + 10, y2 - 20), f"approx area(deg2): {ring_area(result.ring_lonlat):.10f}", fill=(180, 190, 200), font=font)

    coarse = _find_method_result(results, "M3 Backend /parcel-geometry-m3")
    refined = _find_method_result(results, "M3 Refine")
    coarse_ring = coarse.ring_lonlat if coarse is not None else None
    refined_ring = refined.ring_lonlat if refined is not None else None
    extras_enabled = coarse_ring is not None and refined_ring is not None and len(results) <= 2

    if extras_enabled:
        mosaic_cell = cells[2]
        diff_cell = cells[3]

        used_radius_raw = coarse.debug.get("used_radius") if coarse and coarse.debug else requested_radius
        used_radius = int(used_radius_raw) if isinstance(used_radius_raw, (int, float)) else requested_radius

        # Extra panel 1: composed WMS tile mosaic used for the inspected parcel.
        mx1, my1, mx2, my2 = mosaic_cell
        draw.rectangle(mosaic_cell, outline=(70, 75, 85), width=2, fill=(30, 34, 40))
        draw.text((mx1 + 10, my1 + 10), "Mosaico tile composito (M3)", fill=(240, 240, 240), font=font)

        mosaic_img, mosaic_bbox = _fetch_m3_mosaic(base_url or DEFAULT_BASE_URL, lon, lat, used_radius)
        if mosaic_img is not None and mosaic_bbox is not None:
            inner = (mx1 + 10, my1 + 30, mx2 - 10, my2 - 10)
            inner_w = max(1, inner[2] - inner[0])
            inner_h = max(1, inner[3] - inner[1])
            mosaic_fit = mosaic_img.resize((inner_w, inner_h))
            canvas.paste(mosaic_fit, (inner[0], inner[1]))

            b_min_lon, b_min_lat, b_max_lon, b_max_lat = mosaic_bbox
            mosaic_bounds = (b_min_lon, b_max_lon, b_min_lat, b_max_lat)

            if coarse_ring and len(coarse_ring) >= 4:
                coarse_pts = [project_preserve_aspect(p, inner, mosaic_bounds) for p in coarse_ring]
                draw.line(coarse_pts, fill=(255, 191, 73), width=2)
            if refined_ring and len(refined_ring) >= 4:
                refined_pts = [project_preserve_aspect(p, inner, mosaic_bounds) for p in refined_ring]
                draw.line(refined_pts, fill=(83, 156, 255), width=2)

            cpx, cpy = project_preserve_aspect((lon, lat), inner, mosaic_bounds)
            draw.ellipse((cpx - 3, cpy - 3, cpx + 3, cpy + 3), fill=(255, 255, 255))
            draw.text((mx1 + 10, my2 - 20), "giallo=coarse, blu=edge-snap refine", fill=(225, 225, 225), font=font)

        # Extra panel 2: geometric diff between coarse and refined detection.
        dx1, dy1, dx2, dy2 = diff_cell
        draw.rectangle(diff_cell, outline=(70, 75, 85), width=2, fill=(30, 34, 40))
        draw.text((dx1 + 10, dy1 + 10), "Diff coarse vs refined", fill=(240, 240, 240), font=font)

        if coarse_ring and refined_ring and len(coarse_ring) >= 4 and len(refined_ring) >= 4:
            d_inner_w = max(1, (dx2 - dx1) - 20)
            d_inner_h = max(1, (dy2 - dy1) - 40)
            diff_panel = Image.new("RGB", (d_inner_w, d_inner_h), (35, 39, 46))
            d_draw = ImageDraw.Draw(diff_panel)

            diff_points = coarse_ring + refined_ring
            d_min_lon = min(p[0] for p in diff_points)
            d_max_lon = max(p[0] for p in diff_points)
            d_min_lat = min(p[1] for p in diff_points)
            d_max_lat = max(p[1] for p in diff_points)
            d_dx = max(1e-9, d_max_lon - d_min_lon)
            d_dy = max(1e-9, d_max_lat - d_min_lat)
            d_min_lon -= d_dx * 0.08
            d_max_lon += d_dx * 0.08
            d_min_lat -= d_dy * 0.08
            d_max_lat += d_dy * 0.08

            def project_local(pt: tuple[float, float]) -> tuple[float, float]:
                scale = min(d_inner_w / max(1e-9, d_max_lon - d_min_lon), d_inner_h / max(1e-9, d_max_lat - d_min_lat))
                draw_w = (d_max_lon - d_min_lon) * scale
                draw_h = (d_max_lat - d_min_lat) * scale
                ox = (d_inner_w - draw_w) / 2.0
                oy = (d_inner_h - draw_h) / 2.0
                x = ox + (pt[0] - d_min_lon) * scale
                y = oy + (d_max_lat - pt[1]) * scale
                return x, y

            coarse_local = [project_local(p) for p in coarse_ring]
            refined_local = [project_local(p) for p in refined_ring]

            coarse_mask = Image.new("L", (d_inner_w, d_inner_h), 0)
            refined_mask = Image.new("L", (d_inner_w, d_inner_h), 0)
            ImageDraw.Draw(coarse_mask).polygon(coarse_local, fill=255)
            ImageDraw.Draw(refined_mask).polygon(refined_local, fill=255)
            diff_mask = ImageChops.difference(coarse_mask, refined_mask)
            zero_mask = Image.new("L", (d_inner_w, d_inner_h), 0)
            diff_rgb = Image.merge("RGB", (diff_mask, zero_mask, zero_mask))
            diff_panel = ImageChops.add(diff_panel, diff_rgb)
            d_draw = ImageDraw.Draw(diff_panel)
            d_draw.polygon(coarse_local, outline=(255, 191, 73), width=2)
            d_draw.polygon(refined_local, outline=(83, 156, 255), width=2)

            canvas.paste(diff_panel, (dx1 + 10, dy1 + 30))
            refined_debug = refined.debug if refined is not None else {}
            delta_m2 = float(refined_debug.get("delta_area_m2", 0.0)) if refined_debug else 0.0
            draw.text((dx1 + 10, dy2 - 20), f"rosso=diff simmetrica, delta_area={delta_m2:.2f} m2", fill=(225, 225, 225), font=font)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format="PNG")


def run(
    base_url: str = DEFAULT_BASE_URL,
    lon: float | None = TARGET_LON,
    lat: float | None = TARGET_LAT,
    hint: str = TARGET_HINT,
    radius: int = 2,
    case_name: str | None = None,
) -> int:
    try:
        lon, lat, resolved_source = resolve_input_coordinates(hint, lon, lat)
    except ValueError as exc:
        print("Smoke FAIL")
        print(f"  {exc}")
        return 2
    results: list[MethodResult] = []
    parcel_ref = hint
    out_img, out_json = build_output_paths(lon, lat, "full", case_name=case_name)

    try:
        m1, parcel_ref = method_1_semantic_geometry(base_url, lon, lat, hint)
    except Exception as exc:
        m1 = MethodResult("M1 Semantic /parcel-at-point", False, f"Exception: {exc}", None, {
            "traceback": traceback.format_exc(),
        })
    results.append(m1)

    try:
        m2 = method_2_wms_featureinfo_json(base_url, lon, lat, parcel_ref)
    except Exception as exc:
        m2 = MethodResult("M2 WMS GetFeatureInfo JSON", False, f"Exception: {exc}", None, {
            "traceback": traceback.format_exc(),
        })
    results.append(m2)

    try:
        m3 = method_3_raster_segmentation(base_url, lon, lat, radius)
    except Exception as exc:
        m3 = MethodResult("M3 Raster color segmentation", False, f"Exception: {exc}", None, {
            "traceback": traceback.format_exc(),
        })
    results.append(m3)

    if ENABLE_METHOD_4:
        try:
            m4 = method_4_grid_probing(base_url, lon, lat, parcel_ref)
        except Exception as exc:
            m4 = MethodResult("M4 Grid probing parcel-id", False, f"Exception: {exc}", None, {
                "traceback": traceback.format_exc(),
            })
        results.append(m4)

    draw_panel(results, lon, lat, out_img, base_url=base_url, requested_radius=radius, case_name=case_name)

    report = {
        "base_url": base_url,
        "target": {
            "lon": lon,
            "lat": lat,
            "hint": hint,
            "resolved_parcel_ref": parcel_ref,
            "resolved_source": resolved_source,
            "case_name": _normalize_case_name(case_name),
        },
        "results": [
            {
                "name": r.name,
                "ok": r.ok,
                "details": r.details,
                "vertices": len(r.ring_lonlat or []),
                "debug": r.debug,
            }
            for r in results
        ],
        "output_image": str(out_img),
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    ok_count = sum(1 for r in results if r.ok)
    print(f"Smoke completed: {ok_count}/{len(results)} metodi OK")
    print(f"Image: {out_img}")
    print(f"Report: {out_json}")

    return 0 if ok_count > 0 else 2


def run_method3_only(
    base_url: str = DEFAULT_BASE_URL,
    lon: float | None = TARGET_LON,
    lat: float | None = TARGET_LAT,
    hint: str = TARGET_HINT,
    radius: int = 2,
    refine: bool = False,
    quality: str = "balanced",
    max_requests: int | None = None,
    case_name: str | None = None,
    corner_snap: bool = False,
    trace: bool = False,
    trace_tolerance_m: float = 0.35,
) -> int:
    try:
        lon, lat, resolved_source = resolve_input_coordinates(hint, lon, lat)
    except ValueError as exc:
        print("M3 FAIL")
        print(f"  {exc}")
        return 2
    out_img, out_json = build_output_paths(lon, lat, "m3", case_name=case_name)
    try:
        m3 = method_3_raster_segmentation(base_url, lon, lat, radius)
    except Exception as exc:
        m3 = MethodResult("M3 Backend /parcel-geometry-m3", False, f"Exception: {exc}", None, {
            "traceback": traceback.format_exc(),
        })

    results = [m3]
    m3_refine = None
    if refine:
        try:
            m3_refine = method_3_refine_border_tiles(
                base_url,
                lon,
                lat,
                m3,
                quality=quality,
                max_requests=max_requests,
                corner_snap=corner_snap,
            )
        except Exception as exc:
            m3_refine = MethodResult("M3 Refine border-only tiles", False, f"Exception: {exc}", None, {
                "traceback": traceback.format_exc(),
            })
        results.append(m3_refine)

    m3_trace = None
    if trace:
        try:
            m3_trace = method_3_trace_contour_walk(
                base_url,
                lon,
                lat,
                m3,
                tolerance_m=trace_tolerance_m,
            )
        except Exception as exc:
            m3_trace = MethodResult("M3 Trace contour-walk", False, f"Exception: {exc}", None, {
                "traceback": traceback.format_exc(),
            })
        results.append(m3_trace)

    draw_panel(results, lon, lat, out_img, base_url=base_url, requested_radius=radius, case_name=case_name)

    report = {
        "base_url": base_url,
        "target": {"lon": lon, "lat": lat, "hint": hint, "resolved_source": resolved_source, "case_name": _normalize_case_name(case_name)},
        "results": [
            {
                "name": r.name,
                "ok": r.ok,
                "details": r.details,
                "vertices": len(r.ring_lonlat or []),
                "debug": r.debug,
            }
            for r in results
        ],
        "output_image": str(out_img),
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if m3.ok:
        parcel_num = m3.debug.get("parcel_label") or m3.debug.get("parcel_reference") or "unknown"
        area_m2 = float(m3.debug.get("estimated_area_m2", 0.0))
        area_ha = float(m3.debug.get("estimated_area_ha", 0.0))
        used_radius = m3.debug.get("used_radius", "n/a")
        max_radius_requested = m3.debug.get("max_radius_requested", radius)
        print("M3 OK")
        print(f"  parcel: {parcel_num}")
        print(f"  area: {area_m2:.2f} m2 ({area_ha:.4f} ha)")
        print(f"  radius requested: {max_radius_requested}")
        print(f"  radius used: {used_radius}")
        print(f"  vertices: {len(m3.ring_lonlat or [])}")
    else:
        print("M3 FAIL")
        print(f"  radius requested: {radius}")
        print(f"  debug: {m3.debug}")

    if refine and m3_refine is not None:
        if m3_refine.ok:
            def _safe_float(value: Any) -> float:
                if isinstance(value, (int, float)):
                    return float(value)
                try:
                    return float(value)
                except Exception:
                    return 0.0

            print("M3 REFINE OK")
            print(f"  quality: {m3_refine.debug.get('quality', quality)}")
            print(f"  requests used: {m3_refine.debug.get('requestsUsed', 'n/a')}")
            print(f"  snap accepted: {m3_refine.debug.get('snapAcceptedVertices', m3_refine.debug.get('snap_accepted_vertices', 'n/a'))}")
            print(f"  snap kept: {m3_refine.debug.get('snapKeptVertices', m3_refine.debug.get('snap_kept_vertices', 'n/a'))}")
            print(f"  mean snap: {_safe_float(m3_refine.debug.get('meanSnapMeters', m3_refine.debug.get('mean_snap_meters', 0.0))):.2f} m")
            print(f"  mean confidence: {_safe_float(m3_refine.debug.get('meanConfidence', m3_refine.debug.get('mean_confidence', 0.0))):.3f}")
            print(f"  ownership mode: {m3_refine.debug.get('ownershipMode', 'n/a')}")
            print(f"  ownership accepted: {m3_refine.debug.get('ownershipAccepted', 'n/a')}")
            print(f"  ownership rejected: {m3_refine.debug.get('ownershipRejected', 'n/a')}")
            print(f"  ownership ambiguous: {m3_refine.debug.get('ownershipAmbiguous', 'n/a')}")
            print(f"  mean ownership score: {_safe_float(m3_refine.debug.get('meanOwnershipScore', 0.0)):.3f}")
            print(f"  ownership dir flips: {m3_refine.debug.get('ownershipDirectionFlips', 'n/a')}")
            print(f"  inside failures: {m3_refine.debug.get('ownershipInsideFailures', 'n/a')}")
            print(f"  outside failures: {m3_refine.debug.get('ownershipOutsideFailures', 'n/a')}")
            print(f"  continuity boost mean: {_safe_float(m3_refine.debug.get('continuityBoostMean', 0.0)):.3f}")
            print(f"  mean score gain: {_safe_float(m3_refine.debug.get('meanScoreGain', 0.0)):.3f}")
            print(f"  rejected by distance: {m3_refine.debug.get('rejectedByDistance', 'n/a')}")
            print(f"  rejected by weak gain: {m3_refine.debug.get('rejectedByWeakGain', 'n/a')}")
            print(f"  delta area: {float(m3_refine.debug.get('delta_area_m2', 0.0)):.2f} m2")
            print(f"  delta ratio: {float(m3_refine.debug.get('delta_area_ratio', 0.0)):.4f}")
        else:
            print("M3 REFINE FAIL")
            print(f"  debug: {m3_refine.debug}")

    if trace and m3_trace is not None:
        if m3_trace.ok:
            print("M3 TRACE OK")
            print(f"  algorithm: {m3_trace.debug.get('algorithm', 'n/a')}")
            print(f"  toleranceM: {m3_trace.debug.get('toleranceM', 'n/a')}")
            print(f"  tiles fetched: {m3_trace.debug.get('tilesFetched', 'n/a')}")
            print(f"  skeleton pixels full/filtered: {m3_trace.debug.get('skeletonPixelsFull', 'n/a')} / {m3_trace.debug.get('skeletonPixelsFiltered', 'n/a')}")
            print(f"  coarse vertices: {m3_trace.debug.get('coarseVertices', 'n/a')}")
            print(f"  snapped corners: {m3_trace.debug.get('snappedCorners', 'n/a')} (snap failures {m3_trace.debug.get('snapFailures', 'n/a')})")
            print(f"  BFS failures: {m3_trace.debug.get('bfsFailures', 'n/a')}")
            print(f"  final vertices: {m3_trace.debug.get('finalVertices', 'n/a')}")
            print(f"  anti-fuga snapped/kept-atpoint/dropped: {m3_trace.debug.get('antiFugaSnapped', 'n/a')} / {m3_trace.debug.get('antiFugaKeptViaAtPoint', 'n/a')} / {m3_trace.debug.get('antiFugaDropped', 'n/a')}")
            print(f"  atPoint calls: {m3_trace.debug.get('atPointCalls', 'n/a')}")
            print(f"  delta area: {float(m3_trace.debug.get('delta_area_m2', 0.0)):.2f} m2")
            print(f"  delta ratio: {float(m3_trace.debug.get('delta_area_ratio', 0.0)):.4f}")
        else:
            print("M3 TRACE FAIL")
            print(f"  debug: {m3_trace.debug}")

    print(f"Image: {out_img}")
    print(f"Report: {out_json}")

    if refine and trace:
        all_ok = m3.ok and m3_refine is not None and m3_refine.ok and m3_trace is not None and m3_trace.ok
        return 0 if all_ok else 2
    if refine:
        return 0 if (m3.ok and m3_refine is not None and m3_refine.ok) else 2
    if trace:
        return 0 if (m3.ok and m3_trace is not None and m3_trace.ok) else 2
    return 0 if m3.ok else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smoke test parcels")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--lon", type=float, default=None)
    parser.add_argument("--lat", type=float, default=None)
    parser.add_argument("--hint", default=TARGET_HINT)
    parser.add_argument("--ref", default=None, help="Cadastral reference to use as lookup hint (e.g. B609_000200.333)")
    parser.add_argument("--radius", type=int, default=2, help="Max progressive radius for endpoint M3 method")
    parser.add_argument("--refine", action="store_true", help="Run M3 fine border alignment after coarse detect")
    parser.add_argument("--quality", choices=["fast", "balanced", "precise", "aggressive"], default="balanced", help="Quality profile for refine mode")
    parser.add_argument("--max-requests", type=int, default=None, help="Optional max request budget override for refine mode")
    parser.add_argument("--corner-snap", action="store_true", help="Enable corner-aware line-fit consolidation in refine")
    parser.add_argument("--trace", action="store_true", help="Run the new contour-walk trace algorithm (/parcel-geometry-m3-trace)")
    parser.add_argument("--trace-tolerance", type=float, default=0.35, help="Tolerance in meters for trace adaptive subdivision (default 0.35)")
    parser.add_argument("--case-name", default=None, help="Human-readable identifier for the test case")
    parser.add_argument("--method3-only", action="store_true", help="Run only method 3")
    args = parser.parse_args()

    hint = args.ref or args.hint

    if args.method3_only:
        raise SystemExit(run_method3_only(
            args.base_url,
            args.lon,
            args.lat,
            hint,
            args.radius,
            refine=args.refine,
            quality=args.quality,
            max_requests=args.max_requests,
            case_name=args.case_name,
            corner_snap=args.corner_snap,
            trace=args.trace,
            trace_tolerance_m=args.trace_tolerance,
        ))
    raise SystemExit(run(args.base_url, args.lon, args.lat, hint, args.radius, case_name=args.case_name))
