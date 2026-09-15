# WMS Proxy Interpretation Layer – Technical Specification

## Objective

Evolve the current WMS proxy from a **transport layer** (pass-through) into an **interpretation layer** while maintaining full backward compatibility.

The system must:
- Preserve current raw WMS responses
- Add structured JSON outputs for FeatureInfo
- Introduce a semantic endpoint `/parcel-at-point`
- Avoid breaking existing frontend behavior

---

## 1. Current State (Baseline)

The proxy currently:
- Forwards WMS requests
- Normalizes CRS/BBOX
- Handles retries and errors
- Returns raw responses (PNG, XML, HTML)

FeatureInfo responses:
- Returned as raw HTML
- Parsed client-side (or manually via regex)

---

## 2. Design Goals

1. **Non-breaking evolution**
2. **Dual-mode responses (raw + structured)**
3. **Server-side parsing responsibility**
4. **Progressive migration path**

---

## 3. Phase A – Structured FeatureInfo Output

### 3.1 Behavior

Extend `/wms-proxy` to support an optional parameter:

```
OUTPUT=json
```

When present AND request is `GetFeatureInfo`:
- Parse HTML response
- Return structured JSON

Otherwise:
- Return original raw response

---

### 3.2 Detection Logic

```
if REQUEST == "GetFeatureInfo" and OUTPUT == "json":
    return parsed JSON
else:
    return original response
```

---

### 3.3 Parsing Strategy

Use existing function:

```
_extract_featureinfo_fields_from_html(payload)
```

Enhance normalization:

| Raw Field | Normalized Key |
|----------|----------------|
| Label | label |
| NationalCadastralReference | parcel_id |
| InspireId_localId | local_id |
| InspireId_namespace | namespace |

---

### 3.4 Output Schema

```
{
  "type": "FeatureInfo",
  "parcel": {
    "id": "B609_000200.67",
    "label": "67",
    "namespace": "IT.AGE.PLA",
    "local_id": "IT.AGE.PLA.B609_000200.67"
  },
  "raw": {
    "...": "original fields"
  }
}
```

---

### 3.5 Error Handling

If parsing fails:

```
{
  "type": "FeatureInfo",
  "error": "parse_failed",
  "raw_html": "..."
}
```

---

## 4. Phase B – `/parcel-at-point` Endpoint

### 4.1 Purpose

Abstract WMS complexity from frontend.

Replace:
- manual GetFeatureInfo requests
- I/J pixel calculations

With:
- coordinate-based query

---

### 4.2 Endpoint Definition

```
POST /parcel-at-point
```

### 4.3 Input

```
{
  "lat": float,
  "lon": float,
  "buffer": optional float (meters or degrees)
}
```

---

### 4.4 Internal Workflow

1. Convert lat/lon → bounding box
2. Build WMS GetFeatureInfo request
3. Call upstream via existing proxy logic
4. Parse HTML → structured JSON
5. Return normalized response

---

### 4.5 Output

```
{
  "type": "ParcelLookup",
  "point": [lat, lon],
  "parcel": {
    "id": "...",
    "label": "...",
    "namespace": "...",
    "local_id": "..."
  },
  "source": "wms"
}
```

---

## 5. Backward Compatibility

### MUST preserve:

- `/wms-proxy` default behavior
- raw HTML responses
- existing frontend integration

### Migration path:

| Phase | Frontend Behavior |
|------|------------------|
| Now | raw HTML |
| Step 1 | optional JSON |
| Step 2 | switch to JSON |
| Step 3 | use `/parcel-at-point` |

---

## 6. Refactoring Constraints

- Do NOT modify existing request pipeline
- Add logic as **conditional branches only**
- Reuse existing parsing utilities
- Avoid duplication of WMS logic

---

## 7. Suggested Internal Structure

```
proxy/
 ├── wms_forward.py
 ├── featureinfo_parser.py
 ├── parcel_service.py
```

---

## 8. Performance Considerations

- FeatureInfo calls are lightweight
- Avoid repeated calls for same point

Future improvement:

```
parcel_cache[lat,lon] → result
```

---

## 9. Future Extensions (Do NOT implement yet)

- Parcel geometry retrieval
- Intersection engine
- Batch parcel queries
- Spatial indexing

---

## 10. Design Principle


Transport Layer → Proxy → Interpretation Layer → Application Logic


The proxy must evolve from:

"data forwarding"

to:

"data normalization and semantic extraction"


---

## Final Note

This change enables:

- cleaner frontend
- reusable backend API
- future spatial analysis capabilities

Without breaking current functionality.

