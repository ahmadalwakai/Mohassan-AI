"""Strict, local-only inference checkpoint reader. This module never saves weights."""

from __future__ import annotations

from collections import OrderedDict
from contextlib import ExitStack
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Any, BinaryIO
import zipfile

import torch

from .config import ModelConfig
from .errors import ExecutionModelError, ModelLoadError, ResourceError
from .metadata import ARCHITECTURE_ID, ModelMetadata
from .model import ExecutionModel
from .resources import ResolvedResources, ResourceConfig, is_out_of_memory, place_model
from .tokenizer import ByteBPETokenizer


CHECKPOINT_FORMAT = "mohassan-execution-checkpoint"
CHECKPOINT_VERSION = 1
_HASH = re.compile(r"[0-9a-f]{64}")
_MANIFEST_FIELDS = frozenset({
    "format", "version", "architecture", "config_identity", "tokenizer_identity",
    "weights_sha256", "training_status", "initialization_seed",
})
_FLOAT_DTYPES = {torch.float32, torch.float16, torch.bfloat16}


@dataclass(frozen=True)
class LoadedCheckpoint:
    model: ExecutionModel
    tokenizer: ByteBPETokenizer
    metadata: ModelMetadata
    resolved_resources: ResolvedResources


def _fail(message: str, reason: str, **details: Any) -> ModelLoadError:
    return ModelLoadError(message, details={"reason": reason, **details})


def _pairs_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _fail("Checkpoint JSON contains a duplicate field.", "INVALID_METADATA")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise _fail("Checkpoint JSON contains a nonfinite number.", "INVALID_METADATA")


def _read_json(handle: BinaryIO, limit: int) -> dict[str, Any]:
    data = handle.read(limit + 1)
    if len(data) > limit:
        raise _fail("Checkpoint metadata exceeds its size limit.", "METADATA_TOO_LARGE")
    try:
        document = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs_without_duplicates, parse_constant=_invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise _fail("Checkpoint metadata is not valid UTF-8 JSON.", "INVALID_METADATA") from error
    if type(document) is not dict:
        raise _fail("Checkpoint metadata must be a JSON object.", "INVALID_METADATA")
    return document


def _local_directory(path: str | os.PathLike[str]) -> Path:
    raw = os.fspath(path)
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise _fail("An explicit local checkpoint directory is required.", "INVALID_PATH")
    is_scheme = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", raw) is not None
    is_windows_drive = re.match(r"^[A-Za-z]:[\\/]", raw) is not None
    if raw.startswith(("\\\\", "//")) or "://" in raw or (is_scheme and not is_windows_drive):
        raise _fail("Remote paths and URLs are not checkpoint sources.", "NONLOCAL_PATH")
    directory = Path(raw).absolute()
    if os.name == "nt":
        # Reject mapped network drives too. No downloads or network clients are
        # used; mounts on non-Windows systems remain the host's responsibility.
        import ctypes
        from ctypes import wintypes
        get_drive_type = ctypes.windll.kernel32.GetDriveTypeW
        get_drive_type.argtypes = [wintypes.LPCWSTR]
        get_drive_type.restype = wintypes.UINT
        drive_type = get_drive_type(str(directory.anchor))
        if drive_type == 4:  # DRIVE_REMOTE
            raise _fail("Mapped network drives are not checkpoint sources.", "NONLOCAL_PATH")
    for component in (*reversed(directory.parents), directory):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise _fail("Checkpoint paths may not contain symbolic links or reparse points.", "NONLOCAL_PATH")
    if not directory.is_dir():
        raise _fail("The checkpoint path must be a directory.", "INVALID_PATH")
    return directory


def _open_file(stack: ExitStack, directory: Path, name: str, limit: int) -> BinaryIO:
    path = directory / name
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise _fail("Checkpoint members must be regular local files.", "INVALID_FILE", member=name)
    if not 0 < info.st_size <= limit:
        raise _fail("Checkpoint member exceeds its size limit or is empty.", "FILE_SIZE_LIMIT", member=name, limit=limit)
    handle = stack.enter_context(path.open("rb"))
    opened_info = os.fstat(handle.fileno())
    if (opened_info.st_size, opened_info.st_ino, opened_info.st_dev) != (info.st_size, info.st_ino, info.st_dev):
        raise _fail("Checkpoint member changed while opening it.", "FILE_CHANGED", member=name)
    return handle


