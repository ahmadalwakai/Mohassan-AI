"""Compare unchanged development handlers with case-scoped fixture UUID entropy."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("repo", type=Path)
parser.add_argument("baseline", type=Path)
parser.add_argument("candidate", type=Path)
parser.add_argument("selection", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
repo = args.repo.resolve(strict=True)
selection = args.selection.resolve(strict=True)
output = args.output.resolve()
if output.is_relative_to(repo):
    raise ValueError("Write controlled replay receipts outside the product checkout")
sys.path.insert(0, str(repo / "scripts/dev-bench"))
import runner


def write(path, value):
    with open(path, "x", encoding="utf8", opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def arm(receipt_path, target):
    receipt = json.loads(receipt_path.read_bytes())
    commit = receipt["commit"]
    expected = receipt["source"]
    observed_inputs = {}
    product_hash = runner.hash_product(repo, commit)
    assert product_hash == expected["inputs"]["product/git-archive.tar"]
    target.mkdir(mode=0o700)
    replay_source = Path(__file__).resolve().with_name("replay.mjs")
    with TemporaryDirectory(prefix="checkout-", dir=target) as name:
        temporary = Path(name)
        checkout = temporary / "product"
        environment, settings = runner.collect_environment(expected["settings"], temporary)
        assert settings == expected["settings"]
        runner.git(repo, "worktree", "add", "--detach", "--no-checkout", str(checkout), commit)
        try:
            patterns = ("/*", *(f"!/{path}/" for path in runner.HOLDOUTS))
            runner.git(checkout, "sparse-checkout", "set", "--no-cone", "--stdin",
                       input_bytes=("\n".join(patterns) + "\n").encode())
            runner.git(checkout, "checkout", "--detach")
            observed_inputs["product/package-lock.json"] = runner.digest(checkout / "package-lock.json")
            install = ["npm", "ci", "--no-audit", "--no-fund", "--offline"]
            runner.run_logged(install, checkout, environment | {"npm_config_cache": os.environ["npm_config_cache"]},
                              target / "npm-ci.log")
            toolchain = runner.toolchain(checkout, environment, observed_inputs)
            assert all(value == expected["toolchain"][key] for key, value in toolchain.items())

            for version, revision, harness, payload in (
                ("v1", runner.V1_BUNDLE, runner.COMMON,
                 (f"{runner.FIXTURES}/manifest.json", f"{runner.FIXTURES}/development.json")),
                ("v2", runner.AUDIT, runner.V2_HARNESS, (runner.V2_DEV,)),
            ):
                installed = runner.install_inputs(repo, checkout, revision,
                                                  tuple(f"{runner.BENCH}/{file}" for file in harness),
                                                  observed_inputs, version)
                installed += runner.install_inputs(repo, checkout, revision, payload, observed_inputs, version)
                adapter = f"{runner.BENCH}/by-branch.mjs"
                installed += runner.install_inputs(repo, checkout, runner.ADAPTERS, (adapter,), observed_inputs, version)
                observer = checkout / runner.BENCH / "observe.ts"
                subprocess.run(["node", "--input-type=module", "-e", runner.APPLY_ADAPTERS, "dev-bench-adapter",
                                str(checkout / adapter), str(observer), version],
                               cwd=checkout, env=environment, check=True)
                observed_inputs[f"{version}/effective/observe.ts"] = runner.digest(observer)
                assert not any((checkout / path).exists() for path in runner.HOLDOUTS)
                assert all(value == expected["inputs"][key] for key, value in observed_inputs.items())

                control = checkout / runner.BENCH / "controlled-uuid-replay.mjs"
                control.write_bytes(replay_source.read_bytes())
                raw = target / f"{version}.json"
                runner.run_logged(["node", *runner.NODE_OPTIONS, str(control), version, str(selection), str(raw)],
                                  checkout, environment, target / f"{version}.log")
                control.unlink()
                for mounted in installed:
                    mounted.unlink()
        finally:
            runner.git(repo, "worktree", "remove", "--force", str(checkout))
    return {
        "commit": commit, "productSha256": product_hash, "inputSha256": observed_inputs,
        "armReceiptSha256": runner.digest(receipt_path), "toolchain": toolchain, "settings": settings,
        "replayReceiptSha256": {version: runner.digest(target / f"{version}.json") for version in ("v1", "v2")},
    }


def compare(sources):
    versions = {}
    for version in ("v1", "v2"):
        native = []
        replay = []
        for side, source in sources.items():
            raw = (output / side / f"{version}.json").read_bytes()
            assert sha256(raw).hexdigest() == source["metadata"]["replayReceiptSha256"][version]
            replay.append(json.loads(raw)["evidence"])
            native_receipt = json.loads(source["path"].read_bytes())
            native.append({row["id"]: row["passed"] for row in native_receipt["versions"][version]["scores"]})
        rows = []
        for a, b in zip(*replay, strict=True):
            assert a["id"] == b["id"]
            case_id = a["id"]
            rows.append({
                "id": case_id, "verdictsMatchNative": a["passed"] == b["passed"] == native[0][case_id] == native[1][case_id],
                "exactReplyMatch": a["replySha256"] == b["replySha256"] and a["repliesSha256"] == b["repliesSha256"],
                "uuidCallCountsMatch": a["uuidCalls"] == b["uuidCalls"],
            })
        versions[version] = rows
    return versions


output.mkdir(mode=0o700, parents=True)
sources = {
    name: {"path": path, "metadata": arm(path, output / name)}
    for name, path in (("a", args.baseline.resolve()), ("b", args.candidate.resolve()))
}
versions = compare(sources)
report = {
    "toolSha256": {name: runner.digest(Path(__file__).resolve().with_name(name)) for name in ("replay.py", "replay.mjs")},
    "selectionSha256": runner.digest(selection),
    "arms": {side: source["metadata"] for side, source in sources.items()},
    "versions": versions,
}
write(output / "summary.json", report)
passed = True
for version, rows in versions.items():
    matches = sum(row["exactReplyMatch"] and row["verdictsMatchNative"] for row in rows)
    calls_match = sum(row["uuidCallCountsMatch"] for row in rows)
    passed &= matches == len(rows)
    print(f"{version}: {matches}/{len(rows)} exact full replies and original verdicts, "
          f"{calls_match}/{len(rows)} UUID call counts match")
raise SystemExit(0 if passed else 1)
