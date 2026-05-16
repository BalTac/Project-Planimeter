# TODO LIST

## Regole operative
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.
- [ ] Flaggare come completate solo le voci realmente testate/validate.
- [ ] Mantenere la wiki solo locale (cartelle [wiki/](wiki/) e [raw/](raw/)), finche il progetto non e piu maturo.
- [x] Ripulire e riallineare [README.md](README.md) al codice reale (struttura unica, senza duplicazioni).
- [x] Estendere [README.md](README.md) con template screenshot e matrice compatibilita browser; registrare modifica in [CHANGELOG.md](CHANGELOG.md).

## Priorita prossime task

### P0 — Stabilizzazione e validazione corrente
- [x] Verificare resa responsive desktop/mobile toolbar e tool icons senza overflow.
- [x] Verificare hint hover IT/EN e accessibilita keyboard/screen-reader dei pulsanti.
- [x] Verificare gruppi layer A/B: mutua esclusione nel gruppo e massimo 2 layer attivi totali.
- [x] Verificare ripristino preferenze layer corretto dopo refresh.
- [x] Verificare cache WMS: primo caricamento MISS, secondo HIT, anche su layer differenti.
- [x] Verificare clear cache da Settings (contenuto + metriche azzerate).
- [x] Verificare update runtime cache (TTL/MB) da UI e applicazione effettiva lato backend.
- [x] Rendere robusto il restore localStorage su payload legacy (FeatureCollection diretto / wrapper senza version) e fallback automatico alla campagna piu recente non vuota.
- [x] Verificare download reale GeoTIFF dalla toolbar Export.
- [x] Verificare ZIP PNG+PGW (coerenza file .png e .pgw).
- [x] Verificare ZIP Bundle (image.tif, areas.geojson, meta.json).
- [x] Validare input proxy WMS con allowlist parametri ammessi.
- [x] Introdurre rate limit semplice sugli endpoint proxy.
- [x] Rendere il rate limit dinamico in base alle richieste concorrenti in-flight, mantenendo thread safety.
- [x] Aggiungere bypass automatico rate-limit per connessioni da localhost.
- [x] Aggiungere test automatici minimi backend (smoke server, parsing GeoJSON, utility area/format).
- [x] Verificare compatibilita importmap cross-browser (Chrome/Firefox/Safari target).
- [x] Aggiungere smoke E2E Playwright: draw polygon, export GeoJSON, locale switch.
- [x] Evitare overwrite negli smoke test pertinenze: output PNG/JSON nominati per coordinate e modalita (full/m3).
- [x] Rendere configurabile il radius del metodo 3 nello smoke test di segmentazione raster.
- [x] Rendere dinamico il titolo del pannello smoke e preservare l'aspect ratio nella visualizzazione della particella.
- [x] Aggiungere reverse lookup locale da riferimento catastale per lo smoke test (fallback su report storici).
- [x] Rendere assoluto il percorso output dello smoke test per evitare directory duplicate in base al cwd.
- [x] Rendere il reverse lookup da riferimento catastale basato solo su riferimenti realmente osservati nel debug.
- [x] Supportare anche `inspireId.localId` completo (es. IT.AGE.PLA.B609_000100.333) nel reverse lookup smoke test.
- [x] Debuggare e ottimizzare metodo 3 (raster segmentation): fix da convex_hull → seed-based flood-fill (edge detection + flood-fill dal centro). Area accuracy migliorata 31x → 11x su particelle piccole, stabile su medie/grandi.

### P1 — Interpretation layer backend
- [x] Estendere [server.py](server.py) con `OUTPUT=json` per `GetFeatureInfo`, senza rompere il path raw HTML/XML corrente.
- [x] Normalizzare il parser server-side in payload canonico (`parcel.id`, `parcel.label`, `parcel.namespace`, `parcel.local_id`) con diagnostica `raw`.
- [x] Gestire contratto esplicito `parse_failed` quando l'HTML non produce campi affidabili.
- [x] Implementare endpoint semantico `POST /parcel-at-point` che nasconde i dettagli WMS al frontend.

