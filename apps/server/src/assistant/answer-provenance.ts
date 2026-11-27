import { taskEvidenceHash } from './task-supervisor.js';
import { matchText, normalizeRequest } from './mind/normalize.js';

const AR = /^(?:(?:اشرح|وضح|اخبرني)(?: لي)? )?(?:كيف (?:حصلت|توصلت) (?:علي|الي)|من اين (?:حصلت علي|اتيت ب)|ما (?:هو )?(?:مصدر|مصادر)) (?:(?:ال)?اجابه|اجابتك|(?:ال)?جواب|جوابك|(?:ال)?رد|ردك) (?:السابقه?|الاخيره?)[.!؟?]*$/u;
const EN = /^(?:(?:explain|tell me) )?(?:how (?:did you (?:get|find|reach|come up with|arrive at)|you (?:got|found|reached|came up with|arrived at))|where did you (?:get|find)|what (?:is|are|was|were) (?:the )?sources? (?:for|of)) (?:the|your) (?:previous|last) (?:answer|reply|response)[.!?]*$/u;

export function answerProvenanceRequest(request: string): 'ar' | 'en' | null {
  const text = matchText(normalizeRequest(request).text).replace(/\s+/gu, ' ').trim()
    .replace(/^[وف]\s*(?=كيف |من اين |ما )|^and\s+/u, '');
  return AR.test(text) ? 'ar' : EN.test(text) ? 'en' : null;
}

export interface AnswerProvenance {
  answerHash: string;
  sources: string[];
}

const sourceLine = /^\s*(?:\*\*)?(?:المصدر|مصدر ثانٍ (?:يؤكد|يختلف)|رابط المصدر|الصفحة التي قرأتها|Source(?: link)?|A second source (?:agrees|differs)|The page I read)\s*:|^\s*«[^\n»]+»\s+https?:\/\//iu;

function sourceAddress(text: string) {
  if (typeof text !== 'string' || text.length > 2000 || /[\s\p{C}<>]/u.test(text)) return null;
  try {
    const url = new URL(text);
    return /^(?:https?):$/u.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** A source must appear in a citation in the published reply and in the host's read records. */
export function recordAnswerProvenance(answer: string, readUrls: readonly string[]): AnswerProvenance {
  const read = new Set(readUrls.map(sourceAddress).filter(Boolean));
  const sources = new Set<string>();
  for (const line of answer.split('\n')) {
    if (!sourceLine.test(line)) continue;
    for (const match of line.matchAll(/\]\((https?:\/\/[^\s]+)\)(?:\s|$)|\b(https?:\/\/[^\s<>()\[\]]+)/gu)) {
      const citation = match[1] ?? match[2];
      if (!citation) continue;
      const url = sourceAddress(citation);
      if (url && read.has(url)) sources.add(url);
      if (sources.size === 8) break;
    }
    if (sources.size === 8) break;
  }
  return { answerHash: taskEvidenceHash(answer), sources: [...sources] };
}

export function explainPreviousAnswer(lang: 'ar' | 'en', previous: { text: string; provenance?: AnswerProvenance; legacyUrls?: string[]; calculation?: string } | null) {
  const ar = lang === 'ar';
  if (!previous) return ar ? 'لا توجد إجابة سابقة في هذه المحادثة أرجع إليها.' : 'There is no previous answer in this conversation to explain.';
  const { text, provenance, legacyUrls, calculation } = previous;
  const sources = provenance?.answerHash === taskEvidenceHash(text) && Array.isArray(provenance.sources)
    ? provenance.sources : !provenance ? legacyUrls ?? [] : [];
  const recorded = recordAnswerProvenance(text, sources).sources;
  if (recorded.length) {
    const intro = ar ? 'استند الرد السابق إلى الصفحات المقروءة التالية، وهي المصادر المسجّلة معه.'
      : 'The previous reply used these pages, which are the recorded sources cited in it.';
    return `${intro}\n\n${recorded.map(url => `- ${url}`).join('\n')}`;
  }
  if (calculation && text.includes(calculation)) return ar ? `حصلت على النتيجة بالحساب المحلي.\n\n${calculation}` : `I computed the result locally.\n\n${calculation}`;
  return ar ? 'لا توجد مصادر مسجّلة للرد السابق. لا أستطيع تأكيد الطريقة التي حصلت بها عليه من السجل المتاح.'
    : 'No sources are recorded for the previous reply. The available record does not establish how it was produced.';
}
