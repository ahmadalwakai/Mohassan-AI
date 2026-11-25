import { publicSearchText, safeResumeUrl } from '@mohassan/browser';
import type { Evidence, Lang } from '../mind/contract.js';
import { isPageInstruction, typedNumbers } from '../mind/extract.js';
import { matchText, stripCourtesyTail } from '../mind/normalize.js';
import { reasoned, reasoningGap, type ReasoningResult } from './result.js';

export interface ComparisonPage {
  url: string;
  title: string;
  text: string;
  observedAt?: string;
}

interface Request {
  measure?: string;
  order: 'high' | 'low';
  limit?: number;
  data: string;
  scoped: boolean;
}

interface Row {
  name: string;
  measure?: string;
  raw: string;
  evidence: Evidence;
  header?: Evidence;
}

interface Quantity {
  amount: number;
  domain: string;
}

const aliases: Record<string, string> = {
  'surface area': 'area', 'total area': 'area', 'مساحه': 'area', 'المساحه': 'area',
  'طول': 'length', 'الطول': 'length', 'ارتفاع': 'height', 'الارتفاع': 'height',
  'عمر': 'age', 'العمر': 'age', 'سن': 'age', 'السن': 'age',
  'born': 'birth', 'birth date': 'birth', 'date of birth': 'birth', 'تاريخ الميلاد': 'birth', 'الميلاد': 'birth', 'ولد': 'birth',
  'founded': 'founded', 'founding date': 'founded', 'تاريخ التاسيس': 'founded', 'تاسس': 'founded',
  'mass': 'weight', 'وزن': 'weight', 'الوزن': 'weight', 'كتله': 'weight', 'الكتله': 'weight',
  'عدد السكان': 'population', 'السكان': 'population', 'سكان': 'population',
  'سعر': 'price', 'السعر': 'price', 'درجه': 'score', 'الدرجه': 'score',
  'وقت': 'duration', 'الوقت': 'duration', 'المده': 'duration', 'مده': 'duration',
};

