import { asksToRemember } from '../brain.js';
import { memoryRecallFormat, verifyMemoryRecall } from '../memory-recall.js';
import type { Claim, Evidence, Frame, MindDeps } from './contract.js';
import { fixedReply, type LocalReply } from './limits.js';
import { assessRecallCoverage, extractRecallFactAtoms, recallOutputFieldKey, type RecallCoverageOptions } from './recall-coverage.js';
import { parsePreferredLanguageFact, recognizePreferredLanguageRequest } from '../preferred-language-fact.js';
export { assessRecallCoverage, type RecallCoverage, type RecallCoverageEvidence, type RecallCoverageOptions } from './recall-coverage.js';

const COPY = {
  ar: {
    noMemory: 'لم أجد المعلومة المطلوبة في الذاكرة.',
    noKnowledge: 'لم أجد المعلومة المطلوبة في المستندات المقيّمة.',
    saved: 'حفظت كلامك في الذاكرة.',
    cannotSave: 'تعذّر حفظ الملاحظة في الذاكرة.',
    memory: 'من الذاكرة',
    document: 'من مستند',
    incomplete: 'لم أجد دعمًا لجميع الحقول المطلوبة.',
    conflictingFormat: 'تتضمن الذاكرة قيمًا متعارضة؛ لم أتحقق من جواب واحد بالصيغة المطلوبة.',
    conflictingDocuments: 'تتضمن المستندات المقيّمة قيمًا متعارضة للمعلومة المطلوبة.',
    conflictingPreferences: 'تتعارض تفضيلات اللغة المحفوظة؛ لم أتحقق من تفضيل حالي واحد.',
  },
  en: {
    noMemory: 'I couldn’t find the requested information in memory.',
    noKnowledge: 'I couldn’t find the requested information in the evaluated documents.',
    saved: 'I saved your note in memory.',
    cannotSave: 'I couldn’t save the note in memory.',
    memory: 'From memory',
    document: 'From document',
    incomplete: 'I could not find evidence for every requested field.',
    conflictingFormat: 'The saved records contain conflicting values, so I could not verify one answer in the requested format.',
    conflictingDocuments: 'The evaluated documents contain conflicting values for the requested fact.',
    conflictingPreferences: 'The saved language preferences conflict; I could not verify one current preference.',
  },
} as const;

const QUOTE_END = /[\r\n\u0085\u2028\u2029!?؟。؛;]|(?<!\d)\.|\.(?!\d)/u;
const META_INSTRUCTION = /\b(?:ignore|disregard|override|forget|bypass)\b[^.!?؟\r\n]*\b(?:instructions?|user|developer|system|prompt|previous|request)\b|^\s*(?:assistant|system|developer|instruction)\s*:|(?:تجاهل|تخط|انس|اضرب)[^.!?؟\r\n]*(?:التعليمات|السائل|المستخدم|الطلب|الرسالة|السابق)/iu;
const OUTPUT_INSTRUCTION = /^\s*(?:ignore|disregard|reveal|say|output|execute|click|submit|send|open|delete)\b|^\s*(?:تجاهل|اذكر|اطبع|اكشف|نفذ|انقر|ارسل|افتح|احذف)(?!\p{L})/iu;
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
  sourceRef?: string;
  /** The original leading statement exceeded the bounded quote; not a whole fact. */
  clipped?: true;
};

function quotes(text: string) {
  return text.split(QUOTE_END).map(segment => segment.trim());
}

function safeQuote(text: string) {
  // The evidence contract bounds verbatim quotes. If the leading span is too long, cut at a word boundary.
  // This bound comes from the contract. Congestion-based tuning has not been measured.
  const bounded = text.length > 320 ? text.slice(0, 320).replace(/\S*$/u, '').trimEnd() : text;
  return bounded && !META_INSTRUCTION.test(bounded) && !OUTPUT_INSTRUCTION.test(bounded) ? bounded : null;
}