### P2 — Migrazione frontend parcel workflow
- [x] Introdurre adapter/feature flag frontend per supportare sia risposta raw HTML sia risposta JSON normalizzata.
- [x] Migrare progressivamente la query particella dal path raw al path JSON/semantico senza regressioni UX.
- [x] Preparare integrazione di `parcel_id` nel workflow applicativo come riferimento stabile.

### P3 — Data model e versioning
- [x] Evolvere data model feature con UUID stabile, bbox, timestamp, properties dinamiche e tags.
- [x] Introdurre `links.cadastral[]` nel modello persistente con `parcel_id`, `intersection_area`, `coverage_ratio`.
- [x] Implementare versioning append-only per mutazioni di geometria e proprieta.

### P4 — Geometria e analytics
- [x] Introdurre engine intersection area/ratio riusabile e UI-agnostic.
- [x] Valutare caching geometrie catastali o strategia equivalente per workload ripetuti.

### P5 — DSL e form dinamiche
#### Decision matrix approvata — step progressivi
- [x] DM1 Snapshot annuali completi: archiviare per campagna/anno geometrie + assegnazioni semantiche; abilitare query storiche `history_at_point` e `history_at_parcel`.
- [x] DM2 DSL estensibile/editabile: schema base multi-dominio con categorie e sottocategorie modificabili da UX (ID stabili, label editabili).
- [x] DM3 Aggregazione semantica filtrabile: riepiloghi per categoria/anno/sottocategoria con filtri di visualizzazione configurabili.
- [ ] DM4 Geometria utente primaria + pertinenze dinamiche: set pertinenze selezionabile su reticolo WMS e modificabile nel tempo (aggiunta/rimozione anche dopo setup iniziale).
- [x] Separare il layer Pertinenze dal layer aree utente, con ordine di rendering dedicato tra WMS e layer utente, selector toolbar del target di editing e persistenza locale multi-layer.
- [x] Consentire deselezione completa dei layer base/amministrativi e toggle indipendente del gruppo C Pertinenze.
- [ ] DM5 Single-user locale: mantenere architettura locale con schema versionato e percorsi pronti a futura estensione.

- [x] Definire schema DSL v1 domain-agnostic (`domainId`, `version`, `categories[]`, `fields[]`, regole di validazione, palette colore).
- [x] Introdurre registry domini (`domains/default/*.json`) con dominio iniziale `agriculture` e categorie colture base.
- [x] Definire modalita validazione per dominio: `strict` (blocca salvataggio) e `flexible` (warning non bloccante).
- [x] Implementare loader DSL con merge stratificato: base di sistema + override utente (localStorage).
- [x] Estendere style engine: colore area/stroke derivato da categoria (fallback al tema attuale se categoria assente).
- [x] Aggiungere legenda live (colore -> categoria) filtrata sulle categorie effettivamente presenti nel progetto.
- [x] Aggiungere tabella riepilogo per categoria con somma superfici (m2/ha) e conteggio feature.
- [x] Estendere persistence con metadati DSL (`dslActiveDomainId` nel snapshot campagna, `dsl` nel history record).
- [ ] Aggiungere editor UX per dominio/categorie (crea, rinomina, elimina, aggiungi campi enum/number/text/color).
- [x] Aggiungere assegnazione categoria alla feature selezionata (context menu + pannello Operativo).
- [x] Generare form dinamica dalla categoria selezionata e bind su `feature.properties.dsl`.
- [x] Aggiornare bundle export con report semantico per categoria (totali, percentuali, anno/stagione).
- [x] Introdurre gestione dinamica pertinenze catastali sulla feature selezionata (lista link `links.cadastral` con rimozione puntuale post-setup).
- [x] Calcolare automaticamente `intersection_area` e `coverage_ratio` al collegamento della pertinenza catastale su area selezionata.
- [ ] Approfondire modello "pertinenze globali" non collegate a una specifica area (campagna-level).

