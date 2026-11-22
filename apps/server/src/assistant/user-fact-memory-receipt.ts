import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MemoryExactPayloadSchema } from '@mohassan/memory';
import { redactSecrets } from '@mohassan/providers';
import { redactCredentialText } from '@mohassan/cognitive';
import { asksToRemember, deniesMemoryWrite } from './brain.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { parseUserRequestConstraints, requestCapabilityAllowed } from './request-constraints.js';
import { scanCurrentMemoryDeclaration } from './current-memory-declaration.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const SpanSchema = z.object({ start: z.number().int().min(0).max(4000), end: z.number().int().min(1).max(4000), hash: digest }).strict();
const BindingSchema = z.object({ ownerId: identity, conversationId: identity, runId: identity, evaluatedAt: instant,
  /** HOST hash of this current user's actual pre-schema/pre-redaction string. Never infer it from a supplied receipt. */
  originalRequestHash: digest }).strict();
export type UserFactMemoryBinding = z.infer<typeof BindingSchema>;
const ReceiptSchema = BindingSchema.extend({ version: z.literal(1), kind: z.literal('current_user_literal_memory'),
  statementKind: z.enum(['language_preference', 'literal_note', 'current_declaration']), requestHash: digest, directiveSpan: SpanSchema, envelopeSpan: SpanSchema, payloadSpan: SpanSchema,
  payload: z.object({ text: MemoryExactPayloadSchema, hash: digest, bytes: z.number().int().min(1).max(16000) }).strict(), operationKey: digest }).strict();
export type UserFactMemoryReceipt = z.infer<typeof ReceiptSchema>;
type Span = z.infer<typeof SpanSchema>;
export type UserFactMemoryReason = 'ready' | 'unrelated' | 'invalid_input' | 'noncanonical_request' | 'denied' | 'affirmative_required'
  | 'request_constraint' | 'unsupported_statement' | 'ambiguous_sequence' | 'invalid_literal' | 'noncanonical_payload' | 'credential_material';
export type UserFactMemoryAssessment = { candidate: false; status: 'unrelated'; reason: 'unrelated' | 'invalid_input' }
  | { candidate: true; status: 'rejected'; reason: Exclude<UserFactMemoryReason, 'ready' | 'unrelated'> }
  | { candidate: true; status: 'ready'; reason: 'ready'; statementKind: UserFactMemoryReceipt['statementKind'];
      directiveSpan: Span; envelopeSpan: Span; payloadSpan: Span };

