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
import json
import io
import math
import pathlib
import re
import traceback
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageDraw, ImageFont
import cv2
import numpy as np


DEFAULT_BASE_URL = "http://127.0.0.1:8000"
TARGET_LON = 12.561465
TARGET_LAT = 43.012393
TARGET_HINT = "B609_000200.402"

OUT_DIR = pathlib.Path(__file__).resolve().parent / "output"
LEGACY_OUT_DIR = pathlib.Path(__file__).resolve().parent / "tests" / "output"
ENABLE_METHOD_4 = False


def build_output_paths(lon: float, lat: float, mode: str) -> tuple[pathlib.Path, pathlib.Path]:
    lon_tag = f"{lon:.6f}".replace("-", "m").replace(".", "p")
    lat_tag = f"{lat:.6f}".replace("-", "m").replace(".", "p")
    stem = f"parcel_smoke_{mode}_lon_{lon_tag}_lat_{lat_tag}"
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
            debug = result.get("debug") if isinstance(result.get("debug"), dict) else {}
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
    name = "M3 Raster color segmentation"
    tile_half = 0.00030
    tile_px = 420
    max_radius = max(0, int(max_radius))  # radius=0 -> 1x1, 1 -> 3x3, 2 -> 5x5 tiles

    def fetch_tile(center_lon: float, center_lat: float) -> Image.Image:
        lon_min_t, lat_min_t, lon_max_t, lat_max_t = bbox_from_center(center_lon, center_lat, tile_half)
        qs = urllib.parse.urlencode({
            "SERVICE": "WMS",
            "REQUEST": "GetMap",
            "VERSION": "1.3.0",
            "LAYERS": "CP.CadastralParcel",
            "STYLES": "",
            "CRS": "EPSG:6706",
            "BBOX": f"{lat_min_t},{lon_min_t},{lat_max_t},{lon_max_t}",
            "WIDTH": str(tile_px),
            "HEIGHT": str(tile_px),
            "FORMAT": "image/png",
            "TRANSPARENT": "true",
        })
        png = http_bytes(base_url, f"/wms-proxy?{qs}")
        
        # DEBUG: save raw WMS tile for analysis (only on first tile)
        if radius == 0:
            debug_path = OUT_DIR / f"wms_raw_tile_lon_{center_lon:.6f}_lat_{center_lat:.6f}.png"
            debug_path.parent.mkdir(parents=True, exist_ok=True)
            debug_path.write_bytes(png)
        
        return Image.open(io.BytesIO(png)).convert("RGBA")

    def build_mosaic(radius: int) -> Image.Image:
        side = (2 * radius + 1) * tile_px
        mosaic = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        span_deg = tile_half * 2.0

        for gy in range(radius, -radius - 1, -1):
            for gx in range(-radius, radius + 1):
                lon_t = lon + gx * span_deg
                lat_t = lat + gy * span_deg
                try:
                    tile_img = fetch_tile(lon_t, lat_t)
                except Exception:
                    tile_img = Image.new("RGBA", (tile_px, tile_px), (0, 0, 0, 0))

                px_x = (gx + radius) * tile_px
                px_y = (radius - gy) * tile_px
                mosaic.paste(tile_img, (px_x, px_y))

        return mosaic

    def detect_on_image(img: Image.Image, radius: int) -> tuple[list[tuple[float, float]] | None, dict[str, Any]]:
        """Extract parcel boundary by:
        1. Mask out red logo (Agenzia Entrate branding)
        2. Finding all edge pixels (black borders)
        3. Flood-filling from image center to find region containing the queried point
        4. Extracting only the contour of that region"""
        
        # Convert PIL to numpy
        img_cv = np.array(img.convert("RGB"))
        img_cv = cv2.cvtColor(img_cv, cv2.COLOR_RGB2BGR)
        
        # Remove red logo (Agenzia Entrate): detect red pixels and replace with background
        # Red in BGR: high R (>150), low G (<100), low B (<100)
        lower_red = np.array([0, 0, 150])      # BGR: B, G, R
        upper_red = np.array([100, 100, 255])
        red_mask = cv2.inRange(img_cv, lower_red, upper_red)
        
        # Replace red pixels with beige background (WMS fill color ~253,236,189 in RGB = 189,236,253 in BGR)
        background_color = np.array([189, 236, 253], dtype=np.uint8)
        img_cv[red_mask > 0] = background_color
        
        # Convert to grayscale
        gray = cv2.cvtColor(img_cv, cv2.COLOR_BGR2GRAY)
        
        # Detect edges (WMS black borders ~10-15 grayscale)
        edges = cv2.Canny(gray, threshold1=50, threshold2=120)
        
        # Invert: white=border, black=fillable area
        filled_area = cv2.bitwise_not(edges)
        
        # Flood-fill from image center to find the region containing the queried point
        w, h = img.size
        cx, cy = w // 2, h // 2
        
        # Verify center pixel is not on a border
        if filled_area[cy, cx] == 0:
            # Center is on a border, search nearby
            found = False
            for r_search in range(1, 20):
                for dy in range(-r_search, r_search + 1):
                    for dx in range(-r_search, r_search + 1):
                        x, y = cx + dx, cy + dy
                        if 0 <= x < w and 0 <= y < h and filled_area[y, x] > 0:
                            cx, cy = x, y
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
        
        if filled_area[cy, cx] == 0:
            return None, {"reason": "center_on_border"}
        
        # Create a mask: flood-fill from center
        # This finds the exact region that contains the queried point
        mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
        cv2.floodFill(filled_area, mask, (cx, cy), 255)
        
        # Extract the filled region (without the extra border added by floodFill)
        region_mask = mask[1:-1, 1:-1]
        region_area_px = np.count_nonzero(region_mask)
        
        if region_area_px < 20:
            return None, {"reason": "region_too_small", "region_px": int(region_area_px)}
        
        # Find contours of this region
        contours, _ = cv2.findContours(region_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            return None, {"reason": "no_region_contours"}
        
        # Should have exactly one contour for the region
        region_contour = max(contours, key=cv2.contourArea)
        
        # Approximate to reduce noise
        epsilon = 0.005 * cv2.arcLength(region_contour, True)
        approx = cv2.approxPolyDP(region_contour, epsilon, True)
        
        boundary_px = [(pt[0][0], pt[0][1]) for pt in approx]
        
        if len(boundary_px) < 3:
            return None, {"reason": "too_few_vertices"}
        
        # Convert to lon/lat
        total_half = tile_half * (2 * radius + 1)
        lon_min, lat_min, lon_max, lat_max = bbox_from_center(lon, lat, total_half)
        
        def px_to_lonlat(x: int, y: int) -> tuple[float, float]:
            lon_v = lon_min + (x / (w - 1)) * (lon_max - lon_min)
            lat_v = lat_max - (y / (h - 1)) * (lat_max - lat_min)
            return lon_v, lat_v
        
        ring = normalize_ring([px_to_lonlat(x, y) for x, y in boundary_px])
        
        if len(ring) < 3:
            return None, {"reason": "ring_too_small"}
        
        touches_border = any((x <= 2 or x >= w - 2 or y <= 2 or y >= h - 2) for x, y in boundary_px)
        
        return ring, {
            "region_area_px": int(region_area_px),
            "contour_vertices": len(approx),
            "touches_border": touches_border,
            "radius": radius,
            "mosaic_tiles": (2 * radius + 1) ** 2,
            "seed_cx": cx,
            "seed_cy": cy,
            "red_pixels_masked": int(np.count_nonzero(red_mask)),
        }

    last_debug: dict[str, Any] = {}
    for radius in range(0, max_radius + 1):
        mosaic = build_mosaic(radius)
        ring, debug = detect_on_image(mosaic, radius)
        last_debug = debug

        if not ring:
            continue

        if debug.get("touches_border") and radius < max_radius:
            # The detected parcel spills out of current mosaic: expand to neighboring tiles.
            continue

        area_m2 = ring_area_interpolated_m2(ring)
        debug["estimated_area_m2"] = area_m2
        debug["estimated_area_ha"] = area_m2 / 10000.0
        debug["max_radius_requested"] = max_radius
        debug["used_radius"] = radius
        debug.update(fetch_parcel_label_from_featureinfo_html(base_url, lon, lat))
        return MethodResult(name, True, f"Raster-derived hull, {len(ring)} vertices (radius={radius})", ring, debug)

    last_debug["max_radius_requested"] = max_radius
    return MethodResult(name, False, "Unable to close raster contour after neighbor-tile expansion", None, last_debug)


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


def _resolve_panel_title(results: list[MethodResult], lon: float, lat: float) -> str:
    for result in results:
        if result.debug:
            parcel_num = result.debug.get("parcel_label") or result.debug.get("parcel_reference")
            if parcel_num:
                return f"Smoke test particella {parcel_num} @ lon={lon:.6f}, lat={lat:.6f}"
    return f"Smoke test particella @ lon={lon:.6f}, lat={lat:.6f}"


def draw_panel(results: list[MethodResult], lon: float, lat: float, out_path: pathlib.Path) -> None:
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

    # Add margin.
    dx = max(1e-9, max_lon - min_lon)
    dy = max(1e-9, max_lat - min_lat)
    min_lon -= dx * 0.1
    max_lon += dx * 0.1
    min_lat -= dy * 0.1
    max_lat += dy * 0.1

    def project(pt: tuple[float, float], cell: tuple[int, int, int, int]) -> tuple[float, float]:
        x1, y1, x2, y2 = cell
        w = max(1, x2 - x1)
        h = max(1, y2 - y1)
        x = x1 + ((pt[0] - min_lon) / (max_lon - min_lon)) * w
        y = y2 - ((pt[1] - min_lat) / (max_lat - min_lat)) * h
        return x, y

    def project_preserve_aspect(pt: tuple[float, float], cell: tuple[int, int, int, int]) -> tuple[float, float]:
        x1, y1, x2, y2 = cell
        cell_w = max(1, x2 - x1)
        cell_h = max(1, y2 - y1)
        data_w = max(1e-9, max_lon - min_lon)
        data_h = max(1e-9, max_lat - min_lat)
        scale = min(cell_w / data_w, cell_h / data_h)
        draw_w = data_w * scale
        draw_h = data_h * scale
        offset_x = x1 + (cell_w - draw_w) / 2.0
        offset_y = y1 + (cell_h - draw_h) / 2.0
        x = offset_x + (pt[0] - min_lon) * scale
        y = offset_y + (max_lat - pt[1]) * scale
        return x, y

    colors = [
        (59, 211, 127),
        (83, 156, 255),
        (255, 191, 73),
        (255, 115, 115),
    ]

    for idx, result in enumerate(results):
        cell = cells[idx]
        x1, y1, x2, y2 = cell
        draw.rectangle(cell, outline=(70, 75, 85), width=2, fill=(30, 34, 40))

        status = "OK" if result.ok else "FAIL"
        status_col = (77, 214, 148) if result.ok else (255, 116, 116)
        draw.text((x1 + 10, y1 + 10), f"{result.name}", fill=(240, 240, 240), font=font)
        draw.text((x1 + 10, y1 + 26), status, fill=status_col, font=font)

        detail = result.details[:80]
        draw.text((x1 + 50, y1 + 26), detail, fill=(200, 205, 212), font=font)

        # Draw center point.
        cx, cy = project_preserve_aspect((lon, lat), cell)
        draw.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=(240, 240, 240))

        if result.ring_lonlat and len(result.ring_lonlat) >= 4:
            pts = [project_preserve_aspect(p, cell) for p in result.ring_lonlat]
            draw.polygon(pts, outline=colors[idx], fill=(colors[idx][0], colors[idx][1], colors[idx][2], 40))
            area = ring_area(result.ring_lonlat)
            draw.text((x1 + 10, y2 - 20), f"approx area(deg2): {area:.10f}", fill=(180, 190, 200), font=font)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format="PNG")


