"""Measure overlap with the frozen capability v2 benchmark, keeping case IDs local."""

import argparse
from collections import Counter, defaultdict
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path

from exclusion import PARTITIONS, benchmark_texts, normalize_text, read_benchmark, source_id_key

METHODS = ("exact", "near", "id")
BRANCHES = (44, 47, 57)
NGRAM_SIZE = 5
THRESHOLD_NUMERATOR = 4
THRESHOLD_DENOMINATOR = 5
BAND_SIZE = 4
BANDS = 32
HASH_PRIME = 4_294_967_311


def minhash_parameters():
    for index in range(BANDS * BAND_SIZE):
        seed = hashlib.sha256(f"capability-v2-minhash:{index}".encode()).digest()
        multiplier = int.from_bytes(seed[:8], "big") % (HASH_PRIME - 1) + 1
        offset = int.from_bytes(seed[8:16], "big") % HASH_PRIME
        yield multiplier, offset


PERMUTATIONS = tuple(minhash_parameters())


def shingles(text):
    return frozenset(text[index:index + NGRAM_SIZE] for index in range(len(text) - NGRAM_SIZE + 1))


@lru_cache(maxsize=32768)
def gram_hash(gram):
    return int.from_bytes(hashlib.blake2s(gram.encode(), digest_size=4).digest(), "big")


@lru_cache(maxsize=4096)
def minhash_bands(grams):
    hashes = tuple(gram_hash(gram) for gram in grams)
    signature = [min((a * value + b) % HASH_PRIME for value in hashes) for a, b in PERMUTATIONS]
    return tuple(tuple(signature[i:i + BAND_SIZE]) for i in range(0, len(signature), BAND_SIZE))


def prefix_size(size):
    required = (THRESHOLD_NUMERATOR * size + THRESHOLD_DENOMINATOR - 1) // THRESHOLD_DENOMINATOR
    return size - required + 1


def gram_overlap(left, right):
    intersection = len(left & right)
    union = len(left) + len(right) - intersection
    return intersection, union


class TextIndex:
    def __init__(self, partitions):
        self.exact = defaultdict(set)
        self.ids = defaultdict(set)
        self.case_sources = {}
        for partition, cases in partitions.items():
            for case in cases:
                key = (partition, case["id"])
                provenance = case["provenance"]["source"]
                self.ids[source_id_key(provenance)].add(key)
                self.case_sources[key] = provenance.split(":", 1)[0]
                for raw in benchmark_texts(case):
                    text = normalize_text(raw)
                    if text:
                        self.exact[text].add(key)

        self.grams = {text: shingles(text) for text in self.exact if len(text) >= NGRAM_SIZE}
        frequencies = Counter(gram for grams in self.grams.values() for gram in grams)
        self.frequencies = frequencies
        self.prefixes = defaultdict(list)
        for text, grams in self.grams.items():
            for gram in self.prefix(grams):
                self.prefixes[gram].append(text)

    def prefix(self, grams):
        return sorted(grams, key=lambda gram: (self.frequencies[gram], gram))[:prefix_size(len(grams))]

    def near(self, text):
        grams = shingles(text)
        if not grams:
            return frozenset(), 0, 0
        # Every pair at the Jaccard threshold shares a prefix gram in this common order.
        candidates = {candidate for gram in self.prefix(grams) for candidate in self.prefixes.get(gram, ())}
        band_matches, fallback = set(), set()
        minhash_pairs = 0
        minhash_misses = 0
        for candidate in candidates - {text}:
            other = self.grams[candidate]
            if min(len(grams), len(other)) * THRESHOLD_DENOMINATOR < max(len(grams), len(other)) * THRESHOLD_NUMERATOR:
                continue
            common, union = gram_overlap(grams, other)
            # Skip signature work well below the final threshold.
            if 4 * common < 3 * union:
                continue
            shares_band = any(left == right for left, right in zip(minhash_bands(grams), minhash_bands(other)))
            if common * THRESHOLD_DENOMINATOR < union * THRESHOLD_NUMERATOR:
                continue
            if shares_band:
                band_matches.update(self.exact[candidate])
                minhash_pairs += 1
            else:
                fallback.update(self.exact[candidate])
                minhash_misses += 1
        return frozenset(band_matches | fallback), minhash_pairs, minhash_misses


