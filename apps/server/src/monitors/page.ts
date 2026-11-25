import { publicSearchText } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import type { MonitorObservation, WatchedBlock } from './evaluation.js';

const OMIT = new Set(['aside', 'footer', 'iframe', 'nav', 'noscript', 'script', 'style', 'svg', 'template']);
const BLOCK = new Set(['article', 'blockquote', 'body', 'button', 'dd', 'div', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'p', 'pre', 'section', 'tr']);
const MOVING_ELEMENT = /(?:^|[\s_-])(?:ad|ads|advertisement|analytics|banner-rotation|carousel|cookie-banner|countdown|counter|current-time|live-clock|pageviews|ticker)(?:$|[\s_-])/iu;
const MARKER = /^(?:(?:last (?:updated|refreshed)|generated (?:at|on)|server time|current time|page\s*views?|views?|visitors?|updated \d+ (?:seconds?|minutes?) ago|آخر تحديث|وقت الخادم|عدد المشاهدات|عدد الزوار)[:\s\-–—]|\d{1,2}:\d{2}:\d{2}(?:\s|$))/iu;
const MAX_NODES = 20_000;
const MAX_BLOCKS = 160;
const MAX_BLOCK_LENGTH = 512;
const DISPLAY_LENGTH = 320;

export function cleanMonitorText(value: string): string {
  return value.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\p{Z}]+/gu, ' ').trim();
}

function arabicDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit < '۰' ? 0x660 : 0x6f0)));
}

export function matchMonitorText(value: string): string {
  return arabicDigits(cleanMonitorText(value)).toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
}

export function phraseIndex(text: string, phrase: string): number {
  if (!phrase) return -1;
  let index = text.indexOf(phrase);
  while (index >= 0) {
    const end = index + phrase.length;
    if (!/[\p{L}\p{N}]/u.test(text[index - 1] ?? '') && !/[\p{L}\p{N}]/u.test(text[end] ?? '')) return index;
    index = text.indexOf(phrase, index + 1);
  }
  return -1;
}

function display(value: string): string {
  return publicSearchText(cleanMonitorText(value)).slice(0, DISPLAY_LENGTH);
}

function isElement(node: Html.Node): node is Html.Element {
  return 'tagName' in node;
}

function attrs(node: Html.Element, ...names: string[]): string {
  return node.attrs.filter(attribute => names.includes(attribute.name)).map(attribute => attribute.value).join(' ');
}

function excluded(node: Html.Element): boolean {
  return OMIT.has(node.tagName) || node.attrs.some(item => item.name === 'hidden' || item.name === 'inert')
    || attrs(node, 'aria-hidden') === 'true'
    || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(attrs(node, 'style'))
    || MOVING_ELEMENT.test(attrs(node, 'id', 'class', 'role', 'aria-label', 'data-testid'));
}

function children(node: Html.Node): Html.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

interface Candidate extends WatchedBlock {
  node?: Html.Element;
  scope: string[];
}

