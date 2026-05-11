"""
Test per CategorySchemaLoader (src/categories/loader.js)

Nota: I test qui sono "logic tests" che validano il comportamento del loader
senza eseguire il codice JavaScript direttamente. Simuliamo il loader in Python
per validare la logica.
"""

import json
import pytest


class CategorySchemaLoaderMock:
    """Mock del CategorySchemaLoader per testare logica"""

    def __init__(self):
        self.schema = None
        self.color_overrides = {}
        self.active_domain = None

    def load_schema(self, schema_data):
        if not self._validate_schema_structure(schema_data):
            return False
        self.schema = schema_data
        return True

    def _validate_schema_structure(self, schema_data):
        if not schema_data or not isinstance(schema_data, dict):
            return False
        if 'version' not in schema_data:
            return False
        if 'schemas' not in schema_data or not isinstance(schema_data['schemas'], dict):
            return False

        for domain_name, domain_def in schema_data['schemas'].items():
            if 'categories' not in domain_def or not isinstance(domain_def['categories'], list):
                return False
            for cat in domain_def['categories']:
                if not all(k in cat for k in ['id', 'label', 'color']):
                    return False
        return True

    def set_active_domain(self, domain):
        if not self.schema or domain not in self.schema['schemas']:
            return False
        self.active_domain = domain
        return True

    def get_active_domain(self):
        return self.active_domain

    def get_categories_for_domain(self, domain=None):
        d = domain or self.active_domain
        if not d or not self.schema or d not in self.schema['schemas']:
            return []
        return self.schema['schemas'][d].get('categories', [])

    def get_category_by_id(self, category_id):
        categories = self.get_categories_for_domain()
        for c in categories:
            if c['id'] == category_id:
                return c
        return None

    def get_color_for_category(self, category_id):
        if not self.active_domain:
            return '#cccccc'

        override_key = f"{self.active_domain}.{category_id}"
        if override_key in self.color_overrides:
            return self.color_overrides[override_key]

        category = self.get_category_by_id(category_id)
        return category['color'] if category else '#cccccc'

    def set_color_override(self, category_id, hex_color):
        if not self.active_domain:
            return
        if not self._validate_hex_color(hex_color):
            return
        key = f"{self.active_domain}.{category_id}"
        self.color_overrides[key] = hex_color

    def _validate_hex_color(self, hex_color):
        import re
        return bool(re.match(r'^#[0-9a-fA-F]{6}$', hex_color))

    def get_color_overrides_for_domain(self):
        domain = self.active_domain
        if not domain:
            return {}

        result = {}
        prefix = f"{domain}."
        for key, value in self.color_overrides.items():
            if key.startswith(prefix):
                cat_id = key[len(prefix):]
                result[cat_id] = value
        return result

    def export_domain_schema(self):
        domain = self.active_domain
        if not domain or not self.schema or domain not in self.schema['schemas']:
            return None
        return json.loads(json.dumps(self.schema['schemas'][domain]))

    def export_color_overrides(self):
        return self.get_color_overrides_for_domain()

    def import_categories_for_domain(self, imported_data, target_domain=None):
        domain = target_domain or self.active_domain
        if not domain:
            return False

        if not self.schema:
            self.schema = {'version': '1.0.0', 'schemas': {}}

        if not imported_data or 'categories' not in imported_data or not isinstance(imported_data['categories'], list):
            return False

        for cat in imported_data['categories']:
            if not all(k in cat for k in ['id', 'label', 'color']):
                return False

        if domain not in self.schema['schemas']:
            self.schema['schemas'][domain] = {
                'name': domain,
                'label': imported_data.get('label', domain),
                'domain': domain,
                'description': imported_data.get('description', ''),
                'allowCustomColors': imported_data.get('allowCustomColors', True),
                'categories': []
            }

        self.schema['schemas'][domain]['categories'] = imported_data['categories']
        return True

    def get_available_domains(self):
        if not self.schema or 'schemas' not in self.schema:
            return []
        return list(self.schema['schemas'].keys())

    def get_domain_metadata(self, domain):
        if not self.schema or domain not in self.schema['schemas']:
            return None
        d = self.schema['schemas'][domain]
        return {
            'name': d['name'],
            'label': d['label'],
            'description': d['description'],
            'allowCustomColors': d['allowCustomColors']
        }

    def clear_color_overrides_for_domain(self):
        if not self.active_domain:
            return
        domain = self.active_domain
        keys_to_delete = [k for k in self.color_overrides.keys() if k.startswith(f"{domain}.")]
        for key in keys_to_delete:
            del self.color_overrides[key]


# ===== TESTS =====

@pytest.fixture
def schema_data():
    """Fixture con schema test minimalista"""
    return {
        "version": "1.0.0",
        "schemas": {
            "agronomico": {
                "name": "agronomico",
                "label": "Dominio Agronomico",
                "domain": "agronomico",
                "description": "Test agricolo",
                "allowCustomColors": True,
                "categories": [
                    {
                        "id": "prato",
                        "label": "Prato",
                        "color": "#00b050",
                        "description": "Prato stabile",
                        "fields": {}
                    },
                    {
                        "id": "grano_duro",
                        "label": "Grano Duro",
                        "color": "#ffd900",
                        "description": "Grano duro",
                        "fields": {}
                    }
                ]
            },
            "edile": {
                "name": "edile",
                "label": "Dominio Edile",
                "domain": "edile",
                "description": "Test edile",
                "allowCustomColors": True,
                "categories": [
                    {
                        "id": "edificio",
                        "label": "Edificio",
                        "color": "#ff7f50",
                        "description": "Edificio",
                        "fields": {}
                    }
                ]
            },
            "urbanistica": {
                "name": "urbanistica",
                "label": "Dominio Urbanistica",
                "domain": "urbanistica",
                "description": "Test urbanistica",
                "allowCustomColors": True,
                "categories": []
            }
        }
    }