def _sha256(handle: BinaryIO, limit: int) -> str:
    digest = hashlib.sha256()
    handle.seek(0)
    total = 0
    while chunk := handle.read(1_048_576):
        total += len(chunk)
        if total > limit:
            raise _fail("Checkpoint weights grew beyond the configured size limit.", "FILE_SIZE_LIMIT")
        digest.update(chunk)
    handle.seek(0)
    return digest.hexdigest()


def _validate_archive(handle: BinaryIO, limit: int) -> None:
    """Only current torch.save ZIP containers, never legacy raw pickle files."""
    try:
        with zipfile.ZipFile(handle, "r") as archive:
            members = archive.infolist()
            if not 1 <= len(members) <= 8192 or len({item.filename for item in members}) != len(members):
                raise _fail("Checkpoint archive has an invalid member count.", "INVALID_ARCHIVE")
            total = 0
            pickle_members = 0
            for item in members:
                parts = item.filename.replace("\\", "/").split("/")
                if not parts[0] or ".." in parts or ":" in item.filename or item.flag_bits & 1:
                    raise _fail("Checkpoint archive contains unsafe members.", "INVALID_ARCHIVE")
                if item.compress_type != zipfile.ZIP_STORED:
                    raise _fail("Only uncompressed tensor archives are supported.", "UNSUPPORTED_ARCHIVE")
                total += item.file_size
                if item.file_size < 0 or item.compress_size != item.file_size or total > limit:
                    raise _fail("Checkpoint archive exceeds the tensor byte limit.", "FILE_SIZE_LIMIT")
                if parts[-1] == "data.pkl":
                    pickle_members += 1
                    if item.file_size > 8_388_608:
                        raise _fail("Checkpoint tensor index is too large.", "FILE_SIZE_LIMIT")
            if pickle_members != 1:
                raise _fail("Checkpoint must contain one tensor state dictionary.", "INVALID_ARCHIVE")
    except (zipfile.BadZipFile, OSError, ValueError) as error:
        raise _fail("Checkpoint is not a supported tensor ZIP archive.", "INVALID_ARCHIVE") from error
    finally:
        handle.seek(0)


def _check_torch_loader() -> None:
    # Older weights_only implementations are not a supported security boundary.
    version = re.match(r"^(\d+)\.(\d+)\.(\d+)", torch.__version__)
    if version is None or tuple(int(part) for part in version.groups()) < (2, 6, 0):
        raise _fail("Checkpoint loading requires a maintained PyTorch version at least 2.6.0 with weights_only support.", "UNSUPPORTED_TORCH_VERSION")
    # Do not inherit an application's user-added unpickler allowlist. There is
    # intentionally no clear_safe_globals() mutation or unsafe fallback here.
    getter = getattr(torch.serialization, "get_safe_globals", None)
    if getter is None:
        raise _fail("Restricted checkpoint loading requires a PyTorch safe-globals inspector.", "UNSAFE_LOADER_CONFIGURATION")
    # PyTorch >= 2.10 itself registers internal types (nested tensors, mesh layouts) at
    # import. Requiring a literally empty list made every load fail. Only entries
    # defined inside PyTorch are tolerated; any application-added global is refused.
    for entry in getter():
        target = entry[0] if isinstance(entry, tuple) else entry
        module = getattr(target, "__module__", None)
        if not isinstance(module, str) or not (module == "torch" or module.startswith("torch.")):
            raise _fail("Restricted checkpoint loading refuses application-added safe globals.", "UNSAFE_LOADER_CONFIGURATION")


def _restricted_load(handle: BinaryIO, device: str) -> dict[str, torch.Tensor]:
    _check_torch_loader()
    handle.seek(0)
    try:
        state = torch.load(handle, map_location=device, weights_only=True)
    except Exception as error:
        if isinstance(error, MemoryError) or is_out_of_memory(error):
            raise ResourceError("Checkpoint tensor loading exhausted available memory.", details={"reason": "OUT_OF_MEMORY"}) from error
        raise _fail("Restricted tensor checkpoint loading failed.", "UNSAFE_OR_INVALID_WEIGHTS") from error
    if type(state) not in (dict, OrderedDict):
        raise _fail("Weights must be a plain tensor state dictionary.", "INVALID_STATE_DICT")
    if any(type(key) is not str or type(value) is not torch.Tensor for key, value in state.items()):
        raise _fail("The state dictionary must contain only string keys and ordinary tensors.", "INVALID_STATE_DICT")
    return state