#### UX wiring DSL (prossimi step)
- [x] Context menu: voce "Assegna categoria" su feature poligonale selezionata → apre pannello/modal di selezione categoria.
- [x] Pannello Operativo: sezione "Assegnazione categoria" con select dominio + dropdown categoria + campi fields dinamici per la feature selezionata.
- [x] Feedback visivo immediato: al cambio categoria la feature si ri-colora senza reload pagina.
- [x] Filtro visibilità categorie: toggle per nascondere/mostrare categorie specifiche nella mappa e nella tabella riepilogo.
- [ ] Export bundle: includere report semantico per categoria nel pacchetto TIFF+GeoJSON+metadata.

### P6 — UX e prodotto
- [x] Aggiungere refresh tile WMS singolo da menu contestuale (tasto destro, modalità Navigate).
- [x] Mostrare riferimento tile ricaricato (`layer:z/x/y`) nella toolbar dopo refresh WMS singolo.
- [x] Aggiungere attribution/licenze cartografiche persistenti in basso a destra, con scala metrica visibile.
- [x] Aggiungere widget coordinate live in modalità Navigate e voce menu contestuale per copia coordinate.
- [ ] Migliorare UX mobile: toggle snapping dedicato (senza Ctrl).
- [x] Migliorare UX edit vertici: marker su tutti i vertici (vuoto/non selezionato, pieno/selezionato), rimozione vertice opzionale via tasto destro o Canc con raddrizzamento automatico contorno.
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva primo avvio.

### DM4 Continuation — Gruppo C (Pertinenze Layer) M3 Integration
**Background**: Dual VectorSource architecture completed (2026-05-15). User-drawn areas + M3-detected cadastral boundaries now live in separate layers with independent persistence, interaction sets, and toolbar selector.

**Completed (2026-05-15):**
- [x] Created second VectorSource (`pertenenzaSource`) alongside user source
- [x] Created second VectorLayer (`layers.pertenenza`) with identical styling
- [x] Implemented dual interaction sets (Select/Modify/Draw/Snap for both user and pertinenze)
- [x] Feature tagging with `overlayLayer` property for provenance tracking
- [x] Implemented routing helpers (`getActiveInteractions()`, `getSourceForFeature()`, `getLayerForFeature()`)
- [x] Added layer selector UI in toolbar (`#editing-layer-select` dropdown)
- [x] Allow complete deselection of Groups A/B/C (independent checkboxes, optional all-off state)
- [x] Added Group C (Pertinenze) layer toggle to HTML
- [x] Added user areas visibility toggle to HTML/layer controls (independent on/off)
- [x] Extended state with `editingLayer` and `pertenenzaVisible`
- [x] Extended preferences with layer selection and visibility persistence
- [x] Extended persistence to handle both `vectorSource` and `pertenenzaSource` independently
- [x] Updated all delete/duplicate/edit/import operations to use correct source via feature tagging
- [x] Added i18n strings for Italian and English
- [x] Validated all changes with node --check (passed)

**Roadmap — 3 Integration Points (TODO):**