const label = /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd} .'’_-]{0,59}$/u;
const field = /^[\p{L}][\p{L}\p{M} _-]{0,39}$/u;
const key = (text: string) => matchText(text.trim()).replace(/\s+/gu, ' ');
const metric = (text: string) => aliases[key(text)] ?? key(text);
const terminal = (text: string) => text.trim().replace(/[.!?؟]+$/u, '').trimEnd();
const names = /\s+(?:and|or|versus|vs\.?|[أا]م|[أا]و|مع|و)\s+|[,،]\s+|[,،](?=\p{L})|[؛;\n]/iu;
const fields = '\\p{L}[\\p{L}\\p{M} _-]{0,39}';
const fieldValue = new RegExp(`^(${fields})\\s*[:=]\\s*(.+)$`, 'u');
const labelledValue = /^(.+?)\s*[:=]\s*(.+)$/u;
const digits = '[+−-]?(?:\\d{1,3}(?:(?:[,،٬])\\d{3})+|\\d+)(?:[.٫]\\d+)?';
const scalar = new RegExp(`^(${digits})(?:\\s*([\\p{L}%٪][\\p{L}\\p{Nd}²%٪ ]{0,30}))?$`, 'u');
const unlabelled = /^(.+?)\s+(?=[+−-]?\p{Nd})(.+)$/u;
const isDate = /^\d{4}-\d{2}-\d{2}$/u;
const KNOWN_METRICS = new Set(['area', 'length', 'height', 'age', 'birth', 'founded', 'weight', 'population', 'price', 'score', 'duration']);
const MAX_COHORT = 30;
const MAX_CITATIONS = 40;
const MAX_PAGE_TEXT = 60_000;
const COUNTS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  واحد: 1, اثنين: 2, اثنان: 2, اثنتين: 2, ثلاثه: 3, ثلاث: 3, اربعه: 4, اربع: 4,
  خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, ثمانيه: 8, ثمان: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10,
};
const adjectives: readonly { words: string; order: Request['order']; measure?: string }[] = [
  { words: 'larger|largest|bigger|biggest|higher|highest|greater|اكبر|اعلي|الاكبر|الاعلي', order: 'high' },
  { words: 'smaller|smallest|lower|lowest|less|اصغر|اقل|الاصغر|الاقل', order: 'low' },
  { words: 'older|oldest|اكبر سنا|اقدم|الاقدم', order: 'high', measure: 'age' },
  { words: 'younger|youngest|اصغر سنا|احدث|الاحدث', order: 'low', measure: 'age' },
  { words: 'longer|longest|اطول|الاطول', order: 'high', measure: 'length' },
  { words: 'taller|tallest|اعلي ارتفاعا', order: 'high', measure: 'height' },
  { words: 'shorter|shortest|اقصر|الاقصر', order: 'low', measure: 'length' },
  { words: 'heavier|heaviest|اثقل|الاثقل', order: 'high', measure: 'weight' },
  { words: 'lighter|lightest|اخف|الاخف', order: 'low', measure: 'weight' },
  { words: 'more populous|most populous|اكثر سكانا', order: 'high', measure: 'population' },
  { words: 'least populous|less populous|اقل سكانا', order: 'low', measure: 'population' },
];
const scope = /(?:^|\s)(?:(?:in|on|from) (?:this|that|the) (?:open page|page|table|list|data)|among these|(?:في|من|علي|حسب) (?:(?:(?:هذه|هذي|هات) )?الصفحه|هالصفحه|هذا الجدول|هالجدول|الجدول|هذه القائمه|البيانات))(?:$|(?=\s|[,:،؛?؟]))/iu;
const comparisonLead = /^(?:(?:which|what|who)(?: one)? (?:is|are|was|were) (?:the )?|(?:ايهما|مين(?: فيهم)?|وش|ايش|شنو|ايه|ما(?: هي| هو)?|من(?: هي| هو)?|اي)\s+)/u;
const rankLead = /^(?:rank(?: them| these| the entries)?|compare(?: them| these| the entries)?|رتب(?: لي|لي|ها|هم)?|قارن(?: لي|لي|ها|هم)?)(?=$|[\s،:])/u;
const tailOrder = /\s+(?:ascending|descending|from (?:highest to lowest|lowest to highest)|تصاعديا|تنازليا|من (?:الاكبر للاصغر|الاصغر للاكبر))$/u;
const firstCount = /^(?:the )?(top|bottom|اعلي|اقل)\s+([\p{L}\d]+)(?=$|[\s،:])/u;
const fromCount = (value: string) => /^\d{1,2}$/u.test(value) ? Number(value) : COUNTS[value];

function originalTail(original: string, folded: string) {
  const tail = original.trimEnd().split(/\s+/u).slice(-folded.split(/\s+/u).length).join(' ');
  return key(tail) === folded ? tail : folded;
}

