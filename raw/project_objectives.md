# Objective

Evolve the current geospatial web application into a **multi-domain spatial annotation platform** with support for:

* user-defined polygon features
* dynamic semantic categorization (DSL-based)
* integration with cadastral WMS data
* spatial relationships between user geometries and cadastral parcels

---

# Core Requirements

## 1. Feature Data Model (Refactor Required)

Implement a persistent feature model:

* unique stable ID (UUID)
* geometry (GeoJSON Polygon/MultiPolygon)
* bbox
* timestamps (created_at, updated_at)
* properties (dynamic, schema-driven)
* tags (free-form)
* versioning support

Add a new field:

* `links.cadastral`: array of linked parcels

Each link must support:

* parcel_id (string, from WMS GetFeatureInfo)
* intersection_area (float, in m²)
* coverage_ratio (0–1)

---

## 2. Spatial Intersection Engine (New Module)

Implement a module to compute geometric intersections between:

* user-drawn areas
* cadastral parcels (retrieved via WMS or preloaded GeoJSON)

Suggested approach:

* integrate a geometry library (e.g. turf.js)
* compute:

  * intersection polygon
  * area of intersection
  * ratio vs original area

This module must be:

* decoupled from UI
* reusable for export and analytics

---

## 3. Category DSL System (Extensible)

Implement a domain-agnostic category definition system:

* categories defined as JSON schemas
* each category defines:

  * name
  * label
  * fields (type, enum, validation rules)

Example categories:

* agriculture
* construction
* energy
* zoning

System must support:

* loading categories dynamically (from JSON files)
* user-defined categories
* optional validation (strict vs flexible mode)

---

## 4. Dynamic Form Engine

Based on selected category:

* generate UI form dynamically
* bind form fields to feature.properties
* enforce validation if schema is strict

---

## 5. Cadastral Integration Layer

Implement:

* GetFeatureInfo query on click
* extraction of:

  * parcel ID
  * attributes

Store parcel references in feature.links.cadastral

---

## 6. Dataset Export (AI-Ready)

Implement export pipeline producing:

* GeoJSON (features + properties + links)
* raster snapshot (WMS via proxy)
* metadata JSON

Ensure:

* consistent CRS (EPSG:4258)
* aligned bbox between raster and vector

---

## 7. Versioning System

Each feature must maintain history:

* geometry changes
* property changes

Store as append-only versions.

---

# Optional (Future Tasks)

* spatial indexing (R-tree)
* caching cadastral geometries
* server-side intersection (for large datasets)
* GeoTIFF export pipeline

---

# Design Principles

* Separate geometry from semantics
* Keep core model domain-agnostic
* Treat cadastral data as external reference, not ownership
* Ensure reproducibility of datasets

---

# Deliverables

1. Refactored data model
2. Intersection module
3. Category DSL loader
4. Dynamic form renderer
5. Updated export system
6. Updated TODO_LIST with granular tasks
