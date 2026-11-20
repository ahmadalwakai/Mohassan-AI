"""Per-document next-token losses on the approved English development split."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
import json
import math
from pathlib import Path
from typing import Any, Callable

from .pretrain import _atomic_json, _sha256


WINDOW = 512
SOURCES = {
    "standard-wikipedia": {"wikipedia-20231101-en"},
    "simplewiki": {"simplewiki-20261101"},
    "human-dialogue": {"aya-original", "oasst2-human"},
}


def _verified_bytes(path: Path, expected: str) -> bytes:
    raw = path.read_bytes()
    if sha256(raw).hexdigest() != expected:
        raise ValueError(f"Frozen development file hash mismatch: {path.name}")
    return raw


@dataclass(frozen=True)
class _Document:
    id: str
    source: str
    source_group_key: tuple[str, str]
    article_family_key: str | None
    offset: int
    tokens: int

    def windows(self) -> list[tuple[int, int]]:
        # Reuse the last token as context so every subsequent target is scored once.
        return [(self.offset + i, min(WINDOW, self.tokens - i))
                for i in range(0, self.tokens - 1, WINDOW - 1)]


def _score_batch(model: Any, tokens: Any, windows: list[tuple[int, int]], *,
                 device: str, pad_token_id: int) -> list[float]:
    import torch
    import torch.nn.functional as F

    lengths = [length for _, length in windows]
    width = max(lengths)
    ids = torch.full((len(windows), width), pad_token_id, dtype=torch.long)
    mask = torch.arange(width).unsqueeze(0) < torch.tensor(lengths).unsqueeze(1)
    for row, (offset, length) in enumerate(windows):
        ids[row, :length] = torch.from_numpy(tokens[offset:offset + length].astype("int64"))
    ids, mask = ids.to(device), mask.to(device)
    ignore = model.config.ignore_index
    targets = ids[:, 1:].masked_fill(~mask[:, 1:], ignore)
    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
        logits = model(ids, attention_mask=mask).logits
    losses = F.cross_entropy(logits[:, :-1, :].float().reshape(-1, model.config.vocab_size),
                             targets.reshape(-1), ignore_index=ignore, reduction="none")
    # Cross-entropy uses the model's ordinary float32 semantics. Sum on CPU
    # in float64 so document totals do not depend on reduction groupings.
    return losses.reshape(len(windows), width - 1).cpu().sum(1, dtype=torch.float64).tolist()


class FrozenEnglishDevelopment:
    def __init__(self, directory: Path, expected_manifest_sha256: str, *,
                 pad_token_id: int = 0, eos_token_id: int = 258):
        import numpy as np

        manifest = json.loads(_verified_bytes(directory / "manifest.json", expected_manifest_sha256))
        if manifest["status"] != "frozen_cpu_preparation" or set(manifest["validation_documents_by_stratum"]) != set(SOURCES):
            raise ValueError("Unexpected frozen English development profile.")
        self.manifest_sha256 = expected_manifest_sha256
        self.pad_token_id = pad_token_id
        self.eos_token_id = eos_token_id
        self.input_sha256 = {}
        self.strata = {}
        source_counts: dict[str, Counter] = {}
        identities, groups, families = set(), set(), set()
        for stratum, sources in SOURCES.items():
            binary_name, index_name = f"{stratum}.bin", f"{stratum}.documents.jsonl"
            for name in (binary_name, index_name):
                self.input_sha256[name] = manifest["sha256"][name]
            binary = _verified_bytes(directory / binary_name, self.input_sha256[binary_name])
            tokens = np.frombuffer(binary, dtype="<u2")
            rows = _verified_bytes(directory / index_name, self.input_sha256[index_name]).splitlines()
            documents, stats = [], Counter()
            for line in rows:
                item = json.loads(line)
                doc = _Document(str(item["id"]), item["source"], tuple(item["source_group_key"]),
                                item["article_family_key"], item["token_offset"], item["tokens"])
                identity = doc.source, doc.id
                if (item["stratum"] != stratum or doc.source not in sources or identity in identities
                        or len(doc.source_group_key) != 2 or doc.source_group_key[0] != doc.source
                        or doc.source_group_key in groups
                        or (doc.article_family_key is not None and doc.article_family_key in families)):
                    raise ValueError(f"Invalid or duplicate development document: {identity}")
                if (doc.offset != stats["packed_tokens"] or doc.tokens < 2 or
                        doc.offset + doc.tokens > len(tokens) or int(tokens[doc.offset + doc.tokens - 1]) != eos_token_id):
                    raise ValueError(f"Invalid development token span: {identity}")
                windows = doc.windows()
                counts = {"documents": 1, "packed_tokens": doc.tokens, "windows": len(windows),
                          "input_positions": sum(length for _, length in windows), "scored_targets": doc.tokens - 1}
                if any(item[key] != counts[key] for key in ("windows", "input_positions", "scored_targets")):
                    raise ValueError(f"Frozen development window counts differ: {identity}")
                stats.update(counts)
                source_counts.setdefault(doc.source, Counter()).update(counts)
                identities.add(identity)
                groups.add(doc.source_group_key)
                if doc.article_family_key is not None:
                    families.add(doc.article_family_key)
                documents.append(doc)
            if (stats != manifest["validation_documents_by_stratum"][stratum] or stats["packed_tokens"] != len(tokens)
                    or not documents or int(np.count_nonzero(tokens == eos_token_id)) != len(documents)):
                raise ValueError(f"Frozen development stratum totals differ: {stratum}")
            self.strata[stratum] = (tokens, tuple(documents), dict(stats))
        if source_counts != manifest["validation_documents_by_source"]:
            raise ValueError("Frozen development source totals differ.")

    def evaluate(self, model: Any, *, device: str, output: Path, batch_size: int = 2,
                 progress_check: Callable[[], Any] | None = None) -> dict:
        import torch

        if output.exists():
            raise FileExistsError(f"Development output already exists: {output}")
        if batch_size < 1 or model.config.max_context_length < WINDOW:
            raise ValueError("Development scoring needs a positive batch and a 512-position context.")
        if any(int(tokens.max()) >= model.config.vocab_size for tokens, _, _ in self.strata.values()):
            raise ValueError("Frozen development tokens exceed the model vocabulary.")
        records, results = [], {}
        previous_mode = model.training
        model.eval()
        try:
            with torch.no_grad():
                for stratum, (tokens, docs, stats) in self.strata.items():
                    windows = [(number, offset, length) for number, doc in enumerate(docs)
                               for offset, length in doc.windows()]
                    # Group equal widths together without changing the stable report order.
                    windows.sort(key=lambda window: -window[2])
                    document_loss_terms: list[list[float]] = [[] for _ in docs]
                    for i in range(0, len(windows), batch_size):
                        if progress_check is not None:
                            progress_check()
                        batch = windows[i:i + batch_size]
                        losses = _score_batch(model, tokens, [(start, length) for _, start, length in batch],
                                              device=device, pad_token_id=self.pad_token_id)
                        for (number, _, _), loss in zip(batch, losses, strict=True):
                            if not math.isfinite(loss) or loss < 0:
                                raise ValueError("Non-finite or negative English development loss.")
                            document_loss_terms[number].append(loss)
                    doc_losses = [math.fsum(terms) for terms in document_loss_terms]
                    total_loss = math.fsum(doc_losses)
                    results[stratum] = {**stats, "loss_sum": total_loss, "mean_loss": total_loss / stats["scored_targets"]}
                    for doc, loss in zip(docs, doc_losses, strict=True):
                        records.append({"stratum": stratum, "source": doc.source, "id": doc.id,
                                        "source_group_key": doc.source_group_key, "article_family_key": doc.article_family_key,
                                        "scored_targets": doc.tokens - 1, "loss_sum": loss})
            if progress_check is not None:
                progress_check()
        finally:
            model.train(previous_mode)

        output.mkdir(parents=True, exist_ok=False)
        path = output / "per-document.jsonl"
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            for record in records:
                stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        summary = {"evaluation_input_sha256": self.manifest_sha256, "split_files_sha256": self.input_sha256,
                   "evaluation_code_sha256": _sha256(Path(__file__)),
                   "files": {path.name: _sha256(path)}, "strata": results,
                   "equal_weight_prose_loss": math.fsum(results[key]["mean_loss"]
                                                       for key in ("standard-wikipedia", "simplewiki")) / 2}
        _atomic_json(output / "manifest.json", summary)
        return summary