function pageCandidates(html: string, plain: boolean): Candidate[] {
  if (plain) return html.split(/\r?\n/u, MAX_BLOCKS).flatMap((line, index) => {
    const text = display(line);
    return text && !MARKER.test(text) ? [{ key: String(index), text, scope: [] }] : [];
  });

  const tree = parse(html);
  const stack: { node: Html.Node; key: string; depth: number; parent?: Html.Element; scope: string[] }[] = [
    { node: tree, key: '', depth: 0, scope: [] },
  ];
  const blocks = new Map<string, Candidate>();
  let body: Html.Element | undefined;
  let main: Html.Element | undefined;
  let visited = 0;
  while (stack.length && ++visited <= MAX_NODES) {
    const { node, key, depth, parent, scope } = stack.pop()!;
    if (depth > 80 || isElement(node) && excluded(node)) continue;
    if (isElement(node) && node.tagName === 'body') body ??= node;
    if (isElement(node) && (node.tagName === 'main' || attrs(node, 'role') === 'main')) main ??= node;
    const owner = isElement(node) && BLOCK.has(node.tagName) ? node : parent;
    const scopes = isElement(node) ? [...scope, key] : scope;
    const blockKey = owner === node ? key : scope.findLast(path => blocks.has(path));
    if (owner === node) blocks.set(key, { key, text: '', node: owner, scope: scopes });
    if (node.nodeName === '#text' && 'value' in node && typeof node.value === 'string' && blockKey) {
      const block = blocks.get(blockKey)!;
      if (block.text.length < MAX_BLOCK_LENGTH) block.text += ' ' + node.value.slice(0, MAX_BLOCK_LENGTH);
    }
    const indexes = new Map<string, number>();
    const next = children(node).map(child => {
      const identity = isElement(child) && /^[\w-]{1,80}$/u.test(attrs(child, 'id')) ? '#' + attrs(child, 'id') : child.nodeName;
      const index = (indexes.get(identity) ?? 0) + 1;
      indexes.set(identity, index);
      return { node: child, key: `${key}/${identity}:${index}`, depth: depth + 1, parent: owner, scope: scopes };
    });
    for (let index = next.length - 1; index >= 0; index--) stack.push(next[index]);
  }
  const root = Array.from(blocks.values()).find(block => block.node === (main ?? body))?.key;
  return Array.from(blocks.values()).flatMap(block => {
    const text = publicSearchText(cleanMonitorText(block.text)).slice(0, MAX_BLOCK_LENGTH);
    return text && (!root || block.scope.includes(root)) && !MARKER.test(text) ? [{ ...block, text }] : [];
  }).slice(0, MAX_BLOCKS);
}

function labelNeedles(label: string): string[] {
  return label === 'price' ? ['price', 'السعر', 'سعر'] : [matchMonitorText(label)];
}

function labelContext(candidates: Candidate[], label: string): Candidate[] {
  const needles = labelNeedles(label);
  const exact = candidates.findIndex(item => needles.includes(matchMonitorText(item.text).replace(/[:：\s]+$/u, '')));
  const first = exact >= 0 ? exact : candidates.findIndex(item => needles.some(needle => phraseIndex(matchMonitorText(item.text), needle) >= 0));
  if (first < 0) return [];
  const anchor = candidates[first];
  if (anchor.node && /^h[1-6]$/u.test(anchor.node.tagName)) {
    const rest = candidates.slice(first + 1);
    const parent = anchor.scope.at(-2);
    const end = rest.findIndex(item => /^h[1-6]$/u.test(item.node?.tagName ?? '') || parent && !item.scope.includes(parent));
    return [anchor, ...rest.slice(0, Math.min(end < 0 ? 4 : end, 4))];
  }
  if (exact >= 0 && candidates[first + 1] && (!anchor.node || /^(?:dd|p|div|tr)$/u.test(candidates[first + 1].node?.tagName ?? ''))) {
    return [anchor, candidates[first + 1]];
  }
  return [anchor];
}

