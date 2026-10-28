---
target: planimeter.html
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
target_identity: "file:D:\\Planimeter\\planimeter.html"
target_fingerprint: "sha256:9901835d16f77be830d9fc2959840d8d6c8d43e3714cedf6c110071b6c095caa"
target_path: "D:\\Planimeter\\planimeter.html"
timestamp: 2026-10-28T07-48-16Z
slug: planimeter-html
---
# Critique: Planimeter Dashboard & Core UX

Method: dual-agent (A: c835eb73-98ee-45b6-a77e-d851ef3422ac · B: 9033c279-77c0-48e1-800a-cc2f9f0de489)

#### Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:-----:|-----------|
| 1 | Visibility of System Status | 2 | Telemetria diagnostica da sviluppatore (Proxy health, Zoom 6.0, Viewport X/Y gauges) in primo piano; stato del salvataggio campagne e snapping in secondo piano |
| 2 | Match System / Real World | 2 | Contrasto terminologico: autentici concetti agronomici (rotazione PAC, BCAA 7, particelle) oscurati da gergo tecnico (M3 Refine, Trace tolerance, Magnete XOR) |
| 3 | User Control and Freedom | 3 | Ottimo motore di snapshot e cronologia con rollback, ma compromesso da 18+ alert e prompt bloccanti del browser (window.alert/confirm) |
| 4 | Consistency and Standards | 2 | Disallineamento nei pattern: dialog nativi, popover fluttuanti e confirm browser; checkbox usate per gruppi a selezione esclusiva |
| 5 | Error Prevention | 1 | Tasti di azione (Elimina selezione, Duplica, Esporta) apparentemente attivi anche senza alcuna particella selezionata, che scatenano alert di errore al click |
| 6 | Recognition Rather Than Recall | 3 | Legenda colture e catalogo SIAN/UE ben integrati; interrogazione catastale richiede però di ricordare una sequenza a più passaggi |
| 7 | Flexibility and Efficiency | 3 | Ottimi shortcut (Ctrl+K, ?) e tabella riepilogativa spostabile; mancano pillole contestuali di azione rapida direttamente sul canvas mappa |
| 8 | Aesthetic and Minimalist Design | 1 | Sovraccarico visivo: 9 sezioni impilate nella barra laterale, 8 slider WMS sottolayer, finestre flottanti che collidono e coprono il 70% della mappa |
| 9 | Error Recovery | 2 | Regole PAC con motivazioni chiare, ma errori tecnici (parsing GeoJSON, KML malformato, timeout WMS) liquidati con messaggi opachi |
| 10 | Help and Documentation | 2 | Guida relegata a un accordion in fondo alla 9ª sezione della sidebar; assenza di onboarding guidato per la rotazione PAC |
| **Total** | | **21/40** | **Marginal (Debito di usabilità / Intervento raccomandato)** |

#### Design Specificity Verdict

