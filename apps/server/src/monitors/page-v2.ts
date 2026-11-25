import { createHash } from 'node:crypto';
import type { MonitorSpec } from '@mohassan/contracts';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import type { MonitorObservation } from './evaluation.js';
import {
  attrs, display, hasPhrase, isElement, labelContext, labelNeedles, matchMonitorText, observePage, pageAnchorContext, pageCandidates,
  phraseIndex, statusFrom, type Candidate,
} from './page.js';
import { htmlNodes, nodeText, schemaProperty, schemaString, schemaTypes, schemaValueObjects, structuredEntities } from './page-structured-v2.js';
import { normalizeCurrency, normalizeUnit, pageDate, pageNumbers, pageStatus } from './page-values-v2.js';

type Property = 'price' | 'availability' | 'startDate' | 'eventStatus' | 'productName';
interface Target { property?: Property; currency?: string; unit?: string }
type PageSpec = Pick<MonitorSpec, 'read'> & {
  source: Extract<MonitorSpec['source'], { kind: 'page' }>;
  v2?: { target?: Target };
};

export interface MonitorPageAnchor {
  key: string;
  label: string;
  pattern: { kind: string; currency?: string; unit?: string };
  context: string;
  origin: 'structured' | 'visible' | 'visual';
  old?: true;
}
export interface MonitorPageCandidate {
  id: string;
  label: string;
  observation: MonitorObservation;
  anchor: MonitorPageAnchor;
}
export interface MonitorPageRelocation { at: string; from: string; to: string; confidence: number }
export type ObserveResult =
  | { kind: 'value'; observation: MonitorObservation; anchor?: MonitorPageAnchor; relocation?: MonitorPageRelocation }
  | { kind: 'clarify'; candidates: MonitorPageCandidate[]; confidence: number; url: string }
  | { kind: 'unsafe-target'; confidence: number; url: string }
  | { kind: 'missing'; url: string };

const high = 0.84;
const middle = 0.55;
const lead = 0.16;
const oldPrice = /\b(?:old|was|regular price|list price|original price|previous)\b|السعر السابق|السعر القديم|كان السعر/u;
const statusWords = /\b(?:not in stock|not available|out of stock|in stock|on sale|sold out|not open|coming soon|moved online|opens? on|will open|now live|cancell?ed|scheduled|postponed|rescheduled|open(?:ed)?|closed|available|unavailable|published|unpublished|released)\b|غير متاح|غير متوفر|نفد(?:ت)? الكميه|نفد(?:ت)?|لم يفتح|لم ينشر|تم النشر|مفتوح|مغلق|متوفر|متاح|قريبا|سيفتح|ستفتح|منشور/gu;
const heading = /^h[1-6]$/u;
const targetLabels: Record<Property, string[]> = {
  price: ['price', 'السعر', 'سعر'],
  availability: ['availability', 'stock', 'in stock', 'out of stock', 'التوفر', 'المخزون', 'متوفر', 'نفدت الكمية'],
  startDate: ['start date', 'event start', 'تاريخ البدء', 'بداية الحدث'],
  eventStatus: ['event', 'event status', 'حالة الحدث'],
  productName: ['name', 'product name', 'اسم المنتج'],
};

function boundedKey(value: string): string {
  return value.length > 180 ? createHash('sha256').update(value).digest('hex') : value;
}

function targetProperty(spec: PageSpec): Property | undefined {
  if (spec.v2?.target?.property) return spec.v2.target.property;
  const label = matchMonitorText('label' in spec.read ? spec.read.label ?? '' : spec.source.anchor ?? '');
  if (spec.read.kind === 'number' && ((!label && !spec.source.anchor) ||
      targetLabels.price.some(value => matchMonitorText(value) === label))) return 'price';
  if (spec.read.kind === 'status' && (label === 'tickets' || targetLabels.availability.some(value => matchMonitorText(value) === label))) return 'availability';
  if (spec.read.kind === 'status' && targetLabels.eventStatus.some(value => matchMonitorText(value) === label)) return 'eventStatus';
  if (spec.read.kind === 'date' && (!label || targetLabels.startDate.some(value => matchMonitorText(value) === label))) return 'startDate';
  if (spec.read.kind === 'main' && targetLabels.productName.some(value => matchMonitorText(value) === label)) return 'productName';
}

