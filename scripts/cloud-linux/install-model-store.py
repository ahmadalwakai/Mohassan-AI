"""Stage and publish model store generations from a verified directory upload."""

import argparse
from contextlib import contextmanager, ExitStack
import ctypes
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
OCR_EXPORT = Path("artifacts/vision/ocr-v1")
CHUNK_SIZE = 1024 * 1024
MAX_MANIFEST_BYTES = 16 * CHUNK_SIZE


@contextmanager
def directory(path, parent=None, *, create=False):
    """Open each component without following symlinks, relative to a directory descriptor."""
    with ExitStack() as stack:
        if parent is None:
            parent = os.open(path.anchor, DIRECTORY_FLAGS)
            stack.callback(os.close, parent)
            parts = path.parts[1:]
        else:
            parts = path.parts
        for part in parts:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=parent)
                except FileExistsError:
                    pass
            parent = os.open(part, DIRECTORY_FLAGS, dir_fd=parent)
            stack.callback(os.close, parent)
        yield parent


@contextmanager
def regular_file(path, directory_fd, *, upload=False):
    with directory(path.parent, directory_fd) as parent:
        fd = os.open(path.name, FILE_FLAGS, dir_fd=parent)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (upload and info.st_nlink != 1):
                raise ValueError(f"Expected an ordinary file: {path}")
            yield source, info.st_size


def scan_tree(fd, prefix=Path(), *, upload=False):
    """List directories and regular files without following links."""
    dirs, files = set(), {}
    for name in os.listdir(fd):
        path = prefix / name
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            with directory(Path(name), fd) as child:
                child_dirs, child_files = scan_tree(child, path, upload=upload)
            dirs.add(path)
            dirs.update(child_dirs)
            files.update(child_files)
        elif stat.S_ISREG(info.st_mode) and (not upload or info.st_nlink == 1):
            files[path] = info.st_size
        else:
            raise ValueError(f"Expected an ordinary file or directory: {path}")
    return dirs, files