function comparisonRequest(request: string): Request | null {
  const original = terminal(stripCourtesyTail(request)).replace(/^(?:please|kindly|لو سمحت|من فضلك)[\s،,:]+/iu, '');
  const folded = key(original);
  const scoped = scope.test(folded);
  // Do not turn a class such as “country” into a subject or assume the evidence
  // ranks the world. An explicit cohort or page scope authorizes a local rank.
  const headBoundary = /[?:؟：]|\n/.exec(original)?.index ?? original.length;
  const rawHead = original.slice(0, headBoundary);
  let head = key(rawHead).replace(scope, ' ').trim();
  let data = terminal(original.slice(headBoundary + 1)).replace(/^[\s:：]+/u, '');
  const rank = rankLead.exec(head);
  let order: Request['order'] = 'high';
  let limit: number | undefined = rank ? undefined : 1;
  let measure: string | undefined;

  if (rank) {
    head = head.slice(rank[0].length).trim();
    const direction = tailOrder.exec(` ${head}`);
    if (direction) {
      order = /ascending|lowest to highest|تصاعديا|الاصغر للاكبر/u.test(direction[0]) ? 'low' : 'high';
      head = head.slice(0, Math.max(0, direction.index - 1)).trim();
    }
  } else {
    head = head.replace(comparisonLead, '').replace(/^(?:show(?: me)?|list|هات(?: لي|لي)?|جيب(?: لي|لي)?|عطني|اعطني)\s+(?:the )?/u, '');
    const top = firstCount.exec(head);
    if (top && fromCount(top[2]) !== undefined) {
      order = /^(?:bottom|اقل)$/u.test(top[1]) ? 'low' : 'high';
      limit = fromCount(top[2]);
      head = head.slice(top[0].length).trim();
    } else {
      const found = adjectives.flatMap(adjective => {
        const match = new RegExp(`^(?:${adjective.words})(?=$|[\\s،,:])`, 'u').exec(head);
        return match ? [{ adjective, length: match[0].length }] : [];
      }).sort((a, b) => b.length - a.length)[0];
      if (!found) return null;
      ({ order, measure } = found.adjective);
      head = head.slice(found.length).trim();
      const count = /^([\p{L}\d]+)(?=$|[\s،,:])/u.exec(head);
      const amount = count ? fromCount(count[1]) : undefined;
      if (count && amount !== undefined && (head === count[0] || !names.test(head))) {
        limit = amount;
        head = head.slice(count[0].length).trim();
      }
    }
  }
  if (limit !== undefined && (limit < 1 || limit > MAX_COHORT)) return null;

  const qualified = /(?:^|\s)(?:by|حسب|بحسب|من حيث)\s+(.+)$/u.exec(head);
  if (qualified && field.test(qualified[1])) {
    measure = metric(qualified[1]);
    head = head.slice(0, qualified.index).trim();
  }
  const among = /(?:^|\s)(?:among|between|من بين|بين)\s+(.+)$/u.exec(head);
  if (among && !data) {
    data = originalTail(rawHead, among[1]);
    head = head.slice(0, among.index).trim();
  }
  if (!data && names.test(head)) {
    data = originalTail(rawHead, head);
    head = '';
  }
  if (head && !scoped && !data) return null;
  return { measure, order, limit, data, scoped };
}

export function isComparisonRequest(text: string): boolean {
  return comparisonRequest(text) !== null;
}

export function isScopedComparisonRequest(text: string): boolean {
  return comparisonRequest(text)?.scoped ?? false;
}

function parsedQuantity(raw: string, measure?: string): Quantity | null {
  const value = key(raw).replace(/^\((.+)\)$/u, '$1');
  if (isDate.test(value)) {
    if (!['birth', 'founded'].includes(measure ?? '')) return null;
    const date = Date.parse(value);
    return Number.isFinite(date) && new Date(date).toISOString().startsWith(value) ? { amount: date, domain: measure! } : null;
  }
  const result = scalar.exec(value);
  if (!result) return null;
  const [, numeric, suffix] = result;
  const amount = Number(numeric.replace(/[,،٬]/gu, '').replace('٫', '.').replace('−', '-'));
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER || numeric.replace(/\D/gu, '').length > 15) return null;
  if (!suffix) {
    if (measure === 'birth' || measure === 'founded') return null;
    return { amount, domain: measure === 'age' ? 'age:years' : 'number' };
  }
  if (/^(?:years?|yrs?|سن[هة]|سنوات|عاما?|اعوام)$/u.test(suffix)) return { amount, domain: 'age:years' };
  if (/^(?:people|persons?|residents?|inhabitants?|نسمه|شخصا?|اشخاص)$/u.test(suffix)) return { amount, domain: 'number' };
  const area = /^(?:(km|m|كم|م)\s*[2²]|(square kilomet(?:ers?|res?)|كيلو ?متر مربع|كم مربع)|(square met(?:ers?|res?)|متر مربع))$/u.exec(suffix);
  if (area) return { amount: amount * (area[2] || /^(?:كم|km)$/u.test(area[1] ?? '') ? 1_000_000 : 1), domain: 'area:m2' };
  const known = typedNumbers(value);
  if (known.length === 1 && key(known[0].value) === value && known[0].unit !== 'number') {
    // The shared unit reader uses floats. Canonicalize its roundoff within the
    // precision limit of the decimal input before testing equality or ties.
    return { amount: Number(known[0].number.toPrecision(15)), domain: known[0].unit };
  }
  const unit = ({ م: 'm', كم: 'km', سم: 'cm', كغ: 'kg', كجم: 'kg' } as Record<string, string>)[suffix];
  return unit ? parsedQuantity(`${numeric} ${unit}`, measure) : { amount, domain: suffix };
}