const normalize = (value: string) => value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();
const potential = (value: string) => /^(?:(?:please|kindly|من فضلك|لو سمحت|رجاء)[,،\s]+)?(?:remember\b|don['’]?t forget\b|save (?:this|that|it)\b|keep in mind\b|(?:تذكر|احفظ|لا تنس)(?=\s|[:،]))/iu.test(normalize(value).trimStart());
function matchingSource(raw: string) {
  let text = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const point of raw) {
    const normalized = normalize(point);
    for (let index = 0; index < normalized.length; index++) { starts.push(offset); ends.push(offset + point.length); }
    text += normalized; offset += point.length;
  }
  return { text, starts, ends };
}
const span = (raw: string, start: number, end: number): Span => ({ start, end, hash: hash(raw.slice(start, end)) });
const courtesy = '(?:(?:please|من فضلك|لو سمحت)[,، \\t]+)?';
const envelope = new RegExp(`^${courtesy}(?:remember[ \\t]+exactly[ \\t]+this[ \\t]+note|احفظ[ \\t]+في[ \\t]+ذاكرتي[ \\t]+النص[ \\t]+التالي):`, 'u');
const natural = new RegExp(`^${courtesy}(?:remember(?:[ \\t]+that)?[ \\t]+|تذكر[ \\t]+)`, 'u');
const preference = /^(?:i prefer (?:arabic|english)|(?:انني|انا) افضل (?:العربيه|الانجليزيه))[.!]?$/u;
const quotePairs: Readonly<Record<string, string>> = { '"': '"', '“': '”', '«': '»' };
// An explicitly assigned credential is sensitive even when its value is shorter
// than token-redaction heuristics (for example a four-digit PIN). Mere prose
// containing the word password remains ordinary literal data.
const credentialAssignment = /(?<!\p{L})(?:password|passwd|api[ _-]?key|(?:access|refresh|auth)[ _-]?token|client[ _-]?secret|secret|pin|otp|one[ _-]?time[ _-]?(?:code|password)|كلمه\s+(?:المرور|السر)|رمز\s+(?:الدخول|المرور|التحقق)|رقم\s+التعريف\s+الشخصي|مفتاح\s+api)(?!\p{L})\s*[:=：]\s*(?:["'`“«]\s*)?[^\s"'`“”«»]/u;
const ownedCredentialEN = /(?<!\p{L})(?:my|our)\s+(?:(?:account|email|database|login)\s+)?(?:password|passwd|api[ _-]?key|(?:access|refresh|auth)[ _-]?token|client[ _-]?secret|pin|otp|passcode|one[ _-]?time[ _-]?(?:code|password))(?!\p{L})\s+(?:is|are)(?:\s+|(?=[0-9٠-٩۰-۹]))(?!(?:not|unknown|redacted|hidden|unavailable)(?!\p{L}))\S/u;
const ownedCredentialAR = /(?<!\p{L})(?:(?:كلمه\s+(?:المرور|السر)|رمز\s+(?:الدخول|المرور|التحقق)|رقم\s+التعريف\s+الشخصي|مفتاح\s+api)\s+(?:الخاصه?\s+بي|لحسابي|لي)|كلمه\s+(?:مروري|سري)|رمز\s+(?:دخولي|مروري)|كلمه\s+مرور\s+حسابي)(?!\p{L})\s+(?:هو|هي)(?:\s+|(?=[0-9٠-٩۰-۹]))(?!(?:ليس|ليست|غير|مجهول|مجهوله|محجوب|محجوبه)(?!\p{L}))\S/u;
const numericCredential = /(?<!\p{L})(?:pin|otp|passcode|verification\s+code|one[ _-]?time[ _-]?(?:code|password)|رمز\s+(?:الدخول|المرور|التحقق)|رقم\s+التعريف\s+الشخصي)(?!\p{L})\s+(?:is|was|هو|هي)(?:\s+|(?=[0-9٠-٩۰-۹]))["'`“«]?[0-9٠-٩۰-۹]{3,}(?![0-9٠-٩۰-۹])/u;

function currentDeclaration(raw: string): UserFactMemoryAssessment {
  const scanned = scanCurrentMemoryDeclaration(raw);
  if (scanned.status !== 'ready' || !scanned.exactScalar)
    return { candidate: true, status: 'rejected', reason: 'unsupported_statement' };
  const { start, end } = scanned.statementSpan;
  if (!MemoryExactPayloadSchema.safeParse(raw.slice(start, end)).success)
    return { candidate: true, status: 'rejected', reason: 'noncanonical_payload' };
  return { candidate: true, status: 'ready', reason: 'ready', statementKind: 'current_declaration',
    directiveSpan: span(raw, 0, start), envelopeSpan: span(raw, start, end), payloadSpan: span(raw, start, end) };
}

/**
 * Classifies original CURRENT USER text only. Candidate remains true on unsafe
 * leading remember requests so hosts can block them without legacy/model-save
 * fallback. No previous value, source fetch, permission or factual truth is inferred.
 */
export function assessUserFactMemoryRequest(raw: unknown): UserFactMemoryAssessment {
  const candidate = typeof raw === 'string' && potential(raw.slice(0, 300));
  const reject = (reason: Exclude<UserFactMemoryReason, 'ready' | 'unrelated'>): UserFactMemoryAssessment => ({ candidate: true, status: 'rejected', reason });
  if (typeof raw !== 'string' || !raw || raw.length > 4000 || /[\u0000\ud800-\udfff]/u.test(raw))
    return candidate ? reject('invalid_input') : { candidate: false, status: 'unrelated', reason: 'invalid_input' };
  if (!candidate) return { candidate: false, status: 'unrelated', reason: 'unrelated' };
  if (raw.trim() !== raw) return reject('noncanonical_request');
  // Preserve existing denial precedence exactly, including conservative denials
  // inside supplied data. Literal handling must not become a DENY bypass.
  if (deniesMemoryWrite(raw)) return reject('denied');
  if (!asksToRemember(raw)) return reject('affirmative_required');
  const credentialView = normalize(raw);
  if (credentialAssignment.test(credentialView) || ownedCredentialEN.test(credentialView) || ownedCredentialAR.test(credentialView)
    || numericCredential.test(credentialView) || redactCredentialText(redactSecrets(raw)) !== raw) return reject('credential_material');
  const constraints = parseUserRequestConstraints(raw);
  if (!requestCapabilityAllowed(constraints, 'memory_write') || !requestCapabilityAllowed(constraints, 'memory_read')) return reject('request_constraint');
  const view = matchingSource(raw), introduced = envelope.exec(view.text), preferred = !introduced && natural.exec(view.text);
  const matched = introduced ?? preferred;
  if (!matched) return currentDeclaration(raw);
  const last = matched[0].length - 1, boundary = view.ends[last];
  if (boundary === undefined || view.starts[last + 1] !== undefined && view.starts[last + 1]! < boundary) return reject('invalid_literal');
  let noteStart = boundary, start = boundary, end = raw.length;
  if (introduced) {
    // Exactly one declared delimiter separator is syntax. No trim/skip loop.
    if (raw.slice(noteStart, noteStart + 2) === '\r\n') noteStart += 2;
    else if (raw[noteStart] === ' ' || raw[noteStart] === '\n') noteStart++;
    start = noteStart;
    const close = quotePairs[raw[start] ?? ''];
    if (close) {
      let closing = -1;
      for (let index = start + 1; index < raw.length; index++) {
        if (raw[index] === '\\') { index++; continue; }
        if (raw[index] === close) { closing = index; break; }
      }
      if (closing !== raw.length - 1) return reject('invalid_literal');
      start++; end = closing;
    } else if (/['‘’`”»]/u.test(raw[start] ?? '') || /[\r\n]/u.test(raw.slice(start))) return reject('invalid_literal');
  } else if (!preference.test(view.text.slice(matched[0].length))) return currentDeclaration(raw);
  const payload = raw.slice(start, end);
  if (!MemoryExactPayloadSchema.safeParse(payload).success) return reject('noncanonical_payload');
  // A fenced/quoted note is opaque data to the sequence parser; an apparent
  // unquoted outer sequence stays ambiguous rather than executing or shortening it.
  if (analyzeCompoundRequest(raw).kind !== 'single') return reject('ambiguous_sequence');
  return { candidate: true, status: 'ready', reason: 'ready', statementKind: introduced ? 'literal_note' : 'language_preference',
    directiveSpan: span(raw, 0, noteStart), envelopeSpan: span(raw, noteStart, raw.length), payloadSpan: span(raw, start, end) };
}

/** Pure compilation of exact user-provided bytes, never a computed fact or a model-selected paraphrase. */
export function createUserFactMemoryReceipt(raw: unknown, binding: UserFactMemoryBinding): UserFactMemoryReceipt | null {
  try {
    const parsed = BindingSchema.safeParse(binding), assessment = assessUserFactMemoryRequest(raw);
    if (!parsed.success || assessment.status !== 'ready' || typeof raw !== 'string' || hash(raw) !== parsed.data.originalRequestHash) return null;
    const text = raw.slice(assessment.payloadSpan.start, assessment.payloadSpan.end), requestHash = hash(raw), payloadHash = hash(text);
    const body = { ...parsed.data, version: 1 as const, kind: 'current_user_literal_memory' as const, statementKind: assessment.statementKind,
      requestHash, directiveSpan: assessment.directiveSpan, envelopeSpan: assessment.envelopeSpan, payloadSpan: assessment.payloadSpan,
      payload: { text, hash: payloadHash, bytes: Buffer.byteLength(text, 'utf8') },
      operationKey: hash(JSON.stringify([assessment.statementKind === 'current_declaration' ? 'mohassan:current-user-declaration-memory:v1' : 'mohassan:current-user-literal-memory:v1', parsed.data.ownerId, parsed.data.conversationId,
        parsed.data.runId, parsed.data.evaluatedAt, requestHash, assessment.statementKind, assessment.payloadSpan, payloadHash])) };
    return ReceiptSchema.parse(body);
  } catch { return null; }
}

/** Trusted binding includes independently pinned pre-schema hash. Self-consistent altered receipts cannot change the original current request. */
export function restoreUserFactMemoryReceipt(value: unknown, raw: unknown, binding: UserFactMemoryBinding): UserFactMemoryReceipt | null {
  try {
    const parsed = ReceiptSchema.safeParse(value);
    if (!parsed.success) return null;
    const expected = createUserFactMemoryReceipt(raw, binding);
    return expected && JSON.stringify(parsed.data) === JSON.stringify(expected) ? expected : null;
  } catch { return null; }
}
