#!/usr/bin/env python3
"""Reconstruct the pinned Android npm lockfile before F-Droid source scanning."""
import base64
import gzip
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS_DIR = ROOT / "android" / "package-lock-source"
OUTPUT = ROOT / "android" / "package-lock.json"
EXPECTED_SHA256 = "fcff97ebdfb728268ad432c360d5812f94c5558cb1b25c9703d17e1080049880"

parts = sorted(
    path for path in PARTS_DIR.iterdir()
    if re.fullmatch(r"part-\d{2}\.b64", path.name)
)
if len(parts) != 12:
    raise SystemExit(f"Expected 12 Android npm lockfile fragments; found {len(parts)}.")

encoded = "".join(path.read_text(encoding="utf-8") for path in parts)
try:
    compressed = base64.b64decode(encoded, validate=True)
except Exception as exc:
    raise SystemExit(f"Android npm lockfile fragments are not valid Base64: {exc}") from exc

actual_sha256 = hashlib.sha256(compressed).hexdigest()
if actual_sha256 != EXPECTED_SHA256:
    raise SystemExit("Compressed Android npm lockfile failed its SHA-256 integrity check.")

try:
    lock = json.loads(gzip.decompress(compressed).decode("utf-8"))
except Exception as exc:
    raise SystemExit(f"Android npm lockfile could not be decompressed or parsed: {exc}") from exc

if lock.get("lockfileVersion") != 3 or "node_modules/@supabase/supabase-js" not in lock.get("packages", {}):
    raise SystemExit("Android npm lockfile is invalid or missing the pinned Supabase client.")

OUTPUT.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("Restored SHA-256-verified Android npm lockfile before F-Droid scanning.")