function isComparable(measure: string | undefined, domain: string) {
  if (domain === 'number' || !measure) return true;
  switch (measure) {
    case 'length': case 'height': return domain === 'length:m';
    case 'area': return domain === 'area:m2';
    case 'weight': return domain === 'mass:g';
    case 'duration': return domain === 'duration:s';
    case 'population': return false;
    case 'age': return domain === 'age:years';
    default: return true;
  }
}

function inlineRow(part: string, evidence: Evidence, measure?: string): Row | null {
  const raw = terminal(part).replace(/^[-*]\s+/u, '');
  const assignment = labelledValue.exec(raw);
  const literal = parsedQuantity(raw, measure);
  const parens = /^(.+?)\s*\(([^()]+)\)$/u.exec(raw);
  const parts = assignment ?? parens ?? (literal ? null : unlabelled.exec(raw));
  const name = parts?.[1]?.trim() ?? raw;
  if (!label.test(name) && !literal) return null;
  const value = parts?.[2]?.trim() ?? (literal ? raw : '');
  const explicitField = fieldValue.exec(value);
  const born = /^(?:born|ولد|founded|تاسس)\s+(.+)$/u.exec(key(value));
  return {
    name, measure: explicitField ? metric(explicitField[1]) : born ? metric(key(value).split(' ')[0]) : measure,
    raw: explicitField?.[2] ?? born?.[1] ?? value, evidence,
  };
}

function safeQuote(text: string) {
  return text.length <= 250 && !/[<>\x60[\]\p{Cf}]/u.test(text) && publicSearchText(text) === text && !isPageInstruction(text);
}

function tableRows(lines: readonly string[], source: (quote: string) => Evidence): Row[] {
  const rows: Row[] = [];
  let header: { fields: string[]; units: string[]; separator: RegExp; evidence: Evidence } | undefined;
  for (const line of lines) {
    const cells = header?.separator ?? (/\|/u.test(line) ? /\s*\|\s*/u : /\t/u);
    const row = line.startsWith('|') ? line.slice(1).replace(/\|$/u, '') : line;
    const cellsOfRow = row.split(cells).map(cell => cell.trim());
    if (cellsOfRow.length < 2 || cellsOfRow.length > 8 || !safeQuote(line)) { header = undefined; continue; }
    if (/^(?:name|subject|item|entity|country|river|الاسم|البند|الدوله|النهر)$/u.test(key(cellsOfRow[0]))) {
      const fieldsAndUnits = cellsOfRow.slice(1).map(cell => /^(.*?)\s*(?:\(([^()]+)\))?$/u.exec(cell)!);
      if (fieldsAndUnits.every(([, value]) => field.test(value))) {
        header = { fields: fieldsAndUnits.map(([, value]) => metric(value)), units: fieldsAndUnits.map(([, , unit]) => unit ?? ''), separator: cells, evidence: source(line) };
      }
      continue;
    }
    if (!header || cellsOfRow.length !== header.fields.length + 1 || !label.test(cellsOfRow[0])) continue;
    for (const [index, measure] of header.fields.entries()) {
      const value = cellsOfRow[index + 1];
      const unit = header.units[index];
      const raw = unit && scalar.test(key(value)) && !scalar.exec(key(value))?.[2] ? `${value} ${unit}` : value;
      rows.push({ name: cellsOfRow[0], measure, raw, evidence: source(line), header: header.evidence });
    }
  }
  return rows;
}

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function pageRows(page: ComparisonPage): Row[] {
  const url = safeResumeUrl(page.url);
  if (!url) return [];
  const title = safeQuote(page.title) ? page.title : undefined;
  const source = (quote: string): Evidence => ({
    id: '', source: 'site', quote, url, title, ...(page.observedAt ? { fetchedAt: page.observedAt } : {}),
  });
  const lines = page.text.split(/\r?\n/u).map(line => line.trim());
  const rows = tableRows(lines, source);
  for (const line of lines) for (const { segment } of sentences.segment(line)) {
    const quote = segment.trim();
    if (!safeQuote(quote)) continue;
    const parsed = inlineRow(quote, source(quote));
    if (parsed?.measure && parsed.raw) rows.push(parsed);
    else {
      const entry = fieldValue.exec(terminal(quote));
      if (entry && title && label.test(title.trim()) && KNOWN_METRICS.has(metric(entry[1]))) {
        rows.push({ name: title.trim(), measure: metric(entry[1]), raw: entry[2], evidence: source(quote) });
      }
    }
  }
  return rows;
}