#### Phase 1: M3 Detection → Auto-Populate Pertinenze Layer
- [x] 1.1: Extend context menu in Navigate mode with "Rileva particella (M3)" action
- [x] 1.2: Call `method_3_raster_segmentation()` from backend API endpoint `/parcel-geometry-m3`
- [x] 1.3: Convert M3 result (lon/lat ring) to OL Polygon feature with `overlayLayer: 'pertenenze'` tag
- [x] 1.4: Auto-add feature to `pertenenzaSource`
- [x] 1.5: Switch layer selector to "Pertinenze" and make layer visible
- [x] 1.6: Show success toast with detected area/vertices count
- [x] **Implementation Complete** — All files modified: server.py (/parcel-geometry-m3 endpoint), context-menu.js, planimeter.js (detectParcelM3AtPixel), i18n (it.js, en.js)
- [x] 1.7: Fix runtime error in M3 toast (`calculateFeatureArea` → `calculateArea`) and align message interpolation/units
- [x] 1.8: Introduce dedicated pertinenze nomenclature (`Pertinenza N`, `pert-N`) with independent sequence counter
- [x] 1.9: Introduce dedicated neutral pertinenze style (distinct from user unassigned areas) with configurable color in Settings
- [x] 1.10: Expand M3 contour extraction to include outer black cadastral border (mask dilation before contour)
- [x] 1.11: Implement progressive radius expansion with user confirmation: if detection touches border, ask to retry with radius+1 (up to max 5)
- [x] 1.12: Show live on-map preview for each successful M3 auto-expand step before asking next confirmation
- [x] 1.13: Fix backend radius semantics: `/parcel-geometry-m3` now detects at exact requested radius (not first success in 0..radius)
- [x] 1.14: Set progressive M3 start radius to 1 and enrich expand confirmation copy with manual fine-editing hint on Cancel
- [x] 1.15: Show property scope labels as parcel numbers only on map; keep metrics persisted but move area/perimeter/localId details to selection toolbar and parcel info panel
- [x] 1.16: Fix parcel number derivation priority (prefer cadastral id/local_id over label) to avoid showing boundary counter-like labels
- [x] 1.17: Add context-menu action "Risincronizza metadati catastali" for pertinenze polygons (refresh parcel number/local id from cadastral endpoint)
- [x] 1.18: Fix `/parcel-at-point` and parcel geometry helper to reuse Agenzia CRS/BBOX normalization before upstream `GetFeatureInfo`
- [x] 1.19: Fix `Risincronizza metadati catastali` crash by importing and using shared `getFeatureLabelGeometry()` helper correctly
- [x] 1.20: Add WMS proxy JSON fallback for parcel summary lookup so resync/M3 metadata survive `/parcel-at-point` 502 responses
- [x] 1.21: Switch user-facing parcel metadata flows to proxy-first lookup to suppress recurring `/parcel-at-point` 502 console noise
- [x] 1.22: Add visible floating spinner/message during M3 detect so wait state stays visible even on slow requests
- [x] 1.23: Reuse same floating busy overlay for map tile loading and hide it when all tiles finish loading
- [ ] **Testing**: Right-click WMS parcel in Navigate mode → "Rileva particella (M3)" → spinner → "2,500 m², 12 vertici" → feature appears on map in pertinenze layer with distinctive color

#### Phase 2: "Promote Parcel" UI Workflow
- [ ] 2.1: Add "Promuovi a pertinenza" action in right-click menu (WMS parcel clicks)
- [ ] 2.2: Same as Phase 1, but user-triggered instead of auto-detection
- [ ] 2.3: Optional: Show confirmation dialog with detected area vs current user area comparison
- [ ] **Testing**: Right-click WMS parcel → "Promuovi a pertinenza" → Dialog shows "Rilevato: 2,500 m² | Tuo: 1,200 m²" → User confirms → Feature added to Pertinenze layer

#### Phase 3: Intersection Metrics & Summary Panel
- [ ] 3.1: Add "Intersezioni con pertinenze" section in riepilogo panel
- [ ] 3.2: For each user feature: list all overlapping pertinenze + intersection area + coverage percentage
- [ ] 3.3: Allow click-to-highlight pertinenza on map
- [ ] 3.4: Use existing `calculateIntersectionMetricsWithCache()` from geometry module
- [ ] **Testing**: Draw user polygon → Switch to Riepilogo → See "Intersezioni: 1,800 m² (72% copertura)" for each pertinenza → Click row → Pertinenza highlights on map

### Futuro — Export AI-ready e scaling
- [ ] Aggiornare export AI-ready con schema esteso coerente tra feature, links catastali e metadata raster/vector.
- [ ] Garantire coerenza CRS/bbox tra snapshot raster e dataset vettoriale esportato.
- [ ] Valutare indexing spaziale, cache geometrica catastale e possibili ottimizzazioni server-side per dataset grandi.
