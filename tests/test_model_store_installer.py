import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="The installer uses Linux directory exchange")


@pytest.fixture()
def installer():
    script = Path(__file__).resolve().parents[1] / "scripts/cloud-linux/install-model-store.py"
    spec = spec_from_file_location("model_store_installer", script)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def stores(tmp_path):
    live = tmp_path / "models"
    ocr = tmp_path / "ocr"
    bundle = tmp_path / "upload"
    live.mkdir()
    ocr.mkdir()
    path = "weights.bin"
    (live / path).write_bytes(b"original models")
    (ocr / path).write_bytes(b"original OCR")
    rows = []
    for area, data in [("models", b"new models"), ("ocr", b"new OCR")]:
        payload = bundle / "files" / area
        payload.mkdir(parents=True)
        (payload / path).write_bytes(data)
        rows.append({"area": area, "path": path, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    manifest = json.dumps({"schemaVersion": 1, "files": rows, "totalBytes": sum(row["sizeBytes"] for row in rows)}).encode()
    (bundle / "manifest.json").write_bytes(manifest)
    args = SimpleNamespace(bundle=bundle, ocr_dir=ocr, manifest_sha256=hashlib.sha256(manifest).hexdigest(),
                           node="never called", checker="never called")
    return live, ocr, path, args


def test_second_swap_failure_restores_the_first_store(installer, stores, monkeypatch):
    live, ocr, path, args = stores
    original_rename = installer.rename_directory
    first_inode = live.stat().st_ino

    def stop_second_swap(fd, source, destination, *, exchange):
        if destination == ocr.name:
            raise OSError("simulated OCR exchange failure")
        return original_rename(fd, source, destination, exchange=exchange)

    monkeypatch.setattr(installer, "check_registry", lambda *_: None)
    monkeypatch.setattr(installer, "rename_directory", stop_second_swap)
    with pytest.raises(OSError, match="simulated OCR exchange failure"):
        installer.install(args, live, os.getgid())
    assert live.stat().st_ino == first_inode
    assert (live / path).read_bytes() == b"original models"
    assert (ocr / path).read_bytes() == b"original OCR"
    assert not list(live.parent.glob("*.previous-*"))


def test_low_disk_space_refuses_before_staging(installer, stores, monkeypatch):
    live, _, _, args = stores
    monkeypatch.setattr(installer.os, "fstatvfs", lambda _: SimpleNamespace(f_frsize=1, f_bavail=0))
    with pytest.raises(ValueError, match="Insufficient staging space"):
        installer.install(args, live, os.getgid())
    assert not list(live.parent.glob("*.previous-*"))