function evidenceRows(evidence: readonly Evidence[]): Row[] {
  return evidence.flatMap(item => {
    if (!safeQuote(item.quote) || (item.url && !safeResumeUrl(item.url))) return [];
    const inline = inlineRow(item.quote, item);
    if (inline?.measure) return [inline];
    const entry = fieldValue.exec(terminal(item.quote));
    const measure = entry && KNOWN_METRICS.has(metric(entry[1])) ? metric(entry[1]) : undefined;
    const raw = measure ? entry![2] : item.value && terminal(item.quote) === item.value ? item.value : undefined;
    if (raw !== undefined && item.title && safeQuote(item.title) && label.test(item.title.trim())) {
      return [{ name: item.title.trim(), measure, raw, evidence: item }];
    }
    if (inline && inline.raw && item.value === inline.raw) return [inline];
    return [];
  });
}

const fitsMeasure = (measure: string | undefined, requested: string | undefined) =>
  !requested || !measure || measure === requested || (requested === 'age' && (measure === 'birth' || measure === 'founded'));

const provenance = (row: Row, lang: Lang) => {
  const source = row.evidence;
  const label = source.source === 'computed' ? lang === 'ar' ? 'من بياناتك' : 'your data'
    : (source.sourceRef && safeQuote(source.sourceRef) ? source.sourceRef : undefined) ?? (lang === 'ar' ? 'الدليل' : 'evidence');
  return `- ${row.name} — «${source.quote}» (${label})${source.url ? ` ${source.url}` : ''}`;
};

