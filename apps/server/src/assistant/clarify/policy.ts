import { randomUUID } from 'node:crypto';
import type { ChatQuestion } from '@mohassan/contracts';
import type { RequestResolution } from '../request-context.js';
import type { RoutedIntent } from '../routing-decision.js';

type Language = 'ar' | 'en';
export type ClarificationKind = 'entity' | 'date' | 'account' | 'file' | 'route';
type OperandKind = Exclude<ClarificationKind, 'route'>;
type OpenKind = OperandKind | 'request' | 'conversion';
type Reason = 'entity_matches' | 'close_routes' | 'missing_slot';

export interface ClarificationChoice {
  label: string;
  value: string;
  score: number;
  source: 'conversation' | 'search' | 'memory' | 'rules' | 'b0';
  private?: boolean;
  route?: RoutedIntent;
}

export interface ClarificationPlan {
  kind: ClarificationKind | 'request' | 'conversion';
  reason: Reason;
  subject?: string;
  language: Language;
  prompt: string;
  candidates: ClarificationChoice[];
}

// Relative costs and starting margins for the deterministic evidence scores.
// A higher cost of a wrong guess warrants asking over a wider range of scores.
export const clarificationCosts = {
  entity_matches: { unnecessaryQuestion: 1, wrongGuess: 4, margin: 0.16 },
  close_routes: { unnecessaryQuestion: 1, wrongGuess: 6, margin: 0.18 },
  missing_slot: { unnecessaryQuestion: 1, wrongGuess: 8, margin: 0.20 },
} as const;

const prompts: Record<ClarificationKind, Record<Language, string>> = {
  entity: { en: 'Which subject do you mean?', ar: 'أيّ موضوع تقصد؟' },
  route: { en: 'Which action should I take?', ar: 'أيّ إجراء تريدني أن أنفّذ؟' },
  date: { en: 'Which date should I use?', ar: 'أيّ تاريخ تقصد؟' },
  account: { en: 'Which account should I use?', ar: 'أيّ حساب تريدني أن أستخدم؟' },
  file: { en: 'Which file should I use?', ar: 'أيّ ملف تريدني أن أستخدم؟' },
};

export const clarificationLanguage = (request: string): Language => /\p{Script=Arabic}/u.test(request.match(/\p{L}/u)?.[0] ?? '') ? 'ar' : 'en';
const key = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\u0640\u064b-\u065f\u0670]/gu, '').trim();

export function decideClarification(input: {
  kind: ClarificationKind;
  language: Language;
  subject?: string;
  candidates: readonly ClarificationChoice[];
}): { decision: 'ask'; plan: ClarificationPlan } | { decision: 'insufficient_evidence' | 'clear_winner'; count: number } {
  const reason = input.kind === 'route' ? 'close_routes' : input.kind === 'entity' ? 'entity_matches' : 'missing_slot';
  const values = new Set<string>();
  const labels = new Set<string>();
  const candidates = [...input.candidates].filter(({ score, label, value }) => Number.isFinite(score) && score >= 0.6 && score <= 1
    && label.trim() === label && label.length > 0 && label.length <= 120 && value.trim() === value && value.length > 0 && value.length <= 120
    && !/[\p{Cc}\p{Cf}]/u.test(label + value) && !['other', 'غير ذلك'].includes(key(label)))
    .sort((a, b) => b.score - a.score).filter(candidate => {
      const value = key(candidate.value), label = key(candidate.label);
      if (values.has(value) || labels.has(label)) return false;
      values.add(value); labels.add(label);
      return true;
    });
  const [first, second] = candidates;
  const margin = clarificationCosts[reason].margin;
  if (first && (first.score >= 0.95 || second && first.score - second.score >= margin)) return { decision: 'clear_winner', count: candidates.length };
  if (!second || !first) return { decision: 'insufficient_evidence', count: candidates.length };
  const prompt = input.kind === 'entity' && input.subject && input.subject.length <= 80
    ? input.language === 'ar' ? `ماذا تقصد بـ«${input.subject}»؟` : `What do you mean by “${input.subject}”?`
    : prompts[input.kind][input.language];
  return { decision: 'ask', plan: { kind: input.kind, reason, language: input.language, prompt,
    ...(input.subject ? { subject: input.subject } : {}), candidates: candidates.filter(candidate => first.score - candidate.score < margin).slice(0, 4) } };
}

export function clarificationCard(plan: ClarificationPlan): ChatQuestion {
  const options = plan.candidates.map(({ label }, index) => ({ id: `choice_${index + 1}`, label }));
  return { id: randomUUID(), prompt: plan.prompt, options, fields: [{ id: 'choice', prompt: plan.prompt,
    suggestions: options.map(({ label }) => ({ label })), placeholder: options.length
      ? plan.language === 'ar' ? 'غير ذلك…' : 'Other…'
      : plan.language === 'ar' ? 'اكتب التوضيح' : 'Enter the missing detail' }] };
}

export function openClarification(kind: OpenKind, language: Language, subject?: string, prompt?: string): ClarificationPlan {
  const subjectPrompt = language === 'ar' ? 'ما اسم الشخص أو الموضوع الذي تقصده؟' : 'Which subject do you mean?';
  return { kind, reason: 'missing_slot', language, ...(subject ? { subject } : {}), candidates: [],
    prompt: prompt ?? (kind === 'request' || kind === 'entity' || kind === 'conversion' ? subjectPrompt : prompts[kind][language]) };
}

export function legacyClarificationNeeded(resolution: RequestResolution | null | undefined): boolean {
  return resolution?.kind === 'ambiguous' && resolution.ambiguities.some(reason =>
    reason === 'missing_reference' || reason === 'missing_question' || reason === 'unclear_replacement');
}

export function missingClarificationSlot(text: string, resolution?: RequestResolution | null): 'date' | 'file' | 'account' | null {
  const folded = text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآ]/gu, 'ا');
  if (resolution?.intent === 'reminder' && !resolution.slots.some(slot => slot.kind === 'time')
    && !/\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|noon|midnight|morning|evening|later)\b|(?:السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|صباح|مساء|بعد قليل|بعد غد|امس)|\p{Nd}{1,4}[-/:٫]\p{Nd}{1,2}|\b(?:on|at)\s+\p{Nd}|(?:\b(?:in|after)|(?:^|\s)بعد)\s+\p{Nd}+\s*(?:minutes?|hours?|days?|weeks?|دقائق|ساعات|ايام|اسابيع)/iu.test(folded)) return 'date';
  if (/^(?:please\s+)?(?:show|check|look up|find|read|view)\b[^\n.!?؟]{0,180}\b(?:in|for|from|on) (?:my|the) account\s*[.!?؟]?$/iu.test(folded)
    || /^(?:اعرض|تحقق|اقرا|ابحث|ارني)\s+[^\n.!?؟]{0,180}(?:في|من|على)\s+(?:حسابي|الحساب)\s*[.!?؟]?$/u.test(folded)) return 'account';
  if (/^(?:please\s+)?(?:open|read|show|summari[sz]e|inspect|find)\s+(?:(?:the|my|this|that)\s+)?(?:file|document|pdf)(?: on my (?:computer|pc))?\s*[.!?؟]?$/iu.test(folded)
    || /^(?:افتح|اقرا|اعرض|لخص|ابحث عن)\s+(?:الملف|المستند|ملفي|مستندي)(?:\s+على\s+جهازي)?\s*[.!?؟]?$/u.test(folded)) return 'file';
  return null;
}
