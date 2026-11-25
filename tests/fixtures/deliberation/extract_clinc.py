"""Extract the benchmark from a local, pinned copy of CLINC150 data_full.json."""

import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata


SOURCE_SHA256 = '36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0'
SOURCE_REVISION = '828f8093932c8fe6ca7936c3d2e52903b1c523de'


DIRECT_ROUTES = {
    'greeting': 'chat',
    'goodbye': 'chat',
    'thank_you': 'chat',
    'what_is_your_name': 'chat',
    'date': 'compute',
    'definition': 'web_search',
    'calories': 'web_search',
    'nutrition_info': 'web_search',
}


def expected_decision(text, intent):
    if intent in DIRECT_ROUTES:
        return {'kind': 'act', 'route': DIRECT_ROUTES[intent]}
    if intent == 'who_made_you':
        if re.search(r'\b(?:you|your|ai)\b', text):
            return {'kind': 'act', 'route': 'chat'}
        return {'kind': 'ask'}
    if intent == 'calculator':
        if text in {'help me solve this math equation', 'i need your assistance to solve this math problem'}:
            return {'kind': 'ask'}
        if not re.search(r'\b(?:derivative|factor|ask the ai)\b', text):
            return {'kind': 'act', 'route': 'compute'}
    if intent == 'weather':
        if re.search(r'\b(?:atlanta|tokyo|wisconsin|seattle|austin|las vegas)\b', text):
            return {'kind': 'act', 'route': 'web_search'}
        return {'kind': 'ask'}
    if intent == 'exchange_rate':
        if re.search(r'\bcountry [ab]\b', text):
            return {'kind': 'ask'}
        return {'kind': 'act', 'route': 'web_search'}
    if intent == 'next_song':
        return {'kind': 'abstain'}
    if intent == 'freeze_account' and not text.startswith('how '):
        return {'kind': 'abstain'}
    if intent == 'text' and not text.startswith('write a text '):
        return {'kind': 'abstain'}
    return None


def extract(source):
    splits = {'benchmark': ('test', []), 'development': ('val', [])}
    seen = set()
    for partition, (original_split, rows) in splits.items():
        for offset, (text, intent) in enumerate(source[original_split]):
            expected = expected_decision(text, intent)
            fingerprint = ' '.join(unicodedata.normalize('NFKC', text).casefold().split())
            if expected is None or fingerprint in seen:
                continue
            seen.add(fingerprint)
            rows.append({'id': f'clinc-{original_split}-{offset}', 'text': text, 'intent': intent, 'expected': expected})
    return {
        'source': 'CLINC150 (human crowdsourced, 2019)',
        'sourceRevision': SOURCE_REVISION,
        'sourceSha256': SOURCE_SHA256,
        'purpose': 'Decision calibration and benchmark only; excluded from training.',
        **{partition: rows for partition, (_, rows) in splits.items()},
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python tests/fixtures/deliberation/extract_clinc.py /path/to/data_full.json')
    data = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise SystemExit('The CLINC150 input does not match the pinned upstream file.')
    target = Path(__file__).with_name('clinc150.json')
    content = extract(json.loads(data))
    fields = []
    for key, value in content.items():
        if isinstance(value, list):
            rows = ',\n'.join('    ' + json.dumps(row, ensure_ascii=False) for row in value)
            fields.append(f'  "{key}": [\n{rows}\n  ]')
        else:
            fields.append(f'  "{key}": {json.dumps(value, ensure_ascii=False)}')
    target.write_text('{\n' + ',\n'.join(fields) + '\n}\n', encoding='utf-8')
    print(f"{len(content['development'])} development rows, {len(content['benchmark'])} benchmark rows")


if __name__ == '__main__':
    main()
