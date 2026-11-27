import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

export type Edition = 'ar' | 'en';
export interface EntryRequest {
  language: Edition;
  intent: 'definition' | 'partOfSpeech' | 'plural' | 'root' | 'pattern' | 'etymology' | 'spelling' | 'synonyms' | 'translation';
  target?: string;
}

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export function stripArabicMarks(value: string): string {
  return value.replace(/(?<=\p{Script=Arabic})\p{M}+/gu, '').replaceAll('ـ', '');
}

export function validTitle(value: string): boolean {
  return /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd} .’'\-]{0,79}$/u.test(value);
}

function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

const attribute = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
const hasClass = (node: Element, name: string) => attribute(node, 'class')?.split(/\s+/u).includes(name) ?? false;
const OMIT = new Set(['script', 'style', 'sup', 'template', 'noscript', 'dl', 'ul', 'ol', 'rt']);

function excerpt(node: Node): string {
  let value = '';
  const pending = [...children(node)].reverse();
  while (pending.length) {
    const next = pending.pop()!;
    if ('value' in next) value += next.value;
    if (isElement(next) && (OMIT.has(next.tagName) || hasClass(next, 'mw-editsection') || attribute(next, 'hidden') !== undefined)) continue;
    pending.push(...[...children(next)].reverse());
  }
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\s]+/gu, ' ').trim();
}

function* elements(root: Node, descend = (_node: Element) => true): Generator<Element> {
  const pending = [...children(root)].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (!isElement(node)) continue;
    yield node;
    if (descend(node)) pending.push(...[...children(node)].reverse());
  }
}

function label(value: string): string {
  return stripArabicMarks(value.toLowerCase()).replace(/[أإآٱ]/gu, 'ا').replace(/\s+\d+$/u, '').trim();
}

// Section vocabulary checked 2026-11-27 against Wiktionary's edition guides and the recorded entries.
// https://en.wiktionary.org/wiki/Wiktionary:Entry_layout
// https://ar.wiktionary.org/wiki/ويكاموس:صيغة_الكتابة
const LANGUAGES: Record<Edition, string[]> = {
  ar: ['arabic', 'العربية', 'عربية', 'اللغة العربية', 'علوم اللغة'],
  en: ['english', 'الانجليزية', 'انجليزية', 'اللغة الانجليزية', 'انكليزية', 'الانكليزية'],
};
const POS = new Set(['noun', 'proper noun', 'verb', 'adjective', 'adverb', 'pronoun', 'determiner', 'article', 'preposition', 'postposition', 'conjunction', 'interjection', 'numeral', 'particle', 'prefix', 'suffix', 'phrase', 'proverb', 'اسم', 'اسم علم', 'فعل', 'صفة', 'ظرف', 'ضمير', 'حرف', 'عدد', 'اداة', 'عبارة', 'مثل']);
const DEFINITIONS = new Set(['definitions', 'المعاني', 'معاني', 'المعنى', 'معنى']);
const ETYMOLOGY = new Set(['etymology', 'الاصل والاشتقاق', 'الاصل', 'اصل', 'اشتقاق', 'الاشتقاق', 'الجذر والاشتقاق']);
const SYNONYMS = new Set(['synonyms', 'مرادفات', 'المرادفات', 'مرادف', 'المرادف']);
const TRANSLATIONS = new Set(['translations', 'ترجمات', 'الترجمات', 'ترجمة', 'الترجمة']);
const INFLECTION = new Set(['inflection', 'declension', 'conjugation', 'التصريفات', 'التصريف', 'تصريف', 'الجمع', 'جمع']);
const BLOCKS = new Set(['p', 'ol', 'ul', 'dl', 'table']);
const ROOT = /(?:^|\s)(?:من\s+)?(?:ال)?جذر\s+[\p{Script=Arabic}\p{M}]+/u;
const PATTERN = /(?:على\s+وزن|الوزن|وزنه)\s+[\p{Script=Arabic}\p{M}]+|\b(?:pattern|form)\s+(?:[IVX]+|[\p{Script=Arabic}\p{M}]+)(?=[\s.,;)]|$)/u;
const PLURAL = /\b(?:plural|plurals)\b|(?:^|[\s(])(?:الجمع|جمع|يجمع)(?:[\s:)]|$)/iu;

function linkedTitle(anchor: Element, origin: string): string | undefined {
  const href = attribute(anchor, 'href');
  if (!href || hasClass(anchor, 'new')) return undefined;
  try {
    const url = new URL(href, `${origin}/wiki/`);
    if (url.origin !== origin || !url.pathname.startsWith('/wiki/') || url.search) return undefined;
    const title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replaceAll('_', ' ');
    return validTitle(title) ? title : undefined;
  } catch {
    return undefined;
  }
}

function linkedLemmas(item: Element, origin: string): string[] {
  const wrappers = [...elements(item, node => !OMIT.has(node.tagName))].filter(node => hasClass(node, 'form-of-definition-link'));
  return wrappers.flatMap(wrapper => [...elements(wrapper)]
    .filter(anchor => anchor.tagName === 'a')
    .map(anchor => linkedTitle(anchor, origin))
    .filter((word): word is string => word !== undefined));
}

