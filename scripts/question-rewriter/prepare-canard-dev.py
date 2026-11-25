"""Apply the capability v2 exclusion registry to the official CANARD dev split."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


DEV_SHA256 = "fafd9f53be0684fd33f85f6bf12a63e61b835ecb9e987c9bd2186149366ce2e5"
AUDIT_MODULE = Path("scripts/agent-capability-bench/v2")
AUDIT_MANIFEST = Path("tests/fixtures/agent-capability-bench/v2/exclusion/manifest.json")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Official CANARD dev.json")
    parser.add_argument("--audit-root", type=Path, required=True, help="Local v2 contamination audit checkout")
    parser.add_argument("--output", type=Path, required=True, help="New filtered JSON file outside the feature checkout")
    args = parser.parse_args()

    sys.path.insert(0, str(args.audit_root.resolve() / AUDIT_MODULE))
    from exclusion import Exclusions

    manifest = args.audit_root / AUDIT_MANIFEST
    exclusions = Exclusions.load(manifest)
    data = args.input.read_bytes()
    if hashlib.sha256(data).hexdigest() != DEV_SHA256:
        raise SystemExit("Expected the original CANARD dev.json member from the official release.")

    rows = json.loads(data)
    retained = []
    for row in rows:
        source_id = f"canard:{row['QuAC_dialog_id']}:{row['Question_no']}"
        reference = row["Rewrite"]
        without_ending_punctuation = re.sub(r"[.!?؟]+$", "", reference.strip()).rstrip()
        texts = (row["Question"], *row["History"], reference, without_ending_punctuation)
        if not exclusions.matches(texts, source_id=source_id):
            retained.append(row)

    receipt = {
        "sourceSha256": DEV_SHA256,
        "exclusionManifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "input": len(rows),
        "dropped": len(rows) - len(retained),
        "retained": len(retained),
    }
    with args.output.open("x", encoding="utf-8") as output:
        json.dump({"receipt": receipt, "rows": retained}, output, ensure_ascii=False)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
