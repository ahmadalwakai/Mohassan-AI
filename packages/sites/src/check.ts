import type { SiteBrief, SiteCheckReport } from '@mohassan/contracts';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { asciiDigits, telDigits } from './html.ts';
import { findNumbers } from './text.ts';
import { contrastRatio, deriveTheme, themePairs } from './theme.ts';
import { fileBytes } from './compose.ts';
import type { ComposeOptions, SiteFile } from './types.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const attr = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value;

interface PageFacts {
  path: string; errors: number; headings: number[]; h1: number; images: { alt: string | undefined }[];
  links: string[]; sources: string[]; forms: string[]; text: string[]; lang?: string; dir?: string; title: string; description?: string; viewport?: string; csp?: string; inlineHandlers: number; inlineStyles: number;
}
function readPage(path: string, html: string): PageFacts {
  let errors = 0;
  const document = parse(html, { onParseError: () => { errors++; } });
  const facts: PageFacts = { path, errors, headings: [], h1: 0, images: [], links: [], sources: [], forms: [], text: [], title: '', inlineHandlers: 0, inlineStyles: 0 };
  const walk = (node: Node, skip: boolean) => {
    if (isElement(node)) {
      const tag = node.tagName;
      if (tag === 'html') { facts.lang = attr(node, 'lang'); facts.dir = attr(node, 'dir'); }
      if (/^h[1-6]$/.test(tag)) { facts.headings.push(Number(tag[1])); if (tag === 'h1') facts.h1++; }
      if (tag === 'img') { facts.images.push({ alt: attr(node, 'alt') }); const src = attr(node, 'src'); if (src) facts.sources.push(src); const srcset = attr(node, 'srcset'); if (srcset) for (const part of srcset.split(',')) facts.sources.push(part.trim().split(/\s+/)[0]!); }
      if (tag === 'a') { const href = attr(node, 'href'); if (href) facts.links.push(href); }
      if (tag === 'link') { const href = attr(node, 'href'); if (href) facts.sources.push(href); }
      if (tag === 'script') { const src = attr(node, 'src'); if (src) facts.sources.push(src); }
      if (tag === 'form') { const action = attr(node, 'action'); if (action) facts.forms.push(action); }
      if (tag === 'title') facts.title = children(node).map(child => ('value' in child ? child.value : '')).join('');
      if (tag === 'meta') { const name = attr(node, 'name'), equiv = attr(node, 'http-equiv'); if (name === 'description') facts.description = attr(node, 'content'); if (name === 'viewport') facts.viewport = attr(node, 'content'); if (equiv?.toLowerCase() === 'content-security-policy') facts.csp = attr(node, 'content'); }
      for (const attribute of node.attrs) { if (/^on[a-z]+$/i.test(attribute.name)) facts.inlineHandlers++; if (attribute.name === 'style') facts.inlineStyles++; }
      const skipText = skip || tag === 'script' || tag === 'style' || tag === 'template';
      for (const child of children(node)) walk(child, skipText);
      if (tag === 'template' && 'content' in node) for (const child of children((node as unknown as { content: Node }).content)) walk(child, true);
    } else if ('value' in node && !skip && node.nodeName === '#text') facts.text.push(node.value);
    else for (const child of children(node)) walk(child, skip);
  };
  walk(document, false);
  facts.errors = errors;
  return facts;
}

const USER_TEXT_KEYS = new Set(['name', 'tagline', 'city', 'address', 'phone', 'whatsapp', 'email', 'hours', 'title', 'detail', 'price', 'offer', 'body', 'lead', 'question', 'answer', 'role', 'bio', 'features', 'note', 'period', 'value', 'label', 'quote', 'date', 'alt', 'lines']);
const phoneNumber = (value: string) => telDigits(value).replace(/^\+/, '');

