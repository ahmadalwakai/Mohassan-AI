import type { DefaultTreeAdapterTypes as Html } from 'parse5';
import { attrs, children, isElement } from './page.js';

type Entity = Record<string, unknown>;
interface SchemaEntity { data: Entity; key: string }
const schemaOrigin = /^https?:\/\/schema\.org(?:[/#]|$)/iu;
const MAX_NODES = 20_000;
const MAX_ENTITIES = 160;
const MAX_JSON_BYTES = 256 * 1024;

function entity(value: unknown): value is Entity {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaLocal(value: string): string {
  return value.replace(schemaOrigin, '');
}

function listStrings(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items.filter((item): item is string => typeof item === 'string');
}

export function schemaTypes(data: Entity): string[] {
  return listStrings(data['@type']).map(schemaLocal);
}

export function schemaProperty(data: Entity, name: string): unknown {
  return data[name] ?? data[`https://schema.org/${name}`] ?? data[`http://schema.org/${name}`];
}

export function schemaString(value: unknown): string | undefined {
  for (let depth = 0; depth < 16; depth++) {
    if (Array.isArray(value)) value = value.length === 1 ? value[0] : undefined;
    else if (entity(value)) value = value['@value'] ?? value['@id'];
    else if (typeof value === 'number') return String(value);
    else return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : undefined;
  }
}

export function htmlNodes(document: Html.Document): { node: Html.Element; key: string }[] {
  const nodes: ReturnType<typeof htmlNodes> = [];
  const stack: { node: Html.Node; key: string; depth: number }[] = [{ node: document, key: '', depth: 0 }];
  for (let visited = 0; stack.length && visited < MAX_NODES; visited++) {
    const current = stack.pop()!;
    if (current.depth > 80) continue;
    if (isElement(current.node)) nodes.push({ node: current.node, key: current.key });
    const nested = children(current.node);
    for (let index = nested.length - 1; index >= 0; index--) {
      const child = nested[index];
      stack.push({ node: child, key: `${current.key}/${child.nodeName}:${index}`, depth: current.depth + 1 });
    }
  }
  return nodes;
}

export function nodeText(node: Html.Node): string {
  let text = '';
  const stack = [node];
  for (let visited = 0; stack.length && visited < 160 && text.length < 512; visited++) {
    const current = stack.pop()!;
    if ('value' in current && typeof current.value === 'string') text += current.value.slice(0, 512 - text.length);
    const nested = children(current);
    for (let index = nested.length - 1; index >= 0; index--) stack.push(nested[index]);
  }
  return text.trim();
}

function schemaContext(value: unknown): boolean {
  const pending = [value];
  for (let index = 0; pending.length && index < 80; index++) {
    const current = pending.pop();
    if (typeof current === 'string' && schemaOrigin.test(current)) return true;
    if (Array.isArray(current)) pending.push(...current.slice(0, 16));
    else if (entity(current)) pending.push(current['@vocab']);
  }
  return false;
}

function jsonEntities(nodes: ReturnType<typeof htmlNodes>): SchemaEntity[] {
  const roots: { data: unknown; key: string; depth: number; scope?: boolean }[] = [];
  let remaining = MAX_JSON_BYTES;
  for (const { node, key } of nodes) {
    if (node.tagName !== 'script' || !/^application\/ld\+json(?:\s*;|$)/iu.test(attrs(node, 'type').trim())) continue;
    const json = children(node).find(child => child.nodeName === '#text');
    if (!json || !('value' in json) || typeof json.value !== 'string') continue;
    remaining -= Buffer.byteLength(json.value);
    if (remaining < 0) break;
    try { roots.push({ data: JSON.parse(json.value), key: `json:${key}`, depth: 0 }); }
    catch { /* A malformed block cannot supply structured evidence. */ }
  }
  const entities: SchemaEntity[] = [];
  const stack = roots.reverse();
  for (let visited = 0; stack.length && visited < MAX_NODES && entities.length < MAX_ENTITIES; visited++) {
    const { data, key, depth, scope } = stack.pop()!;
    if (depth > 80) continue;
    if (Array.isArray(data)) {
      for (let index = Math.min(data.length, MAX_NODES) - 1; index >= 0; index--) {
        stack.push({ data: data[index], key: `${key}/${index}`, depth: depth + 1, scope });
      }
    } else if (entity(data)) {
      const ownScope = data['@context'] === undefined ? scope : schemaContext(data['@context']);
      const typed = listStrings(data['@type']);
      if ((typed.length || typeof data['@id'] === 'string') &&
          (ownScope !== false || typed.some(type => schemaOrigin.test(type)))) entities.push({ data, key });
      const entries = Object.entries(data).filter(([name]) => name !== '@context');
      for (let index = entries.length - 1; index >= 0; index--) {
        const [name, value] = entries[index];
        if (Array.isArray(value) || entity(value)) stack.push({ data: value, key: `${key}/${name.slice(0, 80)}`, depth: depth + 1, scope: ownScope });
      }
    }
  }
  return entities;
}

function microdataValue(node: Html.Element): string {
  // Element value rules from the HTML microdata specification.
  if (node.tagName === 'meta') return attrs(node, 'content');
  if (['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video'].includes(node.tagName)) return attrs(node, 'src');
  if (['a', 'area', 'link'].includes(node.tagName)) return attrs(node, 'href');
  if (node.tagName === 'object') return attrs(node, 'data');
  if (['data', 'meter'].includes(node.tagName)) return attrs(node, 'value');
  if (node.tagName === 'time') return attrs(node, 'datetime') || nodeText(node);
  return nodeText(node);
}

function putMicrodata(scope: Entity, properties: string[], value: unknown) {
  for (const property of properties.slice(0, 12)) {
    if (property.startsWith('@')) continue;
    const name = schemaLocal(property);
    const current = scope[name];
    scope[name] = current === undefined ? value : Array.isArray(current) ? [...current.slice(-15), value] : [current, value];
  }
}

function microdataEntities(nodes: ReturnType<typeof htmlNodes>): SchemaEntity[] {
  const entities: SchemaEntity[] = [];
  const scopes = new Map<Html.Element, Entity | null>();
  const references: { scope: Entity; ids: string[] }[] = [];
  const elementIds = new Map<string, Html.Element>();
  for (const { node, key } of nodes) {
    const id = attrs(node, 'id');
    if (id && !elementIds.has(id)) elementIds.set(id, node);
    const parent = node.parentNode;
    const inherited = parent && isElement(parent) ? scopes.get(parent) : undefined;
    const scope = node.attrs.some(attribute => attribute.name === 'itemscope');
    const types = attrs(node, 'itemtype').split(/\s+/u).filter(Boolean);
    const properties = attrs(node, 'itemprop').split(/\s+/u).filter(Boolean);
    let own: Entity | null | undefined = inherited;
    if (scope) {
      own = (!types.length && inherited || types.some(type => schemaOrigin.test(type))) ? Object.create(null) as Entity : null;
      if (own) {
        own['@type'] = types;
        own['@id'] = attrs(node, 'itemid') || undefined;
        if (entities.length < MAX_ENTITIES) {
          entities.push({ data: own, key: `microdata:${key}` });
          const ids = attrs(node, 'itemref').split(/\s+/u).filter(Boolean).slice(0, 12);
          if (ids.length) references.push({ scope: own, ids });
        }
      }
    }
    if (inherited && properties.length) {
      const value = scope ? own : microdataValue(node);
      if (value) putMicrodata(inherited, properties, value);
    }
    scopes.set(node, own ?? null);
  }
  for (const { scope, ids } of references) {
    const pending = ids.map(id => elementIds.get(id)).filter(node => node !== undefined);
    const seen = new Set<Html.Element>();
    while (pending.length && seen.size < 160) {
      const node = pending.pop()!;
      if (seen.has(node) || scopes.get(node) === scope) continue;
      seen.add(node);
      const nested = node.attrs.some(attribute => attribute.name === 'itemscope');
      const properties = attrs(node, 'itemprop').split(/\s+/u).filter(Boolean);
      const value = nested ? scopes.get(node) : properties.length ? microdataValue(node) : undefined;
      if (properties.length && value) putMicrodata(scope, properties, value);
      if (!nested) pending.push(...children(node).filter(isElement).slice(0, 160));
    }
  }
  return entities;
}

export function structuredEntities(nodes: ReturnType<typeof htmlNodes>): SchemaEntity[] {
  return [...jsonEntities(nodes), ...microdataEntities(nodes)];
}

export function schemaValueObjects(value: unknown, entities: SchemaEntity[]): Entity[] {
  return (Array.isArray(value) ? value : [value]).slice(0, MAX_ENTITIES).flatMap(item => {
    if (typeof item === 'string') {
      const referenced = entities.find(({ data }) => data['@id'] === item);
      return referenced ? [referenced.data] : [];
    }
    if (!entity(item)) return [];
    const id = item['@id'];
    const referenced = typeof id === 'string' ? entities.find(({ data }) => data['@id'] === id && Object.keys(data).length > Object.keys(item).length) : undefined;
    return [referenced?.data ?? item];
  });
}