def test_load_schema_valid(schema_data):
    """Test caricamento schema valido"""
    loader = CategorySchemaLoaderMock()
    assert loader.load_schema(schema_data) is True
    assert loader.schema == schema_data


def test_load_schema_invalid_missing_version():
    """Test validazione schema: assenza version"""
    loader = CategorySchemaLoaderMock()
    invalid = {"schemas": {}}
    assert loader.load_schema(invalid) is False


def test_load_schema_invalid_missing_categories(schema_data):
    """Test validazione schema: dominio senza categories"""
    loader = CategorySchemaLoaderMock()
    invalid = {
        "version": "1.0.0",
        "schemas": {
            "test": {
                "name": "test",
                # manca 'categories'
            }
        }
    }
    assert loader.load_schema(invalid) is False


def test_set_active_domain(schema_data):
    """Test impostazione dominio attivo"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    assert loader.set_active_domain("agronomico") is True
    assert loader.get_active_domain() == "agronomico"


def test_set_active_domain_invalid(schema_data):
    """Test impostazione dominio non esistente"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    assert loader.set_active_domain("non_esiste") is False


def test_get_categories_for_domain(schema_data):
    """Test lettura categorie per dominio"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    categories = loader.get_categories_for_domain()
    assert len(categories) == 2
    assert categories[0]['id'] == 'prato'
    assert categories[1]['id'] == 'grano_duro'


def test_get_category_by_id(schema_data):
    """Test lookup categoria per ID"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    cat = loader.get_category_by_id("prato")
    assert cat is not None
    assert cat['label'] == 'Prato'
    assert cat['color'] == '#00b050'


def test_get_category_by_id_not_found(schema_data):
    """Test lookup categoria non esistente"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    cat = loader.get_category_by_id("non_esiste")
    assert cat is None


def test_get_color_for_category_default(schema_data):
    """Test lettura colore categoria senza override"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    color = loader.get_color_for_category("prato")
    assert color == "#00b050"


def test_get_color_for_category_with_override(schema_data):
    """Test lettura colore categoria con override"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    loader.set_color_override("prato", "#ff0000")
    color = loader.get_color_for_category("prato")
    assert color == "#ff0000"


def test_set_color_override_invalid_hex(schema_data):
    """Test validazione colore hex"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    # Colore invalido
    loader.set_color_override("prato", "not_a_hex")
    color = loader.get_color_for_category("prato")
    assert color == "#00b050"  # rimane il colore originale


def test_export_domain_schema(schema_data):
    """Test export schema dominio attivo"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    exported = loader.export_domain_schema()
    assert exported is not None
    assert exported['name'] == 'agronomico'
    assert len(exported['categories']) == 2


def test_export_color_overrides(schema_data):
    """Test export override colori"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    loader.set_color_override("prato", "#ff0000")
    loader.set_color_override("grano_duro", "#00ff00")

    overrides = loader.export_color_overrides()
    assert overrides == {
        "prato": "#ff0000",
        "grano_duro": "#00ff00"
    }


def test_import_categories_for_domain(schema_data):
    """Test import categorie per dominio"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("urbanistica")

    imported = {
        "label": "Test Urban",
        "description": "Test import",
        "categories": [
            {
                "id": "zona_res",
                "label": "Zona Residenziale",
                "color": "#ff0000",
                "description": "Test"
            }
        ]
    }

    assert loader.import_categories_for_domain(imported) is True
    cats = loader.get_categories_for_domain("urbanistica")
    assert len(cats) == 1
    assert cats[0]['id'] == 'zona_res'


def test_import_categories_invalid(schema_data):
    """Test import con dati invalidi"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    invalid = {
        "categories": [
            {
                "id": "test",
                # manca 'label' e 'color'
            }
        ]
    }

    assert loader.import_categories_for_domain(invalid) is False


def test_get_available_domains(schema_data):
    """Test lettura domini disponibili"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)

    domains = loader.get_available_domains()
    assert set(domains) == {"agronomico", "edile", "urbanistica"}


def test_get_domain_metadata(schema_data):
    """Test lettura metadati dominio"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)

    metadata = loader.get_domain_metadata("agronomico")
    assert metadata is not None
    assert metadata['name'] == 'agronomico'
    assert metadata['label'] == 'Dominio Agronomico'
    assert metadata['allowCustomColors'] is True


def test_clear_color_overrides_for_domain(schema_data):
    """Test azzeramento override colori per dominio"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)
    loader.set_active_domain("agronomico")

    loader.set_color_override("prato", "#ff0000")
    loader.set_color_override("grano_duro", "#00ff00")

    loader.clear_color_overrides_for_domain()

    color1 = loader.get_color_for_category("prato")
    color2 = loader.get_color_for_category("grano_duro")

    assert color1 == "#00b050"  # colore originale
    assert color2 == "#ffd900"  # colore originale


def test_color_overrides_per_domain_isolation(schema_data):
    """Test isolamento override colori tra domini diversi"""
    loader = CategorySchemaLoaderMock()
    loader.load_schema(schema_data)

    loader.set_active_domain("agronomico")
    loader.set_color_override("prato", "#ff0000")

    loader.set_active_domain("edile")
    # edificio ha colore #ff7f50, non deve essere affetto da override agronomico
    color = loader.get_color_for_category("edificio")
    assert color == "#ff7f50"

    # Ritorna ad agronomico, override deve ancora esserci
    loader.set_active_domain("agronomico")
    color = loader.get_color_for_category("prato")
    assert color == "#ff0000"
