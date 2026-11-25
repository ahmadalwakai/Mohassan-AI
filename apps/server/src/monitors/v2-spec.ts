import {
  MONITOR_V2_DEFAULT_FRESHNESS_MS, MonitorSpecSchema, type MonitorSpec, type MonitorTrend, type MonitorValueTarget, type MonitorV2Target,
} from '@mohassan/contracts';
import { parseNumberWords } from '../assistant/reasoning/number-words.js';
import { monitorCurrencyPair, monitorMatchText, monitorPageUrl, type MonitorNeed } from './detection.js';
import { generateMonitorSpec } from './spec.js';

const address = /https?:\/\/[^\s<>"'`«»“”]+/giu;
const directionWord = /\b(?:falls?|drops?|decreases?|rises?|increases?|go(?:es)? (?:up|down))\b|(?<!\p{L})(?:ينخفض|تنخفض|ينزل|تنزل|يرتفع|ترتفع|يزيد|تزيد)(?!\p{L})/giu;
const falls = /^(?:fall|drop|decrease|go(?:es)? down|ينخفض|تنخفض|ينزل|تنزل)/u;
const timeUnit = 'minutes?|hours?|days?|weeks?|دقيقه|دقائق|ساعه|ساعات|يوم|ايام|اسبوع|اسابيع';
const duration = String.raw`(\d+)\s+(${timeUnit})(?!\p{L})`;
const within = new RegExp(String.raw`(?:\bwithin|(?<!\p{L})خلال)\s+${duration}`, 'giu');
const freshness = new RegExp(String.raw`(?:\bfresh within|\bno older than|(?<!\p{L})لا يتجاوز عمرها)\s+${duration}`, 'u');
const repeat = /\bevery time\b|(?<!\p{L})كلما(?!\p{L})|(?<!\p{L})في كل مره(?!\p{L})/u;
const daily = /\bdaily (?:digest|summary)\b|(?<!\p{L})(?:ملخص يومي|خلاصه يوميه)(?!\p{L})/u;
const product = /\bproduct name\b|(?<!\p{L})اسم المنتج(?!\p{L})/u;
const eventStatus = /\bevent status\b|(?<!\p{L})حاله (?:الفعاليه|الحدث)(?!\p{L})/u;
const startDate = /\b(?:event )?start date\b|(?<!\p{L})(?:تاريخ البدء|(?:تاريخ )?(?:بدء|بدايه) (?:الفعاليه|الحدث))(?!\p{L})/u;
const currencies = new Set(Intl.supportedValuesOf('currency'));

function durationMs(match: RegExpMatchArray | null | undefined): number | undefined {
  if (!match) return;
  const amount = Number(match[1]);
  const minutes = /^(?:hour|ساع)/u.test(match[2]) ? 60 : /^(?:day|يوم|ايام)/u.test(match[2]) ? 24 * 60
    : /^(?:week|اسبوع|اسابيع)/u.test(match[2]) ? 7 * 24 * 60 : 1;
  return amount * minutes * 60_000;
}

function trendCondition(body: string, language: MonitorSpec['language']): MonitorTrend | null | undefined {
  const foundDirection = Array.from(body.matchAll(directionWord)).at(-1);
  if (!foundDirection) return;
  const direction = falls.test(foundDirection[0]) ? 'fall' : 'rise';
  const afterDirection = body.slice(foundDirection.index + foundDirection[0].length).trim();
  const rawCount = /^(?:over\s+|for\s+)?(.{1,40}?)\s+checks?\s+in a row\b|^(.{1,40}?)\s+(?:فحوص|فحوصات|مرات|قراءات)\s+متتالي(?:ه|ات)?(?!\p{L})/u.exec(afterDirection);
  if (rawCount) {
    const words = (rawCount[1] ?? rawCount[2]).split(/\s+/u);
    const count = words.map((_word, index) => parseNumberWords(words.slice(index).join(' '), language)).find(value => value !== null);
    const checks = Number(count);
    return checks >= 2 ? { kind: 'consecutive', direction, checks } : null;
  }
  const percentage = /(?:^|\s+(?=بنسبه ))(?:by +|بنسبه +)?(\d+(?:\.\d+)?)\s*(?:%|٪|percent\b|بالمئه(?!\p{L}))/u.exec(afterDirection);
  const window = Array.from(afterDirection.matchAll(within))[0];
  if (percentage && window) {
    const percent = Number(percentage[1]);
    const windowMs = durationMs(window);
    return percent > 0 && windowMs ? { kind: 'percent-window', direction, percent, windowMs } : null;
  }
}

function structuredTarget(spec: MonitorSpec, body: string): MonitorValueTarget | undefined {
  if (spec.source.kind !== 'page') return;
  const property = product.test(body) ? 'productName' : eventStatus.test(body) ? 'eventStatus' : startDate.test(body) ? 'startDate'
    : spec.read.kind === 'number' && spec.read.label === 'price' ? 'price'
      : spec.read.kind === 'status' && spec.read.label === 'availability' ? 'availability' : undefined;
  if (spec.read.kind !== 'number') return property && { property };
  const code = /\b(?:in|currency)\s+([a-z]{3})\b|(?<!\p{L})(?:بالعمله|بعمله)\s+([a-z]{3})\b|\d\s+([a-z]{3})\b/u.exec(body);
  const currency = (code?.[1] ?? code?.[2] ?? code?.[3])?.toUpperCase();
  const unit = /(?:\bin units? of|(?<!\p{L})بوحده)\s+([\p{L}°%/]{1,24})(?!\p{L})/u.exec(body)?.[1];
  if (property || unit || currency && currencies.has(currency)) {
    return { ...(property && { property }), ...(currency && currencies.has(currency) && { currency }), ...(unit && { unit }) };
  }
}

function parseTarget(need: MonitorNeed, now: Date): { spec: MonitorSpec; target: MonitorV2Target } | null {
  const body = monitorMatchText(need.text.replace(address, ' '));
  const trend = trendCondition(body, need.language);
  if (trend === null) return null;
  const changes = need.language === 'ar' ? 'يتغير' : 'changes';
  const pageContent = need.language === 'ar' ? 'محتوى الصفحة' : 'page content';
  const productName = product.test(body);
  const event = eventStatus.test(body);
  const date = startDate.test(body);
  const field = productName || event || date;
  const primary = generateMonitorSpec(need, now) ?? ((trend || field) && generateMonitorSpec({ ...need,
    text: `${trend ? need.text.replace(directionWord, changes) : need.text} ${field ? pageContent : ''} ${changes}` }, now));
  if (!primary) return null;

  let selected = primary;
  if (primary.source.kind === 'page' && field) {
    const subject = need.language === 'ar' ? productName ? 'اسم المنتج' : event ? 'حالة الفعالية' : 'تاريخ البدء'
      : productName ? 'Product name' : event ? 'Event status' : 'Start date';
    const title = `${new URL(primary.source.url).hostname} · ${subject}`;
    selected = { ...primary, read: { kind: productName ? 'main' : event ? 'status' : 'date' }, condition: { kind: 'change' }, title,
      message: need.language === 'ar' ? `تحقّق شرط المراقبة لـ «${title}».` : `The monitoring condition was met for ${title}.` };
  }
  if (trend) {
    if (selected.read.kind !== 'number') return null;
    selected = { ...selected, condition: { kind: 'change' } };
  }
  const target = structuredTarget(selected, body);
  const freshnessMs = durationMs(freshness.exec(body));
  const v2 = { freshnessMs: freshnessMs ?? MONITOR_V2_DEFAULT_FRESHNESS_MS, ...(target && { target }), ...(trend && { trend }) };
  return { spec: { ...selected, v2 },
    target: { source: selected.source, read: selected.read, condition: selected.condition, ...v2 } };
}

type Connector = 'and' | 'or' | 'sequence';

function splitSources(text: string) {
  const links = Array.from(text.matchAll(address));
  const parts: string[] = [];
  const connectors: Connector[] = [];
  let start = 0;
  for (const match of text.matchAll(/(?:[,،]\s*|\s+)(and\s+|or\s+|then\s+|ثم\s+|[أا]و\s+|و\s*)/giu)) {
    const end = match.index + match[0].length;
    if (links.some(link => link.index < end && link.index + link[0].length > match.index)) continue;
    const tail = text.slice(end);
    const tailBody = monitorMatchText(tail);
    const leadsToSource = /^(?:(?:monitor|watch|track|if|when|at|on|for|the|price (?:of|at|on)|راقب|تابع|اذا|عندما|عند|في|سعر)\s+){0,4}https?:\/\//iu.test(tail)
      || Boolean(monitorCurrencyPair(tailBody.split(/\s+/u, 4).join(' ')))
      || /^(?:the )?(?:weather|temperature|wind|rain|الطقس|الحراره|درجه الحراره|الرياح|المطر)\s+(?:in|at|for|في)\s/u.test(tailBody);
    if (!leadsToSource) continue;
    const connector = monitorMatchText(match[1]);
    parts.push(text.slice(start, match.index));
    connectors.push(connector === 'then' || connector === 'ثم' ? 'sequence' : connector === 'or' || connector === 'او' ? 'or' : 'and');
    start = end;
  }
  return { parts: [...parts, text.slice(start)], connectors };
}

export function generateMonitorV2Spec(need: MonitorNeed, now = new Date()): MonitorSpec | null {
  if (need.kind !== 'explicit') {
    const spec = generateMonitorSpec(need, now);
    return spec && { ...spec, v2: { freshnessMs: MONITOR_V2_DEFAULT_FRESHNESS_MS } };
  }
  const { parts, connectors } = splitSources(need.text);
  if (parts.length > 3 || new Set(connectors).size > 1 || connectors[0] === 'sequence' && parts.length !== 2) return null;
  const parsed = parts.map((text, index) => parseTarget(parts.length === 1 ? need : {
    ...need, text, sourceUrl: monitorPageUrl(text), ...(index > 0 && { sourceText: undefined }),
  }, now));
  const [first, ...rest] = parsed;
  if (!first || rest.some(part => !part)) return null;
  const body = monitorMatchText(need.text.replace(address, ' '));
  const additional = rest.flatMap(part => part?.target ?? []);
  const hasNewItem = [first.target, ...additional].some(item => item.condition.kind === 'new-item');
  const delivery = hasNewItem ? daily.test(body) ? 'daily' : repeat.test(body) ? 'each' : undefined : undefined;
  const connector = connectors[0];
  const windowMs = connector === 'sequence' ? durationMs(Array.from(body.matchAll(within)).at(-1)) : undefined;
  if (connector === 'sequence' && !windowMs) return null;
  const combine = connector === 'sequence' ? { kind: connector, windowMs } : connector ? { kind: connector } : undefined;
  const title = parsed.flatMap(part => part?.spec.title ?? []).join(' · ').slice(0, 180);
  const message = connector ? need.language === 'ar' ? `تحقّق شرط المراقبة لـ «${title}».` : `The monitoring condition was met for ${title}.` : first.spec.message;
  const v2 = { freshnessMs: first.target.freshnessMs, ...first.spec.v2,
    ...(combine && { combine, additional }), ...(delivery && { delivery }) };
  const result = MonitorSpecSchema.safeParse({ ...first.spec, title, message, v2 });
  return result.success ? result.data : null;
}