class Overlap:
    def __init__(self):
        self.rows = 0
        self.matches = {method: set() for method in METHODS}
        self.matched_training_rows = 0
        self.minhash_pairs = 0
        self.minhash_misses = 0

    def add(self, matches, minhash_pairs, misses):
        self.rows += 1
        self.minhash_pairs += minhash_pairs
        self.minhash_misses += misses
        for method, cases in matches.items():
            self.matches[method].update(cases)
        self.matched_training_rows += any(matches.values())

    def summary(self):
        return {
            "trainingRows": self.rows,
            "matchedTrainingRows": self.matched_training_rows,
            "minHashConfirmedPairs": self.minhash_pairs,
            "minHashMissPairs": self.minhash_misses,
            **{partition: self.counts(partition) for partition in PARTITIONS},
        }

    def count_cases(self, method):
        return self.matches[method] if method != "any" else set.union(*self.matches.values())

    def counts(self, partition):
        return {method: sum(part == partition for part, _ in self.count_cases(method)) for method in (*METHODS, "any")}


def add_rows(index, paths):
    groups = defaultdict(Overlap)
    totals = defaultdict(Overlap)
    roles = defaultdict(Overlap)
    near = lru_cache(maxsize=16384)(index.near)
    for path in paths:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                branch, source = row["branch"], row["source"]
                split, upstream_split = row["split"], row["upstream_split"]
                role = row["role"]
                if branch not in BRANCHES or role not in {"fit", "selection", "evaluation", "eligible"}:
                    raise ValueError("Unexpected training branch or row role")
                source_ids = {row["source_id"], *row.get("source_ids", ())} - {None, ""}
                texts = {normalize_text(text) for text in row["texts"]} - {""}
                matches = {method: set() for method in METHODS}
                for source_id in source_ids:
                    matches["id"].update(index.ids.get(source_id_key(source_id), ()))
                minhash_pairs = 0
                misses = 0
                for text in texts:
                    matches["exact"].update(index.exact.get(text, ()))
                    near_cases, pair_count, miss_count = near(text)
                    matches["near"].update(near_cases)
                    minhash_pairs += pair_count
                    misses += miss_count
                groups[(branch, source, upstream_split, split, role)].add(matches, minhash_pairs, misses)
                if role != "evaluation":
                    totals[branch].add(matches, minhash_pairs, misses)
                roles[(branch, role)].add(matches, minhash_pairs, misses)
    return groups, totals, roles


def audit(partitions, paths):
    index = TextIndex(partitions)
    groups, totals, roles = add_rows(index, paths)
    return {
        "benchmark": {
            partition: dict(sorted(Counter(source for (part, _), source in index.case_sources.items() if part == partition).items()))
            for partition in PARTITIONS
        },
        "byTrainingSource": [
            {"branch": branch, "source": source, "upstreamSplit": upstream, "split": split, "role": role, **overlap.summary()}
            for (branch, source, upstream, split, role), overlap in sorted(groups.items())
        ],
        "byRole": [
            {"branch": branch, "role": role, **overlap.summary()}
            for (branch, role), overlap in sorted(roles.items())
        ],
        "byBranch": {str(branch): overlap.summary() for branch, overlap in sorted(totals.items())},
        "sealedExcludedCaseIds": {
            str(branch): sorted(case for partition, case in totals[branch].count_cases("any") if partition == "sealed")
            for branch in (47, 57)
            if branch in totals
        },
        "sealedFitExcludedCaseIds": {
            str(branch): sorted(case for partition, case in roles[(branch, "fit")].count_cases("any") if partition == "sealed")
            for branch in (47, 57)
            if (branch, "fit") in roles
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=Path, nargs="+", required=True)
    parser.add_argument("--out", type=Path, required=True, help="New private output path outside version control")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    result = audit(read_benchmark(repo), args.rows)
    file = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(file, "w", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps(result["byBranch"], sort_keys=True))


if __name__ == "__main__":
    main()
