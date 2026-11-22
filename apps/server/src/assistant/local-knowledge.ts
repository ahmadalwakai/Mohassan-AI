import { buildFrame } from './mind/frame.js';
import { recall } from './mind/recall.js';
import { fixedReply, type LocalReply } from './mind/limits.js';
import { matchText } from './mind/normalize.js';

export interface LocalKnowledgeDocument { title: string; text: string; source: string }
export interface LocalKnowledgeDeps {
  /** Host-owned retrieval of active, evaluated owner documents; never client-provided excerpts. */
  knowledge(query: string): Promise<readonly LocalKnowledgeDocument[]>;
}
export interface LocalKnowledgeOptions {
  maxDocuments?: number;
  maxDocumentChars?: number;
  maxTotalChars?: number;
  timeoutMs?: number;
}

const COPY = {
  ar: {
    missing: 'لم أجد المعلومة المطلوبة في المستندات المقيّمة المتاحة لي.',
    unavailable: 'تعذّر قراءة المستندات المقيّمة الآن، لذلك لم أتحقق من المعلومة المطلوبة.',
    recorded: 'هذه معلومة مسجّلة في المستند، ولم أتحقق من أنها تعبّر عن الحالة الحالية.',
  },
  en: {
    missing: 'I couldn’t find the requested information in the evaluated documents available to me.',
    unavailable: 'I couldn’t read the evaluated documents, so I haven’t verified the requested information.',
    recorded: 'This is a recorded document statement; I haven’t verified that it reflects the current state.',
  },
} as const;

const DOCUMENT = /\b(?:documents?|files?|guides?|manuals?|handbooks?|knowledge base|uploaded|imported|evaluated records?|internal records?)\b|(?:مستند|وثيق|وثايق|وثائق|ملف|ملفات|دليل|كتيب|قاعده المعرفه|المرفوع|المستورد|السجلات الداخليه)/iu;
const LOCAL_DOCUMENT = /\b(?:my|our|local|private|internal|saved|uploaded|imported|evaluated)\b[^.!?؟\n]{0,100}\b(?:documents?|files?|guides?|manuals?|handbooks?|records?|knowledge base)\b|\b(?:documents?|files?|records?)\b[^.!?؟\n]{0,60}\b(?:uploaded|imported|evaluated|saved)\b|(?:مستنداتي|مستنداتنا|وثائقي|وثائقنا|ملفاتي|ملفاتنا|دليلي|دليلنا|مستندي|ملفي|وثيقتي)(?!\p{L})|(?:مستند|وثيقه|ملف|دليل|سجل)[^.!?؟\n]{0,80}(?:الخاص|الداخلي|المحفوظ|المقيم|المرفوع|المستورد)|(?:المستندات|الوثائق|الملفات|السجلات)\s+(?:المقيمه|المحفوظه|الداخليه|المرفوعه|المستورده)/iu;
const RECORDED_SOURCE = /\b(?:according to|from|in|within|listed|stated|recorded|documented|specified|reported)\b|(?<!\p{L})(?:حسب|في|من|ورد|مذكور|مدون|مسجل|المحدد)(?!\p{L})/iu;
const MEMORY_ONLY = /\b(?:from memory|in memory|my memory|our memory|saved notes?|my notes?)\b|(?:ذاكرتي|ذاكرتنا|ذاكرتك|من الذاكره|في الذاكره|ملاحظاتي|ملاحظاتنا)/iu;
const FRESH = /\b(?:right now|currently|current|today|latest|at present|this (?:week|month|year))\b|(?<!\p{L})(?:الان|حاليا|اليوم|احدث|هذا (?:الاسبوع|الشهر|العام))(?!\p{L})/iu;
const HISTORICAL = /\b(?:first|former|historical|history|founded|invented|in\s+(?:1\d{3}|20\d{2}))\b|(?:اول|السابق|تاريخي|تاريخيه|تاسس|اخترع|عام\s+\d{4}|سنه\s+\d{4})/iu;
const TIME_VARYING_PUBLIC = /\b(?:president|prime minister|ceo|chief executive|chairperson|mayor|governor|minister|head of|dean|chancellor|exchange rate|interest rate|weather|forecast|prices?|stocks?|share price|news|elections?|scores?|standings?|rankings?|schedule|opening hours|population|regulations?|laws?|versions?|releases?)\b|(?:رئيس|رييس|المدير التنفيذي|عمده|محافظ|وزير|سعر الصرف|سعر الفائده|طقس|الطقس|الاسعار|اسعار|سعر|اسهم|اخبار|انتخابات|نتيجه المباراه|ترتيب الدوري|جدول المباريات|ساعات العمل|عدد السكان|قوانين|لوائح|الاصدار الحالي|احدث اصدار)(?!\p{L})/iu;
const CODE_FILE = /(?:^|[\s/\\])[^\s/\\]+\.(?:tsx?|jsx?|mjs|cjs|py|json|ya?ml|toml|env|sql|sh|ps1)(?:[\s?!؟.,]|$)|[a-z]:\\/iu;
const DEVICE_QUERY = /\b(?:my (?:computer|pc|desktop|screen)|(?:open|active|current) windows|windows (?:are|currently)|desktop apps?|running applications?)\b|(?:جهازي|كمبيوتري|حاسبي|شاشتي|سطح المكتب|النوافذ المفتوحه|البرامج المفتوحه)/iu;
const WEB_REQUEST = /\b(?:search|look up|check|browse)\b[^.!?؟\n]{0,80}\b(?:online|internet|web)\b|\b(?:from|on) the (?:web|internet)\b|(?:ابحث|تحقق|تصفح)[^.!?؟\n]{0,60}(?:الويب|الانترنت|النت)(?!\p{L})/iu;

