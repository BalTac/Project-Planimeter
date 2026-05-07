import io
import json
import unittest
from email.message import Message
from http import HTTPStatus

from server import PlanimeterHandler


class ExportPayloadTests(unittest.TestCase):
    def make_handler(self, payload):
        handler = PlanimeterHandler.__new__(PlanimeterHandler)
        raw = json.dumps(payload).encode("utf-8")
        headers = Message()
        headers["Content-Length"] = str(len(raw))
        handler.headers = headers
        handler.rfile = io.BytesIO(raw)
        handler.sent_json = None

        def send_json(status, body):
            handler.sent_json = (status, body)

        handler.send_json = send_json
        return handler

    def test_world_file_uses_upper_left_pixel_center(self):
        world_file = PlanimeterHandler._build_world_file(
            None,
            [10, 20, 12, 24],
            4,
            2,
        ).splitlines()

        self.assertEqual(world_file[0], "1.000000000000")
        self.assertEqual(world_file[3], "-1.000000000000")
        self.assertEqual(world_file[4], "20.500000000000")
        self.assertEqual(world_file[5], "11.500000000000")

    def test_export_payload_rejects_non_finite_bbox(self):
        handler = self.make_handler({
            "bbox": [10, 20, "NaN", 24],
            "width": 512,
            "height": 512,
        })

        self.assertIsNone(handler._parse_export_payload())
        self.assertEqual(handler.sent_json[0], HTTPStatus.BAD_REQUEST)

    def test_export_payload_rejects_inverted_bbox(self):
        handler = self.make_handler({
            "bbox": [12, 20, 10, 24],
            "width": 512,
            "height": 512,
        })

        self.assertIsNone(handler._parse_export_payload())
        self.assertEqual(handler.sent_json[0], HTTPStatus.BAD_REQUEST)


if __name__ == "__main__":
    unittest.main()