function contextText(value: string): string {
  return matchMonitorText(value).replace(/[\d.,٫٬]+/gu, ' ').replace(/[^\p{L}\p{Sc}%°]+/gu, ' ').trim().slice(0, 240);
}

function candidate(value: MonitorObservation['value'], url: string, at: string, excerpt: string,
  anchor: MonitorPageAnchor, label?: string): MonitorPageCandidate {
  const safeAnchor = { ...anchor, key: boundedKey(anchor.key), label: display(anchor.label).slice(0, 180), context: contextText(display(anchor.context)) };
  const id = createHash('sha256').update(JSON.stringify(safeAnchor)).digest('hex').slice(0, 24);
  return { id, label: display(label ?? excerpt).slice(0, 180) || String(value), anchor: safeAnchor,
    observation: { value, excerpt: display(excerpt), url, observedAt: at } };
}

function schemaStatus(raw: string, property: 'availability' | 'eventStatus', tickets: boolean): string | undefined {
  const status = raw.replace(/^https?:\/\/schema\.org\//iu, '');
  if (property === 'eventStatus') {
    // The enumerations are defined at https://schema.org/EventStatusType.
    const events = { EventCancelled: 'event cancelled', EventMovedOnline: 'event moved online',
      EventPostponed: 'event postponed', EventRescheduled: 'event rescheduled', EventScheduled: 'event scheduled' };
    return Object.hasOwn(events, status) ? events[status as keyof typeof events] : undefined;
  }
  // The enumerations are defined at https://schema.org/ItemAvailability.
  if (['InStock', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly', 'Reserved'].includes(status)) return tickets ? 'tickets available' : 'in stock';
  if (['OutOfStock', 'SoldOut', 'Discontinued'].includes(status)) return tickets ? 'tickets unavailable' : 'out of stock';
  if (['PreOrder', 'PreSale', 'BackOrder'].includes(status)) return tickets ? 'tickets unavailable' : 'coming soon';
}

function structuredCandidates(nodes: ReturnType<typeof htmlNodes>, property: Property, spec: PageSpec,
  url: string, at: string): MonitorPageCandidate[] {
  const entities = structuredEntities(nodes);
  const parents = new Map(entities.flatMap(({ data }) => {
    if (!schemaTypes(data).some(type => type === 'Product' || type.endsWith('Event'))) return [];
    const name = schemaString(schemaProperty(data, 'name'));
    return schemaValueObjects(schemaProperty(data, 'offers'), entities).map(offer => [offer, name] as const);
  }));
  const targets: { data: (typeof entities)[number]['data']; key: string }[] = [...entities];
  const existing = new Set(entities.map(({ data }) => data));
  for (const { data, key } of entities) {
    if (!schemaTypes(data).some(type => type === 'Product' || type.endsWith('Event'))) continue;
    for (const [index, offer] of schemaValueObjects(schemaProperty(data, 'offers'), entities).entries()) {
      if (!existing.has(offer)) {
        existing.add(offer);
        targets.push({ data: offer, key: key + '/offers/' + index });
      }
    }
  }
  return targets.flatMap(({ data, key }) => {
    const types = schemaTypes(data);
    const offer = types.includes('Offer') || parents.has(data) && types.length === 0;
    const event = types.some(type => type.endsWith('Event'));
    if (property === 'productName' ? !types.includes('Product') :
      property === 'eventStatus' || property === 'startDate' ? !event : !offer) return [];
    const name = parents.get(data) ?? schemaString(schemaProperty(data, 'name'));
    const label = 'label' in spec.read ? spec.read.label : undefined;
    const scopedLabel = spec.source.anchor ? matchMonitorText(spec.source.anchor) : undefined;
    const genericScope = scopedLabel && Object.values(targetLabels).flat().some(item => matchMonitorText(item) === scopedLabel);
    if (scopedLabel && !genericScope && (!name || phraseIndex(matchMonitorText(name), scopedLabel) < 0)) return [];
    const raw = schemaString(schemaProperty(data, property === 'productName' ? 'name' : property));
    if (raw === undefined) return [];
    const number = property === 'price' ? pageNumbers(raw) : [];
    const currency = property === 'price' ? normalizeCurrency(schemaString(schemaProperty(data, 'priceCurrency'))) : undefined;
    let value: string | number | undefined;
    if (property === 'price') value = number.length === 1 && !number[0].conflicting ? number[0].value : undefined;
    else if (property === 'startDate') value = pageDate(raw);
    else if (property === 'productName') value = display(raw);
    else value = schemaStatus(raw, property, label === 'tickets');
    if (value === undefined || property === 'price' && number[0].currency && currency && number[0].currency !== currency) return [];
    const actualCurrency = currency ?? number[0]?.currency;
    const id = schemaString(data['@id']);
    const context = property === 'productName' ? schemaString(schemaProperty(data, 'sku')) ?? property : name ?? property;
    const title = [property !== 'productName' && name, raw, actualCurrency && !number[0]?.currency && actualCurrency].filter(Boolean).join(' · ');
    return [candidate(value, url, at, `${label ?? property}: ${title}`, {
      key: id ? `schema:${createHash('sha256').update(id).digest('hex')}` : key, label: property, context, origin: 'structured',
      pattern: { kind: property, ...(actualCurrency && { currency: actualCurrency }) },
    }, title)];
  });
}

function isStruck(candidate: Candidate, text: string, index: number, raw: string): boolean {
  const line = matchMonitorText(text);
  const prefix = line.slice(0, index);
  const qualifiers = [...prefix.matchAll(new RegExp(oldPrice.source + '|\\b(?:current|sale price|now)\\b|السعر الحالي|الان', 'gu'))];
  if (qualifiers.length && oldPrice.test(qualifiers.at(-1)![0])) return true;
  if (!candidate.node) return false;
  if (['s', 'strike', 'del'].includes(candidate.node.tagName)) return true;
  const struck = candidate.node.childNodes.filter(isElement).flatMap(node => {
    if (!['s', 'strike', 'del'].includes(node.tagName) && !/text-decoration(?:-line)?\s*:[^;]*line-through/iu.test(attrs(node, 'style'))) return [];
    return [matchMonitorText(nodeText(node))];
  });
  return struck.some(old => old && old.includes(raw) && line.indexOf(old) <= index && line.indexOf(old) + old.length >= index + raw.length);
}

function anchoredText(blocks: Candidate[], spec: PageSpec, url: string, at: string): MonitorPageCandidate[] {
  const { source, read } = spec;
  if (!source.anchor || read.kind !== 'main' && read.kind !== 'phrase') return [];
  const label = source.anchor;
  const needles = labelNeedles(label);
  const matches = blocks.map((block, index) => {
    const normalized = matchMonitorText(block.text);
    return { index, exact: needles.includes(normalized.replace(/[:：\s]+$/u, '')),
      found: needles.some(needle => phraseIndex(normalized, needle) >= 0) };
  });
  const exactMatches = matches.filter(item => item.exact);
  return (exactMatches.length ? exactMatches : matches.filter(item => item.found)).map(({ index, exact }) => {
    const watched = pageAnchorContext(blocks, index, exact);
    const neighboringHeading = blocks.slice(Math.max(0, index - 4), index).findLast(block =>
      heading.test(block.node?.tagName ?? '') && !!block.scope.at(-2) && blocks[index].scope.includes(block.scope.at(-2)!));
    const all = display(watched.map(block => block.text).join(' '));
    const anchor = { key: blocks[index].key, context: [label, neighboringHeading?.text].filter(Boolean).join(' '),
      label, origin: 'visible' as const, pattern: { kind: read.kind } };
    if (read.kind === 'phrase') {
      const matched = watched.find(block => hasPhrase(matchMonitorText(block.text), matchMonitorText(read.phrase)));
      return candidate(Boolean(matched), url, at, matched?.text ?? all, anchor);
    }
    const selected = candidate(all, url, at, all, anchor);
    // Anchor-relative block positions survive a move of the containing section.
    selected.observation.blocks = watched.map(({ text }, order) => ({ key: String(order), text }));
    return selected;
  });
}

function visibleCandidates(blocks: Candidate[], property: Property | undefined, spec: PageSpec,
  url: string, at: string, relocating: boolean): MonitorPageCandidate[] {
  const { source, read } = spec;
  const label = 'label' in read ? read.label : undefined;
  const relevant = label ? labelNeedles(label) : property ? targetLabels[property].map(matchMonitorText) : [];
  const knownStatus = read.kind === 'status' && ['registration', 'tickets', 'availability', 'publication'].includes(label ?? '');
  const labelSpecified = Boolean(label && !knownStatus);
  const anchorLabel = source.anchor && matchMonitorText(source.anchor);
  const genericAnchor = anchorLabel && property === 'price' && targetLabels.price.map(matchMonitorText).includes(anchorLabel);
  const scoped = source.anchor && !genericAnchor ? new Set(labelContext(blocks, source.anchor).map(block => block.key)) : undefined;

  return blocks.flatMap((block, index) => {
    const text = matchMonitorText(block.text);
    const preceding = blocks[index - 1];
    const previousHeading = blocks.slice(Math.max(0, index - 4), index).findLast(item =>
      heading.test(item.node?.tagName ?? '') && item.scope.at(-2) && block.scope.includes(item.scope.at(-2)!));
    const nearest = preceding && preceding.scope.at(-2) === block.scope.at(-2) ? preceding.text : previousHeading?.text ?? '';
    const ownLabel = relevant.find(item => phraseIndex(text, item) >= 0);
    const nearby = !ownLabel && nearest && relevant.find(item => phraseIndex(matchMonitorText(nearest), item) >= 0);
    const labelMatch = ownLabel || nearby;
    const inScope = !scoped || scoped.has(block.key);
    if (!inScope && !relocating) return [];
    const kind = property ?? read.kind;
    const identity = labelMatch ? property ?? label ?? labelMatch : source.anchor && inScope ? source.anchor : '';
    const context = `${nearest} ${block.text}`;
    const make = (value: MonitorObservation['value'], suffix: string, extra: Partial<MonitorPageAnchor> = {},
      pattern: Partial<MonitorPageAnchor['pattern']> = {}, caption?: string) =>
      candidate(value, url, at, block.text, { key: block.key + suffix, label: identity, context, origin: 'visible', ...extra,
        pattern: { kind, ...pattern } }, caption);

    if (read.kind === 'number') {
      const numbers = pageNumbers(block.text);
      return numbers.flatMap(({ value, index: offset, raw, currency, unit, conflicting }, itemIndex) => {
        if (conflicting || !labelMatch && labelSpecified && property !== 'price' && !relocating ||
            !labelMatch && !currency && !unit && (labelSpecified || !inScope)) return [];
        const old = isStruck(block, block.text, offset, raw);
        const arabic = /\p{Script=Arabic}/u.test(block.text);
        const qualifier = numbers.length > 1 || old ? [raw, currency ?? unit, old && (arabic ? 'السعر السابق' : 'Previous price')].filter(Boolean).join(' · ') : undefined;
        return [make(value, `:${itemIndex}`, old ? { old: true } : {}, { currency, unit }, qualifier)];
      });
    }
    if (read.kind === 'date') {
      const value = pageDate(block.text);
      return value && (labelMatch || !labelSpecified && inScope) ? [make(value, '')] : [];
    }
    if (read.kind === 'status') {
      let value: string | undefined;
      if (property === 'eventStatus') {
        const event = /\b(?:event )?(cancelled|canceled|scheduled|postponed|rescheduled|moved online)\b/u.exec(text)?.[1];
        if (event) value = 'event ' + event.replace('canceled', 'cancelled');
      } else if (knownStatus && label !== 'availability' && label !== 'tickets') {
        value = statusFrom([block], label, Boolean(labelMatch || source.anchor && inScope))?.value;
      } else {
        value = pageStatus(block.text, label ?? (property === 'availability' ? property : undefined));
      }
      return value && value !== 'unknown' && (labelMatch || !labelSpecified && inScope)
        ? [make(value, '', { context: matchMonitorText(context).replace(statusWords, ' ') })] : [];
    }
    if (property === 'productName' && (labelMatch || inScope && block.node?.tagName === 'h1')) {
      const value = ownLabel ? block.text.split(/[:：]/u, 2)[1]?.trim() : block.text;
      return value ? [make(value, '', { context: nearby ? nearest : identity || property })] : [];
    }
    return [];
  });
}

function contextSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = new Set(left.split(/\s+/u).filter(Boolean));
  const b = new Set(right.split(/\s+/u).filter(Boolean));
  const overlap = [...a].filter(word => b.has(word)).length;
  return overlap / new Set([...a, ...b]).size;
}

function compatible(before: MonitorPageAnchor, after: MonitorPageAnchor): boolean {
  return before.pattern.kind === after.pattern.kind && before.pattern.currency === after.pattern.currency &&
    before.pattern.unit === after.pattern.unit && before.old === after.old;
}

function score(before: MonitorPageAnchor, after: MonitorPageAnchor): number {
  if (!compatible(before, after)) return 0;
  const label = before.label === after.label ? 0.25 : 0;
  const context = 0.3 * contextSimilarity(before.context, after.context);
  const position = before.key === after.key && before.origin === after.origin ? 0.10 : 0;
  return Math.round((0.35 + label + context + position) * 100) / 100;
}

function sameValue(left: MonitorPageCandidate, right: MonitorPageCandidate): boolean {
  return left.observation.value === right.observation.value && compatible(left.anchor, right.anchor)
    && left.anchor.context === right.anchor.context && left.anchor.label === right.anchor.label;
}

export function observePageV2(body: string, url: string, contentType: string, spec: PageSpec, at: string,
  previous?: MonitorPageAnchor, document?: Html.Document, allowMissingTarget = false): ObserveResult {
  const property = targetProperty(spec);
  const plain = /^text\/plain/iu.test(contentType);
  const doc = plain ? undefined : document ?? parse(body);
  const anchored = !property && spec.source.anchor && ['main', 'phrase'].includes(spec.read.kind);
  const targeted = anchored || property || ['number', 'status', 'date'].includes(spec.read.kind);
  const legacy = (): ObserveResult => {
    const observation = observePage(body, url, contentType, spec, at);
    return observation ? { kind: 'value', observation } : { kind: 'missing', url };
  };
  if (!targeted) return legacy();

  const directTarget = spec.v2?.target;
  const requiredCurrency = normalizeCurrency(directTarget?.currency);
  const requiredUnit = normalizeUnit(directTarget?.unit);
  const targetMatch = ({ anchor }: MonitorPageCandidate) =>
    (!directTarget?.currency || requiredCurrency && anchor.pattern.currency === requiredCurrency) &&
    (!directTarget?.unit || anchor.pattern.unit === requiredUnit);
  const structured = doc && property ? structuredCandidates(htmlNodes(doc), property, spec, url, at).filter(targetMatch) : [];
  let visible: MonitorPageCandidate[] = [];
  if (!structured.length || previous?.origin === 'visible') {
    const blocks = pageCandidates(body, plain, doc);
    visible = (anchored ? anchoredText(blocks, spec, url, at) :
      visibleCandidates(blocks, property, spec, url, at, Boolean(previous))).filter(targetMatch);
  }
  const pool = previous?.origin === 'visible' && visible.length ? visible : structured.length ? structured : visible;
  const distinct = (pool === structured ? pool.filter((item, index) => pool.findIndex(other => sameValue(item, other)) === index) : pool);
  const confirm = (picked: MonitorPageCandidate, confidence: number): ObserveResult => ({
    kind: 'value', observation: picked.observation, anchor: picked.anchor,
    ...(previous && (previous.key !== picked.anchor.key || previous.origin !== picked.anchor.origin) &&
      { relocation: { at, from: previous.key, to: picked.anchor.key, confidence } }),
  });
  if (!previous) {
    if (distinct.length > 1) return { kind: 'clarify', candidates: distinct.slice(0, 4), confidence: middle, url };
    if (distinct.length === 1 && !distinct[0].anchor.old) return confirm(distinct[0], 1);
    if (distinct.length || !allowMissingTarget && (directTarget?.currency || directTarget?.unit)) {
      return { kind: 'unsafe-target', confidence: 0, url };
    }
    return spec.read.kind === 'status' && !directTarget?.property ? legacy() : { kind: 'missing', url };
  }
  const ranked = distinct.map(item => ({ item, confidence: score(previous, item.anchor) })).sort((a, b) => b.confidence - a.confidence);
  const first = ranked[0];
  const confidence = first?.confidence ?? 0;
  const exact = confidence === 1 && ranked[1]?.confidence !== 1;
  if (first && (exact || confidence >= high && confidence - (ranked[1]?.confidence ?? 0) >= lead)) return confirm(first.item, confidence);
  if (confidence >= middle && ranked.length >= 2) {
    return { kind: 'clarify', candidates: ranked.slice(0, 4).map(({ item }) => item), confidence, url };
  }
  return { kind: 'unsafe-target', confidence, url };
}