function numberReader(brief: SiteBrief) {
  const contacts = [brief.phone, brief.whatsapp].flatMap(value => value ? [phoneNumber(value)] : []);
  const knownPhones = contacts.sort((a, b) => b.length - a.length).map(digits => {
    const groups = [...digits].join(String.raw`[().\p{Zs}\t-]*`);
    return String.raw`(?:(?:\+|00)[\p{Zs}\t]*)?\(?${groups}\)?`;
  });
  // In prose, a leading plus, trunk zero or parenthesized area code identifies a formatted phone.
  const explicitPhone = String.raw`(?:\+\d+|0\d+|\(\d+\))(?:(?:[.-]|[\p{Zs}\t]+)(?:\(\d+\)|\d+)|\(\d+\))+`;
  const candidates = new RegExp(String.raw`(?<!\d|\d[.,:٫٬-])(?:${[...knownPhones, explicitPhone].join('|')})(?!\d|[.,:٫٬-]\d|\(\d+\))`, 'gu');
  return (value: string): string[] => {
    const runs: string[] = [];
    const text = asciiDigits(value).replace(candidates, candidate => {
      // A single dot between digit runs can be a decimal price.
      if (/^\+?\d+\.\d+$/.test(candidate)) return candidate;
      const phone = phoneNumber(candidate);
      if (!contacts.includes(phone) && !findNumbers(candidate).some(number => phoneNumber(number.digits) === phone)) return candidate;
      runs.push(phone);
      return ' ';
    });
    return [...runs, ...(text.match(/\d+(?:[.,:٫٬]\d+)*/g) ?? [])];
  };
}

function briefNumbers(brief: SiteBrief, numberRuns: ReturnType<typeof numberReader>): Set<string> {
  const runs = new Set<string>();
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === 'string') {
      if (key && USER_TEXT_KEYS.has(key)) for (const run of numberRuns(value)) runs.add(run);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
    if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(brief, null);
  return runs;
}

/** Complete numeric tokens from the brief, with contact numbers normalised. */
export function briefDigitRuns(brief: SiteBrief): Set<string> {
  return briefNumbers(brief, numberReader(brief));
}

