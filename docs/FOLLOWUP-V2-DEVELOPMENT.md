# Follow-up understanding development evaluation

## Diagnosis and held-back split

The split uses only `id` and `area` from the pinned V2 development payload published in [PR #62](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) at `12cedfe592aab40cdd47ee00d05ea86a6d2bae89`. Select the 240 unique IDs whose area is `follow-up`. Sort the IDs by the ascending SHA-256 digest of their UTF-8 bytes, using the ID itself as a tie-breaker. The first 120 form D and the next 120 form H. Hash each ordered list as one UTF-8 ID per line with a final LF.

| Split | IDs | SHA-256 of ID list |
| --- | ---: | --- |
| D (diagnosis) | 120 | `081dc737f61f9b7c0a4b23f656903d65f2e9b13cd57de70a312fce9e78f770f9` |
| H (held back) | 120 | `f0b6635d69eaaef6f61231fbece5d61721dd1e75765707d737cfbfe87108a4e0` |

```bash
git show 12cedfe592aab40cdd47ee00d05ea86a6d2bae89:tests/fixtures/agent-capability-bench/v2/dev/payload.json | python3 -B -c '
from hashlib import sha256
import json
import sys

ids = [row["id"] for row in json.load(sys.stdin)["cases"] if row["area"] == "follow-up"]
assert len(ids) == len(set(ids)) == 240
ids.sort(key=lambda case_id: (sha256(case_id.encode("utf-8")).digest(), case_id))
for label, group in (("D", ids[:120]), ("H", ids[120:])):
    encoded = "".join(case_id + "\n" for case_id in group).encode("utf-8")
    print(label, len(group), sha256(encoded).hexdigest())
'
```
