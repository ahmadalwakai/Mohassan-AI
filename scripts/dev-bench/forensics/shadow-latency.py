#!/usr/bin/env python3
"""Extract nearest-rank latency from a fresh production-model-relations journal."""

import json
import math
from pathlib import Path
import sys


def stats(values):
    values.sort()
    count = len(values)
    return {
        'count': count,
        'p50Ms': values[math.ceil(count * 0.5) - 1] if count else None,
        'p95Ms': values[math.ceil(count * 0.95) - 1] if count else None,
    }


if len(sys.argv) < 2:
    raise SystemExit('Usage: python3 -B wave5-shadow-latency.py JOURNAL [JOURNAL ...]')

publication = []
background = []
for name in sys.argv[1:]:
    with Path(name).open(encoding='utf-8') as stream:
        for line in stream:
            entry = json.loads(line)
            duration = entry['schedulingMs']
            if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                raise SystemExit(f'Invalid publication latency in {name}')
            publication.append(duration)
            background.extend(
                decision['elapsedMs']
                for decision in entry.get('arbiter') or []
                if math.isfinite(decision['elapsedMs'])
            )

if not publication:
    raise SystemExit('No publication records')
result = {'publication': stats(publication), 'backgroundArbitration': stats(background)}
print(json.dumps(result, indent=2, allow_nan=False))
raise SystemExit(result['publication']['p95Ms'] > 1)
