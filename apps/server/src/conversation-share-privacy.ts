import type { ConversationPrivacyFinding, ConversationSnapshot } from '@mohassan/contracts';
import { TOOL_ACTION } from './assistant/run-plans.js';
import { containsSensitiveCredentialText } from './sensitive-credential-text.js';

export type ConversationPrivateOrigin = Extract<ConversationPrivacyFinding['kind'], 'memory' | 'tool-output'>;
type Kind = ConversationPrivacyFinding['kind'];
type Match = { kind: Kind; start: number; end: number; opaque?: boolean };
type Location = Pick<ConversationPrivacyFinding, 'location' | 'messageIndex'>;

const REMOVED = '⟦حُذف محتوى خاص⟧';
const HIDDEN = /<(think|thinking|analysis|reasoning|tool_calls?|tool_results?|tool_output|tool_trace)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu;

/** Strip internal sections before reading the visible assistant text or its links. */
export function visibleConversationText(text: string): string {
  return text.replace(HIDDEN, '\n').trim();
}

// Domain/local part recognition follows SMTPUTF8 (RFC 6531 §3.3), with a
// dotted domain for prose, and catches quoted local parts. Retrieved 2026-11-25.
// https://www.rfc-editor.org/rfc/rfc6531.html#section-3.3
const EMAIL = /(?<![\p{L}\p{N}_.@])(?:"[^"\r\n]+"|[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~]+(?:\.[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~]+)*)@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}][\p{L}\p{N}-]*(?![\p{L}\p{N}_@])/gu;

