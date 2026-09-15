# WMS Proxy & Georeferenced Export Guide (LLM-Wiki Raw)

## Overview

This document explains the architecture and implementation of:

- WMS proxy integration
- Client-side map rendering (Leaflet)
- Import of external geometries (GeoJSON / KML)
- Versioned dataset storage (IndexedDB)
- Georeferenced export strategies (PNG, GeoTIFF, Dataset bundle)

Focus: **georeferenced export pipeline and data integrity**.

---

## 1. Architecture Summary

```
Browser (Leaflet)
   ↓
Local Proxy (Flask)
   ↓
WMS Server (Agenzia Entrate)
```

### Why Proxy?

The WMS service does not provide proper CORS headers and may return non-image responses.

Without proxy:
- CORB blocking
- inconsistent tile rendering

With proxy:
- stable responses
- controlled headers
- caching possible

---

## 2. WMS Rendering Modes

### Tiled Mode (Leaflet)

- Multiple requests (256x256 tiles)
- Fast navigation
- Multiple watermark repetition

### Single WMS (GetMap)

- One request
- Clean output (single watermark)
- Used for export

---

## 3. Bounding Box (BBOX) Handling

Coordinate system: **EPSG:4258**

Order (WMS 1.3.0):

```
BBOX = south,west,north,east
```

Derived from Leaflet bounds:

```js
const bounds = layer.getBounds();

const bbox = [
  bounds.getSouth(),
  bounds.getWest(),
  bounds.getNorth(),
  bounds.getEast()
];
```

---

## 4. Resolution Strategy

To maintain aspect ratio:

```js
const dx = east - west;
const dy = north - south;

if (dx > dy) {
  width = baseSize;
  height = baseSize * (dy / dx);
} else {
  height = baseSize;
  width = baseSize * (dx / dy);
}
```

This ensures:
- no distortion
- correct geospatial scaling

---

## 5. Export Types

### 5.1 PNG (Non-georeferenced)

- Simple raster
- No spatial metadata
- Fast

Use case:
- preview
- reporting

---

### 5.2 PNG + World File (PGW)

World file structure:

```
pixel_size_x
0
0
-pixel_size_y
origin_x (west)
origin_y (north)
```

Advantages:
- GIS-compatible
- lightweight

Limitations:
- metadata external

---

### 5.3 GeoTIFF (True Georeferenced)

GeoTIFF includes:
- raster data
- coordinate system
- geotransform

Core parameters:

```js
pixelScale = [pixelSizeX, pixelSizeY, 0]
tiePoints = [0, 0, 0, west, north, 0]
```

GeoKeys:

```js
{
  GTModelTypeGeoKey: 2,
  GeographicTypeGeoKey: 4258
}
```

Advantages:
- single file
- GIS-native
- AI pipeline ready

---

## 6. Dataset Export (AI-Oriented)

Recommended structure:

```
field_id_timestamp/
 ├── image.tif
 ├── areas.geojson
 └── meta.json
```

### Components

#### GeoJSON
- vector geometries
- semantic meaning

#### Raster (WMS)
- visual context

#### Metadata

```json
{
  "bbox": "...",
  "crs": "EPSG:4258",
  "timestamp": "...",
  "width": 1024,
  "height": 1024
}
```

---

## 7. IndexedDB Versioning

Each field:

```json
{
  "id": "field_001",
  "name": "Field Name",
  "history": [
    {
      "timestamp": "...",
      "geojson": {...},
      "bbox": [...]
    }
  ]
}
```

Key concepts:
- append-only history
- reproducibility
- dataset lineage

---

## 8. Export Pipeline (Step-by-Step)

1. User selects/imports geometry
2. Bounds extracted
3. BBOX computed
4. WMS request built
5. Raster fetched via proxy
6. (Optional) GeoTIFF encoding
7. Dataset assembled
8. Files downloaded

---

## 9. Critical Constraints

- WMS max size limits (typically 4096px)
- network latency
- server instability

Mitigations:
- stitching
- retry logic
- proxy caching

---

## 10. AI Readiness Considerations

To support ML workflows:

- consistent resolution
- stable CRS
- aligned raster/vector
- versioned datasets

Avoid:
- raw PNG without metadata
- inconsistent scaling

---

## 11. Recommended Evolution

Short-term:
- ZIP export (single package)
- GeoTIFF standardization

Mid-term:
- server-side export
- tile caching

Advanced:
- temporal datasets
- ML integration

---

## Conclusion

The system evolves from:

"map viewer" → "data acquisition pipeline"

Key principle:

**Data integrity > visualization**

Georeferenced export is the foundation for any advanced GIS or AI workflow.

