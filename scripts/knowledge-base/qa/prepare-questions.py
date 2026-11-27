#!/usr/bin/env python3
"""Recreate the bilingual public QA question split from pinned primary sources."""

import argparse
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen


SOURCES = {
    'mintaka-test.json': (
        'https://raw.githubusercontent.com/amazon-science/mintaka/'
        'b6146ffb41562803c45df3c028b4cdad8c09dd4d/data/mintaka_test.json',
        'd2c94a7363d6374c67dacec3bd0ff26ab47c974d9fc5d85de91b555a89163221',
    ),
    'qald-10.json': (
        'https://raw.githubusercontent.com/KGQA/QALD-10/'
        '89caa86371c7a65c6c87a64e0eeaa0e247ff5fe5/data/qald_10/qald_10.json',
        '55720cbc9effb250f4b814a9c27ce5f5d61d863d5943bc8aa93773f6f761c6cc',
    ),
}
LOCK = Path(__file__).with_name('public-eval-lock.json')
SALT = 'mohassan-knowledge-qa-public-v1'
DEV_PER_TYPE = 8
HELD_OUT_PER_TYPE = 16
QID = re.compile(r'Q[1-9][0-9]*')
DATE = re.compile(r'([+-]?[0-9]{1,16})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T00:00:00Z)?')


def read_source(directory, name):
    url, digest = SOURCES[name]
    path = directory / name
    if path.exists():
        content = path.read_bytes()
    else:
        request = Request(url, headers={'User-Agent': 'Mohassan-Knowledge-QA/1.0'})
        with urlopen(request, timeout=60) as response:
            content = response.read()
    if sha256(content).hexdigest() != digest:
        raise ValueError(f'Unexpected source checksum for {name}')
    if not path.exists():
        path.write_bytes(content)
    return json.loads(content)


def valid_values(kind, values):
    if not values:
        return False
    checks = {
        'entity': lambda value: isinstance(value, str) and bool(QID.fullmatch(value)),
        'date': lambda value: isinstance(value, str) and bool(DATE.fullmatch(value)),
        'quantity': lambda value: type(value) in (int, float) or (
            isinstance(value, str) and bool(re.fullmatch(r'[+-]?[0-9]+(?:\.[0-9]+)?', value))),
        'boolean': lambda value: isinstance(value, bool),
        'text': lambda value: isinstance(value, str) and bool(value.strip()),
    }
    return kind in checks and all(checks[kind](value) for value in values)


def mintaka_rows(source):
    for item in source:
        kind = {'numerical': 'quantity', 'string': 'text'}.get(
            item['answer']['answerType'], item['answer']['answerType'])
        values = item['answer']['answer']
        if kind == 'entity' and values:
            values = [value.get('name') for value in values]
        ar = item['translations'].get('ar')
        if not ar or not valid_values(kind, values):
            continue
        seeds = {entity['name'] for entity in item['questionEntity']
                 if entity['entityType'] == 'entity' and QID.fullmatch(entity['name'] or '')}
        yield {
            'dataset': 'mintaka', 'id': item['id'], 'type': item['complexityType'],
            'questions': {'en': item['question'], 'ar': ar},
            'gold': {'kind': kind, 'values': values}, 'seeds': sorted(seeds),
        }


def qald_type(query):
    if re.search(r'\bASK\b', query, re.I):
        return 'yesno'
    if re.search(r'\bCOUNT\s*\(', query, re.I):
        return 'count'
    if re.search(r'\bORDER\s+BY\b', query, re.I) and re.search(r'\bLIMIT\s+1\b', query, re.I):
        return 'superlative'
    if re.search(r'\bpq:P\d+\b', query):
        return 'qualified'
    if len(re.findall(r'\b(?:wdt|p|ps):P\d+\b', query)) > 1:
        return 'multirelation'
    return 'lookup'


def qald_value(value):
    text = value['value']
    if value['type'] == 'uri':
        match = re.fullmatch(r'https?://www\.wikidata\.org/entity/(Q[1-9][0-9]*)', text)
        return ('entity', match[1]) if match else None
    if value['type'] != 'literal':
        return None
    kind = {
        'integer': 'quantity', 'decimal': 'quantity', 'dateTime': 'date', 'date': 'date', '': 'text',
    }.get(value.get('datatype', '').removeprefix('http://www.w3.org/2001/XMLSchema#'))
    return (kind, text) if kind else None


def qald_gold(answer):
    if 'boolean' in answer:
        return ('boolean', [answer['boolean']])
    bindings = answer.get('results', {}).get('bindings', [])
    variables = answer['head']['vars']
    if len(variables) != 1 or not bindings:
        return None
    variable = variables[0]
    typed = [qald_value(binding[variable]) if variable in binding else None for binding in bindings]
    if any(value is None for value in typed) or len({value[0] for value in typed}) != 1:
        return None
    return (typed[0][0], [value[1] for value in typed])


def qald_rows(source):
    for item in source['questions']:
        result = qald_gold(item['answers'][0])
        if result is None or not valid_values(*result):
            continue
        query = item['query']['sparql']
        en = next(question['string'] for question in item['question'] if question['language'] == 'en')
        seeds = re.findall(r'\bwd:(Q[1-9][0-9]*)\b|<https?://www\.wikidata\.org/entity/(Q[1-9][0-9]*)>', query)
        yield {
            'dataset': 'qald-10', 'id': str(item['id']), 'type': qald_type(query),
            'questions': {'en': en},
            'gold': {'kind': result[0], 'values': result[1]},
            'seeds': sorted({left or right for left, right in seeds}),
        }


def rank(row):
    return sha256(f"{SALT}:{row['dataset']}:{row['id']}".encode()).digest()


def select(rows):
    by_type = defaultdict(list)
    for row in rows:
        by_type[row['dataset'], row['type']].append(row)
    dev, held_out = [], []
    seen = set()
    for group in sorted(by_type):
        unique = []
        for row in sorted(by_type[group], key=rank):
            keys = {(lang, ' '.join(text.casefold().split()).rstrip('?.؟'))
                    for lang, text in row['questions'].items()}
            if keys & seen:
                continue
            seen.update(keys)
            unique.append(row)
        dev_count = min(DEV_PER_TYPE, len(unique) // 3)
        dev.extend(unique[:dev_count])
        held_out.extend(unique[dev_count:dev_count + HELD_OUT_PER_TYPE])
    return dev, held_out


def json_lines(rows):
    return ''.join(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n'
                   for row in rows).encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--freeze', action='store_true', help='Initialize split digests for a new protocol version')
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    dev, held_out = select([
        *mintaka_rows(read_source(args.directory, 'mintaka-test.json')),
        *qald_rows(read_source(args.directory, 'qald-10.json')),
    ])
    lock_path = LOCK
    lock = json.loads(lock_path.read_text()) if lock_path.exists() else {}
    if args.freeze and 'questions' in lock:
        raise ValueError('The split is already frozen')
    outputs = {'dev.jsonl': json_lines(dev), 'held-out.jsonl': json_lines(held_out)}
    fingerprints = {name: sha256(content).hexdigest() for name, content in outputs.items()}
    if args.freeze:
        lock['questions'] = fingerprints
        lock_path.write_text(json.dumps(lock, indent=2) + '\n')
    elif lock.get('questions') != fingerprints:
        raise ValueError('The prepared question split differs from the frozen SHA-256')
    for name, content in outputs.items():
        (args.directory / name).write_bytes(content)
    print(json.dumps({'questions': {'dev': len(dev), 'held-out': len(held_out)}, 'sha256': fingerprints}))


if __name__ == '__main__':
    main()