/** Order a cohort whose members are identified by the request or by scoped, labelled observations. */
export function reasonComparison(text: string, lang: Lang, evidence: readonly Evidence[] = [], pages: readonly ComparisonPage[] = []): ReasoningResult | null {
  const request = comparisonRequest(text);
  if (!request) return null;
  const userEvidence = (quote: string): Evidence => ({ id: '', source: 'computed', quote });
  const parts = request.data.split(names).map(part => part.trim()).filter(Boolean);
  const inline = parts.map(part => safeQuote(part) ? inlineRow(part, userEvidence(part), request.measure) : null);
  if (inline.some(row => row === null)) return null;
  const asked = inline.filter((row): row is Row => row !== null);
  const hasContext = evidence.length > 0 || pages.length > 0;
  if (asked.length < 2 && !request.scoped && (asked.length !== 0 || !hasContext)) return null;
  if (!request.scoped && !asked.some(row => row.raw) && !hasContext) return null;

  const ar = lang === 'ar';
  const tooLarge = () => reasoningGap(lang, ar ? 'البيانات أكثر مما يمكن ترتيبه في مقارنة واحدة. حدّد مجموعة أصغر.'
    : 'There is too much evidence for one comparison. Specify a smaller cohort.');
  if (evidence.length > 120 || pages.length > 5 || pages.some(page => page.text.length > MAX_PAGE_TEXT)) return tooLarge();
  const observed = [...asked.filter(row => row.raw), ...evidenceRows(evidence), ...pages.flatMap(pageRows)];
  const cohort = new Map(asked.map(row => [key(row.name), row.name]));
  const byName = new Map<string, Row[]>();
  for (const row of observed) {
    const name = key(row.name);
    if ((asked.length && !cohort.has(name)) || !fitsMeasure(row.measure, request.measure)) continue;
    if (!cohort.has(name)) cohort.set(name, row.name);
    if (cohort.size > MAX_COHORT) return tooLarge();
    const rows = byName.get(name);
    if (rows) rows.push(row);
    else byName.set(name, [row]);
  }
  if (cohort.size > MAX_COHORT) return tooLarge();
  const shown: Row[] = [];
  const accepted: { name: string; value: Quantity; measure?: string }[] = [];
  const gaps: string[] = [];
  for (const [nameKey, name] of cohort) {
    const rows = byName.get(nameKey) ?? [];
    const supported = rows.flatMap(row => {
      const measure = row.measure ?? request.measure;
      const value = parsedQuantity(row.raw, measure);
      return value && isComparable(measure, value.domain) ? [{ row, value, measure }] : [];
    });
    const first = supported[0];
    shown.push(...rows);
    if (!first) gaps.push(ar ? `لا توجد قيمة موثّقة قابلة للمقارنة لـ«${name}».` : `No comparable value is supported for “${name}”.`);
    else if (supported.some(({ value, measure }) => value.amount !== first.value.amount || value.domain !== first.value.domain || measure !== first.measure)) {
      gaps.push(ar ? `الأدلة على قيمة «${name}» متعارضة.` : `The evidence for “${name}” conflicts.`);
    } else accepted.push({ name, value: first.value, measure: first.measure });
  }
  const labelSet = new Set(accepted.flatMap(item => item.measure ?? []));
  if (accepted.some(item => item.value.domain !== accepted[0].value.domain) || labelSet.size > 1) {
    gaps.push(ar ? 'القيم الموثّقة تختلف في نوع القياس أو الوحدة.' : 'The supported values use different measures or incompatible units.');
  }
  if (cohort.size < Math.max(2, request.limit ?? 0)) {
    gaps.push(ar ? 'لا توجد بيانات كافية لإكمال المقارنة المطلوبة.' : 'There are too few documented entries for the requested comparison.');
  }
  const unique = [...new Map(shown.map(row => [JSON.stringify([row.name, row.evidence.quote, row.evidence.url, row.evidence.sourceRef]), row])).values()];
  const headers = [...new Map(unique.flatMap(row => row.header ? [[JSON.stringify([row.header.url, row.header.quote]), row.header] as const] : [])).values()];
  if (unique.length + headers.length > MAX_CITATIONS) return tooLarge();
  const citations = [
    ...headers.map(header => `- ${ar ? 'عنوان أعمدة الجدول' : 'Table column headings'} — «${header.quote}» ${header.url}`),
    ...unique.map(row => provenance(row, lang)),
  ];
  const sources = [...headers, ...unique.map(row => row.evidence)].map((source, at): Evidence => ({ ...source, id: `comparison-${at + 1}` }));
  if (gaps.length) return reasoningGap(lang, [...gaps, ...citations].join('\n'), sources);

  const chronological = ['birth', 'founded'].includes(accepted[0].value.domain);
  const sign = (request.order === 'high') === chronological ? 1 : -1;
  accepted.sort((a, b) => sign * (a.value.amount - b.value.amount));
  const cutoff = request.limit ? accepted[request.limit - 1].value.amount : undefined;
  const ranked = accepted.filter((item, index) => !request.limit || index < request.limit || item.value.amount === cutoff);
  const groups: string[][] = [];
  for (const [index, item] of ranked.entries()) {
    if (index && item.value.amount === ranked[index - 1].value.amount) groups.at(-1)!.push(item.name);
    else groups.push([item.name]);
  }
  const value = groups.map(group => group.join(' = ')).join(' → ');
  const heading = ar ? 'بالترتيب المطلوب ضمن القيم التي قارنتها' : 'In the requested order among the values compared';
  return reasoned(lang, [`${heading} — ${value}`, ...citations].join('\n'), value, sources);
}