// E.164 limits international numbers to 15 digits. Local numbers use prose
// cues or common separators so dates and short numeric values stay visible.
// https://www.itu.int/rec/T-REC-E.164/en (retrieved 2026-11-25)
const PHONE = /(?<![\p{L}\p{N}_.@])\+?\(?\d(?:[ \t().\u00a0\u202f\-‐‑–]*\d){6,14}\)?(?![\p{L}\p{N}_]|[.\-‐‑–]\d)/gu;
const PHONE_LABEL = /(?:\b(?:call|phone|mobile|tel|whatsapp|telephone)(?:\s+(?:me|us|at|number))?|(?:هاتف|جوال|موبايل|تليفون|واتساب|اتصل)(?:\s+(?:بي|بنا|على|رقم))*)\s*[:=#：]?\s*$/iu;
const VERSION_LABEL = /(?:\b(?:version|release|build)(?:\s+is)?|(?:رقم\s+)?(?:الإصدار|النسخة))\s*[:=#：]?\s*$/iu;
const DATES = /(?<!\d)(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{4})(?!\d)/gu;

// Google Ads uses 10 digits, shown in the account UI with 3-3-4 grouping.
// https://support.google.com/google-ads/answer/1704344 (retrieved 2026-11-25)
// https://developers.google.com/google-ads/api/rest/common/search (retrieved 2026-11-25)
const ADS_FORMATTED = /(?<![\p{L}\p{N}+])\d{3}[-‐‑–]\d{3}[-‐‑–]\d{4}(?![\p{L}\p{N}])/gu;
const ADS_CONTEXT = /(?:\b(?:google\s+ads(?:\s+(?:(?:customer|account)\s+)?id)?|(?:google\s+ads\s+)?customer\s*id|login[-_ ]?customer[-_ ]?id|customer[-_ ]id|customers\/)|(?:معر[ّ]?ف|رقم)\s+(?:العميل|حساب\s+(?:إعلانات|اعلانات)\s+جوجل)|إعلانات\s+جوجل|اعلانات\s+جوجل)\s*["'\s:=#：]*$/iu;
const TEN_DIGITS = /(?<!\d)\d{10}(?![\p{L}\p{N}])/gu;

const URL_TEXT = /(?<![\p{L}\p{N}./:\\])(?:[a-z][a-z\d+.-]*:\/\/|www\.|\/\/(?=[\p{L}\p{N}.-]+\.))[^\s<>"'`«»“”{}]+/giu;
// OAuth bearer query parameters and signatures on presigned URLs.
// https://www.rfc-editor.org/rfc/rfc6750.html#section-2.3 (retrieved 2026-11-25)
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html (retrieved 2026-11-25)
// https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas (retrieved 2026-11-25)
const TOKEN_KEY = /^(?:(?:[a-z0-9]+[-_.])*(?:token|secret|password|credential|signature|jwt|session|session[-_]?id|api[-_]?key|auth(?:orization)?|sig|code)(?:[-_.][a-z0-9]+)*|[a-z]+token)$/iu;
const TOKEN_KEY_AR = /^(?:رمز[\s_.-]*(?:الوصول|الدخول|المصادقة|الجلسة|التحديث)|مفتاح[\s_.-]*الوصول)$/u;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

// A root or dot segment, drive, UNC, file URI, or relative path with a file
// extension distinguishes file references from ordinary slash-separated words.
// https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap03.html (retrieved 2026-11-25)
// https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats (retrieved 2026-11-25)
const PATH_START = /^(?:[a-z]:[\\/]|\\\\|~\/|\.{1,2}[\\/]|\/|file:\/\/)|^[^/\\]+[\\/].+\.[\p{L}\p{N}_-]+$/iu;
const QUOTED = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|«([^»\r\n]+)»|“([^”\r\n]+)”/gu;
const PATH = /(?<![\p{L}\p{N}.@/:\\])(?:(?:[a-z]:[\\/]|\\\\|~\/|\.{1,2}[\\/]|\/)[^\s<>"'`«»“”\[\]{}(),;،؛؟]+|(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+\.[\p{L}\p{N}_-]+)/giu;
const SPACED_PATH = /(?<![\p{L}\p{N}.@/:\\])(?:[a-z]:[\\/]|\\\\|~\/|\.{1,2}[\\/]|\/)(?:[^\s<>"'`«»“”\[\]{}(),;،؛؟]+[ \t]+)+[\p{L}\p{N}_.\\/-]+\.[\p{L}\p{N}_-]+/giu;

// Host-written memory labels are in assistant/mind/recall.ts; tool labels
// are deliberately anchored to a colon rather than general prose mentions.
const MEMORY_QUOTE = /(?:\b(?:from (?:your |my |the )?memory|(?:your |my )?saved (?:note|memory))|(?:من (?:ذاكرتك|ذاكرتي|الذاكرة)|(?:الملاحظة|الذاكرة) المحفوظة))\s*[:：]/giu;
const TOOL_QUOTE = /(?:\b(?:(?:from (?:the )?)?tool (?:output|result)|(?:command|terminal) output|stdout|stderr)|(?:(?:من )?(?:مخرجات|ناتج|نتيجة) (?:الأداة|الاداة|الأمر|الطرفية)))\s*[:：]/giu;

/** Normalization preserves offsets for redaction and covers Eastern Arabic digits and bidi controls. */
function scanView(text: string) {
  const starts: number[] = [], ends: number[] = [], chars: string[] = [];
  let offset = 0;
  for (const original of text) {
    const start = offset;
    offset += original.length;
    if (/[\p{Cf}\u0640\u064b-\u065f\u0670]/u.test(original)) continue;
    const normalized = original.normalize('NFKC').replace(/[\u0660-\u0669\u06f0-\u06f9]/gu, digit => String(digit.charCodeAt(0) & 0xf));
    chars.push(normalized);
    for (let index = 0; index < normalized.length; index++) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { text: chars.join(''), starts, ends };
}

function matches(text: string, pattern: RegExp, kind: Kind): Match[] {
  return Array.from(text.matchAll(pattern), match => ({ kind, start: match.index, end: match.index + match[0].length }));
}

function overlaps(first: Match, second: Match): boolean {
  return first.start < second.end && second.start < first.end;
}

function literalQuoteMatches(text: string, pattern: RegExp, kind: ConversationPrivateOrigin): Match[] {
  const found: Match[] = [];
  for (const label of text.matchAll(pattern)) {
    const after = label.index + label[0].length;
    const value = text.slice(after).trimStart();
    const start = text.length - value.length;
    const delimiter = value.startsWith('```') ? '```' : value[0] === '«' ? '»' : value[0] === '“' ? '”' : value[0];
    const quoted = delimiter && ['```', '»', '”', '"', "'", '`'].includes(delimiter);
    let close = -1;
    if (quoted) {
      let depth = 1;
      for (let index = delimiter.length; index < value.length; index++) {
        if (value[index - 1] === '\\') continue;
        if ((delimiter === '»' && value[index] === '«') || (delimiter === '”' && value[index] === '“')) depth++;
        if (value.startsWith(delimiter, index) && --depth === 0) { close = index; break; }
      }
    }
    // Without balanced delimiters the following section may be multiline.
    const end = close >= 0 ? start + close + delimiter.length : text.length;
    if (start < end) found.push({ kind, start, end });
  }
  return found;
}

function numericMatches(text: string): Match[] {
  const dates = matches(text, DATES, 'phone');
  const adsIds = [
    ...matches(text, ADS_FORMATTED, 'google-ads-id').filter(match => !PHONE_LABEL.test(text.slice(Math.max(0, match.start - 48), match.start))),
    ...matches(text, TEN_DIGITS, 'google-ads-id').filter(match => ADS_CONTEXT.test(text.slice(Math.max(0, match.start - 96), match.start))),
  ];
  const phones = matches(text, PHONE, 'phone').filter(match => {
    if ([...dates, ...adsIds].some(other => overlaps(match, other))) return false;
    const value = text.slice(match.start, match.end);
    const prefix = text.slice(Math.max(0, match.start - 48), match.start);
    if (value.includes('.') && VERSION_LABEL.test(prefix)) return false;
    const digits = value.replace(/\D/gu, '');
    return value.startsWith('+') || digits.length >= 10 || /[ ()\-‐‑–]/u.test(value)
      || PHONE_LABEL.test(prefix);
  });
  return [...adsIds, ...phones];
}

function pathMatches(text: string): Match[] {
  const quotedPaths = Array.from(text.matchAll(QUOTED)).flatMap(match => {
    const value = match.slice(1).find(Boolean);
    if (!value || !PATH_START.test(value) || /^(?:https?:|\/\/)/iu.test(value)) return [];
    return [{ kind: 'path' as const, start: match.index + 1, end: match.index + match[0].length - 1 }];
  });
  return [...quotedPaths, ...matches(text, PATH, 'path'), ...matches(text, SPACED_PATH, 'path')];
}

function urlMatches(text: string): { covered: Match[]; findings: Match[] } {
  const covered = matches(text, URL_TEXT, 'token-url');
  const findings: Match[] = [];
  for (const match of covered) {
    const address = text.slice(match.start, match.end).replace(/[).,،؛؟!?]+$/u, '');
    const capture = { ...match, end: match.start + address.length };
    if (/^file:\/\//iu.test(address)) findings.push({ ...capture, kind: 'path' });
    try {
      const url = new URL(address.replace(/&amp;/giu, '&'), 'https://example.invalid');
      const params = new URLSearchParams(url.search.slice(1).replace(/;/gu, '&'));
      if (url.username || url.password || [...params].some(([key, value]) => value && (TOKEN_KEY.test(key) || TOKEN_KEY_AR.test(scanView(key).text) || JWT.test(value)))) findings.push({ ...capture, opaque: true });
      // Decode query parameters, including PII written as URL-encoded text.
      // Remove the whole link because a partial URL can still carry the value.
      const kinds = new Set<Kind>();
      for (const [key, value] of params) {
        const content = scanView(`${key}=${value}`).text;
        for (const item of [...matches(content, EMAIL, 'email'), ...numericMatches(content), ...pathMatches(content)]) kinds.add(item.kind);
      }
      for (const kind of kinds) findings.push({ ...capture, kind });
    } catch { /* The text is not a URL the platform can parse. */ }
  }
  return { covered, findings };
}

function storedQuoteMatches(text: string, quotes: readonly string[]): Match[] {
  const found: Match[] = [];
  for (const quote of new Set(quotes)) {
    const needle = scanView(quote.trim()).text;
    if (!needle) continue;
    for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) {
      const end = start + needle.length;
      if (/[\p{L}\p{N}]/u.test(text[start - 1] ?? '') && /^[\p{L}\p{N}]/u.test(needle)) continue;
      if (/[\p{L}\p{N}]/u.test(text[end] ?? '') && /[\p{L}\p{N}]$/u.test(needle)) continue;
      found.push({ kind: 'tool-output', start, end });
    }
  }
  return found;
}

function detect(original: string, quotes: readonly string[]): Match[] {
  const { text, starts, ends } = scanView(original);
  const urls = urlMatches(text);
  // Token-bearing URLs already have an opaque, precise finding. Check the rest for credential literals.
  const residue = redact(text, urls.findings.filter(finding => finding.kind === 'token-url'));
  if (containsSensitiveCredentialText(residue)) return [{ kind: 'credential', start: 0, end: original.length, opaque: true }];
  const hidden = matches(text, HIDDEN, 'tool-output').map(match => ({ ...match, opaque: true }));
  const found = [
    ...urls.findings,
    ...matches(text, EMAIL, 'email'),
    ...numericMatches(text),
    ...pathMatches(text).filter(match => !urls.covered.some(other => overlaps(match, other))),
    ...literalQuoteMatches(text, MEMORY_QUOTE, 'memory'),
    ...literalQuoteMatches(text, TOOL_QUOTE, 'tool-output'),
    ...storedQuoteMatches(text, quotes),
  ].filter(match => !hidden.some(other => overlaps(match, other))
    && (match.opaque || !urls.findings.some(other => other.opaque && overlaps(match, other)))).concat(hidden);
  return found.map(match => ({ ...match, start: starts[match.start] ?? 0, end: ends[match.end - 1] ?? original.length }));
}

function redact(text: string, found: Match[]): string {
  let end = 0, result = '';
  for (const match of found.slice().sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (match.start >= end) result += text.slice(end, match.start) + REMOVED;
    end = Math.max(end, match.end);
  }
  return result + text.slice(end);
}

export function scanConversationPrivacy(snapshot: ConversationSnapshot,
  provenance: ReadonlyMap<number, readonly ConversationPrivateOrigin[]> = new Map(),
  quotes: ReadonlyMap<number, readonly string[]> = new Map()) {
  const findings: ConversationPrivacyFinding[] = [];
  function review(text: string, location: Location, origin: readonly ConversationPrivateOrigin[] = [], excerpts: readonly string[] = []) {
    const found = detect(text, excerpts);
    if (text.length) for (const kind of new Set(origin)) found.push({ kind, start: 0, end: text.length, opaque: true });
    const covered = new Map<Kind, number>();
    for (const match of found.slice().sort((a, b) => a.start - b.start || b.end - a.end)) {
      if ((covered.get(match.kind) ?? 0) >= match.end) continue;
      covered.set(match.kind, match.end);
      const visible = match.opaque ? REMOVED : text.slice(match.start, match.end).slice(0, 100);
      findings.push({ ...location, kind: match.kind, preview: visible });
    }
    return { text: redact(text, found), flagged: found.length > 0 };
  }

  const title = review(snapshot.title, { location: 'title' }).text;
  const messages = snapshot.messages.map((message, messageIndex) => {
    const origin = message.role === 'assistant' ? provenance.get(messageIndex) : undefined;
    const text = review(message.text, { location: 'message', messageIndex }, origin, quotes.get(messageIndex)).text;
    const location = { location: 'source', messageIndex } as const;
    const sources = message.sources.filter(source => {
      const title = review(source.title, location);
      const url = review(source.url, location, origin);
      return !title.flagged && !url.flagged;
    });
    return { role: message.role, text, createdAt: message.createdAt, sources };
  });
  return { snapshot: { title, createdAt: snapshot.createdAt, messages }, findings };
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.map(record).filter(item => item !== undefined) : [];
const MEMORY_ACTION = /^(?:memory[_\.-]|user_(?:note_verify|fact_memory)|calculation_memory)/u;
const OUTPUT_ACTION = /^(?:workspace_list|load_skill|local_sequence|ads[_. ]|chrome_campaign_queued|browser[_.]|web[_.]|computer[_.]|desktop[_.]|document[_.]|runtime[_.]|skill[_.]|knowledge[_.]|site[_.])/u;

function promptPrivacy(state: Record<string, unknown> | undefined) {
  const marker = record(state?.conversationPromptPrivacy);
  return marker?.version === 1 && typeof marker.memory === 'boolean' && typeof marker.toolOutput === 'boolean'
    ? { memory: marker.memory, toolOutput: marker.toolOutput } : undefined;
}

export const hasConversationPromptPrivacy = (state: unknown): boolean => Boolean(promptPrivacy(record(state)));

function hasMemoryContent(memory?: string): boolean {
  if (!memory?.trim()) return false;
  try {
    const context = record(JSON.parse(memory));
    // packages/memory/src/index.ts builds this bounded context from owner-scoped search.
    return !context || context.method !== 'lexical-v1' || typeof context.expiredExcluded !== 'number'
      || [context.items, context.citations, context.skillProposals].some(value => !Array.isArray(value) || value.length > 0);
  } catch { return true; }
}

/** Keep presence flags only. A run's later prompt cannot erase an earlier private input. */
export function noteConversationPromptPrivacy(state: object, input: { memory?: string; browser: unknown; learning?: string; skill?: string }) {
  const prior = promptPrivacy(record(state));
  Object.assign(state, { conversationPromptPrivacy: {
    version: 1,
    memory: Boolean(prior?.memory || hasMemoryContent(input.memory)),
    toolOutput: Boolean(prior?.toolOutput || input.browser || input.learning?.trim() || input.skill?.trim()),
  } });
}

function runIndicators(state: Record<string, unknown>) {
  const ledger = record(state.agentRun);
  const actions = records(record(state.actionCompletion)?.events).map(row => record(row.event)?.kind);
  const outcomes = records(record(state.supervision)?.steps);
  const sources = outcomes.flatMap(row => records(row.observations).map(observation => observation.source));
  const capabilities = records(record(ledger?.plan)?.steps).map(row => row.capability);
  const trail = records(state.trail);
  const toolNames = [...trail.map(row => row.action), ...actions, ...outcomes.map(row => row.tool), ...capabilities]
    .filter((name): name is string => typeof name === 'string');
  return { ledger, trail, sources, toolNames };
}

function outputAction(action: string) {
  return !MEMORY_ACTION.test(action) && (TOOL_ACTION.test(action) || OUTPUT_ACTION.test(action));
}

const publicTool = /^(?:search(?: |$)|read(?: |$)|web\.search$|browser\.read$)/u;

/** Deterministic web answers copy these stored excerpts verbatim in assistant/hands.ts. */
export function conversationPublicToolQuotes(value: unknown): string[] {
  const state = record(value);
  if (!state) return [];
  const found = record(state.handsFound);
  const second = record(found?.second);
  if (typeof found?.url !== 'string' || typeof found?.readAt !== 'string' || !Array.isArray(found.lines)) return [];
  const { ledger, trail, toolNames, sources } = runIndicators(state);
  if (promptPrivacy(state) || state.mindTimings || (typeof ledger?.modelCalls === 'number' && ledger.modelCalls > 0)
    || toolNames.some(name => outputAction(name) && !publicTool.test(name))
    || sources.some(source => source !== 'browser-verifier')) return [];
  const addresses = new Set([found.url, ...(typeof second?.url === 'string' ? [second.url] : [])]);
  const reads = new Set(trail.flatMap(row => {
    if (typeof row.action !== 'string' || !row.action.startsWith('read ') || typeof row.result !== 'string') return [];
    return /^HTTP 2\d{2} (https?:\/\/\S+) · \d+ chars$/u.exec(row.result)?.[1] ?? [];
  }));
  if (addresses.size !== reads.size || [...addresses].some(url => !reads.has(url))) return [];
  return [...new Set([...found.lines, found.quote, second?.line].filter((text): text is string => typeof text === 'string' && Boolean(text.trim())))];
}

/** Where run state has no reliable quote offsets, mark the entire affected assistant reply. */
export function conversationRunPrivacy(value: unknown): ConversationPrivateOrigin[] {
  const state = record(value);
  if (!state) return [];
  const { ledger, sources, toolNames } = runIndicators(state);
  const prompt = promptPrivacy(state);
  // Mind C and older model runs have private context whose raw content is intentionally absent from state.
  if (state.mindTimings || !prompt && typeof ledger?.modelCalls === 'number' && ledger.modelCalls > 0) return ['memory', 'tool-output'];

  const memory = prompt?.memory || toolNames.some(action => MEMORY_ACTION.test(action) && (action !== 'memory_read' || !prompt)) || sources.includes('memory-read')
    || Boolean(state.computationMemory || state.memoryVerification || state.userFactMemory || state.userFactMemoryVerification);
  const tool = prompt?.toolOutput || toolNames.some(outputAction)
    || sources.some(source => ['artifact', 'authoritative-readback', 'browser-observation', 'browser-verifier', 'computer-observation', 'knowledge-verifier', 'tool-receipt'].includes(String(source)))
    || Boolean(state.handsFound || state.handsResults || state.localComputerRead || state.computerElements)
    || ledger?.path === 'action' && !memory && !prompt;

  return [...(memory ? ['memory' as const] : []), ...(tool && !conversationPublicToolQuotes(state).length ? ['tool-output' as const] : [])];
}
