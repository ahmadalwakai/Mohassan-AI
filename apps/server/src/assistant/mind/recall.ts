import { asksToRemember } from '../brain.js';
import { memoryRecallFormat, verifyMemoryRecall } from '../memory-recall.js';
import type { Evidence, Frame, MindDeps } from './contract.js';
import { fixedReply, type LocalReply } from './limits.js';

const COPY = {
  ar: {
    noMemory: 'لم أجد المعلومة المطلوبة في الذاكرة.',
    noKnowledge: 'لم أجد المعلومة المطلوبة في المستندات المقيّمة.',
    saved: 'حفظت كلامك في الذاكرة.',
    cannotSave: 'تعذّر حفظ الملاحظة في الذاكرة.',
    memory: 'من الذاكرة',
    document: 'من مستند',
  },
  en: {
    noMemory: 'I couldn’t find the requested information in memory.',
    noKnowledge: 'I couldn’t find the requested information in the evaluated documents.',
    saved: 'I saved your note in memory.',
    cannotSave: 'I couldn’t save the note in memory.',
    memory: 'From memory',
    document: 'From document',
  },
} as const;

const QUOTE_END = /[\r\n\u0085\u2028\u2029!?؟。؛;]|(?<!\d)\.|\.(?!\d)/u;
const INSTRUCTION = /\b(?:ignore|disregard|override|forget|bypass)\b[^.!?؟\r\n]*(?:\b(?:instructions?|user|developer|system|prompt|previous|request)\b)|^(?:\s*(?:assistant|system|developer|instruction)\s*:|\s*(?:ignore|disregard|reveal|say|output|execute|click|submit|send|open|delete)\b)|(?:تجاهل|تخط|انس|اضرب)[^.!?؟\r\n]*(?:التعليمات|السائل|المستخدم|الطلب|الرسالة|السابق)|^\s*(?:تجاهل|اذكر|اطبع|اكشف|نفذ|انقر|ارسل|افتح|احذف)(?!\p{L})/iu;
const RECORD_DATE = /^(\d{4}-\d{2}-\d{2})\s*[:–—]\s*/u;
const MEMORY_REQUEST = /\b(?:(?:my|your|saved) memor(?:y|ies)|(?:from|in) memory|saved notes?|my notes?|recall)\b|(?:في الذاكر[ةه]|من الذاكر[ةه]|ذاكرتي|ذاكرتك|ملاحظاتي|محفوظ)/iu;
const DOCUMENT_REQUEST = /\b(?:document|file|guide|manual|handbook)\b|(?:مستند|دليل|ملف|وثيقة|وثيقه)/iu;
const STOP = new Set('about according and are as at be by did do does for from has have how in is it me my notes note no of on or our please said say saved tell that the their this to was what when where which who with would you your only give memory memories document file guide manual data number much a an — في من الى عن هو هي كان كانت ما ماذا متى اين هل كما هل هذا هذه لي لدي عندي قل اذكر اعطني كم الذي التي لي فقط الذاكرة الذاكره ذاكرتي ذاكرتك معلومات مستند ملف دليل وثيقه ملاحظاتي ملاحظه رقم عدد كثير يا يوجد'.split(' '));

function normalize(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/[ى]/gu, 'ي').replace(/ة/gu, 'ه').replace(/ؤ/gu, 'و').replace(/ئ/gu, 'ي')
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));
}

function terms(value: string): Set<string> {
  const input = normalize(value);
  const words = input.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.flatMap(word => {
    if (STOP.has(word) || !/\p{L}/u.test(word)) return [];
    const arabic = /\p{Script=Arabic}/u.test(word);
    const base = arabic ? word.replace(/^(?:ال|وال)(?=\p{L}+\p{L})/u, '').replace(/ه$/u, '')
      : word.replace(/ies$/u, 'y').replace(/s$/u, '').replace(/^colour$/u, 'color');
    return [base];
  }));
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return [...a].filter(term => b.has(term)).length;
}