/** Select document retrieval before personal memory only when a document is named. */
export const isKnowledgeDocumentRequest = (request: string): boolean => DOCUMENT.test(matchText(request));

// Matching is performed on a folded copy; returned evidence remains verbatim.
const ROLE_DIRECTIVE = /(?:^|[\r\n\u0085\u2028\u2029])\s*(?:system|developer|assistant|instruction|النظام|المطور|المساعد|تعليمات)\s*[:：]|```[ \t]*(?:system|developer|assistant|instructions?)\b|<\|(?:system|developer|assistant|im_start|im_end)|<\/?(?:system|developer|assistant)>/iu;
const OVERRIDE_DIRECTIVE = /\b(?:ignore|disregard|override|bypass|forget)\b[^.!?؟\r\n]{0,180}\b(?:instructions?|user|developer|system|prompt|previous|request|rules?)\b|(?:تجاهل|تخط|انس|اهمل)[^.!?؟\r\n]{0,180}(?:التعليمات|المستخدم|المطور|النظام|الرساله|الطلب|القواعد|السابق)/iu;
const OUTPUT_DIRECTIVE = /(?:^|[.!?؟؛;。\r\n\u0085\u2028\u2029])\s*(?:(?:you|the assistant)\s+(?:must|should|will)\s+(?:answer|reply|output|print|say|reveal|execute|send)|(?:answer|reply|output|print|say|reveal|execute|send|delete|click|submit)\b|(?:يجب عليك|على المساعد|علي المساعد)\s*(?:ان\s+)?(?:تجيب|ترد|تطبع|تكشف|تنفذ|ترسل)|(?:اطبع|اكشف|نفذ|ارسل|احذف|انقر)(?!\p{L}))/iu;

function instructionLike(value: string): boolean {
  const text = matchText(value).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '');
  return ROLE_DIRECTIVE.test(text) || OVERRIDE_DIRECTIVE.test(text) || OUTPUT_DIRECTIVE.test(text);
}

function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value!))) : fallback;
}

function selectedDocuments(raw: readonly LocalKnowledgeDocument[], options: LocalKnowledgeOptions): LocalKnowledgeDocument[] {
  const maxDocuments = limit(options.maxDocuments, 8, 1, 16);
  const maxDocumentChars = limit(options.maxDocumentChars, 12_000, 64, 32_000);
  const maxTotalChars = limit(options.maxTotalChars, 40_000, 256, 96_000);
  const documents: LocalKnowledgeDocument[] = [];
  const seen = new Set<string>();
  let total = 0;
  // The real retriever already returns bounded chunks. Bound the adapter again,
  // including malformed dependencies, without truncating a source mid-statement.
  for (const item of raw.slice(0, 32)) {
    if (!item || typeof item.title !== 'string' || typeof item.text !== 'string' || typeof item.source !== 'string') continue;
    const title = item.title.trim(), source = item.source.trim();
    if (!title || title.length > 300 || !source || source.length > 500 || !item.text.trim() || item.text.length > maxDocumentChars
        || /[\u0000-\u001f\u007f]/u.test(title + source) || instructionLike(title) || instructionLike(source) || instructionLike(item.text)) continue;
    if (total + item.text.length > maxTotalChars) continue;
    const identity = `${source}\u0000${title}\u0000${item.text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    documents.push({ title, text: item.text, source });
    total += item.text.length;
    if (documents.length >= maxDocuments) break;
  }
  return documents;
}