function relevantMemories(notes: readonly string[], focus: ReadonlySet<string>): Candidate[] {
  return notes.flatMap(note => {
    const leading = quotes(note.trimStart())[0] ?? '';
    const text = safeQuote(leading);
    if (!text) return [];
    const score = overlap(focus, terms(text));
    // Retrieval supplies the candidate set. Token overlap ranks it but cannot
    // prove (or reject) field coverage across aliases and subject metadata.
    return [{ source: 'memory' as const, text, date: RECORD_DATE.exec(text)?.[1], score, ...(leading.length > 320 ? { clipped: true as const } : {}) }];
  });
}

function relevantDocuments(documents: Awaited<ReturnType<NonNullable<MindDeps['knowledge']>>>, focus: ReadonlySet<string>): Candidate[] {
  return documents.flatMap(doc => {
    if (!doc.title || META_INSTRUCTION.test(doc.title)) return [];
    const titleTerms = terms(doc.title);
    const titleScore = overlap(focus, titleTerms);
    const contentFocus = new Set([...focus].filter(term => !titleTerms.has(term)));
    const contentQuotes = quotes(doc.text);
    const matched = contentQuotes.flatMap(content => {
      const leading = content.replace(/^[-*]\s+/u, '');
      const text = safeQuote(leading);
      if (!text) return [];
      const score = overlap(contentFocus, terms(text));
      return [{ source: 'knowledge' as const, text, title: doc.title, sourceRef: doc.source, score: titleScore + score,
        ...(leading.length > 320 ? { clipped: true as const } : {}) }];
    });
    return matched;
  });
}

