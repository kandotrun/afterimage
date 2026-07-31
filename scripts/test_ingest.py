import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import ingest, vlm


class StabilityFilterTest(unittest.TestCase):
    def test_zero_stability_processes_on_first_scan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            video = root / "clip.mp4"
            video.write_bytes(b"video")
            stable, state = ingest.select_stable_videos(
                root,
                [video],
                {},
                now=100,
                stable_seconds=0,
            )
        self.assertEqual(stable, [video])
        self.assertIn("clip.mp4", state)


class IngestWithoutSttTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name) / "data"
        self.cache = Path(self.tempdir.name) / "cache"
        (self.cache / "work").mkdir(parents=True)
        self.video = self.root / "daily" / "2026" / "0724" / "silent.mp4"
        self.video.parent.mkdir(parents=True)
        self.video.write_bytes(b"fake-video")
        self.probe = {
            "duration_seconds": 2.0,
            "creation_time": "2026-07-24T00:00:00+00:00",
            "width": 640,
            "height": 360,
            "video_codec": "h264",
            "audio_codec": "",
            "audio_sample_rate": 0,
            "audio_channels": 0,
        }

    def _write_thumbnail(self, _video: Path, destination: Path, _workdir: Path, _duration: float) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"jpeg")

    def test_stt_none_does_not_extract_audio(self) -> None:
        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
        ):
            result = ingest.process_video(
                self.root,
                self.video,
                self.cache,
                generate_web_preview=False,
            )

        self.assertEqual(result["status"], "completed")
        transcript = ingest.read_json(ingest.artifact_paths(self.root, self.video)["transcript_json"])
        self.assertEqual(transcript["provider"], "none")
        self.assertEqual(transcript["text"], "")

    def test_vlm_provider_writes_scene_artifact(self) -> None:
        scene_result = {
            "version": 1,
            "provider": "fake",
            "model": "fake-vision-1",
            "summary": "A person walks through a kitchen.",
            "scenes": [{
                "timestamp_seconds": 1.0,
                "description": "A person walks through a kitchen.",
                "labels": ["person", "kitchen"],
            }],
        }

        class FakeProvider:
            name = "fake"
            model = "fake-vision-1"

        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none", "VLM_PROVIDER": "fake"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
            mock.patch.object(vlm, "create_provider_from_env", return_value=FakeProvider()),
            mock.patch.object(vlm, "analyze_video", return_value=scene_result),
        ):
            result = ingest.process_video(
                self.root,
                self.video,
                self.cache,
                generate_web_preview=False,
            )

        scene_path = self.root / "scenes" / "2026" / "0724" / "silent.mp4.json"
        self.assertTrue(scene_path.is_file())
        self.assertEqual(ingest.read_json(scene_path)["summary"], scene_result["summary"])
        self.assertEqual(result["scene_count"], 1)
        scenes = json.loads(scene_path.read_text(encoding="utf-8"))
        self.assertEqual(scenes["provider"], "fake")

    def test_vlm_model_change_reanalyzes_existing_scene_artifact(self) -> None:
        class ProviderV1:
            name = "fake"
            model = "vision-v1"

        class ProviderV2:
            name = "fake"
            model = "vision-v2"

        first = {
            "version": 1,
            "provider": "fake",
            "model": "vision-v1",
            "summary": "First analysis.",
            "scenes": [{"timestamp_seconds": 1, "description": "First analysis.", "labels": []}],
        }
        second = {
            "version": 1,
            "provider": "fake",
            "model": "vision-v2",
            "summary": "Second analysis.",
            "scenes": [{"timestamp_seconds": 1, "description": "Second analysis.", "labels": []}],
        }

        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none", "VLM_PROVIDER": "fake"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
        ):
            with (
                mock.patch.object(vlm, "create_provider_from_env", return_value=ProviderV1()),
                mock.patch.object(vlm, "analyze_video", return_value=first),
            ):
                ingest.process_video(self.root, self.video, self.cache, generate_web_preview=False)

            with (
                mock.patch.object(vlm, "create_provider_from_env", return_value=ProviderV2()),
                mock.patch.object(vlm, "analyze_video", return_value=second) as analyze,
            ):
                ingest.process_video(self.root, self.video, self.cache, generate_web_preview=False)

        analyze.assert_called_once()
        scene_path = self.root / "scenes" / "2026" / "0724" / "silent.mp4.json"
        scenes = json.loads(scene_path.read_text(encoding="utf-8"))
        self.assertEqual(scenes["model"], "vision-v2")
        self.assertEqual(scenes["summary"], "Second analysis.")

    def test_sampling_config_change_invalidates_scene_artifact(self) -> None:
        class Provider:
            name = "fake"
            model = "vision-v1"

        result = {
            "version": 1,
            "provider": "fake",
            "model": "vision-v1",
            "summary": "Analysis.",
            "scenes": [{"timestamp_seconds": 1, "description": "Analysis.", "labels": []}],
        }

        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none", "VLM_PROVIDER": "fake", "VLM_FRAME_INTERVAL": "60"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
            mock.patch.object(vlm, "create_provider_from_env", return_value=Provider()),
            mock.patch.object(vlm, "analyze_video", return_value=result),
        ):
            ingest.process_video(self.root, self.video, self.cache, generate_web_preview=False)

        # Change only the sampling interval, keep same provider/model.
        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none", "VLM_PROVIDER": "fake", "VLM_FRAME_INTERVAL": "30"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
            mock.patch.object(vlm, "create_provider_from_env", return_value=Provider()),
            mock.patch.object(vlm, "analyze_video", return_value=result) as analyze,
        ):
            ingest.process_video(self.root, self.video, self.cache, generate_web_preview=False)

        analyze.assert_called_once()

    def test_failed_reanalysis_after_config_change_removes_stale_scenes(self) -> None:
        class ProviderV1:
            name = "fake"
            model = "vision-v1"

        class ProviderV2:
            name = "fake"
            model = "vision-v2"

        first = {
            "version": 1,
            "provider": "fake",
            "model": "vision-v1",
            "summary": "Old analysis.",
            "scenes": [{"timestamp_seconds": 1, "description": "Old analysis.", "labels": []}],
        }

        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none", "VLM_PROVIDER": "fake"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
            mock.patch.object(vlm, "create_provider_from_env", return_value=ProviderV1()),
            mock.patch.object(vlm, "analyze_video", return_value=first),
        ):
            ingest.process_video(self.root, self.video, self.cache, generate_web_preview=False)

        scene_path = self.root / "scenes" / "2026" / "0724" / "silent.mp4.json"
        self.assertTrue(scene_path.is_file())

        # Config change + analysis failure should remove stale scenes.
        with (
            mock.patch.dict(os.environ, {"STT_PROVIDER": "none", "VLM_PROVIDER": "fake"}, clear=False),
            mock.patch.object(ingest, "probe_video", return_value=self.probe),
            mock.patch.object(ingest, "extract_audio", side_effect=AssertionError("audio extraction must be skipped")),
            mock.patch.object(ingest, "extract_thumbnail", side_effect=self._write_thumbnail),
            mock.patch.object(vlm, "create_provider_from_env", return_value=ProviderV2()),
            mock.patch.object(vlm, "analyze_video", side_effect=RuntimeError("VLM down")),
        ):
            result = ingest.process_video(self.root, self.video, self.cache, generate_web_preview=False)

        self.assertFalse(scene_path.is_file())
        self.assertEqual(result["scene_count"], 0)
        self.assertIn("VLM down", result["scene_error"])

    def test_render_daily_memory_includes_chronology_and_scene_offsets(self) -> None:
        entries = [
            {
                "filename": "later-name.mp4",
                "captured_at": "2026-07-29T01:00:00+09:00",
                "capture_time_source": "filesystem_mtime_fallback",
                "duration_seconds": 30,
                "source_path": "daily/2026/0729/later-name.mp4",
                "status": "completed",
                "text": "Went to the pool.",
                "transcript_segments": [{"start_seconds": 1, "end_seconds": 2.5, "text": "Went to the pool."}],
                "scenes": [{"timestamp_seconds": 5, "description": "A pool is visible.", "labels": ["pool"]}],
            },
            {
                "filename": "earlier-name.mp4",
                "captured_at": "2026-07-29T00:30:00Z",
                "duration_seconds": 45,
                "source_path": "daily/2026/0729/earlier-name.mp4",
                "status": "completed",
                "text": "The dog is resting.",
                "scenes": [{"timestamp_seconds": 12, "description": "A dog is resting at home.", "labels": ["dog"]}],
            },
        ]

        markdown = ingest.render_daily_memory("2026-07-29", entries, "http://localhost:8901")

        self.assertLess(markdown.index("later-name.mp4"), markdown.index("earlier-name.mp4"))
        self.assertIn("Chronological timeline", markdown)
        self.assertIn("Capture end (estimated)", markdown)
        self.assertIn("Capture time source: filesystem mtime fallback (approximate)", markdown)
        self.assertIn("Gap after previous clip: 08:29:30", markdown)
        self.assertIn("+00:12", markdown)
        self.assertIn("A dog is resting at home.", markdown)
        self.assertIn("+00:01–+00:02.500", markdown)

    def test_transcript_record_preserves_timed_segments(self) -> None:
        record = ingest.transcript_record(
            self.root,
            self.video,
            "A dog is resting.",
            {
                "provider": "fake",
                "model": "fake-stt-1",
                "segments": [{"start": 1.25, "end": 3.5, "text": "A dog is resting."}],
            },
        )

        self.assertEqual(record["segments"], [{"start_seconds": 1.25, "end_seconds": 3.5, "text": "A dog is resting."}])


if __name__ == "__main__":
    unittest.main()