function stripDirective(request: string) {
  if (!asksToRemember(request)) return null;
  let index = 0;
  let normalized = '';
  const sourceEnd: number[] = [];
  for (const char of request) {
    index += char.length;
    const folded = char.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا');
    normalized += folded;
    for (let i = 0; i < folded.length; i++) sourceEnd.push(index);
  }
  const prefix = /^\s*(?:(?:please|من فضلك|لو سمحت|رجاء)[،,\s]+)?(?:remember\b|don['’]?t forget\b|save (?:this|that|it)\b|keep in mind\b|تذكر(?=\s|[:،])|احفظ(?=\s|[:،])|لا تنس(?=\s|[:،]))(?:\s+(?:that\b|ان(?!\p{L})))?[\s:،]+/iu.exec(normalized);
  return prefix ? request.slice(sourceEnd[prefix[0].length - 1]).trim() || null : null;
}

type Candidate = {
  text: string;
  source: 'memory' | 'knowledge';
  title?: string;
  score: number;
  date?: string;
};

function quotes(text: string) {
  return text.split(QUOTE_END).map(segment => segment.trim());
}

function safeQuote(text: string) {
  // The evidence contract bounds verbatim quotes. If the leading span is too long, cut at a word boundary.
  // This bound comes from the contract. Congestion-based tuning has not been measured.
  const bounded = text.length > 320 ? text.slice(0, 320).replace(/\S*$/u, '').trimEnd() : text;
  return Boolean(bounded) && !INSTRUCTION.test(bounded) ? bounded : null;
}

function relevantMemories(notes: readonly string[], focus: ReadonlySet<string>): Candidate[] {
  return notes.flatMap(note => {
    const text = safeQuote(quotes(note.trimStart())[0] ?? '');
    if (!text) return [];
    const score = overlap(focus, terms(text));
    if (!score && focus.size) return [];
    return [{ source: 'memory' as const, text, date: RECORD_DATE.exec(text)?.[1], score }];
  });
}

function relevantDocuments(documents: Awaited<ReturnType<NonNullable<MindDeps['knowledge']>>>, focus: ReadonlySet<string>): Candidate[] {
  return documents.flatMap(doc => {
    if (!doc.title || INSTRUCTION.test(doc.title)) return [];
    const titleTerms = terms(doc.title);
    const titleScore = overlap(focus, titleTerms);
    const contentFocus = new Set([...focus].filter(term => !titleTerms.has(term)));
    const contentQuotes = quotes(doc.text);
    const matched = contentQuotes.flatMap(content => {
      const text = safeQuote(content.replace(/^[-*]\s+/u, ''));
      if (!text) return [];
      const score = overlap(contentFocus, terms(text));
      if (!score && !(titleScore && !contentFocus.size && contentQuotes.filter(Boolean).length === 1)) return [];
      return [{ source: 'knowledge' as const, text, title: doc.title, score: titleScore + score }];
    });
    return matched;
  });
}

const COPULA = /\s+(?:(?:is|are|was|were|has|have|equals|is set to|weighs|measures)\s+|(?:هو|هي|هما|يبلغ|تبلغ|بلغ|يساوي|تساوي|كان|كانت)\s+)/iu;
const DATE_VALUE = /(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/u;
const NUMBER_VALUE = /(?<![\p{L}\p{N}:+-])[+-]?[\p{Nd}]+(?:[.,٬٫][\p{Nd}]+)*(?:\s?[%٪])?(?!\p{Nd})/u;
const MONEY_VALUE = /(?:\b(?:USD|EUR|GBP|AED|SAR|JPY|INR|CAD|AUD|CHF|EGP)\s*|[$€£¥]\s*)[\p{Nd}]+(?:[.,٬٫][\p{Nd}]+)*|[\p{Nd}]+(?:[.,٬٫][\p{Nd}]+)*\s+(?:dollars?|euros?|pounds?|riyals?|dirhams?|USD|EUR|GBP|AED|SAR|دولار\p{M}*\p{L}*|يورو|جنيه\p{M}*\p{L}*|ريال\p{M}*\p{L}*|درهم\p{M}*\p{L}*)/iu;

function valueFrom(text: string, answerType: Frame['answerType']): string | undefined {
  const body = text.replace(RECORD_DATE, '');
  const relation = COPULA.exec(body);
  const colon = body.indexOf(':');
  const part = (relation ? body.slice(relation.index + relation[0].length) : colon >= 0 ? body.slice(colon + 1) : body).trim();
  switch (answerType) {
    case 'number': return NUMBER_VALUE.exec(part)?.[0].trim();
    case 'money': return (MONEY_VALUE.exec(part) ?? NUMBER_VALUE.exec(part))?.[0].trim();
    case 'date': return DATE_VALUE.exec(part)?.[0] ?? (relation ? part : undefined);
    default: return relation || colon >= 0 ? part : NUMBER_VALUE.exec(part)?.[0].trim();
  }
}

function subjectOf(text: string, value: string) {
  const body = text.replace(RECORD_DATE, '');
  const relation = COPULA.exec(body);
  const left = relation ? body.slice(0, relation.index) : body.slice(0, body.indexOf(value));
  return [...terms(left)].sort().join(' ');
}

function evidenceFor(candidate: Candidate, id: string, value?: string): Evidence {
  return { id, source: candidate.source, quote: candidate.text, ...(value ? { value } : {}), ...(candidate.date ? { pageDate: candidate.date } : {}) };
}

function structuredRecall(format: NonNullable<ReturnType<typeof memoryRecallFormat>>, candidates: Candidate[], frame: Frame): LocalReply | null {
  const notes = candidates.map(candidate => candidate.text);
  if (format.kind === 'value') {
    const candidate = candidates[0];
    const value = valueFrom(candidate.text, frame.answerType);
    if (!value || !verifyMemoryRecall(value, format, [candidate.text])) return null;
    const evidence = evidenceFor(candidate, 'memory-1', value);
    return { status: 'completed', text: value, claims: [{ text: value, support: [evidence.id], status: 'single_source' }], evidence: [evidence] };
  }

  const fields = format.keys ?? candidates.flatMap(candidate => {
    const body = candidate.text.replace(RECORD_DATE, '');
    const copula = COPULA.exec(body);
    const key = (copula ? body.slice(0, copula.index) : body.split(':', 1)[0]).trim();
    return key !== body ? [key] : [];
  });
  const evidence: Evidence[] = [];
  const values = new Map<string, string>();
  for (const key of new Set(fields)) {
    const wanted = terms(key);
    const candidate = candidates.find(item => wanted.size && overlap(wanted, terms(item.text)) === wanted.size);
    const value = candidate && valueFrom(candidate.text, format.fieldTypes?.[key] === 'number' ? 'number' : null);
    if (!candidate || !value) return null;
    values.set(key, value);
    evidence.push(evidenceFor(candidate, `memory-${evidence.length + 1}`));
  }
  const text = verifyMemoryRecall(JSON.stringify(Object.fromEntries(values)), format, notes);
  return text ? { status: 'completed', text, claims: [{ text, support: evidence.map(item => item.id), status: 'single_source' }], evidence } : null;
}

function renderRecall(frame: Frame, candidates: Candidate[], format: ReturnType<typeof memoryRecallFormat>): LocalReply | null {
  const copy = COPY[frame.lang];
  candidates.sort((a, b) => b.score - a.score);
  const first = candidates[0];
  if (!first) return null;
  const strongest = candidates.filter(candidate => candidate.score === first.score);
  const bySubject = new Map<string, Map<string, Candidate>>();
  for (const candidate of strongest) {
    const value = valueFrom(candidate.text, frame.answerType);
    if (!value) continue;
    const subject = subjectOf(candidate.text, value);
    if (!subject) continue;
    const values = bySubject.get(subject) ?? new Map<string, Candidate>();
    values.set(normalize(value), candidate);
    bySubject.set(subject, values);
  }
  const conflicts = [...bySubject.values()].find(values => values.size > 1);
  const conflict = conflicts !== undefined && first.source === 'memory';
  if (format && !conflict) return structuredRecall(format, strongest, frame);

  const selected = conflict ? [...conflicts.values()] : [first];
  const evidence = selected.map((candidate, index) => evidenceFor(candidate, `recall-${index + 1}`));
  const claims = selected.map((candidate, index) => {
    const value = frame.valueOnly && !conflict ? valueFrom(candidate.text, frame.answerType) : undefined;
    const provenValue = value && candidate.source === 'memory' && verifyMemoryRecall(value, { kind: 'value' }, [candidate.text]) ? value : undefined;
    const label = candidate.title ? `${copy.document} «${candidate.title}»` : copy.memory;
    const text = provenValue ?? `${label}: «${candidate.text}»`;
    return { text, support: [evidence[index].id], status: conflict ? 'conflict' as const : 'single_source' as const };
  });
  return { status: 'completed', text: claims.map(claim => claim.text).join('\n'), claims, evidence };
}

type RecallDeps = Pick<MindDeps, 'memory' | 'knowledge'> & { saveMemory?(text: string, signal: AbortSignal): Promise<void> };

export async function recall(frame: Frame, request: string, deps: RecallDeps, signal: AbortSignal): Promise<LocalReply | null> {
  signal.throwIfAborted();
  const copy = COPY[frame.lang];
  if (frame.intent === 'memory_save') {
    const text = stripDirective(request);
    if (!deps.saveMemory || !text) return fixedReply(copy.cannotSave, 'blocked');
    await deps.saveMemory(text, signal);
    signal.throwIfAborted();
    return fixedReply(copy.saved);
  }

  const focus = terms(frame.text);
  if (frame.personal || MEMORY_REQUEST.test(frame.text)) {
    const notes = await deps.memory?.(frame.text) ?? [];
    signal.throwIfAborted();
    const result = renderRecall(frame, relevantMemories(notes, focus), memoryRecallFormat(request));
    return result ?? fixedReply(copy.noMemory, 'blocked', 'not_found');
  }

  const documents = await deps.knowledge?.(frame.text) ?? [];
  signal.throwIfAborted();
  const result = renderRecall(frame, relevantDocuments(documents, focus), null);
  if (result || !DOCUMENT_REQUEST.test(frame.text) || frame.intent !== 'memory_recall') return result;
  return fixedReply(copy.noKnowledge, 'blocked', 'not_found');
}
