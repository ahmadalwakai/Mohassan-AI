import { normalizeRequest } from '../assistant/mind/normalize.js';
import { recognizeMarket } from '../live-data/recognize-market.js';
import type { MonitorCard } from '@mohassan/contracts';
import { monitorMatchText, monitorPageUrl, safeMonitorRequest } from './detection.js';

type Language = 'ar' | 'en';
type Verb = 'pause' | 'resume' | 'stop';

export type MonitorManagementChange =
  | { kind: Verb; target: string }
  | { kind: 'threshold'; target: string; value: number; hysteresis: number }
  | { kind: 'delivery'; target: string; delivery: 'each' | 'daily' }
  | { kind: 'offers'; enabled: boolean };

export type MonitorManagement = { language: Language } & (MonitorManagementChange | { kind: 'list' });

const languageOf = (text: string) => normalizeRequest(text).lang;
const list = /^(?:what (?:are you monitoring(?: for me)?|monitors? (?:are|do i) have)|(?:show(?: me)?|list) (?:all (?:of )?)?my monitors|ماذا تراقب(?: لي)?|ما(?:ذا)? هي مراقباتي|اعرض(?: لي)? مراقباتي|ما المراقبات النشطه)$/u;
const controls: ReadonlyArray<readonly [Verb, RegExp]> = [
  ['pause', /^(?:pause (?:monitoring|(?:my |the )?monitor(?: for)?)|اوقف م[وؤ]قتا مراقبه|علق مراقبه)\s+(.+)$/u],
  ['resume', /^(?:resume (?:monitoring|(?:my |the )?monitor(?: for)?)|استأنف مراقبه|استانف مراقبه|واصل مراقبه)\s+(.+)$/u],
  ['stop', /^(?:stop (?:monitoring|(?:my |the )?monitor(?: for)?)|الغ(?:ي|اء)? مراقبه|انه مراقبه|اوقف مراقبه)\s+(.+)$/u],
];
const threshold = /^(?:change (?:the |my )?threshold(?: (?:for|of) (.+?))? to|غير (?:لي )?(?:الحد|عتبه التنبيه)(?: (?:ل|في) ?(.+?))? الي) ([+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,12})?)$/u;
const digest = /^(?:send me (?:a )?daily digest(?: for (.+?))?(?: instead of (?:each|individual) alerts?)?|(?:ارسل|ابعث) لي ملخصا? يوميا?(?: (?:ل|عن) ?(.+?))?(?: بدل(?:ا? من)? كل تنبيه)?)$/u;
const individual = /^(?:send me (?:each alert|individual alerts)(?: for (.+?))? instead of (?:a |the )?daily digest|(?:ارسل|ابعث) لي كل تنبيه(?: (?:ل|عن) ?(.+?))? بدل(?:ا? من)? الملخص اليومي)$/u;
const offerSetting = /^(?:turn (on|off) (?:proactive |smart )?monitor(?:ing)? offers|(?:فعل|شغل|الغ|عطل|اوقف) (?:ال)?عروض المراقبه)$/u;

export function parseMonitorManagement(text: string): MonitorManagement | null {
  if (text.length > 800) return null;
  const body = monitorMatchText(normalizeRequest(text).text).replace(/[.!?؟]+$/u, '');
  const language = languageOf(text);
  if (list.test(body)) return { kind: 'list', language };
  const setting = offerSetting.exec(body);
  if (setting) return { kind: 'offers', language, enabled: setting[1] === 'on' || /^(?:فعل|شغل) /u.test(body) };
  const change = threshold.exec(body);
  if (change) {
    const numeric = change[3].replace(/,/gu, '').replace('−', '-');
    const value = Number(numeric);
    if (!Number.isFinite(value)) return null;
    return { kind: 'threshold', language, target: change[1] ?? change[2] ?? '', value,
      hysteresis: 10 ** -(numeric.split('.')[1]?.length ?? 0) };
  }
  const daily = digest.exec(body);
  const each = daily ? null : individual.exec(body);
  if (daily || each) return { kind: 'delivery', language, target: (daily ?? each)?.[1] ?? (daily ?? each)?.[2] ?? '', delivery: daily ? 'daily' : 'each' };
  for (const [kind, pattern] of controls) {
    const target = pattern.exec(body)?.[1];
    if (target) return { kind, language, target };
  }
  return null;
}

function matchesTarget(card: MonitorCard, target: string, language: Language): boolean {
  const title = monitorMatchText(card.spec.title);
  if (title === target || title.startsWith(`${target} `) || title.endsWith(` ${target}`)) return true;
  const source = card.spec.source;
  if (source.kind === 'currency') {
    const market = recognizeMarket(`exchange rate ${target}`, language, target);
    if (market?.kind === 'exchange') return market.from === source.base && market.to === source.quote;
    if (market?.kind === 'exchange-quote') return market.from === source.base || market.from === source.quote;
  } else if (source.kind === 'weather') return monitorMatchText(source.location) === target;
  else if (source.kind === 'search') return monitorMatchText(source.query) === target;
  else if (source.kind === 'page') return monitorMatchText(source.url) === target || monitorMatchText(source.anchor ?? '') === target;
  return false;
}

export function monitorManagementTargets(cards: readonly MonitorCard[], intent: MonitorManagementChange & { language: Language }, conversationId: string): MonitorCard[] {
  if (intent.kind === 'offers') return [];
  const eligible = cards.filter(card => {
    if (card.status !== 'active' && card.status !== 'paused') return false;
    if (intent.kind === 'threshold' && card.spec.condition.kind !== 'threshold' && card.spec.condition.kind !== 'crossing') return false;
    if (intent.kind === 'delivery' && card.spec.condition.kind !== 'new-item'
      && card.spec.v2?.delivery !== 'each' && card.spec.v2?.delivery !== 'daily') return false;
    return !intent.target || matchesTarget(card, intent.target, intent.language);
  });
  const contextual = eligible.filter(card => card.conversationId === conversationId);
  return intent.target || !contextual.length ? eligible : contextual;
}