const isRelative = (ref: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(ref);
const strip = (ref: string) => ref.split('#')[0]!.split('?')[0]!;

/**
 * Model-free quality checks on a composed site. The report is what the user sees next to the preview,
 * so every message says what was checked, not only that something failed.
 */
export function checkSite(files: SiteFile[], brief: SiteBrief, options: ComposeOptions = {}): SiteCheckReport {
  const paths = new Set(files.map(file => file.path));
  const pages = files.filter((file): file is SiteFile & { content: string } => file.path.endsWith('.html') && typeof file.content === 'string').map(file => readPage(file.path, file.content));
  const css = files.find(file => file.path === 'styles.css');
  const cssText = css && typeof css.content === 'string' ? css.content : '';
  const checks: SiteCheckReport['checks'] = [];
  const add = (id: string, passed: boolean, message: string) => checks.push({ id, passed, message: message.slice(0, 300) });
  const bytes = files.reduce((sum, file) => sum + fileBytes(file), 0);
  const where = (bad: string[]) => (bad.length ? `: ${bad.slice(0, 4).join(', ')}` : '');

  const invalid = pages.filter(page => page.errors > 0);
  add('html_valid', invalid.length === 0, invalid.length ? `HTML parse errors in ${invalid.map(page => `${page.path} (${page.errors})`).join(', ')}` : `All ${pages.length} pages parse without errors.`);
  const h1 = pages.filter(page => page.h1 !== 1);
  add('one_h1', h1.length === 0, h1.length ? `Pages without exactly one h1${where(h1.map(page => page.path))}` : 'Each page has exactly one h1.');
  const skips = pages.filter(page => page.headings.some((level, index) => index > 0 && level > page.headings[index - 1]! + 1));
  add('heading_order', skips.length === 0, skips.length ? `Heading levels skip a step${where(skips.map(page => page.path))}` : 'Heading levels never skip.');
  const alt = pages.filter(page => page.images.some(image => image.alt === undefined));
  add('img_alt', alt.length === 0, alt.length ? `Images without alt${where(alt.map(page => page.path))}` : 'Every image has an alt attribute.');
  const langDir = pages.filter(page => page.lang !== brief.lang || page.dir !== (brief.lang === 'ar' ? 'rtl' : 'ltr'));
  add('lang_dir', langDir.length === 0, langDir.length ? `lang/dir mismatch${where(langDir.map(page => page.path))}` : `Every page declares lang="${brief.lang}" and the matching direction.`);
  const meta = pages.filter(page => !page.title || !page.description || page.description.length > 160 || !page.viewport);
  add('title_description', meta.length === 0, meta.length ? `Missing title, description (≤160) or viewport${where(meta.map(page => page.path))}` : 'Every page has a title, a description and a viewport.');
  const csp = pages.filter(page => !page.csp || !/default-src 'none'/.test(page.csp) || !/script-src 'self'/.test(page.csp));
  add('csp_meta', csp.length === 0, csp.length ? `Missing or weak CSP meta${where(csp.map(page => page.path))}` : 'Every page carries a strict Content-Security-Policy.');
  const handlers = pages.filter(page => page.inlineHandlers > 0 || page.inlineStyles > 0);
  add('no_inline_code', handlers.length === 0, handlers.length ? `Inline handlers or styles${where(handlers.map(page => page.path))}` : 'No inline event handlers or style attributes.');

  const broken: string[] = [];
  for (const page of pages) for (const ref of [...page.links, ...page.sources]) { if (!isRelative(ref)) continue; const target = strip(ref); if (target && !paths.has(target)) broken.push(`${page.path} → ${ref}`); }
  add('internal_links', broken.length === 0, broken.length ? `Internal links to missing files${where(broken)}` : 'Every internal link and asset resolves.');
  const allowed = new Set<string>([brief.mapUrl ?? '', ...Object.values(brief.social ?? {}), options.formEndpoint ?? ''].filter(Boolean));
  const external: string[] = [];
  for (const page of pages) {
    for (const href of page.links) if (!isRelative(href) && !/^(?:tel:|mailto:|https:\/\/wa\.me\/|#)/.test(href) && !allowed.has(href)) external.push(`${page.path} → ${href}`);
    for (const src of page.sources) if (!isRelative(src)) external.push(`${page.path} loads ${src}`);
    for (const action of page.forms) if (!isRelative(action) && !/^(?:mailto:|https:\/\/wa\.me\/)/.test(action) && action !== options.formEndpoint) external.push(`${page.path} posts to ${action}`);
  }
  add('external_refs', external.length === 0, external.length ? `Unexpected external references${where(external)}` : 'No external scripts, styles, fonts or images; only tel, mail, WhatsApp, the map and social links leave the site.');

  const theme = deriveTheme(brief.primary, brief.mood);
  const weak = themePairs(theme).filter(pair => contrastRatio(pair.foreground, pair.background) < pair.minimum);
  add('contrast', weak.length === 0, weak.length ? `Low contrast${where(weak.map(pair => `${pair.name} ${contrastRatio(pair.foreground, pair.background).toFixed(2)}`))}` : 'Every text colour pair meets WCAG AA (4.5:1).');
  const mediaQueries = (cssText.match(/@media/g) ?? []).length;
  add('media_queries', mediaQueries >= 2, `${mediaQueries} media queries in styles.css.`);

  const numberRuns = numberReader(brief);
  const material = briefNumbers(brief, numberRuns);
  const invented: string[] = [];
  for (const page of pages) {
    for (const run of page.text.flatMap(numberRuns)) {
      if (!material.has(run)) invented.push(`${page.path}: ${run}`);
    }
  }
  add('digits_from_brief', invented.length === 0, invented.length ? `Numbers not found in the brief${where([...new Set(invented)])}` : 'Every number on the pages comes from the brief.');
  add('size', true, `${bytes} bytes in ${files.length} files; ${pages.length} pages.`);
  return { passed: checks.every(check => check.passed), checks, bytes, pages: pages.length };
}