async function retrieve(deps: LocalKnowledgeDeps, query: string, signal: AbortSignal, timeoutMs: number): Promise<readonly LocalKnowledgeDocument[] | null> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const timedOut = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const rows = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return deps.knowledge(query); }), timedOut, aborted]);
    signal.throwIfAborted();
    return Array.isArray(rows) ? rows : null;
  } catch (error) {
    signal.throwIfAborted();
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * A local, extractive capability independent of the experimental Mind route.
 * Retrieval authority belongs to the host. Documents supply evidence, never
 * instructions, permissions, live-state guarantees or a network destination.
 * This function never fetches a source URI or invokes a model.
 */
export async function evaluateLocalKnowledge(request: string, deps: LocalKnowledgeDeps, signal: AbortSignal,
    options: LocalKnowledgeOptions = {}): Promise<LocalReply | null> {
  signal.throwIfAborted();
  if (typeof request !== 'string' || !request.trim() || request.length > 4000) return null;
  const frame = buildFrame(request);
  const folded = matchText(frame.text);
  const documentRequest = DOCUMENT.test(folded);
  if (frame.urls.length || CODE_FILE.test(folded) || WEB_REQUEST.test(folded) || !documentRequest && DEVICE_QUERY.test(folded) || frame.missing.length
      || !['fact_question', 'memory_recall'].includes(frame.intent) || MEMORY_ONLY.test(folded) && !documentRequest) return null;
  const localOnly = frame.personal || LOCAL_DOCUMENT.test(folded);
  const recordedRequest = documentRequest && RECORDED_SOURCE.test(folded) && !FRESH.test(folded);
  const dynamic = frame.timeSensitive || TIME_VARYING_PUBLIC.test(folded) && !HISTORICAL.test(folded);
  if (dynamic && !localOnly && !recordedRequest) return null;
  const raw = await retrieve(deps, frame.text, signal, limit(options.timeoutMs, 2000, 1, 10_000));
  const copy = COPY[frame.lang];
  if (!raw) return localOnly ? fixedReply(copy.unavailable, 'blocked') : null;
  const documents = selectedDocuments(raw, options);
  if (!documents.length) return localOnly ? fixedReply(copy.missing, 'blocked', 'not_found') : null;
  const reply = await recall({ ...frame, personal: false, intent: 'fact_question' }, request,
    { knowledge: async () => documents }, signal, { source: 'knowledge' });
  signal.throwIfAborted();
  if (!reply?.evidence.length) return localOnly ? fixedReply(copy.missing, 'blocked', 'not_found') : null;
  // Preserve the original host provenance and verify every excerpt against the
  // exact bounded sources passed to extraction. No model-written citation enters.
  const evidence = reply.evidence.map(item => {
    const matches = documents.filter(document => document.text.includes(item.quote)
      && (!item.title || document.title === item.title) && (!item.sourceRef || document.source === item.sourceRef));
    return item.source === 'knowledge' && item.quote.trim() && matches.length === 1
      ? { ...item, title: matches[0].title, sourceRef: matches[0].source } : null;
  });
  if (evidence.some(item => !item)) return localOnly ? fixedReply(copy.missing, 'blocked', 'not_found') : null;
  const proven = evidence.filter(item => item !== null);
  const ids = new Set(proven.map(item => item.id));
  if (reply.claims.some(claim => claim.support.some(id => !ids.has(id)))) return localOnly ? fixedReply(copy.missing, 'blocked', 'not_found') : null;
  if (dynamic && !recordedRequest) {
    return { ...reply, status: 'partial', text: `${reply.text}\n\n${copy.recorded}`, evidence: proven,
      claims: [...reply.claims, { text: copy.recorded, support: [], status: 'fixed' }] };
  }
  return { ...reply, evidence: proven };
}
