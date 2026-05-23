# TODO LIST

## Regole operative
- [ ] Mantenere [CHANGELOG.md](CHANGELOG.md) aggiornato a ogni milestone.
- [ ] Flaggare come completate solo le voci realmente testate/validate.
- [ ] Mantenere la wiki solo locale (cartelle [wiki/](wiki/) e [raw/](raw/)), finche il progetto non e piu maturo.
- [x] Ripulire e riallineare [README.md](README.md) al codice reale (struttura unica, senza duplicazioni).
- [x] Estendere [README.md](README.md) con template screenshot e matrice compatibilita browser; registrare modifica in [CHANGELOG.md](CHANGELOG.md).

## Priorita prossime task

### UX — Toolbar redesign (mode | action | view)
- [x] Step A: audit information architecture della toolbar, classificazione `mode | action | view` (vedi [wiki/toolbar-redesign.md](wiki/toolbar-redesign.md)).
- [ ] Step B: cluster refactor — riorganizzare [planimeter.html](planimeter.html) + [styles.css](styles.css) in 3 zone (mode segmented top, action grid middle, view accordion bottom); ridurre `Strumenti` a 4 modi reali; promuovere snap a toggle esplicito; spostare matrice WMS sublayer da Settings a `view.catasto-wms` gated dal layer catasto attivo; spostare stats live in HUD bar separata; deduplicare lang switcher.
  - [x] B-1: matrice WMS sublayer spostata in `#section-catasto-wms` gated; lang switcher de-duplicato (rimosso `#settings-language`); azioni splittate in 3 sub-grid (Generale / Sulla selezione / Distruttive).
  - [x] B-2: modi `measure-straight` / `measure-polyline` spostati dal segmented-control nella sub-grid Generale (action-button + `data-mode` invariato).
  - [x] B-3: stats live (`Riepilogo`) spostate dalla toolbar a HUD bar `#stats-hud` overlay sulla mappa (top-right, pillole compatte); stessi ID, nessuna riconfigurazione JS.
  - [ ] B-3: spostare stats live (`Riepilogo`) in HUD bar fuori dalla toolbar.
  - [x] B-4: snap promosso a toggle esplicito (`#snap-toggle`) con preferenza persistita (`snapEnabled` in `DEFAULT_PREFERENCES`); Ctrl ora agisce come override temporaneo XOR rispetto allo stato persistente.
  - [x] B-5: azione `dsl.load-domain` esposta come bottone Generale (`#btn-load-domain` + input file nascosto) che chiama `registerDomain()` su JSON utente e rinfresca summary + DSL controls.
  - [x] B-6: Settings collassate in 3 audience (Display / Detection / Cache); rimossa la sezione `Overlay`, `parcel-info` checkbox migrata in `Detection`, color picker pertinenze migrato in `Display`.
  - [x] B-7: tutti i `<select>` della toolbar unificati sotto la classe canonica `.parameter-picker` (variante `.parameter-picker--compact` per il lang switcher); rimossi `.layer-source-select` e `.compact-select`.
- [x] Step C: QoL — command palette (`Ctrl+K`) sopra il registry `mode|action|view` (`src/ui/command-palette.js`); shortcuts overlay (`?`); entry point UI `dsl.load-domain` già coperto in B-5.
- [x] Step D: Mosaico catastale — slider "Trasparenza globale" sempre visibile in cima alla sezione WMS che fa da master sui per-sottolayer; controlli per sottolayer collassati in un `<details>` aperto on demand. Sync bidirezionale: muovere il globale propaga a tutti gli individuali; valori divergenti mostrano `misto/mixed`.

### Persistenza & History — roadmap (DOPO il refactor toolbar)

Origine: bug "hard refresh → aree perse + polygon enorme sopra il centro Italia". Diagnosi in
chat: race tra `restorePersistedFeatures` (sync, localStorage) e `syncPersistenceFromLocalMirror`
(async, backend mirror), `isIncomingStoreNewer` confronta solo `savedAt` e ignora il contenuto,
`schedulePersistenceSync` parte anche su `changefeature` durante drag di vertici, nessun safeguard
"non sovrascrivere localStorage non-vuoto con mirror vuoto", nessuna validazione geometrica al save.