const requestLead = /^(?:is|are|when|has|have|check (?:if|whether)|tell me (?:if|whether|when)|هل|متي|امتي|تحقق (?:من|هل)|اخبرني (?:هل|متي))(?!\p{L})/u;
const refusal = /\b(?:i (?:cannot|can't|could not|couldn't|am unable to|was unable to)|i (?:did not|didn't) (?:verify|confirm)|unable to (?:verify|confirm)|if you (?:mean|meant)|which (?:product|event|page))\b|(?:لم اتمكن|لا استطيع|لم اتحقق|لا يمكنني|لم يتضح|اذا كنت تقصد|اي (?:منتج|رابط|صفحه) تقصد)/u;
const uncertain = /\b(?:might|may|could|possibly|probably|if|unless|reportedly|unconfirmed|no longer|not sold out|was sold out)\b|(?:ربما|يحتمل|قد يكون|قد تكون|اذا كان|اذا كانت|لم يتاكد|لم تعد)/u;
const soon = /\b(?:coming|available) soon\b|(?:قريبا|قريبًا)/u;

const offers = [
  { topic: 'registration', request: /\b(?:registration|enroll?ment|sign[ -]?ups?|applications?)\b|(?:التسجيل|تسجيل|الالتحاق|التقديم)/u,
    pending: /\b(?:registration|enroll?ment|sign[ -]?ups?|applications?) (?:is (?:currently )?closed|(?:will )?opens? (?:on|at|in|soon)|(?:is )?coming soon)\b|(?:التسجيل|التقديم|الالتحاق) (?:مغلق|(?:سيفتح|سيفتح باب التسجيل|يفتح|يبدا|سيبدا) (?:في|يوم|قريبا)|قريبا)|(?:سيفتح|سيبدا) (?:باب )?(?:التسجيل|التقديم) (?:في|يوم|قريبا)/u,
    before: 'registration closed', after: 'registration open', title: { ar: 'فتح التسجيل', en: 'Registration opening' } },
  { topic: 'tickets', request: /\btickets?\b|تذاكر|تذكره/u,
    pending: /\btickets? (?:are (?:currently )?)?(?:sold out|unavailable|coming soon|go on sale (?:on|at|in|soon))\b|(?:نفدت? التذاكر|التذاكر (?:نفدت?|غير متوفره|غير متاحه|قريبا))/u,
    before: 'tickets unavailable', after: 'tickets available', title: { ar: 'توفر التذاكر', en: 'Ticket availability' } },
  { topic: 'availability', request: /\b(?:in stock|in store|available|availability|restock(?:ed)?|product|sold out)\b|(?:متوفر|متاح|توفر|المخزون|منتج|نفدت? الكميه)/u,
    pending: /\b(?:sold out|out of stock|coming soon|available soon)\b|(?:نفدت? (?:ال)?كميه|غير متوفر|قريبا)/u,
    before: 'out of stock', after: 'in stock', title: { ar: 'توفر المنتج', en: 'Product availability' } },
] as const;

export interface MonitorAnswerPage {
  url: string;
  text?: string;
  documentStatus?: number;
  observedAt?: string;
  signals?: { captcha: boolean; password: boolean; otp: boolean; card: boolean };
}

function factualPending(text: string, pending: RegExp): string | undefined {
  return text.match(/[^.!?؟\n؛;]+[.!?؟\n؛;]?/gu)?.find(part => {
    const normalized = monitorMatchText(part);
    return !/[?؟]$/u.test(normalized) && !uncertain.test(normalized) && pending.test(normalized);
  })?.trim().slice(0, 320);
}

export function detectMonitorAnswerOffer(request: string, answer: string, pages: readonly MonitorAnswerPage[]) {
  if (!pages.length || request.length > 800 || answer.length > 2_000) return null;
  const url = monitorPageUrl(request) ?? monitorPageUrl(answer);
  if (!url) return null;
  const normalizedRequest = monitorMatchText(normalizeRequest(request).text);
  const normalizedAnswer = monitorMatchText(answer);
  if (!requestLead.test(normalizedRequest) || refusal.test(normalizedAnswer)) return null;
  const candidate = offers.find(offer => offer.request.test(normalizedRequest)
    && (factualPending(answer, offer.pending) || offer.topic === 'registration' && factualPending(answer, soon)));
  if (!candidate || !safeMonitorRequest(request)) return null;
  const page = pages.findLast(entry => monitorPageUrl(entry.url) === url && entry.text
    && (entry.documentStatus === undefined || entry.documentStatus >= 200 && entry.documentStatus < 300)
    && !Object.values(entry.signals ?? {}).some(Boolean));
  if (!page?.text) return null;
  const excerpt = factualPending(page.text.slice(0, 12_000), candidate.pending)
    ?? (candidate.topic === 'registration' ? factualPending(page.text.slice(0, 12_000), soon) : undefined);
  if (!excerpt) return null;
  const canonical = new URL(url);
  for (const key of [...canonical.searchParams.keys()]) if (/^(?:utm_.+|gclid|fbclid)$/iu.test(key)) canonical.searchParams.delete(key);
  canonical.searchParams.sort();
  const topic = `${canonical.hostname}${canonical.pathname.replace(/\/$/u, '')}${canonical.search}`;
  const language = languageOf(request);
  return { url, topic, language, label: candidate.topic, before: candidate.before, after: candidate.after,
    title: candidate.title[language], excerpt, observedAt: page.observedAt };
}
