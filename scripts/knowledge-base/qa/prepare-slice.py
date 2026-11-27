#!/usr/bin/env python3
"""Project a revision-pinned Wikidata slice for the public QA evaluation."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
from hashlib import sha256
from http.client import HTTPException
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


LOCK = Path(__file__).with_name('public-eval-lock.json')
API = 'https://www.wikidata.org/w/api.php'
SOURCE = 'https://www.wikidata.org/wiki/Special:EntityData'
HEADERS = {
    'User-Agent': 'Mohassan-Knowledge-QA/1.0 (https://github.com/ahmadalwakai/Mohassan-AI)',
    'Accept-Encoding': 'gzip',
}
CLASS_PROPERTIES = {'P31', 'P279'}
PATH_PROPERTIES = {'P17', 'P19', 'P36', 'P131'}
VALUE_PROPERTIES = PATH_PROPERTIES | {
    'P6', 'P20', 'P26', 'P27', 'P30', 'P35', 'P37', 'P38', 'P40', 'P50', 'P57', 'P58', 'P86', 'P101', 'P106', 'P108',
    'P112', 'P123', 'P127', 'P136', 'P137', 'P138', 'P150', 'P155', 'P156', 'P159', 'P161', 'P162', 'P170', 'P175',
    'P176', 'P178', 'P195', 'P264', 'P272', 'P276', 'P361', 'P364', 'P407', 'P414', 'P495', 'P509', 'P527', 'P551',
    'P571', 'P569', 'P570', 'P577', 'P582', 'P585', 'P607', 'P674', 'P740', 'P749', 'P800', 'P807',
    'P840', 'P1001', 'P1037', 'P1104', 'P1128', 'P1303', 'P1344', 'P1376', 'P1448', 'P1476', 'P1549', 'P1971', 'P2043', 'P2044',
    'P2046', 'P2047', 'P2048', 'P2067', 'P2250', 'P2257', 'P281', 'P463', 'P47', 'P61', 'P625',
    'P69', 'P737', 'P937', 'P1082', 'P166', 'P39', 'P22', 'P25', 'P2927', 'P3373', 'P576',
}
# Bound label expansion independently of any answer, while preserving all retained statements.
LABEL_PROPERTIES = PATH_PROPERTIES | {'P20', 'P27', 'P30', 'P37', 'P38', 'P50', 'P57', 'P112', 'P123', 'P138', 'P159', 'P170', 'P176'}
BATCH_SIZE = 8


def api(params):
    query = urlencode({**params, 'format': 'json', 'formatversion': 2, 'maxlag': 5})
    request = Request(f'{API}?{query}', headers=HEADERS)
    for attempt in range(5):
        try:
            with urlopen(request, timeout=45) as response:
                raw = response.read()
                if response.headers.get('Content-Encoding') == 'gzip':
                    raw = gzip.decompress(raw)
                result = json.loads(raw)
                if 'error' not in result:
                    return result
                if result['error']['code'] != 'maxlag':
                    raise ValueError(result['error'])
                delay = 5
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            delay = int(error.headers.get('Retry-After', 2 ** attempt))
        except (URLError, TimeoutError, HTTPException):
            if attempt == 4:
                raise
            delay = 2 ** attempt
        time.sleep(min(delay, 30))
    raise RuntimeError('Wikidata API maxlag retries exhausted')


def qid_order(value):
    return int(value[1:])


def lookup_current(ids):
    try:
        response = api({
            'action': 'wbgetentities', 'ids': '|'.join(ids), 'redirects': 'yes', 'languages': 'en|ar',
            'props': 'labels|aliases|descriptions|claims|info|sitelinks',
        })
    except (HTTPException, URLError, TimeoutError):
        if len(ids) == 1:
            raise
        middle = len(ids) // 2
        return lookup_current(ids[:middle]) | lookup_current(ids[middle:])
    entities = response['entities']
    redirects = {redirect['from']: redirect['to'] for redirect in response.get('redirects', [])}
    return {qid: entities.get(redirects.get(qid, qid)) for qid in ids}


def lookup_revisions(revisions):
    try:
        response = api({
            'action': 'query', 'prop': 'revisions', 'revids': '|'.join(map(str, revisions)),
            'rvprop': 'ids|content', 'rvslots': 'main',
        })
    except (HTTPException, URLError, TimeoutError):
        if len(revisions) == 1:
            raise
        middle = len(revisions) // 2
        yield from lookup_revisions(revisions[:middle])
        yield from lookup_revisions(revisions[middle:])
        return
    for page in response['query']['pages']:
        for revision in page['revisions']:
            main = revision['slots']['main']
            if main['contentmodel'] != 'wikibase-item':
                raise ValueError(f"Revision {revision['revid']} is not an item")
            entity = json.loads(main['content'])
            yield {**entity, 'type': 'item', 'lastrevid': revision['revid']}


def batches(values):
    for start in range(0, len(values), BATCH_SIZE):
        yield values[start:start + BATCH_SIZE]


def canonical_snaks(value):
    if isinstance(value, list):
        return [canonical_snaks(item) for item in value]
    if isinstance(value, dict):
        # MediaWiki's pinned raw revisions omit optional property metadata. The
        # snak's datavalue type, ID, payload, qualifiers and references remain.
        return {key: canonical_snaks(item) for key, item in value.items()
                if key != 'datatype' or 'snaktype' not in value}
    return value


def project(entity, role):
    projected = {field: entity[field] for field in ('id', 'type', 'lastrevid')}
    for field in ('labels', 'descriptions', 'aliases'):
        terms = entity.get(field, {})
        projected[field] = {lang: terms[lang] for lang in ('ar', 'en') if lang in terms}
    # Sitelink site IDs are sufficient for the importer's popularity count.
    projected['sitelinks'] = {site: {} for site in entity.get('sitelinks', {})}
    if role == 'subjects':
        allowed = CLASS_PROPERTIES | VALUE_PROPERTIES
    else:
        allowed = CLASS_PROPERTIES
    claims = entity.get('claims') or {}
    projected['claims'] = {key: canonical_snaks(value) for key, value in claims.items() if key in allowed}
    return projected


def targets(entities, properties):
    ids = set()
    for entity in entities:
        for prop in properties:
            for claim in entity.get('claims', {}).get(prop, []):
                value = claim['mainsnak'].get('datavalue', {})
                if claim['rank'] == 'deprecated' or value.get('type') != 'wikibase-entityid':
                    continue
                item = value['value']
                if item.get('entity-type') == 'item':
                    ids.add(f"Q{item['numeric-id']}")
    return ids


def freeze_slice(directory, extra_seeds, lock):
    rows = []
    for name, fingerprint in lock['questions'].items():
        content = (directory / name).read_bytes()
        if sha256(content).hexdigest() != fingerprint:
            raise ValueError(f'{name} differs from its frozen SHA-256')
        rows.extend(json.loads(line) for line in content.splitlines())
    seed_ids = {seed for row in rows for seed in row['seeds']} | set(extra_seeds)
    entities, roles = {}, {}
    attempted = set()
    cache = directory / 'wikidata-cache'
    cache.mkdir(exist_ok=True)

    with ThreadPoolExecutor(max_workers=3) as pool:
        def fetch(ids, role):
            # Keep earlier, richer projections when an item plays several roles.
            todo = sorted(ids - attempted, key=qid_order)
            attempted.update(todo)
            loaded = []
            for qid in todo:
                path = cache / f'{qid}.json'
                if path.exists():
                    entity = json.loads(path.read_bytes())
                    if entity:
                        loaded.append(entity)
            pending = [qid for qid in todo if not (cache / f'{qid}.json').exists()]
            for payload in pool.map(lookup_current, batches(pending)):
                for qid, entity in payload.items():
                    if entity and entity.get('type') != 'item':
                        entity = None
                    (cache / f'{qid}.json').write_text(json.dumps(entity, ensure_ascii=False), encoding='utf-8')
                    if entity:
                        loaded.append(entity)
            added = []
            for entity in loaded:
                qid = entity['id']
                if qid in entities:
                    continue
                entities[qid] = project(entity, role)
                roles[qid] = role
                added.append(entities[qid])
            print(f'{role}: requested {len(todo)}, added {len(added)}', flush=True)
            return added

        first = fetch(seed_ids, 'subjects')
        places = fetch(targets(first, PATH_PROPERTIES), 'subjects')
        locations = fetch(targets(places, {'P17', 'P36'}), 'subjects')
        labels = fetch(targets(first + places + locations, LABEL_PROPERTIES), 'labels')
        classes = fetch(targets(first + places + locations + labels, CLASS_PROPERTIES), 'classes')
        for _ in range(7):
            if not classes:
                break
            classes = fetch(targets(classes, {'P279'}), 'classes')

    snapshot = datetime.now(timezone.utc).date().isoformat()
    identity = {
        'date': snapshot, 'source': SOURCE, 'license': 'CC0-1.0',
        'seeds': len(seed_ids), 'requested': len(attempted),
        'revisions': {role: {qid: entities[qid]['lastrevid'] for qid in sorted(entities, key=qid_order) if roles[qid] == role}
                      for role in ('subjects', 'labels', 'classes')},
    }
    return entities, identity


def reproduce(directory, identity):
    roles = {revision: (role, qid) for role, group in identity['revisions'].items()
             for qid, revision in group.items()}
    cache = directory / 'wikidata-revisions'
    cache.mkdir(exist_ok=True)
    entities = {}
    pending = []
    for revision, (role, qid) in roles.items():
        path = cache / f'{revision}.json'
        if path.exists():
            entities[qid] = json.loads(path.read_bytes())
            continue
        original = directory / 'wikidata-cache' / f'{qid}.json'
        if original.exists():
            entity = json.loads(original.read_bytes())
            if entity and entity['lastrevid'] == revision and entity['id'] == qid:
                entities[qid] = project(entity, role)
                continue
        pending.append(revision)
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(lambda batch: list(lookup_revisions(batch)), batches(pending)):
            for entity in result:
                revision = entity['lastrevid']
                if revision not in roles or roles[revision][1] != entity.get('id'):
                    raise ValueError(f'Unexpected Wikidata entity revision {revision}')
                role, qid = roles[revision]
                entities[qid] = project(entity, role)
                (cache / f'{revision}.json').write_text(json.dumps(entities[qid], ensure_ascii=False), encoding='utf-8')
    missing = {qid for _, qid in roles.values()} - entities.keys()
    if missing:
        raise ValueError(f'Missing pinned Wikidata revisions for {sorted(missing, key=qid_order)}')
    return entities


def write_lock(path, lock):
    lines, revision_lines = [], []
    for line in json.dumps(lock, indent=2).splitlines():
        if line.startswith('        "Q'):
            revision_lines.append(line.strip())
            if len(revision_lines) < 5:
                continue
        if revision_lines:
            lines.append('        ' + ' '.join(revision_lines))
            revision_lines.clear()
        if not line.startswith('        "Q'):
            lines.append(line)
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--freeze', action='store_true', help='Initialize entity revision pins for a new evaluation protocol')
    parser.add_argument('--lock', type=Path, default=LOCK, help='Separate revision lock for a scratch experiment')
    parser.add_argument('--extra-seeds', type=Path, help='Newline-separated QIDs for a scratch experiment')
    args = parser.parse_args()
    if args.extra_seeds and (not args.freeze or args.lock.resolve() == LOCK.resolve()):
        parser.error('--extra-seeds requires --freeze and a separate --lock')
    if args.lock.exists():
        lock = json.loads(args.lock.read_bytes())
    elif args.freeze:
        lock = {'questions': {}}
    else:
        parser.error('Revision lock does not exist')
    args.directory.mkdir(parents=True, exist_ok=True)
    if args.freeze:
        if 'wikidata' in lock:
            raise ValueError('The Wikidata slice is already frozen')
        extra_seeds = args.extra_seeds.read_text().split() if args.extra_seeds else []
        if any(not re.fullmatch(r'Q[1-9][0-9]*', seed) for seed in extra_seeds):
            raise ValueError('Extra seeds must contain Wikidata item QIDs')
        if not extra_seeds and not lock['questions']:
            raise ValueError('Use the public question split or provide a scratch seed list')
        entities, identity = freeze_slice(args.directory, extra_seeds, lock)
    else:
        identity = lock['wikidata']
        entities = reproduce(args.directory, identity)
    output = args.directory / 'wikidata-slice.json'
    content = '[\n' + ',\n'.join(json.dumps(entities[qid], sort_keys=True, ensure_ascii=False, separators=(',', ':'))
                                for qid in sorted(entities, key=qid_order)) + '\n]\n'
    payload = content.encode('utf-8')
    fingerprint = sha256(payload).hexdigest()
    if args.freeze:
        identity['sha256'] = fingerprint
        lock['wikidata'] = identity
        write_lock(args.lock, lock)
    elif fingerprint != identity['sha256']:
        raise ValueError('Projected Wikidata slice differs from the frozen SHA-256')
    output.write_bytes(payload)
    print(json.dumps({key: value for key, value in identity.items() if key != 'revisions'} | {'entities': len(entities)}))


if __name__ == '__main__':
    main()
