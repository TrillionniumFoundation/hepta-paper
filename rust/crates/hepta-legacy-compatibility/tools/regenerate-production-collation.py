#!/usr/bin/env python3
"""Regenerate the pinned native collation blob from verified official inputs.

A locally installed source-enabled icu4x-datagen 2.1.1 is required. Generation
uses local source ZIPs and has no need for network access. The output must match
the committed provenance digest before --write may replace the checked-in blob.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--datagen", type=Path, required=True)
    parser.add_argument("--icu-export", type=Path, required=True)
    parser.add_argument("--cldr", type=Path, required=True)
    parser.add_argument("--write", action="store_true", help="replace the blob only after exact digest verification")
    arguments = parser.parse_args()
    data = Path(__file__).resolve().parents[1] / "data"
    provenance = json.loads((data / "production-collation-provenance.json").read_text())
    for label, path in (("icu_export", arguments.icu_export), ("cldr", arguments.cldr)):
        if sha256(path) != provenance["sources"][label]["sha256"]:
            raise SystemExit(f"{label} source SHA-256 differs from the qualified input")
    version = subprocess.check_output([str(arguments.datagen.resolve()), "--version"], text=True).strip()
    if version != provenance["generator"]["reported_version"]:
        raise SystemExit(f"unexpected datagen version: {version}")
    with tempfile.TemporaryDirectory(prefix="hepta-production-collation-") as temporary:
        output = Path(temporary) / provenance["artifact"]["filename"]
        command = [str(arguments.datagen.resolve()), "--format", "blob", "--markers"]
        command += provenance["generator"]["markers"]
        command += ["--locales", "en-US", "en", "und", "--deduplication", "none",
                    "--collation-root-han", "unihan", "--cldr-root", str(arguments.cldr.resolve()),
                    "--icuexport-root", str(arguments.icu_export.resolve()),
                    "--segmenter-models", "none", "--out", str(output)]
        subprocess.run(command, check=True)
        observed = sha256(output)
        if observed != provenance["artifact"]["sha256"]:
            raise SystemExit(f"generated blob differs from the qualified profile: {observed}")
        if arguments.write:
            shutil.copyfile(output, data / provenance["artifact"]["filename"])
        print(f"verified {provenance['artifact']['filename']} sha256:{observed}")


if __name__ == "__main__":
    main()