def relative_path(value):
    if (not isinstance(value, str) or not value or re.search(r"[\\:\x00-\x1f\x7f]", value)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError(f"Invalid relative path: {value!r}")
    return Path(value)


def store_path(value):
    if not value:
        raise ValueError("Set MOHASSAN_MODELS_ROOT or pass --store with the live store path.")
    path = Path(value)
    if not path.is_absolute() or path.anchor != "/" or not path.name or ".." in path.parts:
        raise ValueError(f"Expected an absolute directory path: {value!r}")
    return path


def upload_manifest(upload_fd, expected_digest):
    if not expected_digest or not SHA256.fullmatch(expected_digest):
        raise ValueError("Use the SHA-256 printed on the PC with --manifest-sha256.")
    if set(os.listdir(upload_fd)) != {"manifest.json", "files"}:
        raise ValueError("The upload must contain exactly manifest.json and files/.")
    with regular_file(Path("manifest.json"), upload_fd, upload=True) as (source, _):
        manifest_bytes = source.read(MAX_MANIFEST_BYTES + 1)
    if len(manifest_bytes) > MAX_MANIFEST_BYTES or hashlib.sha256(manifest_bytes).hexdigest() != expected_digest:
        raise ValueError("Upload manifest SHA-256 does not match the PC digest.")
    manifest = json.loads(manifest_bytes)
    if (not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int
            or manifest["schemaVersion"] != 1 or not isinstance(manifest.get("files"), list)
            or not manifest["files"]):
        raise ValueError("Expected a version 1 manifest with at least one file.")

    entries = {}
    for row in manifest["files"]:
        if not isinstance(row, dict) or row.get("area") not in ("models", "ocr"):
            raise ValueError("Manifest row needs a valid store area.")
        path = relative_path(row.get("path"))
        source_path = Path(row["area"]) / path
        size = row.get("sizeBytes")
        digest = row.get("sha256")
        if (source_path in entries or (row["area"] == "ocr" and len(path.parts) != 1)
                or type(size) is not int or size < 0 or not isinstance(digest, str) or not SHA256.fullmatch(digest)):
            raise ValueError(f"Invalid or duplicate manifest row: {source_path}")
        entries[source_path] = (size, digest)
    sizes = {path: size for path, (size, _) in entries.items()}
    if type(manifest.get("totalBytes")) is not int or manifest["totalBytes"] != sum(sizes.values()):
        raise ValueError("Manifest totalBytes does not equal the file sizes.")
    with directory(Path("files"), upload_fd) as payload:
        _, uploaded = scan_tree(payload, upload=True)
    if uploaded != sizes:
        raise ValueError("Uploaded paths or sizes differ from the manifest.")
    return manifest_bytes, entries


def copy_file(source_fd, source_path, dest_fd, dest_path, size, digest, group):
    with directory(dest_path.parent, dest_fd) as parent:
        with regular_file(source_path, source_fd, upload=digest is not None) as (source, actual_size):
            if actual_size != size:
                raise ValueError(f"File size changed: {source_path}")
            fd = os.open(dest_path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, "wb") as dest:
                sha = hashlib.sha256() if digest is not None else None
                remaining = size
                while remaining:
                    block = source.read(min(CHUNK_SIZE, remaining))
                    if not block:
                        break
                    dest.write(block)
                    remaining -= len(block)
                    if sha is not None:
                        sha.update(block)
                if remaining or source.read(1):
                    raise ValueError(f"File size changed during copy: {source_path}")
                if sha is not None and sha.hexdigest() != digest:
                    raise ValueError(f"SHA-256 mismatch: {source_path}")
                dest.flush()
                os.fchown(fd, os.geteuid(), group)
                os.fchmod(fd, 0o640)
                os.fsync(fd)


def rename_directory(fd, source, destination, *, exchange):
    libc = ctypes.CDLL(None, use_errno=True)
    # Linux UAPI linux/fs.h defines RENAME_EXCHANGE and RENAME_NOREPLACE, respectively.
    # https://github.com/torvalds/linux/blob/v6.8/include/uapi/linux/fs.h (retrieved 2026-11-27)
    flags = 1 << 1 if exchange else 1 << 0
    if libc.renameat2(fd, os.fsencode(source), fd, os.fsencode(destination), flags) != 0:
        errno = ctypes.get_errno()
        raise OSError(errno, f"Atomic directory rename failed: {os.strerror(errno)}", source)


def ensure_name(parent_fd, name, fd):
    try:
        actual = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        if fd is None:
            return
        raise
    if fd is None or not os.path.samestat(actual, os.fstat(fd)):
        raise ValueError(f"Store directory changed during installation: {name}")


def remove_stage(parent_fd, name, stage_fd):
    # Clean only the directory opened at stage creation, even if its parent is service-owned.
    ensure_name(parent_fd, name, stage_fd)
    for child in os.listdir(stage_fd):
        if stat.S_ISDIR(os.stat(child, dir_fd=stage_fd, follow_symlinks=False).st_mode):
            shutil.rmtree(child, dir_fd=stage_fd)
        else:
            os.unlink(child, dir_fd=stage_fd)
    ensure_name(parent_fd, name, stage_fd)
    os.rmdir(name, dir_fd=parent_fd)


class Stage:
    def __init__(self, stack, live, parent, incoming):
        self.live = live
        self.parent = parent
        generation = uuid.uuid4().hex
        self.staging = f"{live.name}.staging-{generation}"
        self.previous = f"{live.name}.previous-{generation}"
        self.incoming = incoming
        try:
            self.old = stack.enter_context(directory(Path(live.name), parent))
        except FileNotFoundError:
            self.old = None
        dirs, files = scan_tree(self.old) if self.old is not None else (set(), {})
        self.preserved = {path: size for path, size in files.items() if path not in incoming}
        self.dirs = dirs | {parent for path in incoming for parent in path.parents if parent != Path()}
        self.fd = None
        self.published = False

    def stage(self, stack, payload, group):
        os.mkdir(self.staging, mode=0o700, dir_fd=self.parent)
        self.fd = stack.enter_context(directory(Path(self.staging), self.parent))
        if os.fstat(self.fd).st_uid != os.geteuid() or stat.S_IMODE(os.fstat(self.fd).st_mode) != 0o700:
            raise ValueError("Staging directory is not private to the installer.")
        stack.callback(self.cleanup)
        for path in sorted(self.dirs):
            with directory(path, self.fd, create=True):
                pass
        for path, size in self.preserved.items():
            copy_file(self.old, path, self.fd, path, size, None, group)
        for path, (source, size, digest) in self.incoming.items():
            copy_file(payload, source, self.fd, path, size, digest, group)
        for path in sorted(self.dirs | {Path()}, reverse=True):
            with directory(path, self.fd) as fd:
                os.fchown(fd, os.geteuid(), group)
                os.fchmod(fd, 0o750)
                os.fsync(fd)

    def activate(self):
        ensure_name(self.parent, self.live.name, self.old)
        ensure_name(self.parent, self.staging, self.fd)
        rename_directory(self.parent, self.staging, self.live.name, exchange=self.old is not None)
        self.published = True
        ensure_name(self.parent, self.live.name, self.fd)
        ensure_name(self.parent, self.staging, self.old)

    def undo(self):
        ensure_name(self.parent, self.live.name, self.fd)
        ensure_name(self.parent, self.staging, self.old)
        rename_directory(self.parent, self.live.name, self.staging, exchange=self.old is not None)
        self.published = False

    def retain_previous(self):
        ensure_name(self.parent, self.staging, self.old)
        try:
            rename_directory(self.parent, self.staging, self.previous, exchange=False)
        except OSError as error:
            path = self.live.with_name(self.staging)
            raise ValueError(f"Could not name the rollback generation for {self.live}. "
                             f"The previous store remains at {path}: {error}") from error
        ensure_name(self.parent, self.previous, self.old)
        return self.live.with_name(self.previous)

    def cleanup(self):
        if not self.published:
            remove_stage(self.parent, self.staging, self.fd)


def lock_directories(stack, paths):
    descriptors = {path: stack.enter_context(directory(path)) for path in set(paths)}
    identities = {}
    for fd in descriptors.values():
        info = os.fstat(fd)
        identities[info.st_dev, info.st_ino] = fd
    for _, fd in sorted(identities.items()):
        fcntl.flock(fd, fcntl.LOCK_EX)
    return descriptors


def check_space(stages):
    required = {}
    available = {}
    for stage in stages:
        device = os.fstat(stage.parent).st_dev
        usage = os.fstatvfs(stage.parent)
        block = usage.f_frsize
        filesize = list(stage.preserved.values()) + [size for _, size, _ in stage.incoming.values()]
        bytes_needed = (len(stage.dirs) + 1) * block + sum((size + block - 1) // block * block for size in filesize)
        required[device] = required.get(device, 0) + bytes_needed
        available[device] = usage.f_bavail * block
        if required[device] > available[device]:
            raise ValueError(f"Insufficient staging space near {stage.live}: {required[device]} bytes required, "
                             f"{available[device]} bytes available.")


def check_registry(manifest_bytes, node, checker, models_fd, ocr_fd):
    with tempfile.TemporaryFile() as manifest:
        manifest.write(manifest_bytes)
        manifest.flush()
        manifest_fd = manifest.fileno()
        args = [node, os.path.abspath(checker), "--check-bundle", f"/proc/self/fd/{manifest_fd}",
                "--root", f"/proc/self/fd/{models_fd}"]
        fds = [manifest_fd, models_fd]
        if ocr_fd is not None:
            args.extend(("--ocr-dir", f"/proc/self/fd/{ocr_fd}"))
            fds.append(ocr_fd)
        subprocess.run(args, check=True, pass_fds=fds, cwd=Path(__file__).resolve().parents[2],
                       env={"PATH": os.environ["PATH"], "LC_ALL": "C"})


def install(args, live, group):
    ocr = store_path(args.ocr_dir) if args.ocr_dir else live / OCR_EXPORT
    if ocr == live or live.is_relative_to(ocr):
        raise ValueError("The OCR directory cannot be the model store or its parent.")
    nested_ocr = ocr.is_relative_to(live)
    upload_path = store_path(args.bundle)
    for target in (live, ocr):
        if target.is_relative_to(upload_path) or upload_path.is_relative_to(target):
            raise ValueError("Keep the upload outside the live store and OCR directories.")
    with ExitStack() as stack:
        upload = stack.enter_context(directory(upload_path))
        manifest, entries = upload_manifest(upload, args.manifest_sha256)
        payload = stack.enter_context(directory(Path("files"), upload))
        models, ocr_files = {}, {}
        for source, (size, digest) in entries.items():
            path = Path(*source.parts[1:])
            if source.parts[0] == "ocr" and nested_ocr:
                path = ocr.relative_to(live) / path
            destination = ocr_files if source.parts[0] == "ocr" and not nested_ocr else models
            if path in destination:
                raise ValueError(f"Bundle files share an install path: {path}")
            destination[path] = (source, size, digest)

        destinations = [(live, models)]
        if ocr_files:
            destinations.append((ocr, ocr_files))
        parents = lock_directories(stack, (target.parent for target, _ in destinations))
        stages = [Stage(stack, target, parents[target.parent], incoming) for target, incoming in destinations]
        check_space(stages)
        for stage in stages:
            stage.stage(stack, payload, group)
        models_fd = stages[0].fd
        ocr_fd = stages[1].fd if ocr_files else None
        if nested_ocr and any(path.parts[0] == "ocr" for path in entries):
            ocr_fd = stack.enter_context(directory(ocr.relative_to(live), models_fd))
        check_registry(manifest, args.node, args.checker, models_fd, ocr_fd)

        try:
            for stage in stages:
                stage.activate()
            for parent in parents.values():
                os.fsync(parent)
        except (OSError, ValueError):
            for stage in reversed(stages):
                if stage.published:
                    try:
                        stage.undo()
                        os.fsync(stage.parent)
                    except (OSError, ValueError) as error:
                        path = stage.live.with_name(stage.staging)
                        print(f"Could not restore {stage.live}. Inspect {path}: {error}", file=sys.stderr)
            raise

        # All swaps succeeded. Only displaced live generations can receive rollback names.
        print(f"Installed {len(entries)} files from the verified manifest.")
        retention_failed = False
        for stage in stages:
            if stage.old is not None:
                try:
                    print(f"Previous {stage.live}: {stage.retain_previous()}")
                except (OSError, ValueError) as error:
                    print(error, file=sys.stderr)
                    retention_failed = True
        for parent in parents.values():
            os.fsync(parent)
        if retention_failed:
            raise ValueError("The verified replacement is live. Review the previous-store paths above.")


def rollback(live, backup):
    pattern = re.escape(live.name) + r"\.previous-[0-9a-f]{32}"
    if live.parent != backup.parent or not re.fullmatch(pattern, backup.name):
        raise ValueError("Choose a previous generation printed by install for this store.")
    with ExitStack() as stack:
        parent = lock_directories(stack, [live.parent])[live.parent]
        current = stack.enter_context(directory(Path(live.name), parent))
        previous = stack.enter_context(directory(Path(backup.name), parent))
        scan_tree(previous)
        ensure_name(parent, live.name, current)
        ensure_name(parent, backup.name, previous)
        rename_directory(parent, live.name, backup.name, exchange=True)
        os.fsync(parent)
    print(f"Restored {live}; the displaced store is retained at {backup}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--checker", required=True)
    actions = parser.add_subparsers(dest="action", required=True)
    installer = actions.add_parser("install")
    installer.add_argument("bundle")
    installer.add_argument("--manifest-sha256", required=True)
    installer.add_argument("--ocr-dir", default=os.getenv("MOHASSAN_OCR_MODEL_DIR"))
    restorer = actions.add_parser("rollback")
    restorer.add_argument("previous")
    for action in (installer, restorer):
        action.add_argument("--store", default=os.getenv("MOHASSAN_MODELS_ROOT"))
    args = parser.parse_args()
    try:
        live = store_path(args.store)
        group = grp.getgrnam(args.group).gr_gid
        if args.action == "install":
            install(args, live, group)
        else:
            rollback(live, store_path(args.previous))
    except (AttributeError, KeyError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Model store {args.action} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