function numberFrom(text: string): number | undefined {
  const numeric = arabicDigits(text).replace(/٫/gu, '.').replace(/٬/gu, ',').replace(/−/gu, '-');
  // Reject an ambiguous range and a price with two distinct numbers.
  const values = numeric.match(/(?<![\p{L}\p{N}.])[+-]?\d+(?:[.,]\d+)*(?![\p{L}\p{N}])/gu) ?? [];
  if (values.length !== 1) return undefined;
  const raw = values[0];
  const normalized = /^[+-]?\d{1,3}(,\d{3})+(?:\.\d+)?$/u.test(raw) ? raw.replaceAll(',', '') : raw.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

const MONTHS = [
  ['january', 'jan', 'يناير', 'كانون الثاني'], ['february', 'feb', 'فبراير', 'شباط'],
  ['march', 'mar', 'مارس', 'اذار'], ['april', 'apr', 'ابريل', 'نيسان'],
  ['may', 'مايو', 'ايار'], ['june', 'jun', 'يونيو', 'حزيران'],
  ['july', 'jul', 'يوليو', 'تموز'], ['august', 'aug', 'اغسطس', 'اب'],
  ['september', 'sep', 'sept', 'سبتمبر', 'ايلول'], ['october', 'oct', 'اكتوبر', 'تشرين الاول'],
  ['november', 'nov', 'نوفمبر', 'تشرين الثاني'], ['december', 'dec', 'ديسمبر', 'كانون الاول'],
];
const monthNames = MONTHS.flat().join('|');
const dayFirst = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d{1,2})\s+(${monthNames})\.?\s+(\d{4})(?!\d)`, 'u');
const monthFirst = new RegExp(String.raw`(?<![\p{L}\p{N}])(${monthNames})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)`, 'u');

function dateFrom(text: string): string | undefined {
  const normalized = matchMonitorText(text);
  let date = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(normalized)?.[1];
  if (!date) {
    const leadingDay = dayFirst.exec(normalized);
    const leadingMonth = monthFirst.exec(normalized);
    if (!leadingDay && !leadingMonth) return undefined;
    const day = leadingDay?.[1] ?? leadingMonth![2];
    const monthName = leadingDay?.[2] ?? leadingMonth![1];
    const year = leadingDay?.[3] ?? leadingMonth![3];
    const month = MONTHS.findIndex(names => names.includes(monthName)) + 1;
    date = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === date ? date : undefined;
}

const CLOSED = /(?:\b(?:not|no longer|coming soon|closed|unavailable|sold out|out of stock|no tickets?|opens? on|will open|will be|begins? on|scheduled|unpublished|ended|soon|later)\b|(?:غير متاح|غير متوفر|لم يعد|لم يفتح|لم يبدا|لم ينشر|لم تعلن|سيفتح|ستفتح|قريبا|نفد|نفذت|مغلق|اغلق|انتهي))/iu;

const statusRules = {
  registration: { subject: /\b(?:registration|applications?|enrol(?:l)?ment|sign[ -]?ups?)\b|تسجيل|تقديم الطلبات|الالتحاق/u,
    positive: /\b(?:open|opened|accepting|register now|apply now|sign up now)\b|مفتوح|متاح|بدا التسجيل|سجل الان|قدم الان/u, status: 'registration open', negative: 'registration closed' },
  tickets: { subject: /\btickets?\b|تذاكر|تذكره/u,
    positive: /\b(?:available|on sale|buy now|get yours|purchase now)\b|متوفر|متاح|تباع الان|احجز الان|اشتر الان/u, status: 'tickets available', negative: 'tickets unavailable' },
  availability: { subject: /\b(?:availability|in stock|out of stock|sold out|available|unavailable|stock status)\b|المخزون|المتوفر|متاح|توفر|نفد/u,
    positive: /\b(?:in stock|available)\b|متاح|متوفر/u, status: 'in stock', negative: 'out of stock' },
  publication: { subject: /\b(?:publication|published|unpublished|release|released)\b|منشور|نشر|اصدار|صدور/u,
    positive: /\b(?:published|released|now live)\b|منشور|تم النشر|صدر/u, status: 'published', negative: 'unpublished' },
};

function statusFrom(candidates: Candidate[], label: string | undefined, anchored: boolean): { value: string; excerpt: string } | undefined {
  const rule = label && Object.hasOwn(statusRules, label) ? statusRules[label as keyof typeof statusRules] : null;
  if (rule) {
    for (let index = 0; index < candidates.length; index++) {
      const item = candidates[index];
      const text = matchMonitorText(item.text);
      if (!anchored && !rule.subject.test(text)) continue;
      const next = candidates[index + 1];
      const details = matchMonitorText(next?.text ?? '');
      const bareSubject = text.length <= 40 && rule.subject.exec(text)?.[0] === text.replace(/[:：\s]+$/u, '');
      const combined = bareSubject ? `${text} ${details}` : text;
      const evidence = !bareSubject ? item.text : rule.subject.test(details) ? next!.text : `${item.text} ${next?.text ?? ''}`;
      // A negative or future marker in the same target beats a positive word.
      if (CLOSED.test(combined)) return { value: rule.negative, excerpt: display(evidence) };
      if (rule.positive.test(combined)) return { value: rule.status, excerpt: display(evidence) };
    }
    const candidate = candidates.find(item => rule.subject.test(matchMonitorText(item.text))) ?? (anchored ? candidates[0] : undefined);
    return candidate && { value: 'unknown', excerpt: display(candidate.text) };
  }
  const text = display(candidates.map(item => item.text).join(' '));
  return text ? { value: text, excerpt: text } : undefined;
}

function hasPhrase(text: string, phrase: string): boolean {
  let index = phraseIndex(text, phrase);
  if (index < 0) return false;
  const prefix = /(?:\b(?:not(?: yet| currently)?|never|no longer|will be)\b|(?:^|\s)(?:غير|ليس|لم|لن)(?=\s|$))\s*$/iu;
  const suffix = /^\s*(?:\b(?:soon|later|next|yet)\b|قريبا|لاحقا)/iu;
  while (index >= 0) {
    const after = index + phrase.length;
    if (!prefix.test(text.slice(Math.max(0, index - 32), index)) && !suffix.test(text.slice(after, after + 22))) return true;
    const next = phraseIndex(text.slice(after), phrase);
    index = next < 0 ? -1 : after + next;
  }
  return false;
}

export function observePage(
  body: string,
  url: string,
  contentType: string,
  spec: Pick<MonitorSpec, 'read'> & { source: Extract<MonitorSpec['source'], { kind: 'page' }> },
  observedAt: string,
): MonitorObservation | undefined {
  const { source, read } = spec;
  const candidates = pageCandidates(body, /^text\/plain/iu.test(contentType));
  const watched = source.anchor ? labelContext(candidates, source.anchor) : candidates;
  if (!watched.length) return undefined;

  const sample = (value: MonitorObservation['value'], excerpt: string, extra: Partial<MonitorObservation> = {}): MonitorObservation =>
    ({ value, excerpt, url, observedAt, ...extra });
  const excerpt = display(watched.map(item => item.text).join(' '));
  if (read.kind === 'main') {
    return sample(excerpt, excerpt, { blocks: watched.map(({ key, text }) => ({ key, text })) });
  }
  if (read.kind === 'phrase') {
    const needle = matchMonitorText(read.phrase);
    const matched = watched.find(block => hasPhrase(matchMonitorText(block.text), needle));
    return sample(Boolean(matched), matched ? display(matched.text) : excerpt);
  }
  if (read.kind === 'items') {
    const items = watched.filter(item => item.node?.tagName === 'li' || item.node?.tagName === 'tr');
    return sample(items.map(item => display(item.text)), display(items.map(item => item.text).join(' ')) || excerpt);
  }
  if (read.kind === 'status') {
    const relevant = read.label && !Object.hasOwn(statusRules, read.label) ? labelContext(watched, read.label) : watched;
    const status = statusFrom(relevant, read.label, Boolean(source.anchor));
    return status && sample(status.value, status.excerpt);
  }

  const relevant = read.label ? labelContext(watched, read.label) : watched;
  for (const item of relevant) {
    const normalized = matchMonitorText(item.text);
    const label = read.label && labelNeedles(read.label).find(needle => phraseIndex(normalized, needle) >= 0);
    const following = label && normalized.slice(phraseIndex(normalized, label) + label.length).split(/[|·•]/u, 1)[0];
    const findValue = read.kind === 'number' ? numberFrom : dateFrom;
    const value = (following ? findValue(following) : undefined) ?? findValue(item.text);
    if (value !== undefined) return sample(value, display(item.text));
  }
  return undefined;
}
