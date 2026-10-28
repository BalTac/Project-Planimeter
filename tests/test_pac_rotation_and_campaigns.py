import json
import unittest
from pathlib import Path

class TestPacRotationAndCampaigns(unittest.TestCase):
    def setUp(self):
        domain_path = Path(__file__).resolve().parent.parent / "domains" / "agriculture.json"
        with open(domain_path, "r", encoding="utf-8") as f:
            self.domain = json.load(f)

    def test_domain_metadata_pac_present(self):
        cat_map = {c["id"]: c for c in self.domain["categories"]}
        self.assertIn("grano_duro", cat_map)
        self.assertIn("grano_tenero", cat_map)
        self.assertIn("orzo", cat_map)
        self.assertIn("favino", cat_map)

        # Check botanical genus
        self.assertEqual(cat_map["grano_duro"]["botanicalGenus"], "Triticum")
        self.assertEqual(cat_map["grano_tenero"]["botanicalGenus"], "Triticum")
        self.assertEqual(cat_map["orzo"]["botanicalGenus"], "Hordeum")
        self.assertEqual(cat_map["favino"]["botanicalGenus"], "Vicia")

        # Check PAC roles
        self.assertEqual(cat_map["grano_duro"]["eco4Role"], "depauperating")
        self.assertEqual(cat_map["favino"]["eco4Role"], "improver")
        self.assertEqual(cat_map["prato"]["cycleType"], "multiannual")
        self.assertEqual(cat_map["vigna"]["cycleType"], "permanent")

    def test_pac_bcaa7_rules_python_simulation(self):
        cat_map = {c["id"]: c for c in self.domain["categories"]}

        # 1. Grano duro -> Grano duro: VIETATO (stesso genere Triticum)
        prev_crop = cat_map["grano_duro"]
        candidate_crop = cat_map["grano_duro"]
        self.assertEqual(prev_crop["botanicalGenus"], candidate_crop["botanicalGenus"])

        # 2. Grano duro -> Grano tenero: VIETATO (stesso genere Triticum)
        candidate_crop_soft = cat_map["grano_tenero"]
        self.assertEqual(prev_crop["botanicalGenus"], candidate_crop_soft["botanicalGenus"])

        # 3. Grano duro -> Orzo: AMMESSO BCAA 7 (Triticum != Hordeum), ma WARNING ECO-SCHEMA 4
        candidate_barley = cat_map["orzo"]
        self.assertNotEqual(prev_crop["botanicalGenus"], candidate_barley["botanicalGenus"])
        self.assertEqual(prev_crop["eco4Role"], "depauperating")
        self.assertEqual(candidate_barley["eco4Role"], "depauperating")

        # 4. Grano duro -> Favino (Leguminosa): AMMESSO sia BCAA 7 sia ECO-SCHEMA 4
        candidate_faba = cat_map["favino"]
        self.assertNotEqual(prev_crop["botanicalGenus"], candidate_faba["botanicalGenus"])
        self.assertEqual(candidate_faba["eco4Role"], "improver")

        # 5. Grano duro -> Girasole (Rinnovo): AMMESSO sia BCAA 7 sia ECO-SCHEMA 4
        candidate_sunflower = cat_map["girasole"]
        self.assertNotEqual(prev_crop["botanicalGenus"], candidate_sunflower["botanicalGenus"])
        self.assertEqual(candidate_sunflower["eco4Role"], "renewal")

if __name__ == "__main__":
    unittest.main()