def _validate_state(state: dict[str, torch.Tensor], expected: dict[str, torch.Tensor], *, check_finite: bool, limit: int) -> None:
    if set(state) != set(expected):
        raise _fail("Checkpoint tensor names do not match the architecture exactly.", "STATE_KEYS_MISMATCH")
    byte_count = 0
    for name, tensor in state.items():
        if tensor.shape != expected[name].shape or tensor.dtype not in _FLOAT_DTYPES:
            raise _fail("Checkpoint tensor shape or dtype is incompatible.", "TENSOR_MISMATCH", tensor=name)
        if tensor.layout != torch.strided or not tensor.is_contiguous() or tensor.storage_offset() != 0:
            raise _fail("Checkpoint tensors must use contiguous dense storage.", "TENSOR_LAYOUT_MISMATCH", tensor=name)
        byte_count += tensor.numel() * tensor.element_size()
        if tensor.untyped_storage().nbytes() != tensor.numel() * tensor.element_size() or byte_count > limit:
            raise _fail("Checkpoint tensor storage exceeds its expected allocation.", "TENSOR_STORAGE_MISMATCH", tensor=name)
        if check_finite and not bool(torch.isfinite(tensor).all()):
            raise _fail("Checkpoint contains nonfinite weights.", "NONFINITE_WEIGHTS", tensor=name)