function translationLabel(value: string): string {
  return label(value).replace(/^(?:بال|ب(?=انجليز|عربي)|ال|في\s+ال)/u, '');
}

function translations(block: Element, target: string): string[] {
  const requested = translationLabel(target);
  const aliases = Object.values(LANGUAGES).find(names => names.map(translationLabel).includes(requested));
  const names = new Set(aliases?.map(translationLabel) ?? [requested]);
  // Translation tables can nest lists. Inspect each row without treating its child list as part of that row.
  return [...elements(block)].filter(item => item.tagName === 'li').map(excerpt).filter(value => {
    const colon = value.indexOf(':');
    return colon >= 0 && names.has(translationLabel(value.slice(0, colon))) && Boolean(value.slice(colon + 1).trim());
  });
}

function listItems(block: Element): Element[] {
  return block.childNodes.filter(isElement).filter(node => node.tagName === 'li');
}

export function readEntry(html: string, origin: string, title: string, request: EntryRequest) {
  const document = parseFragment(html);
  const lines = new Set<string>();
  const forms = new Set<string>();
  const lemmas = new Set<string>();
  const headings: { depth: number; key: string; text: string }[] = [];
  let inLanguage = false;
  const add = (text: string) => {
    // Keep each complete quotation or omit it. The shared search engine caps snippets at 2,000 characters.
    if (text && text.length <= 420 && lines.size < 4) lines.add(text);
  };
  const linkForms = (block: Element) => {
    if (request.language !== 'ar') return;
    for (const anchor of elements(block)) {
      if (anchor.tagName !== 'a') continue;
      const word = linkedTitle(anchor, origin);
      if (word && word !== title && stripArabicMarks(word) === stripArabicMarks(title)) forms.add(word);
    }
  };

  for (const node of elements(document, node => !BLOCKS.has(node.tagName))) {
    if (!headings.length && hasClass(node, 'disambig-see-also')) linkForms(node);
    const heading = /^h([2-6])$/u.exec(node.tagName);
    if (heading) {
      const text = excerpt(node), key = label(text), depth = Number(heading[1]);
      while (headings.length && headings.at(-1)!.depth >= depth) headings.pop();
      headings.push({ depth, key, text });
      if (depth === 2) inLanguage = LANGUAGES[request.language].includes(key);
      if (inLanguage && request.intent === 'spelling') add(title);
      if (inLanguage && request.intent === 'partOfSpeech' && POS.has(key)) add(text);
      continue;
    }
    if (!BLOCKS.has(node.tagName)) continue;
    if (!inLanguage) {
      if (!headings.length) linkForms(node);
      continue;
    }
    const key = headings.at(-1)?.key ?? '';
    if (headings.some(section => TRANSLATIONS.has(section.key))) {
      if (request.intent === 'translation' && request.target) translations(node, request.target).forEach(add);
      continue;
    }
    const list = listItems(node);
    const values = list.length ? list.map(excerpt) : node.tagName === 'p' ? [excerpt(node)] : [];
    const lexical = POS.has(key) || DEFINITIONS.has(key);
    const headwordSection = lexical || stripArabicMarks(headings.at(-1)?.text ?? '') === stripArabicMarks(title);
    if (request.language === 'en' && request.intent !== 'spelling' && request.intent !== 'partOfSpeech' && lexical) {
      for (const item of list) for (const word of linkedLemmas(item, origin)) if (word !== title) lemmas.add(word);
    }
    switch (request.intent) {
      case 'definition':
        if (headwordSection) list.map(excerpt).forEach(add);
        break;
      case 'partOfSpeech':
        if (DEFINITIONS.has(key) && node.tagName === 'p') values.filter(text => /(?:^|\s)(?:اسم|فعل|صفة|حرف)(?=[\s.]|$)/u.test(stripArabicMarks(text))).forEach(add);
        break;
      case 'plural':
        if (headwordSection || INFLECTION.has(key)) {
          values.filter(value => PLURAL.test(stripArabicMarks(value)) || key === 'الجمع' || key === 'جمع').forEach(add);
        }
        break;
      case 'root':
        if (headwordSection || ETYMOLOGY.has(key) || key === 'الجذر' || key === 'جذر') {
          values.filter(value => ROOT.test(stripArabicMarks(value))).forEach(add);
          for (const anchor of elements(node)) {
            if (anchor.tagName === 'a' && attribute(anchor, 'title')?.startsWith('Appendix:Arabic roots/')) add(excerpt(anchor));
          }
        }
        break;
      case 'pattern':
        if (headwordSection || ETYMOLOGY.has(key)) values.filter(value => PATTERN.test(stripArabicMarks(value))).forEach(add);
        break;
      case 'etymology':
        if (ETYMOLOGY.has(key) && node.tagName === 'p') values.forEach(add);
        break;
      case 'synonyms':
        if (SYNONYMS.has(key)) values.forEach(add);
        if (headwordSection) {
          for (const item of list) {
            for (const note of elements(item)) {
              if (hasClass(note, 'nyms') && hasClass(note, 'synonym')) add(excerpt(note));
            }
          }
        }
        break;
    }
  }
  return { lines: [...lines], forms: [...forms], lemmas: [...lemmas] };
}