const COPULA = /\s+(?:(?:is|are|was|were|has|have|equals|is set to|weighs|measures)\s+|(?:هو|هي|هما|يبلغ|تبلغ|بلغ|يساوي|تساوي|كان|كانت)\s+)/iu;
const DATE_VALUE = /(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/u;
const NUMBER_VALUE = /(?<![\p{L}\p{N}:+-])[+-]?[\p{Nd}]+(?:[.,٬٫][\p{Nd}]+)*(?:\s?[%٪])?(?!\p{Nd})/u;
const MONEY_VALUE = /(?:\b(?:USD|EUR|GBP|AED|SAR|JPY|INR|CAD|AUD|CHF|EGP)\s*|[$€£¥]\s*)[\p{Nd}]+(?:[.,٬٫][\p{Nd}]+)*|[\p{Nd}]+(?:[.,٬٫][\p{Nd}]+)*\s+(?:dollars?|euros?|pounds?|riyals?|dirhams?|USD|EUR|GBP|AED|SAR|دولار\p{M}*\p{L}*|يورو|جنيه\p{M}*\p{L}*|ريال\p{M}*\p{L}*|درهم\p{M}*\p{L}*)/iu;

function valueFrom(text: string, answerType: Frame['answerType'], source?: Candidate['source'], property?: string): string | undefined {
  const preference = source === 'memory' ? parsePreferredLanguageFact(text) : null;
  if (preference && (answerType === null || answerType === 'text')) return preference.value;
  const literal = extractRecallFactAtoms(text);
  if (literal.kind === 'unsupported') return undefined;
  if (literal.kind === 'atoms') {
    const selected = property ?? (answerType === 'number' ? 'quantity' : answerType === 'date' ? 'date' : literal.atoms.length === 1 ? literal.atoms[0]!.property : undefined);
    return literal.atoms.find(atom => atom.property === selected)?.value;
  }
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

function subjectOf(text: string, value: string, source?: Candidate['source']) {
  if (source === 'memory' && parsePreferredLanguageFact(text)) return 'self:preferred_language';
  const body = text.replace(RECORD_DATE, '');
  const relation = COPULA.exec(body);
  const left = relation ? body.slice(0, relation.index) : body.slice(0, body.indexOf(value));
  return [...terms(left)].sort().join(' ');
}

function evidenceFor(candidate: Candidate, id: string, value?: string): Evidence {
  return { id, source: candidate.source, quote: candidate.text, ...(value ? { value } : {}), ...(candidate.date ? { pageDate: candidate.date } : {}),
    ...(candidate.title ? { title: candidate.title } : {}), ...(candidate.sourceRef ? { sourceRef: candidate.sourceRef } : {}) };
}

function structuredRecall(format: NonNullable<ReturnType<typeof memoryRecallFormat>>, candidates: Candidate[], frame: Frame): LocalReply | null {
  const notes = candidates.map(candidate => candidate.text);
  if (format.kind === 'value') {
    const candidate = candidates[0];
    const value = valueFrom(candidate.text, frame.answerType, candidate.source);
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
    // The candidates already satisfy the full current request. Match this key
    // through the shared field/subject vocabulary as well: an English JSON key
    // such as city can refer to an Arabic مدينة assertion without a word match.
    const keyCoverage = assessRecallCoverage(recallOutputFieldKey(key), candidates.map(item => ({ quote: item.text, title: item.title, source: item.source })));
    const candidate = keyCoverage.status === 'complete' ? candidates[keyCoverage.matchedEvidenceIndices[0]!] : undefined;
    const property = keyCoverage.requestedProperties.length === 1 ? keyCoverage.requestedProperties[0] : undefined;
    const value = candidate && valueFrom(candidate.text, format.fieldTypes?.[key] === 'number' ? 'number' : property === 'date' ? 'date' : null, candidate.source, property);
    if (!candidate || !value) return null;
    values.set(key, value);
    evidence.push(evidenceFor(candidate, `memory-${evidence.length + 1}`));
  }
  const text = verifyMemoryRecall(JSON.stringify(Object.fromEntries(values)), format, notes);
  return text ? { status: 'completed', text, claims: [{ text, support: evidence.map(item => item.id), status: 'single_source' }], evidence } : null;
}

function renderRecall(frame: Frame, candidates: Candidate[], format: ReturnType<typeof memoryRecallFormat>, request: string, options: RecallCoverageOptions): LocalReply | null {
  const copy = COPY[frame.lang];
  const preferredLanguage = Boolean(recognizePreferredLanguageRequest(request));
  // A formatted exact answer cannot treat a clipped leading statement as a
  // complete fact; the hidden suffix may negate or qualify its apparent value.
  if (format) candidates = candidates.filter(candidate => !candidate.clipped);
  // The strict preference parser must see a complete leading statement. A
  // clipped prefix can hide a qualifier or second language after whitespace.
  if (preferredLanguage) candidates = candidates.filter(candidate => candidate.source !== 'memory' || !candidate.clipped);
  // Literal compound atoms also require their complete leading source. The
  // generic quote-clipping behavior remains available for other fact shapes.
  candidates = candidates.filter(candidate => !candidate.clipped || extractRecallFactAtoms(candidate.text).kind === 'none');
  candidates.sort((a, b) => b.score - a.score);
  candidates = candidates.slice(0, 100);
  const coverage = assessRecallCoverage(request, candidates.map(candidate => ({ quote: candidate.text, title: candidate.title, source: candidate.source })), options);
  if (coverage.status === 'missing') return null;
  const matched = coverage.matchedEvidenceIndices.map(index => candidates[index]);
  const first = matched[0];
  if (!first) return null;
  const bySubject = new Map<string, Map<string, Candidate>>();
  for (const candidate of matched) {
    const literal = extractRecallFactAtoms(candidate.text);
    if (literal.kind === 'atoms') {
      for (const atom of literal.atoms.filter(atom => coverage.requestedProperties.includes(atom.property))) {
        const subject = `${atom.property}:${[...atom.subject].sort().join(' ')}`;
        const values = bySubject.get(subject) ?? new Map<string, Candidate>();
        values.set(normalize(atom.value), candidate); bySubject.set(subject, values);
      }
      continue;
    }
    // Detect disagreement from the complete literal property value. A global
    // numeric answer hint must not hide conflicts in another requested field.
    const value = valueFrom(candidate.text, null, candidate.source);
    if (!value) continue;
    const subject = subjectOf(candidate.text, value, candidate.source);
    if (!subject) continue;
    const values = bySubject.get(subject) ?? new Map<string, Candidate>();
    const preference = candidate.source === 'memory' ? parsePreferredLanguageFact(candidate.text) : null;
    // Equivalent Arabic/English spellings of the same supported language are
    // duplicates, while different language IDs remain an unresolved conflict.
    values.set(preference?.languageId ?? normalize(value), candidate);
    bySubject.set(subject, values);
  }
  const conflicting = new Set([...bySubject.values()].filter(values => values.size > 1).flatMap(values => [...values.values()]));
  const conflict = conflicting.size > 0;
  const preferenceConflict = preferredLanguage && conflict;
  if (format && !conflict) {
    const structured = coverage.status === 'complete' ? structuredRecall(format, matched, frame) : null;
    return structured && assessRecallCoverage(request, structured.evidence, options).status === 'complete' ? structured : null;
  }

  const perProperty = coverage.matches.flatMap(match => match.evidenceIndices.length ? [candidates[match.evidenceIndices[0]]] : []);
  const selected = [...new Set([...(coverage.matches.length > 1 ? perProperty : [first]), ...(conflict ? conflicting : [])])];
  const evidence = selected.map((candidate, index) => evidenceFor(candidate, `recall-${index + 1}`));
  const claims: Claim[] = selected.map((candidate, index) => {
    const value = frame.valueOnly && !conflict ? valueFrom(candidate.text, frame.answerType, candidate.source) : undefined;
    const provenValue = value && candidate.source === 'memory' && verifyMemoryRecall(value, { kind: 'value' }, [candidate.text]) ? value : undefined;
    const label = candidate.title ? `${copy.document} «${candidate.title}»` : copy.memory;
    const text = provenValue ?? `${label}: «${candidate.text}»`;
    return { text, support: [evidence[index].id], status: conflict && conflicting.has(candidate) ? 'conflict' as const : 'single_source' as const };
  });
  const documentConflict = conflict && first.source === 'knowledge';
  const formatConflict = conflict && Boolean(format);
  const complete = !documentConflict && !formatConflict && !preferenceConflict && coverage.status === 'complete' && assessRecallCoverage(request, evidence, options).status === 'complete';
  if (preferenceConflict) claims.push({ text: copy.conflictingPreferences, support: [], status: 'fixed' });
  else if (documentConflict) claims.push({ text: copy.conflictingDocuments, support: evidence.map(item => item.id), status: 'conflict' });
  else if (formatConflict) claims.push({ text: copy.conflictingFormat, support: evidence.map(item => item.id), status: 'conflict' });
  else if (!complete) claims.push({ text: copy.incomplete, support: [], status: 'not_found' });
  return { status: complete ? 'completed' : 'partial', text: claims.map(claim => claim.text).join('\n'), claims, evidence };
}

type RecallDeps = Pick<MindDeps, 'memory' | 'knowledge'> & { saveMemory?(text: string, signal: AbortSignal): Promise<void> };
export interface RecallOptions extends RecallCoverageOptions { source?: 'memory' | 'knowledge' }

export async function recall(frame: Frame, request: string, deps: RecallDeps, signal: AbortSignal, options: RecallOptions = {}): Promise<LocalReply | null> {
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
  const coverageOptions = { contextTopic: options.contextTopic ?? (frame.text !== request ? frame.text : undefined) };
  if (options.source === 'memory' || options.source !== 'knowledge' && (frame.personal || MEMORY_REQUEST.test(frame.text))) {
    const notes = await deps.memory?.(frame.text) ?? [];
    signal.throwIfAborted();
    const result = renderRecall(frame, relevantMemories(notes, focus), memoryRecallFormat(request), request, coverageOptions);
    return result ?? fixedReply(copy.noMemory, 'blocked', 'not_found');
  }

  const documents = await deps.knowledge?.(frame.text) ?? [];
  signal.throwIfAborted();
  const result = renderRecall(frame, relevantDocuments(documents, focus), null, request, coverageOptions);
  if (result || !DOCUMENT_REQUEST.test(frame.text) || frame.intent !== 'memory_recall') return result;
  return fixedReply(copy.noKnowledge, 'blocked', 'not_found');
}