def load_checkpoint(
    path: str | os.PathLike[str],
    *,
    expected_config: ModelConfig,
    expected_tokenizer_identity: str,
    resources: ResourceConfig | None = None,
) -> LoadedCheckpoint:
    """Load a caller-approved local architecture and tokenizer, with exact matches.

    Hashes detect mismatches; they do not authenticate the checkpoint author.
    ``training_status`` is an unverified declaration by that author. Keep the
    directory immutable during loading. Host/process isolation is still needed
    for hostile files because a tensor parser is not a memory or CPU sandbox.
    """
    if not isinstance(expected_config, ModelConfig):
        raise _fail("An explicit expected ModelConfig is required.", "EXPECTED_CONFIG_REQUIRED")
    if not isinstance(expected_tokenizer_identity, str) or _HASH.fullmatch(expected_tokenizer_identity) is None:
        raise _fail("An explicit expected tokenizer SHA-256 identity is required.", "EXPECTED_TOKENIZER_REQUIRED")
    resources = resources if resources is not None else ResourceConfig()
    if not isinstance(resources, ResourceConfig):
        raise _fail("resources must be ResourceConfig.", "INVALID_RESOURCES")
    if resources.max_context_length > expected_config.max_context_length:
        raise _fail("Resource context limit exceeds the expected model context length.", "INVALID_RESOURCES")
    _check_torch_loader()
    resolved = resources.resolve()
    try:
        directory = _local_directory(path)
        with ExitStack() as stack:
            manifest_handle = _open_file(stack, directory, "manifest.json", 65_536)
            config_handle = _open_file(stack, directory, "config.json", 65_536)
            tokenizer_handle = _open_file(stack, directory, "tokenizer.json", 16_777_216)
            weights_handle = _open_file(stack, directory, "weights.pt", resources.max_checkpoint_bytes)
            manifest = _read_json(manifest_handle, 65_536)
            if set(manifest) != _MANIFEST_FIELDS:
                raise _fail("Checkpoint manifest fields do not match version 1.", "INVALID_MANIFEST")
            if manifest["format"] != CHECKPOINT_FORMAT or type(manifest["version"]) is not int or manifest["version"] != CHECKPOINT_VERSION or manifest["architecture"] != ARCHITECTURE_ID:
                raise _fail("Checkpoint format or architecture version is unsupported.", "UNSUPPORTED_FORMAT")
            for key in ("config_identity", "tokenizer_identity", "weights_sha256"):
                if not isinstance(manifest[key], str) or _HASH.fullmatch(manifest[key]) is None:
                    raise _fail("Checkpoint manifest has an invalid identity.", "INVALID_MANIFEST")
            if manifest["training_status"] not in ("random_initialized", "unverified", "trained"):
                raise _fail("Checkpoint training status is invalid.", "INVALID_MANIFEST")
            seed = manifest["initialization_seed"]
            if seed is not None and (type(seed) is not int or not 0 <= seed < 2**63):
                raise _fail("Checkpoint initialization seed is invalid.", "INVALID_MANIFEST")
            config = ModelConfig.from_dict(_read_json(config_handle, 65_536))
            if config.to_dict() != expected_config.to_dict() or config.identity != manifest["config_identity"]:
                raise _fail("Checkpoint configuration differs from the expected model.", "CONFIG_MISMATCH")
            if seed is not None and seed != config.seed:
                raise _fail("Checkpoint initialization seed disagrees with its configuration.", "CONFIG_MISMATCH")
            if manifest["tokenizer_identity"] != expected_tokenizer_identity:
                raise _fail("Checkpoint tokenizer identity differs from the expected tokenizer.", "TOKENIZER_MISMATCH")
            tokenizer = ByteBPETokenizer.from_dict(_read_json(tokenizer_handle, 16_777_216))
            if tokenizer.identity != expected_tokenizer_identity or tokenizer.vocab_size != config.vocab_size:
                raise _fail("Checkpoint tokenizer contents or vocabulary size are incompatible.", "TOKENIZER_MISMATCH")
            if _sha256(weights_handle, resources.max_checkpoint_bytes) != manifest["weights_sha256"]:
                raise _fail("Checkpoint weights do not match their declared SHA-256 hash.", "WEIGHTS_HASH_MISMATCH")
            _validate_archive(weights_handle, resources.max_checkpoint_bytes)
            # Shape/storage preflight on meta avoids allocating tensor data from
            # an incompatible file. No external weights initialize this model.
            with torch.device("meta"):
                model = ExecutionModel(config)
            expected_state = model.state_dict()
            preflight = _restricted_load(weights_handle, "meta")
            _validate_state(preflight, expected_state, check_finite=False, limit=resources.max_checkpoint_bytes)
            del preflight
            state = _restricted_load(weights_handle, "cpu")
            _validate_state(state, expected_state, check_finite=True, limit=resources.max_checkpoint_bytes)
            if _sha256(weights_handle, resources.max_checkpoint_bytes) != manifest["weights_sha256"]:
                raise _fail("Checkpoint weights changed during loading.", "FILE_CHANGED")
            # assign=True materializes the meta parameters without a second
            # randomly initialized CPU copy. Exact names were already checked.
            model.load_state_dict(state, strict=True, assign=True)
            del state, expected_state
            model = place_model(model, resolved)
            # A finite float32 checkpoint can overflow when explicitly cast to
            # float16. Reject that result before exposing a loaded model.
            if any(not bool(torch.isfinite(parameter).all()) for parameter in model.parameters()):
                raise _fail("Requested inference dtype cannot represent these weights finitely.", "DTYPE_OVERFLOW")
            model.eval()
            model.weight_origin = "local_checkpoint"
            model.initialization_seed = seed
            canonical_manifest = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            metadata = ModelMetadata(
                weight_origin="local_checkpoint", training_status=manifest["training_status"],
                config_identity=config.identity, tokenizer_identity=tokenizer.identity,
                initialization_seed=seed, checkpoint_identity=hashlib.sha256(canonical_manifest).hexdigest(),
            )
            return LoadedCheckpoint(model, tokenizer, metadata, resolved)
    except (ModelLoadError, ResourceError):
        raise
    except ExecutionModelError as error:
        raise _fail("Checkpoint configuration or tokenizer validation failed.", "INVALID_METADATA") from error
    except FileNotFoundError as error:
        raise _fail("Checkpoint directory or a required member is missing.", "CHECKPOINT_NOT_FOUND") from error
    except (OSError, ValueError, TypeError, RuntimeError, MemoryError, RecursionError) as error:
        if isinstance(error, MemoryError) or is_out_of_memory(error):
            raise ResourceError("Checkpoint loading exhausted available memory.", details={"reason": "OUT_OF_MEMORY"}) from error
        raise _fail("Local checkpoint loading failed.", "CHECKPOINT_LOAD_FAILED") from error
