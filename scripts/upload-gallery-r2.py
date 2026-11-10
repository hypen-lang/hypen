#!/usr/bin/env python3
"""Upload built gallery runners to R2 using bucket-scoped S3 credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def aws(endpoint, *args):
    result = subprocess.run(
        ["aws", "--endpoint-url", endpoint, "--region", "auto", "s3api", *args],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout or "{}")


def existing_hash(endpoint, bucket, key):
    try:
        head = aws(endpoint, "head-object", "--bucket", bucket, "--key", key)
    except RuntimeError as error:
        if "(404)" in str(error) or "(NoSuchKey)" in str(error):
            return None
        raise  # Authentication/network failures are not missing objects.
    digest = head.get("Metadata", {}).get("sha256")
    if digest:
        return digest
    # Older manual uploads have no hash metadata. Compare their actual bytes.
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / "existing"
        aws(endpoint, "get-object", "--bucket", bucket, "--key", key, str(target))
        return hashlib.sha256(target.read_bytes()).hexdigest()


def upload(version, directory, bucket, endpoint):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected version X.Y.Z")
    files = [
        ("android", "hypen-gallery.apk", "apk", "application/vnd.android.package-archive"),
        ("ios", "hypen-gallery-ios-simulator.zip", "zip", "application/zip"),
    ]
    pending = []
    # Check both binaries and their checksums before making any writes.
    for platform, filename, extension, content_type in files:
        path = directory / filename
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        checksum = directory / (filename + ".sha256")
        if checksum.read_text().split()[0] != digest:
            raise ValueError(f"Checksum mismatch: {filename}")
        key = f"{platform}/hypen-gallery-{version}.{extension}"
        # Match the existing manual script's sidecar format (hash only).
        sidecar = directory / (platform + ".sha256")
        sidecar.write_text(digest + "\n")
        for source, object_key, mime in [(path, key, content_type), (sidecar, key + ".sha256", "text/plain")]:
            file_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            remote_hash = existing_hash(endpoint, bucket, object_key)
            if remote_hash is not None and remote_hash != file_hash:
                raise ValueError(f"Refusing to overwrite different R2 object: {object_key}")
            if remote_hash is None:
                pending.append((source, object_key, mime, file_hash))
    for source, key, content_type, digest in pending:
        aws(endpoint, "put-object", "--bucket", bucket, "--key", key,
            "--body", str(source), "--content-type", content_type,
            "--cache-control", "public, max-age=31536000, immutable",
            "--metadata", f"sha256={digest}", "--if-none-match", "*")
        if existing_hash(endpoint, bucket, key) != digest:
            raise RuntimeError(f"Upload verification failed: {key}")
        print(f"Published {key}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--bucket", default="hypen")
    args = parser.parse_args()
    # R2 credentials are passed through the AWS CLI's standard environment.
    os.environ.setdefault("AWS_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED")
    os.environ.setdefault("AWS_RESPONSE_CHECKSUM_VALIDATION", "WHEN_REQUIRED")
    upload(args.version.removeprefix("v"), args.directory, args.bucket, os.environ["R2_ENDPOINT_URL"])