**Verdetto: Ibrido / Guscio Disallineato (Motore Agronomico d'Elite intrappolato in una Console Diagnostica GIS)**

- **Valutazione LLM (Design Director)**: L'architettura interna possiede una specificità agronomica straordinaria: comprende le regole PAC 2023–2027 (BCAA 7, Eco-schema 4, deroghe biologico/SQNPI, rinfittimento quinquennale), il catasto ufficiale dell'Agenzia delle Entrate e le campagne pluriennali. Tuttavia, l'involucro visivo esterno sembra una console per sviluppatori di motori cartografici: coordinate Viewport X/Y con barre di caricamento, metriche diagnostiche di proxy WMS e acronimi ingegneristici.
- **Scansione Deterministica**: La scansione statica su 31 file ha certificato la totale assenza di anti-pattern di colore o stile AI standard (0 errori, 0 warning). Il rendering live con Puppeteer ha tuttavia rilevato 4 warning di **`nested-cards`** (scatole annidate dentro altre scatole nella sidebar: sottogruppi azioni e barra confronto campagna) e 2 advisory di **`straggler`** (parole orfane a fine paragrafo per mancanza di `text-wrap: pretty`).

#### Overall Impression
Planimeter ha un "cuore" agronomico e cartografico di altissimo livello, ma si presenta con l'abito di uno strumento di debug per ingegneri GIS. La più grande opportunità di design consiste nel ripulire la console diagnostica per trasformarla in un raffinato cruscotto agronomico focalizzato sulle decisioni aziendali del conduttore agricolo.

#### What's Working
1. **Motore di Condizionalità PAC & Riconoscimento SIAN**: La verifica delle successioni colturali su base quinquennale con calcolo dell'intersezione geometrica tra appezzamenti di diverse annate è una soluzione solida, rara e di reale valore pratico.
2. **Architettura di Cronologia Non Distruttiva**: Il sistema di safety snapshots automatici pre-cancellazione e il ripristino ad albero garantiscono una protezione eccellente contro la perdita accidentale di dati.
3. **Integrazione del Mosaico Catastale Agenzia Entrate**: La sovrapposizione in tempo reale delle particelle catastali con il layer colturale proprietario risolve uno dei problemi più complessi del fascicolo aziendale.

#### Priority Issues

- **[P0] Sostituzione dei Dialog Bloccanti del Browser & Stato Disabilitato sui Pulsanti**
  - *Problema*: 18+ chiamate a `window.alert()`, `window.confirm()` e `window.prompt()`. Pulsanti come *Elimina selezione* e *Duplica area* appaiono cliccabili anche quando non c'è alcuna selezione attiva, generando alert punitivi.
  - *Perché è grave*: Blocca il thread UI del browser, danneggia l'esperienza su tablet touch e punisce l'esplorazione dell'utente.
  - *Soluzione*: Disabilitare reattivamente i pulsanti (`disabled` con opacità 0.45) quando la selezione è nulla; sostituire gli alert con toast/snackbar non bloccanti in basso al centro.
  - *Comando consigliato*: `/impeccable polish`

- **[P1] Decongestione della Sidebar Monolitica & Eliminazione delle Scatole Annidate (Nested Cards)**
  - *Problema*: La toolbar sinistra raggruppa 9 sezioni con decine di controlli e genera warning di `nested-cards`. La finestra di riepilogo da 520px collide con la sidebar e copre la mappa sui display portatili.
  - *Perché è grave*: Affaticamento cognitivo e perdita di contatto visivo con i campi agricoli.
  - *Soluzione*: Riorganizzare la barra in 3 macro-viste con tabs o rail; convertire i sottogruppi di azioni in gruppi tipografici con divisori sottili senza bordi e sfondi scatolari; unificare gli 8 slider WMS in un master slider con preset rapidi.
  - *Comando consigliato*: `/impeccable distill`

- **[P2] Tema ad Alto Contrasto per Uso in Pieno Sole ("Modalità Campo / Daylight")**
  - *Problema*: L'interfaccia è rigidamente confinata in dark mode con sfondo nero-smeraldo e testi minuti.
  - *Perché è grave*: Nelle aziende agricole, l'app viene utilizzata in campo, all'aperto o in cabina trattore, dove la luce solare diretta trasforma uno schermo scuro in uno specchio illeggibile.
  - *Soluzione*: Introdurre una modalità chiara ad alto contrasto con fondo carta/ardesia, testi scuri ad alta leggibilità e target di tocco minimi di 44x44px.
  - *Comando consigliato*: `/impeccable adapt`

- **[P3] Quadro di Conformità PAC Globale Aziendale (Executive Scorecard)**
  - *Problema*: L'esito della conformità PAC (BCAA 7 ed Eco-schema 4) viene mostrato unicamente nella sezione di modifica della singola particella selezionata.
  - *Perché è grave*: L'agricoltore e il tecnico devono sapere subito lo stato dell'intera azienda agricola ("Quanti ettari su 50 rispettano la rotazione? Ci sono anomalie pendenti?").
  - *Soluzione*: Inserire un badge riassuntivo in testata al riepilogo colture (es. *"PAC 2026: 14/15 Appezzamenti OK · 1 Monocultura BCAA 7 da sanare"*) con suggerimenti automatici sulle colture leguminose o miglioratrici ammissibili.
  - *Comando consigliato*: `/impeccable shape`

#### Persona Red Flags

- **Marco (Agricoltore / Utente Occasionale, 54 anni)**:
  - 🚩 *Riflesso del sole*: In cortile o in cabina sul tablet, il tema scuro riflette la luce e rende i micro-testi da 11px illeggibili.
  - 🚩 *Trappole da errore*: Tocca *Elimina selezione* prima di selezionare un poligono e si ritrova bloccato da un popup di errore del browser.
  - 🚩 *Allarmismo senza guida*: Vede il cartello rosso `⛔ Violazione BCAA 7` sul grano e teme il taglio dei contributi senza che il sistema suggerisca con cosa alternarlo.

- **Alex (Agronomo / Consulente Tecnico, 32 anni)**:
  - 🚩 *Guerra per i pixel*: Sul portatile da 14", aprendo la tabella di riepilogo da 520px e la toolbar da 380px, la mappa scompare. Passa il tempo a trascinare finestre.
  - 🚩 *Import silenzioso*: Un GeoJSON regionale con una coordinata imperfetta fallisce con un laconico `Errore durante l'importazione` senza indicare la riga o la particella incriminata.

- **Elena (Operatrice CAA / Istruttrice Pratiche PAC, 43 anni)**:
  - 🚩 *Audit particella per particella*: Per controllare 20 appezzamenti deve cliccarli uno ad uno; manca una vista tabellare a colpo d'occhio con semafori di conformità.
  - 🚩 *Configurazione WMS dispersiva*: Deve aprire 8 slider diversi solo per rendere leggibili i numeri di particella sopra l'ortofoto.

#### Minor Observations
1. **Indicatori Viewport superflui**: Le percentuali Viewport X/Y nella barra inferiore appartengono al debug di OpenLayers e andrebbero rimosse dall'ambiente utente.
2. **Checkbox per scelte mutualmente esclusive**: I layer di base (Gruppo A) e amministrativi (Gruppo B) si comportano come radio button ma usano icone/input di tipo checkbox.
3. **Parole orfane (`straggler`)**: Applicare `text-wrap: pretty;` sui testi descrittivi per evitare finali di riga isolati.

#### Questions to Consider
1. *Se il valore economico fondamentale dell'app è la garanzia dei contributi PAC e la regolarità catastale, perché non accogliere l'utente con un cruscotto di conformità aziendale anziché con una schermata cartografica vuota?*
2. *Quanto aumenterebbe l'operatività in campagna se la toolbar potesse ridursi a 4 grandi tasti di comando ad alto contrasto per l'uso con una sola mano?*