Approccio: tre commit indipendenti, ciascuno verificabile e revertibile. **Commit only, niente push**
finché tutta la catena non e validata in produzione.

#### Commit P1 — Anti-wipe + race fix (no UI, fix invisibile)
- [x] Guard in `isIncomingStoreNewer` ([src/io/persistence.js](src/io/persistence.js)): se l'incoming
  store ha 0 feature totali mentre il local ne ha >0, ritorna `false`. Mai sovrascrivere dati
  esistenti con uno store vuoto, indipendentemente da `savedAt`.
- [x] Spostare `schedulePersistenceSync` ([src/planimeter.js](src/planimeter.js) ~L560-565) dai
  listener `changefeature` sui due `VectorSource` ai soli eventi `drawend` / `modifyend` /
  `translateend` / `addfeature` / `removefeature`. Niente piu salvataggi a meta drag di vertice
  (causa probabile del "polygon enorme" residuo nello store). `changefeature` ora aggiorna solo
  il summary; persist esplicito aggiunto in `modify.on('modifyend')`. Niente `Translate`
  interaction nel progetto.
- [x] Validazione geometrica al save in `persistFeatures` ([src/io/persistence.js](src/io/persistence.js)):
  scartare feature con extent > N km (es. > 100 km diagonale per poligoni user-drawn) o vertici
  fuori bounds 4326. `console.warn` + skip, niente eccezioni.
- [x] Snapshot last-known-good in `localStorage` chiave `planimeter.features.v1.prev` PRIMA di
  ogni `vectorSource.clear()` di restore. Recovery manuale possibile via console anche senza UI.
