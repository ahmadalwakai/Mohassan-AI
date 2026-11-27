import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import re
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
    assert not list(live.parent.glob("*.staging-*"))


def test_low_disk_space_refuses_before_staging(installer, stores, monkeypatch):
    live, _, _, args = stores
    monkeypatch.setattr(installer.os, "fstatvfs", lambda _: SimpleNamespace(f_frsize=1, f_bavail=0))
    with pytest.raises(ValueError, match="Insufficient staging space"):
        installer.install(args, live, os.getgid())
    assert not list(live.parent.glob("*.previous-*"))
    assert not list(live.parent.glob("*.staging-*"))


def test_staged_directories_become_previous_only_after_exchange(installer, stores, monkeypatch, capsys):
    live, ocr, _, args = stores
    live_inodes = {target: target.stat().st_ino for target in (live, ocr)}
    previous = {}

    def check_staging(_manifest, _node, _checker, models_fd, ocr_fd):
        for target, fd in [(live, models_fd), (ocr, ocr_fd)]:
            staging = Path(os.readlink(f"/proc/self/fd/{fd}"))
            assert staging.parent == target.parent
            assert re.fullmatch(rf"{re.escape(target.name)}\.staging-[0-9a-f]{{32}}", staging.name)
            assert staging.stat().st_ino == os.fstat(fd).st_ino
            assert target.stat().st_ino == live_inodes[target]
            assert not list(target.parent.glob(f"{target.name}.previous-*"))
            previous[target] = staging.with_name(staging.name.replace(".staging-", ".previous-"))

    monkeypatch.setattr(installer, "check_registry", check_staging)
    installer.install(args, live, os.getgid())

    output = capsys.readouterr().out
    assert set(previous) == {live, ocr}
    for target, path in previous.items():
        assert f"Previous {target}: {path}" in output
        assert path.stat().st_ino == live_inodes[target]
        assert target.stat().st_ino != live_inodes[target]
    assert not list(live.parent.glob("*.staging-*"))


def test_archive_name_collision_keeps_displaced_store_and_reports_its_path(installer, stores, monkeypatch, capsys):
    live, ocr, path, args = stores
    live_inode = live.stat().st_ino
    ocr_inode = ocr.stat().st_ino
    collision_inode = None
    staging = None
    collision = None
    ocr_previous = None

    def block_model_archive(_manifest, _node, _checker, models_fd, ocr_fd):
        nonlocal collision_inode, staging, collision, ocr_previous
        staging = Path(os.readlink(f"/proc/self/fd/{models_fd}"))
        collision = staging.with_name(staging.name.replace(".staging-", ".previous-"))
        collision.mkdir()
        collision_inode = collision.stat().st_ino
        ocr_staging = Path(os.readlink(f"/proc/self/fd/{ocr_fd}"))
        ocr_previous = ocr_staging.with_name(ocr_staging.name.replace(".staging-", ".previous-"))

    monkeypatch.setattr(installer, "check_registry", block_model_archive)
    with pytest.raises(ValueError):
        installer.install(args, live, os.getgid())

    output = capsys.readouterr()
    assert str(staging) in output.err
    assert collision.stat().st_ino == collision_inode
    assert not list(collision.iterdir())
    assert staging.stat().st_ino == live_inode
    assert (staging / path).read_bytes() == b"original models"
    assert (live / path).read_bytes() == b"new models"
    assert (ocr / path).read_bytes() == b"new OCR"
    assert ocr_previous.stat().st_ino == ocr_inode
    assert str(ocr_previous) in output.out
