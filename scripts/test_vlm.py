import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import vlm


class FakeProvider:
    name = "fake"
    model = "fake-vision-1"

    def analyze_frame(self, image: Path, timestamp_seconds: float) -> dict:
        return {
            "description": f"Scene at {timestamp_seconds:g}s",
            "labels": ["person", image.stem],
        }


class VlmContractTest(unittest.TestCase):
    def test_sample_timestamps_are_bounded_and_limited(self) -> None:
        self.assertEqual(vlm.sample_timestamps(130, interval_seconds=60, max_frames=3), [1.0, 61.0, 121.0])
        self.assertEqual(vlm.sample_timestamps(0, interval_seconds=60, max_frames=3), [0.0])
        self.assertEqual(vlm.sample_timestamps(2, interval_seconds=60, max_frames=3), [2 / 3])

    def test_parse_scene_response_normalizes_json(self) -> None:
        response = """```json
        {"description":" A child playing outside. ","labels":["child","outside","child",9]}
        ```"""
        self.assertEqual(
            vlm.parse_scene_response(response),
            {"description": "A child playing outside.", "labels": ["child", "outside"]},
        )

    def test_frame_prompt_includes_clip_offset(self) -> None:
        prompt = vlm.frame_prompt(12.5)

        self.assertIn("00:12.500", prompt)
        self.assertIn("clip start", prompt.lower())

    def test_analyze_video_uses_pluggable_provider(self) -> None:
        def fake_extract(_video: Path, destination: Path, timestamp: float) -> None:
            destination.write_bytes(f"frame:{timestamp}".encode())

        with tempfile.TemporaryDirectory() as temporary:
            result = vlm.analyze_video(
                Path("clip.mp4"),
                duration_seconds=130,
                workdir=Path(temporary),
                provider=FakeProvider(),
                interval_seconds=60,
                max_frames=3,
                frame_extractor=fake_extract,
            )

        self.assertEqual(result["version"], 1)
        self.assertEqual(result["provider"], "fake")
        self.assertEqual(result["model"], "fake-vision-1")
        self.assertEqual(len(result["scenes"]), 3)
        self.assertEqual(result["scenes"][0]["timestamp_seconds"], 1.0)
        self.assertEqual(result["scenes"][0]["labels"], ["person", "frame-000"])
        self.assertIn("Scene at 121s", result["summary"])
        json.dumps(result)

    def test_gemini_uses_header_auth_instead_of_query_string(self) -> None:
        test_credential = "not-a-real-credential"
        provider = vlm.GeminiProvider(model="gemini-test", api_key=test_credential)
        response = {
            "candidates": [{
                "content": {
                    "parts": [{"text": '{"description":"A test image.","labels":["test"]}'}]
                }
            }]
        }
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "frame.jpg"
            image.write_bytes(b"jpeg")
            with mock.patch.object(vlm, "_post_json", return_value=response) as post:
                result = provider.analyze_frame(image, 1)

        url = post.call_args.args[0]
        options = post.call_args.kwargs
        self.assertNotIn(test_credential, url)
        self.assertNotIn("?key=", url)
        self.assertEqual(options["headers"], {"x-goog-api-key": test_credential})
        self.assertEqual(result["description"], "A test image.")


if __name__ == "__main__":
    unittest.main()
