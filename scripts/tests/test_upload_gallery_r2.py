import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("upload", Path(__file__).parents[1] / "upload-gallery-r2.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.remote = {}
        self.writes = []
        for name in ["hypen-gallery.apk", "hypen-gallery-ios-simulator.zip"]:
            data = name.encode()
            (self.root / name).write_bytes(data)
            (self.root / (name + ".sha256")).write_text(hashlib.sha256(data).hexdigest() + "  " + name)

    def aws(self, endpoint, operation, *args):
        key = args[args.index("--key") + 1]
        if operation == "head-object":
            if key not in self.remote:
                raise RuntimeError("An error occurred (404) when calling the HeadObject operation: Not Found")
            return {"Metadata": {"sha256": self.remote[key]}}
        self.assertEqual(operation, "put-object")
        self.assertEqual(args[args.index("--if-none-match") + 1], "*")
        self.assertNotIn(key, self.remote)
        data = Path(args[args.index("--body") + 1]).read_bytes()
        self.remote[key] = hashlib.sha256(data).hexdigest()
        self.writes.append(key)
        return {}

    def upload(self):
        module.upload("0.6.8", self.root, "hypen", "https://example.r2.cloudflarestorage.com")

    def test_upload_and_identical_retry(self):
        with patch.object(module, "aws", self.aws):
            self.upload()
            self.assertEqual(len(self.writes), 4)
            self.upload()
            self.assertEqual(len(self.writes), 4)
        self.assertIn("android/hypen-gallery-0.6.8.apk", self.remote)
        self.assertIn("ios/hypen-gallery-0.6.8.zip", self.remote)

    def test_conflict_on_second_platform_prevents_all_writes(self):
        self.remote["ios/hypen-gallery-0.6.8.zip"] = "different"
        with patch.object(module, "aws", self.aws), self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
            self.upload()
        self.assertEqual(self.writes, [])

    def test_auth_error_is_not_treated_as_missing(self):
        with patch.object(module, "aws", side_effect=RuntimeError("(403) Forbidden")) as api:
            with self.assertRaisesRegex(RuntimeError, "Forbidden"):
                self.upload()
            self.assertEqual(api.call_count, 1)

    def test_corrupt_download_prevents_upload(self):
        (self.root / "hypen-gallery.apk").write_bytes(b"corrupt")
        with patch.object(module, "aws") as api, self.assertRaisesRegex(ValueError, "Checksum mismatch"):
            self.upload()
        api.assert_not_called()

    def test_legacy_object_without_metadata_is_compared_by_content(self):
        def legacy_api(endpoint, operation, *args):
            if operation == "head-object":
                return {}
            self.assertEqual(operation, "get-object")
            Path(args[-1]).write_bytes(b"legacy")
            return {}
        with patch.object(module, "aws", legacy_api):
            self.assertEqual(module.existing_hash("endpoint", "bucket", "key"), hashlib.sha256(b"legacy").hexdigest())


if __name__ == "__main__":
    unittest.main()
