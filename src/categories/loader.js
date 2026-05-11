/**
 * CategorySchemaLoader — gestisce caricamento, validazione e accesso a schemi DSL categorie.
 * Supporta multi-dominio (agronomico, edile, urbanistica) con override colori a livello progetto.
 */

export class CategorySchemaLoader {
  constructor() {
    this.schema = null;
    this.colorOverrides = new Map(); // { "dominio.categoria": "#hexColor" }
    this.activeDomain = null;
  }

  /**
   * Carica schema globale da file JSON (solitamente src/categories/schema.json)
   * @param {object} schemaData — dati JSON dello schema
   * @returns {boolean} true se caricamento e validazione successful
   */
  loadSchema(schemaData) {
    if (!this._validateSchemaStructure(schemaData)) {
      console.error('[CategorySchemaLoader] Schema structure validation failed');
      return false;
    }
    this.schema = schemaData;
    return true;
  }

  /**
   * Validazione minima dello schema
   * @private
   */
  _validateSchemaStructure(schemaData) {
    if (!schemaData || typeof schemaData !== 'object') return false;
    if (!schemaData.version) return false;
    if (!schemaData.schemas || typeof schemaData.schemas !== 'object') return false;

    for (const [domainName, domainDef] of Object.entries(schemaData.schemas)) {
      if (!domainDef.categories || !Array.isArray(domainDef.categories)) {
        console.error(`[CategorySchemaLoader] Domain "${domainName}" has no valid categories array`);
        return false;
      }
      for (const cat of domainDef.categories) {
        if (!cat.id || !cat.label || !cat.color) {
          console.error(`[CategorySchemaLoader] Category missing required fields: id, label, color`);
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Imposta il dominio attivo del progetto corrente
   * @param {string} domain — nome dominio (es. "agronomico", "edile", "urbanistica")
   * @returns {boolean} true se dominio esiste
   */
  setActiveDomain(domain) {
    if (!this.schema || !this.schema.schemas[domain]) {
      console.error(`[CategorySchemaLoader] Domain "${domain}" not found in schema`);
      return false;
    }
    this.activeDomain = domain;
    return true;
  }

  /**
   * Ritorna il dominio attivo
   */
  getActiveDomain() {
    return this.activeDomain;
  }

  /**
   * Ritorna tutte le categorie del dominio attivo
   * @returns {array} array di categorie, o [] se dominio non impostato
   */
  getCategoriesForDomain(domain = null) {
    const d = domain || this.activeDomain;
    if (!d || !this.schema || !this.schema.schemas[d]) {
      return [];
    }
    return this.schema.schemas[d].categories || [];
  }

  /**
   * Ritorna definizione di una categoria per ID
   * @param {string} categoryId
   * @returns {object|null} categoria o null se non trovata
   */
  getCategoryById(categoryId) {
    const categories = this.getCategoriesForDomain();
    return categories.find((c) => c.id === categoryId) || null;
  }

  /**
   * Ritorna il colore di una categoria, rispettando override
   * @param {string} categoryId
   * @returns {string} colore hex (es. "#ff0000"), o colore di default se non trovata categoria
   */
  getColorForCategory(categoryId) {
    const domain = this.activeDomain;
    if (!domain) {
      console.warn('[CategorySchemaLoader] No active domain set; cannot resolve category color');
      return '#cccccc'; // default gray
    }

    const overrideKey = `${domain}.${categoryId}`;
    if (this.colorOverrides.has(overrideKey)) {
      return this.colorOverrides.get(overrideKey);
    }

    const category = this.getCategoryById(categoryId);
    return category ? category.color : '#cccccc';
  }

  /**
   * Imposta override di colore per una categoria nel dominio attivo
   * @param {string} categoryId
   * @param {string} hexColor — colore hex (es. "#ff0000")
   */
  setColorOverride(categoryId, hexColor) {
    if (!this.activeDomain) {
      console.warn('[CategorySchemaLoader] No active domain set; cannot set color override');
      return;
    }
    const key = `${this.activeDomain}.${categoryId}`;
    if (!/^#[0-9a-f]{6}$/i.test(hexColor)) {
      console.error(`[CategorySchemaLoader] Invalid hex color: ${hexColor}`);
      return;
    }
    this.colorOverrides.set(key, hexColor);
  }

  /**
   * Ritorna tutti gli override di colore per il dominio attivo
   * @returns {object} { categoryId: "#hexColor", ... }
   */
  getColorOverridesForDomain() {
    const domain = this.activeDomain;
    if (!domain) return {};

    const result = {};
    for (const [key, value] of this.colorOverrides.entries()) {
      if (key.startsWith(`${domain}.`)) {
        const catId = key.substring(domain.length + 1);
        result[catId] = value;
      }
    }
    return result;
  }

  /**
   * Carica override di colori da oggetto (tipicamente da preferences/project storage)
   * @param {object} overridesData — { categoryId: "#hexColor", ... }
   */
  loadColorOverrides(overridesData) {
    if (!this.activeDomain || !overridesData || typeof overridesData !== 'object') {
      return;
    }
    for (const [catId, color] of Object.entries(overridesData)) {
      this.setColorOverride(catId, color);
    }
  }

  /**
   * Esporta schema del dominio attivo come JSON
   * @returns {object} schema serializzabile
   */
  exportDomainSchema() {
    const domain = this.activeDomain;
    if (!domain || !this.schema || !this.schema.schemas[domain]) {
      return null;
    }
    return JSON.parse(JSON.stringify(this.schema.schemas[domain]));
  }

  /**
   * Esporta colori override per il dominio attivo come JSON
   * @returns {object} { categoryId: "#hexColor", ... }
   */
  exportColorOverrides() {
    return this.getColorOverridesForDomain();
  }

  /**
   * Importa categorie da file JSON (aggiunge o sovrascrive nel dominio specificato)
   * @param {object} importedData — schema categoria importato
   * @param {string} targetDomain — dominio di destinazione (default: dominio attivo)
   * @returns {boolean} true se import successful
   */
  importCategoriesForDomain(importedData, targetDomain = null) {
    const domain = targetDomain || this.activeDomain;
    if (!domain) {
      console.error('[CategorySchemaLoader] No domain specified and no active domain set');
      return false;
    }

    if (!this.schema) {
      this.schema = { version: '1.0.0', schemas: {} };
    }

    if (!importedData || !importedData.categories || !Array.isArray(importedData.categories)) {
      console.error('[CategorySchemaLoader] Imported data has no valid categories array');
      return false;
    }

    // Valida ogni categoria nel file importato
    for (const cat of importedData.categories) {
      if (!cat.id || !cat.label || !cat.color) {
        console.error('[CategorySchemaLoader] Imported category missing required fields');
        return false;
      }
    }

    // Carica nel dominio
    if (!this.schema.schemas[domain]) {
      this.schema.schemas[domain] = {
        name: domain,
        label: importedData.label || domain,
        domain: domain,
        description: importedData.description || '',
        allowCustomColors: importedData.allowCustomColors !== false,
        categories: []
      };
    }

    // Merge o replace categories
    this.schema.schemas[domain].categories = importedData.categories;
    return true;
  }

  /**
   * Ritorna lista di domini disponibili nello schema
   * @returns {array} array di nomi dominio
   */
  getAvailableDomains() {
    if (!this.schema || !this.schema.schemas) {
      return [];
    }
    return Object.keys(this.schema.schemas);
  }

  /**
   * Ritorna metadati dominio (label, description)
   * @param {string} domain
   * @returns {object|null}
   */
  getDomainMetadata(domain) {
    if (!this.schema || !this.schema.schemas[domain]) {
      return null;
    }
    const def = this.schema.schemas[domain];
    return {
      name: def.name,
      label: def.label,
      description: def.description,
      allowCustomColors: def.allowCustomColors
    };
  }

  /**
   * Azzera tutti gli override di colore per il dominio attivo
   */
  clearColorOverridesForDomain() {
    if (!this.activeDomain) return;
    const domain = this.activeDomain;
    const keysToDelete = [];
    for (const key of this.colorOverrides.keys()) {
      if (key.startsWith(`${domain}.`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.colorOverrides.delete(key);
    }
  }
}

// Singleton di default
export const categorySchemaLoader = new CategorySchemaLoader();
