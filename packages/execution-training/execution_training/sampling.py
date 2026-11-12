"""Serializable deterministic sampling, with explicit batch commit boundaries."""
from __future__ import annotations

from typing import Iterable, Mapping, Any

from .common import digest
from .errors import TrainingError

SAMPLER_SCHEMA_VERSION = "execution-sampler-v1"


class DeterministicSampler:
    """Single-process sampler; no worker prefetch state is hidden in checkpoints.

    ``peek`` can cross epoch boundaries. ``commit`` is called only after the
    accumulation window's optimizer update succeeds; a shorter positive prefix
    may be committed to respect a processed-token budget.
    Order uses SHA-256 sort keys instead of depending on Python's shuffle details.
    """

    def __init__(self, sample_ids: Iterable[str], seed: int, dataset_identity: str):
        supplied_ids = tuple(sample_ids)
        if not supplied_ids or any(type(value) is not str or not value for value in supplied_ids):
            raise TrainingError("EMPTY_TRAINING_SET", "Sampler requires nonempty sample identifiers.")
        self.sample_ids = tuple(sorted(supplied_ids))
        if len(set(self.sample_ids)) != len(self.sample_ids):
            raise TrainingError("DUPLICATE_SAMPLE_ID", "Sampler identifiers must be unique.")
        if type(seed) is not int or type(dataset_identity) is not str or not dataset_identity:
            raise TrainingError("INVALID_SAMPLER", "Sampler seed and dataset identity are required.")
        self.seed = seed
        self.dataset_identity = dataset_identity
        self.epoch = 0
        self.position = 0
        self._pending_count: int | None = None
        self._order = self._epoch_order()

    def _epoch_order(self, epoch: int | None = None) -> tuple[str, ...]:
        number = self.epoch if epoch is None else epoch
        return tuple(sorted(self.sample_ids, key=lambda sample_id: (digest([self.seed, number, sample_id]), sample_id)))

    def peek(self, batch_size: int) -> tuple[str, ...]:
        if type(batch_size) is not int or batch_size < 1:
            raise TrainingError("INVALID_BATCH_SIZE", "Microbatch size must be positive.")
        result: list[str] = []
        epoch, position, order = self.epoch, self.position, self._order
        while len(result) < batch_size:
            taken = order[position:position + batch_size - len(result)]
            result.extend(taken)
            position += len(taken)
            if position == len(order) and len(result) < batch_size:
                epoch += 1
                position = 0
                order = self._epoch_order(epoch)
        self._pending_count = len(result)
        return tuple(result)

    def commit(self, count: int) -> None:
        if type(count) is not int or count <= 0 or self._pending_count is None or count > self._pending_count:
            raise TrainingError("SAMPLER_COMMIT_MISMATCH", "Commit must be a positive prefix of the most recently peeked window.")
        self.epoch += (self.position + count) // len(self.sample_ids)
        self.position = (self.position + count) % len(self.sample_ids)
        self._pending_count = None
        self._order = self._epoch_order()

    def state_dict(self) -> dict:
        return {
            "schema_version": SAMPLER_SCHEMA_VERSION,
            "algorithm": "sha256-epoch-order-v1",
            "dataset_identity": self.dataset_identity,
            "sample_ids_hash": digest(list(self.sample_ids)),
            "sample_count": len(self.sample_ids),
            "seed": self.seed,
            "epoch": self.epoch,
            "position": self.position,
        }

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        expected = self.state_dict()
        if not isinstance(state, Mapping) or set(state) != set(expected):
            raise TrainingError("RESUME_INCOMPATIBLE", "Sampler state fields are incompatible.")
        for key in ("schema_version", "algorithm", "dataset_identity", "sample_ids_hash", "sample_count", "seed"):
            if state[key] != expected[key] or type(state[key]) is not type(expected[key]):
                raise TrainingError("DATASET_MANIFEST_CHANGED", "Sampler dataset, seed or ordering algorithm changed.")
        epoch, position = state["epoch"], state["position"]
        if type(epoch) is not int or epoch < 0 or type(position) is not int or not 0 <= position < len(self.sample_ids):
            raise TrainingError("CORRUPT_CHECKPOINT", "Sampler position is invalid.")
        self.epoch, self.position = epoch, position
        self._pending_count = None
        self._order = self._epoch_order()