- [ ] Unificare il restore in una singola pipeline: rimuovere il doppio `clear()` (uno da
  `restorePersistedFeatures`, uno da `syncPersistenceFromLocalMirror` se l'incoming vince).
  `restorePersistedFeatures` legge localStorage senza montare; `syncPersistenceFromLocalMirror`
  decide vincitore con il guard del primo punto; un solo `restoreFromCampaignStore` finale.
  _(Rimandato: con anti-wipe + prev snapshot il bug e' chiuso; refactor cosmetico, da fare con calma.)_
- [ ] Test: smoke pytest + scenario manuale "draw 3 aree -> apri seconda tab che svuota ->
  refresh prima tab -> deve mostrare le 3 aree (non vuoto)".

#### Commit P2 — Smart prompt utente sul restore
- [x] Quando `localStorage` e vuoto/assente E il mirror backend ha N>0 feature, mostrare modale
  i18n: "Non trovo i dati nel browser. Carico il backup locale (N aree, salvato il `<savedAt>`)
  o creo nuovo?" → [Carica backup] / [Crea nuovo] / [Annulla].
- [x] Quando entrambi hanno feature ma differiscono E il mirror e piu recente, barra non
  intrusiva in alto: "Backup locale piu recente disponibile (N aree, `<savedAt>`). [Carica]
  [Ignora]". Default azione = Ignora (nessuna sovrascrittura silenziosa).
- [x] Chiavi i18n IT/EN: `restore.prompt.title`, `restore.prompt.body`, `restore.prompt.load`,
  `restore.prompt.new`, `restore.prompt.cancel`, `restore.banner.newer`, `restore.banner.load`,
  `restore.banner.ignore`.
- [x] Coerenza con il sync locale concettuale (cambio browser/profilo/macchina, clear
  accidentale o volontario dei dati persistenti del browser). `syncPersistenceFromLocalMirror`
  accetta ora `{ onPromptEmptyLocal, onBannerMirrorNewer }` come opzioni; in mancanza di
  handler resta backward-compatible (auto-apply legacy).

#### Commit P3 — History engine + pannello flottante "Cronologia"

Modello dati: `localStorage` chiave `planimeter.history.v1` + mirror backend companion
`.planimeter_history_store.json`. Una history **per campagna** (campaignId → entries[]).

```js
{
  version: 1,
  byCampaign: {
    "2026-annual": {
      cursor: 12,                    // indice voce corrente (undo/redo)
      entries: [
        {
          id: "h_01HXYZ...",
          ts: "2026-05-22T18:05:25Z",
          kind: "auto" | "manual",
          label: "Disegnata Area 3",
          tags: [],                  // free text per snapshot manuali
          summary: { features, areaSqm, addedIds, removedIds },
          features: { type:"FeatureCollection", features:[...] }
        }
      ]
    }
  }
}
```

- [x] Snapshot **completo** per voce (no delta) compresso con lz-string (~70-80% di riduzione). _(Slice B: `LZString.compressToUTF16` su feature collection; backward-compat read da legacy `entry.features`.)_
- [x] `cursor` per undo/redo deterministico (semantica Photoshop: modifica dopo undo tronca il
  futuro a `cursor+1`).
- [x] Coalescing: snapshot auto consecutivi dello stesso `kind` entro 2s vengono fusi.
- [x] Retention: auto **ultimi 50** (FIFO eviction sui piu vecchi auto), manuali **illimitati**
  (mai eviction, solo cancellazione esplicita), tetto 5 MB compressi in localStorage; oltre,
  manuali offloaded sul mirror backend. _(Slice A: cap 5 MB in chiaro; offload backend deferred a Slice B.)_
- [x] Trigger auto: `drawend` (parcella aggiunta a mano o via M3 trace), `removefeature`,
  `modifyend`, `translateend`, import bulk (1 voce per batch). **Forzato silenzioso** prima di
  "Svuota tutte le aree" + toast "Snapshot di sicurezza creato. Annulla con Ctrl+Z."
- [x] Trigger manuale: bottone `📸 Snapshot...` apre prompt con label + tag opzionali. _(Slice A: voce palette `action.history.snapshot`; bottone toolbar in Slice B.)_
- [x] UI: pannello flottante `#history-popover` (fratello di `#parcel-info-popover`, stesso glass
  theme), ancorato in alto-destra mappa, **draggable dall'header**, larghezza ~340px, altezza
  max ~60vh con scroll interno. Stato aperto/chiuso e posizione persistiti in preferenze.
- [x] Trigger toolbar: bottone 🕒 "Cronologia" (i18n `tool.history`) toggle on/off; non chiude
  su click fuori (palette style); badge contatore tramite `data-history-count` e tooltip
  aggiornato a ogni mutazione.
- [x] Mini-toolbar in header pannello: `⤆ Undo` `⤻ Redo` `📸 Snapshot...` `⋯ Gestisci`.
- [x] Lista entries: click su voce → dialog "Ripristinare? Verra creato uno snapshot dello stato
  attuale." Indicatori: ◉ corrente, ○ altre, 📸 per voci manuali.
- [x] Dialog "Gestisci...": elenco completo, rename, delete, export singolo snapshot come
  `.geojson` (baseline-protected su delete).
- [x] Shortcut: `Ctrl+Z` undo, `Ctrl+Y` / `Ctrl+Shift+Z` redo. Inseriti nel registry
  `mode|action|view` dello Step C toolbar (sinergia, zero conflitti).
- [x] i18n IT/EN per: `action.history.undo|redo|snapshot`, `history.entry.auto.*`, `history.entry.manual.*`,
  `history.toast.autoSafetySnapshot|undone|redone|nothingToUndo|nothingToRedo|snapshotTaken`,
  `history.snapshot.prompt.label`. _(`tool.history`, `history.title`, `history.confirm.restore`,
  `history.snapshot.prompt.tags`, `history.manage` deferred a Slice B.)_

**Slice A (engine + shortcut + palette) — commit `ee74fdc`.**
**Slice B (UI popover + manage dialog + backend mirror + lz-string) — commit corrente.**
Backend mirror live: endpoints `GET /local-history-load` + `POST /local-history-save` con file
`.planimeter_history_store.json` (cap 50 MB, atomic write), adozione automatica al boot solo se
locale è baseline-only.

### Parcel info — refactor popover (DONE)
- [x] Sostituire iframe con render DOM nativo (`renderParcelInfoBody`); state `parcelInfoHtml` → `parcelInfoData`; rimozione `wrapParcelInfoDocument`/`syncParcelInfoFrameSize`/`buildParcelSummaryHtml`/`_buildParcelHtmlFromJson`; fix contrasto/dimensione font colonna valori; rimozione Area/Perimetro dall'header (gia coperti dal summary panel).


### P0 — Stabilizzazione e validazione corrente
- [x] Verificare resa responsive desktop/mobile toolbar e tool icons senza overflow.
- [x] Verificare hint hover IT/EN e accessibilita keyboard/screen-reader dei pulsanti.
- [x] Correggere contrasto testo/sfondo delle combo box (`select/option`) per mantenere leggibilità coerente con il tema toolbar.
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
- [x] Aggiungere E2E Playwright su caso reale M3 (12.562959, 43.011822 / IT.AGE.PLA.B609_000200.35) con detect pertinenza, disegno quadrato intersecante e doppio summary (parcel + drawn area) con report diagnostico.
- [x] Evitare overwrite negli smoke test pertinenze: output PNG/JSON nominati per coordinate e modalita (full/m3).
- [x] Rendere configurabile il radius del metodo 3 nello smoke test di segmentazione raster.
- [x] Rendere dinamico il titolo del pannello smoke e preservare l'aspect ratio nella visualizzazione della particella.
- [x] Aggiungere reverse lookup locale da riferimento catastale per lo smoke test (fallback su report storici).
- [x] Rendere assoluto il percorso output dello smoke test per evitare directory duplicate in base al cwd.
- [x] Rendere il reverse lookup da riferimento catastale basato solo su riferimenti realmente osservati nel debug.
- [x] Supportare anche `inspireId.localId` completo (es. IT.AGE.PLA.B609_000100.333) nel reverse lookup smoke test.
- [x] Debuggare e ottimizzare metodo 3 (raster segmentation): fix da convex_hull → seed-based flood-fill (edge detection + flood-fill dal centro). Area accuracy migliorata 31x → 11x su particelle piccole, stabile su medie/grandi.
- [x] Sostituire antispike con edge-attraction snap sul refine M3, mantenendo confidence gate e senza pruning topologico aggressivo.
- [x] Aggiungere ownership continuity constraint nel refine M3 (inside/outside su ownership mask), con normal smoothing, relax tangenziale e micro-simplify anti-jitter.
- [x] Rifinire il tuning ownership continuity M3 con centroide reale per orientamento normali, probe piu profondo, continuity hysteresis e diagnostica avanzata inside/outside.
- [x] Tarare continuity hysteresis M3 per ridurre over-snap diagonale (peso 0.05 con decay distanza, clamp snap >0.45m e nuove metriche score-gain/reject reason).
- [x] Eseguire micro-step fine tuning: continuity base `balanced` a 0.035 e clamp distanza `balanced` a 0.40 m (senza toccare probeMeters).
- [x] Introdurre endpoint `/parcel-geometry-m3-trace` per ottenere il bordo catastale pixel-perfect via `findContours` sulla `ownership_mask` + RDP a tolleranza in metri (default 0.35 m). Validato su particelle 21 (+1.13 %) e 402 (-1.10 %).
- [x] Migrare il frontend (`refineParcelM3ForFeature` + tab Settings) da `/parcel-geometry-m3-refine` a `/parcel-geometry-m3-trace`. Rimossi controlli `m3RefineQuality` e `m3RefineMaxRequests`, esposto unico setting `m3TraceToleranceM` (default 0.35 m, range 0.05-2.5 m). Endpoint legacy resta lato server per compatibilita test/tooling.
- [x] Rendere opzionale il nuovo comportamento refine in tab Settings: toggle `m3RefineUseTrace` (default ON) per usare `/parcel-geometry-m3-trace`, con fallback manuale a refine classico `/parcel-geometry-m3-refine` e toggle `m3RefineCornerSnap` persistente per il path classico.
- [x] Migliorare UX edit: click su area mappa vuota (nessuna area utente/pertinenza sotto il puntatore) forza ritorno rapido a modalità `navigate`; estesa anche la visualizzazione ghost vertices in `draw`.

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
- [ ] Introdurre versioning locale delle modifiche utente con snapshot incrementali e undo/redo delle ultime operazioni anche senza salvataggio manuale esplicito (standard editor), includendo rollback sicuro dopo test E2E/automazioni.

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
- [x] DM5 Single-user locale: mantenere architettura locale con schema versionato e percorsi pronti a futura estensione.
- [x] Aggiungere indicatore UI stato sync mirror locale (ok/degraded/offline) per diagnosi immediata tra browser.
- [x] Estendere tooltip indicatore sync locale con timestamp ultimo sync riuscito (formattazione per locale IT/EN).

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
- [x] Supportare selezione multipla lato aree utente (Ctrl/Cmd+click in Navigate) e assegnazione categoria unica a più aree in un'unica azione.
- [x] Correggere regressione runtime multi-selezione (`Map` OpenLayers vs `Map` nativa) e aggiungere test E2E di regressione sul bulk assign categoria.
- [x] Drawn Areas: rimuovere il perimetro dalla label area; mantenere nome canonico area (`Area XX`) e mostrare crop assegnata solo nella label mappa.
- [x] Distinguere naming area vs assegnazione crop: in toolbar mantenere nome area canonico (`Area XX`), in label mappa mostrare la crop assegnata (senza parentesi quadre).
- [x] Aggiungere azione `Unassign` in pannello assegnazione DSL per rimuovere l'assegnazione della campagna/anno corrente sulla feature selezionata.
- [x] Feedback visivo immediato: al cambio categoria la feature si ri-colora senza reload pagina.
- [x] Filtro visibilità categorie: toggle per nascondere/mostrare categorie specifiche nella mappa e nella tabella riepilogo.
- [x] Export bundle: includere report semantico per categoria nel pacchetto TIFF+GeoJSON+metadata.

### P6 — UX e prodotto
- [x] Aggiungere refresh tile WMS singolo da menu contestuale (tasto destro, modalità Navigate).
- [x] Mostrare riferimento tile ricaricato (`layer:z/x/y`) nella toolbar dopo refresh WMS singolo.
- [x] Aggiungere attribution/licenze cartografiche persistenti in basso a destra, con scala metrica visibile.
- [x] Aggiungere widget coordinate live in modalità Navigate e voce menu contestuale per copia coordinate.
- [x] Ripristinare live view coordinate in modalità non conflittuali con gauge Viewport X/Y e Zoom, più cursori mappa coerenti con la modalità operativa corrente.
- [x] Summary intersections: mantenere overlay numero parcella su selezione e mostrare layer + dettaglio particella nel pannello.
- [x] Integrare Area/Parcel summary nel menu contestuale principale (solo su feature sotto mouse) e correggere selezione Drawn Areas + header con coltura.
- [ ] Migliorare UX mobile: toggle snapping dedicato (senza Ctrl).
- [x] Migliorare UX edit vertici: marker su tutti i vertici (vuoto/non selezionato, pieno/selezionato), rimozione vertice opzionale via tasto destro o Canc con raddrizzamento automatico contorno.
- [x] Evolvere UX cancellazione vertici: multi-selezione Ctrl+click, menu contestuale vertice con `Delete selected` senza confirm e `Delete all` con warning flottante Accept/Reject; regole topologiche inner ring (riempimento) / outer ring (eliminazione feature).
- [x] Fix overlap edit-click: con feature selezionata, click su vertice in hover priorita alla selezione vertice (anche Ctrl multi-select) senza switch automatico alla feature sottostante.
- [ ] Aggiungere tema chiaro opzionale.
- [ ] Aggiungere mini guida interattiva primo avvio.
- [ ] **Bug**: timeout intermittente su `POST /export-bundle` (≥30s, isolato in `tests/test_e2e_p0_extended.py::TestExportFormats::test_export_bundle_endpoint_responds`). Indagare profilatura backend (riproiezione raster + zip), aggiungere cap memoria/tempo, restituire 503/progress se la generazione supera soglia. Non blocca le altre flow di export.
- [ ] **Bug visuale**: feature gigante (~3.3 milioni ha) emersa al restore di `.planimeter_state_store.json` (vedi screenshot 2026-05-22). Probabile vertice corrotto in localStorage/persistenza. Aggiungere sanity-check su `bbox`/area al restore (warning + opt-out skip) e diagnostica per identificare origine (import legacy / errore disegno).
- [ ] **Roadmap futura — PAC tariffe per anno campagna** (`domains/pac-tariffe-<anno>.json`):
  introdurre file di dominio user-editable con importi unitari (€/ha) per intervento, regione e
  coltura, aggiornati manualmente dalle pubblicazioni AGEA/CREA (PDF/Excel annuali — non esistono
  API REST pubbliche stabili al momento dell'analisi). Schema indicativo:
  `{ year, region, interventions: [{ code, label, crops: [{ id, unit_amount_eur_ha, notes }] }] }`.
  Caricamento via `src/dsl/loader.js` come dominio aggiuntivo selezionabile per anno; le colonne
  summary "Importo stimato (€)" restano OFF di default e si attivano solo se il file dell'anno
  corrente è presente. Da pianificare dopo Step 5 (colonne PAC eligibili + multi-anno).
  Eventuale futura automazione: scraper opzionale lato `server.py` con cache e validazione
  manuale obbligatoria prima di esporre i valori al frontend.

### P7 — PAC / SISTER roadmap (cadastral + possession + interventions)

> All new entries in this section follow the english-only internal-code convention
> (see `.github/copilot-instructions.md` → Language conventions).
> User-visible labels remain localized via `src/i18n/`.

- [x] **Step 1 — Pluggable summary columns**: column registry in `src/ui/summary-panel.js`
  (groups: base, cadastral, geometry), header popover with grouped checkboxes + reset,
  persistence via `preferences.summaryColumns`. Minimal default set (`feature`, `area`,
  `percentSubject`, `crop`). Commit `f8d46c5`.
- [x] **Step 2 — Cadastral identity columns**: INSPIRE `local_id` parser
  (`IT.AGE.PLA.<comune[_sez]>.<foglio>.<particella>[.<sub>]`), new columns
  `comune`, `foglio`, `particella`, `subalterno`, `inspireId`, `officialArea`,
  `perimeter`, `vertices` (all OFF by default). Shared-pertinenza badge `↔N` on rows
  whose pertinenza intersects more than one drawn area. Commit `f8d46c5`.
- [x] **Step 3 — DSL `possession` domain**: new builtin domain `domains/possession.json`
  with 8 tenure categories (`ownership`, `bare_ownership`, `usufruct`, `lease`,
  `loan_for_use`, `emphyteusis`, `concession`, `other`) and per-feature fields
  (`quota_percent`, `holder_name`, `holder_cuaa`, `document_ref`, `document_date`,
  `expiry_date`, `notes`). Schema extended with `date` field type and optional
  `applicableLayers` whitelist (here `["pertenenze"]`). New loader helper
  `getDomainsForLayer(layerKey)`. No UI wiring yet — that lands in Step 4.
- [x] **Step 4 — Possession columns in summary**: added `possession` column group to
  the summary registry (`possessionTitle`, `possessionHolder`, `possessionQuota`,
  `possessionExpiry`) with IT/EN i18n; columns OFF by default (parti stretto).
  DSL panel now resolves the active domain per-selection via
  `resolveDomainForSelection` (new helper) + `getSelectedAssignablePolygonFeatures`,
  so `pertenenze` features can be tagged with the `possession` domain while keeping
  the agriculture flow for `user`-layer polygons untouched. Mixed-layer selection
  is blocked with hint `dsl.assign.hintMixedLayers`. Category/field labels honour
  the optional `labelKey` (i18n). `openIntersectionSummary` now resolves category
  labels per-feature via `feature.dsl.domainId`. `date` field type rendered as
  HTML `<input type="date">` in `buildFieldControl`. Canary `TestDslBulkAssign`
  remains green.
- [ ] **Step 5 — PAC columns + multi-year filter**: add PAC group (`eligible_area`,
  `tare_percent`, `intervention_code`, `campaign_year`). Add header dropdown with
  3y/5y/all filter (default 3y) to scope the summary to recent campaigns.
- [ ] **Step 6 — CSV / XLSX export**: export the currently visible summary columns
  to CSV and XLSX from the panel header.
- [ ] **Step 7 — Map badges for expiry status**: render colored badges on `pertenenze`
  features (green ownership / yellow lease expiring <6 months / red expired) when zoom
  > 17 or pertenenze is the active editing layer.

### P0.5 — Smart Hole Tool (inner ring persistente)
- [x] Definire policy unica overlap per target feature: considerare solo layer visibili; layer non visibili trattati come inesistenti.
- [x] Applicare la policy overlap a menu contestuale "Modifica feature" e a cambio poligono durante edit.
- [x] In caso overlap cross-layer visibile, chiedere esplicitamente su quale layer/feature operare.
- [x] Aggiungere voce contestuale "Draw hole" disponibile solo in Edit mode con feature poligonale selezionata.
- [x] Implementare draw del hole con chiusura via doppio click o Enter (nessun commit immediato).
- [x] Esporre `Draw hole` anche in Navigate su feature poligonali: click destro -> `Draw hole` -> switch automatico a Edit + attivazione hole tool.
- [x] Aggiungere preview stile refine con diff grafica + metriche (area prima, area hole, area dopo, delta) e azioni Accetta/Rifiuta.
- [x] Su Accetta: convertire il draft in inner ring persistente nel GeoJSON; su Rifiuta: rollback completo.
- [ ] Supportare edit manuale successivo dei vertici del ring interno come per l'outer ring.
- [x] Rimosso vincolo v1 no-multi-hole: Draw Hole ora supporta piu inner ring sulla stessa feature (append dei ring esistenti).
- [x] Aggiungere regressione E2E Playwright su caso reale parcel 333/117: accetta hole e verifica pulizia overlay draft + persistenza inner ring.
- [x] Aggiungere test E2E Playwright negativo: hole fuori perimetro -> reject, nessun preview pending, nessun inner ring persistito.
- [ ] Validare manualmente i casi: overlap due layer visibili, overlap con layer nascosto, cambio target in edit, export/import GeoJSON con inner ring.

### P0.6 — Interaction consistency + overlap boolean workflow
- [ ] Draw Hole sticky target: in Edit/Navigate mostrare `Draw hole` anche fuori pixel feature quando esiste una feature poligonale selezionata; target resta sempre la feature selezionata.
- [ ] Draw Hole warning flottante contestuale: se click destro fuori target o se draft esce dal perimetro target, spiegare regola operativa (selezionare prima area target; non si puo disegnare fuori target).
- [ ] Edit mode UX: click sinistro su area non disegnata -> switch automatico a Navigate mode.
- [ ] Draw overlap guard (stesso layer): senza CTRL su finalize emit warning Accept/Reject; Reject annulla draft.
- [ ] Draw overlap override con CTRL: se CTRL premuto durante draw/finalize, aprire preview+diff con azioni `Accept` / `Merge` / `Subtract` / `Reject`.
- [ ] Boolean ops semantica v1 (solo stesso layer): `Merge` = union espansiva, `Subtract` = contrazione area target in overlap, `Accept` = keep-as-drawn.
- [ ] Riuso pannello preview tipo Draw Hole/M3 per operazioni overlap (metriche prima/dopo/diff + rollback completo su Reject).
- [x] ESC global policy: ESC cancella tool attivo con rollback; ESC senza tool attivi forza Navigate; ESC ripetuto in Navigate resta no-op.
- [ ] Tool Selection esplicito (fase successiva): selezione target+operanda in Edit per lanciare Merge/Subtract con stessa preview diff.

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
- [x] 1.24: Allineare README.md alle feature M3/Pertinenze/Resync, endpoint aggiornati e dipendenze Python correnti
- [x] 1.25: Creare documento tecnico esaustivo in `raw/` sulla procedura autodetect M3 (pipeline, fallback, UX, troubleshooting)
- [x] 1.26: Allineare smoke test M3 al flusso corrente app/backend (`/parcel-geometry-m3` progressivo + metadata proxy-first)
- [x] 1.27: Ingest documento M3 da `raw/` a `wiki/` con aggiornamento indice e knowledge synthesis log
- [x] 1.28: Definire e approvare design Fine Align M3 su tile solo lungo bordo (nessuna implementazione `server.py` prima di approvazione)
- [x] 1.29: Definire metrica qualità refine (mean/p95 offset, Hausdorff, delta area, runtime, request usage) con soglie iniziali
- [x] 1.30: Definire indicatore quota richieste giornaliere con contatore locale stimato (target 3000/day) e stato UI (green/amber/red)
- [x] 1.31: Estendere smoke test particella 402 con confronto coarse vs refined e metriche consumo richieste (dopo approvazione)
- [x] 1.32: Ripristinare refine v1 senza antispike, mantenendo il comportamento baseline piu attendibile
- [x] 1.33: Sostituire nel context menu l'azione Detect parcel (M3) con Refine parcel (M3) disponibile solo su particella gia disegnata, aggiungendo in Settings i parametri configurabili Detect/Refine.
- [x] 1.34: Ripristinare Detect parcel (M3) nel context menu solo quando il click non intercetta una feature disegnata (query su parcella non disegnata).
- [x] 1.35: Aggiungere report flottante post-refine con confronto Prima/Dopo/Diff, summary snapped/rejected e decisione esplicita Accetta/Rifiuta con rollback geometria su rifiuto.
- [x] 1.36: Aggiungere anteprima visuale diff geometrico before/after (overlay) nel report refine flottante.
- [x] 1.37: Chiarire nel report refine i casi senza movimento visibile (snap accettati=0) e forzare renderSync mappa su preview/accept/reject per escludere dubbi di mancato redraw.
- [x] 1.38: Introdurre profilo refine `aggressive` (backend+UI) e validarlo con smoke comparativo sulla particella 63.
- [x] 1.39: Refine corner-aware — `_consolidate_corners` (line-fit PCA + corner intersection) come post-processing opt-in (`cornerSnap=true`) in `/parcel-geometry-m3-refine`, con flag CLI `--corner-snap` nel smoke test. Validato su particella 21 (10 vertici coarse → 8 corner snappati ai bordi catastali, delta 0.02%, 0 fallback intersezione).
- [ ] 1.40: Esporre `cornerSnap` in UI Settings (toggle + parametri `angleThresholdDeg`, `minRunLength`, `maxCornerJumpM`) e/o abilitarlo by default nei profili `precise`/`aggressive` dopo validazione cross-parcella.
- [x] 1.41: Aggiungere diagnostica RAW corner-alignment con script dedicato ([tests/preview_corner_alignment_raw.py](tests/preview_corner_alignment_raw.py)) e output 1:1 non compressi per confrontare refine corrente (blu) vs preview riallineata a bordo nero (verde) su particella 21.
- [ ] **Testing**: Right-click WMS parcel in Navigate mode → "Rileva particella (M3)" → spinner → "2,500 m², 12 vertici" → feature appears on map in pertinenze layer with distinctive color
- [ ] **Testing**: In Navigate, click destro su feature poligonale gia disegnata → appare solo "Refine parcel (M3)" (nessun detect) → refine in-place aggiorna geometria, area e version/modifiedAt.
- [ ] **P4 Audit**: Code review `tests/test_smoke_parcel_402_methods.py` — area detection + refinement validation (2026-05-17)
  - [x] Identified 6 bugs: ring_area() meaningless units, ownership_mask JSON crash, field name mismatch (camelCase/snake_case), no geometry validity, delta_ratio unbounded, ring closure redundancy
  - [x] Created helpers: `_is_valid_polygon_ring()`, `_safe_serialize_ownership_mask()`, `_normalize_debug_response()`
  - [x] Fixed CRITICAL issue: ownership_mask numpy array → JSON serialization crash with safe conversion + fallback
  - [x] Fixed HIGH issue: added geometry validity checks (closure, duplicates) + bounds sanity (delta_ratio ±50% threshold with warning)
  - [x] Fixed MEDIUM issue: probe camelCase/snake_case debug field names, consolidate to snake_case output
  - [x] Validated all fixes with unit tests (pass 100%)
  - [ ] Run smoke test with server online: baseline parcel 402 + compare coarse vs refined, area delta, snap metrics
  - [ ] If results still unsatisfactory: consider simpler alternative algorithm (grid-based probing + convex hull fallback)
  - [ ] Document findings in `raw/` and ingest to wiki/

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
