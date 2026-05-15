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
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva primo avvio.

### Futuro — Export AI-ready e scaling
- [ ] Aggiornare export AI-ready con schema esteso coerente tra feature, links catastali e metadata raster/vector.
- [ ] Garantire coerenza CRS/bbox tra snapshot raster e dataset vettoriale esportato.
- [ ] Valutare indexing spaziale, cache geometrica catastale e possibili ottimizzazioni server-side per dataset grandi.