def run(
    base_url: str = DEFAULT_BASE_URL,
    lon: float | None = TARGET_LON,
    lat: float | None = TARGET_LAT,
    hint: str = TARGET_HINT,
    radius: int = 2,
) -> int:
    try:
        lon, lat, resolved_source = resolve_input_coordinates(hint, lon, lat)
    except ValueError as exc:
        print("Smoke FAIL")
        print(f"  {exc}")
        return 2
    results: list[MethodResult] = []
    parcel_ref = hint
    out_img, out_json = build_output_paths(lon, lat, "full")

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

    draw_panel(results, lon, lat, out_img)

    report = {
        "base_url": base_url,
        "target": {
            "lon": lon,
            "lat": lat,
            "hint": hint,
            "resolved_parcel_ref": parcel_ref,
            "resolved_source": resolved_source,
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
) -> int:
    try:
        lon, lat, resolved_source = resolve_input_coordinates(hint, lon, lat)
    except ValueError as exc:
        print("M3 FAIL")
        print(f"  {exc}")
        return 2
    out_img, out_json = build_output_paths(lon, lat, "m3")
    try:
        m3 = method_3_raster_segmentation(base_url, lon, lat, radius)
    except Exception as exc:
        m3 = MethodResult("M3 Raster color segmentation", False, f"Exception: {exc}", None, {
            "traceback": traceback.format_exc(),
        })

    draw_panel([m3], lon, lat, out_img)

    report = {
        "base_url": base_url,
        "target": {"lon": lon, "lat": lat, "hint": hint, "resolved_source": resolved_source},
        "results": [
            {
                "name": m3.name,
                "ok": m3.ok,
                "details": m3.details,
                "vertices": len(m3.ring_lonlat or []),
                "debug": m3.debug,
            }
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
    print(f"Image: {out_img}")
    print(f"Report: {out_json}")

    return 0 if m3.ok else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smoke test parcels")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--lon", type=float, default=None)
    parser.add_argument("--lat", type=float, default=None)
    parser.add_argument("--hint", default=TARGET_HINT)
    parser.add_argument("--ref", default=None, help="Cadastral reference to use as lookup hint (e.g. B609_000200.333)")
    parser.add_argument("--radius", type=int, default=2, help="Max neighbor-tile expansion radius for method 3")
    parser.add_argument("--method3-only", action="store_true", help="Run only method 3")
    args = parser.parse_args()

    hint = args.ref or args.hint

    if args.method3_only:
        raise SystemExit(run_method3_only(args.base_url, args.lon, args.lat, hint, args.radius))
    raise SystemExit(run(args.base_url, args.lon, args.lat, hint, args.radius))
