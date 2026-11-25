import { checkReply } from '../../apps/server/src/assistant/reply-check.js';

export const replyQualityChecks = ['answerFirst', 'noRestatement', 'noEarlierRepetition', 'appropriateStructure'] as const;
type ReplyQualityCheck = typeof replyQualityChecks[number];

interface ObservedReply {
  request: string;
  reply: string;
  previousReplies: readonly string[];
}

type ReplyQualityResult = Record<ReplyQualityCheck, boolean | null>;

const preamble = /^(?:sure|certainly|of course|absolutely|great question|happy to help|here (?:is|are|s) (?:the|my|your)|حسنا|بالطبع|بالتاكيد|اكيد|طبعا|سوال جيد|اليك (?:الاجابه|الجواب))\s/iu;
const listItem = /^\s*(?:[-+*•]|[\p{Nd}]+[.)])\s+(?=\S)/u;
const heading = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*$)/u;
const sourceHeading = /^\s*[*_#\s]*(?:sources?|references?|المصادر?|المراجع?)[*_\s]*[:：]/iu;
const restatementLead = /^(?:you asked(?: me)?|سالت(?:ني)?)\s+/iu;
const listRequest = /(?:\b(?:list|bullets?|bullet points?|steps?|checklist|compare|comparison|pros and cons|how (?:to|do|can|should))\b|(?:^|\s)(?:قارن|مقارنه|خطوات|قائمه|نقاط|عدد|كيف)(?:\s|$))/iu;
const proseRequest = /(?:\b(?:no (?:bullet points?|bullets?|lists?|headings)|in (?:one|a single) (?:paragraph|sentence|line))\b|(?:^|\s)(?:(?:بدون|من دون|بلا) (?:قائمه|نقاط|عناوين)|في (?:فقره|جمله|سطر) واحد(?:ه)?)(?:\s|$))/iu;
const intentionalRepetition = /(?:\b(?:repeat|restate|quote) (?:that|it|your|the same)\b|(?:^|\s)(?:كرر|اعد|اقتبس) (?:ذلك|نفس|ردك|الرد|كلامك)(?:\s|$))/iu;

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[\u0640\u064B-\u065F\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function proseLines(reply: string): string[] {
  return reply.replace(/```[^\n]*\n[\s\S]*?(?:\n```|$)/gu, '')
    .split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}

function substantiveClaims(reply: string): Set<string> {
  const lines = proseLines(reply).filter(line => !heading.test(line) && !/^>/u.test(line));
  const claims = lines.flatMap(line => line.split(/(?<=[.!?؟])\s+/u)).map(normalize)
    .filter(text => text.split(' ').length >= 5);
  return new Set(claims);
}

export function scoreReplyQuality({ request, reply, previousReplies }: ObservedReply): ReplyQualityResult {
  if (!reply.trim()) return { answerFirst: null, noRestatement: null, noEarlierRepetition: null, appropriateStructure: null };
  const lines = proseLines(reply);
  const lead = lines[0] ?? '';
  const question = normalize(request);
  const normalizedReply = normalize(reply);
  const firstSentence = lead.split(/(?<=[.!?؟])\s/u, 1)[0] ?? '';
  const leadCandidates = [normalize(lead), normalize(firstSentence)];
  const restatement = question.split(' ').length >= 3 && leadCandidates.some(candidate => candidate === question
    || candidate.replace(restatementLead, '') === question);
  const firstIsSource = (sourceHeading.test(lead) || /^https?:\/\//iu.test(lead))
    && !/(?:\b(?:source|url|link|references?)\b|(?:^|\s)(?:رابط|مصدر|مرجع)(?:\s|$))/iu.test(question);
  const leadsWithAttribution = checkReply({ question: request, reply }).findings.some(finding => finding.code === 'byline_lead');
  const claims = substantiveClaims(reply);
  const repeat = previousReplies.some(previous => {
    const sameReply = normalizedReply.split(' ').length >= 3 && normalize(previous) === normalizedReply;
    return sameReply || [...substantiveClaims(previous)].some(claim => claims.has(claim));
  });
  const list = lines.filter(line => listItem.test(line));
  const headings = lines.filter(line => heading.test(line) && !sourceHeading.test(line)
    && (lines.length > 1 || /^#/u.test(line)));
  const distinctItems = new Set(list.map(line => normalize(line.replace(listItem, ''))));
  const structured = list.length > 0 || headings.length > 0;
  const usefulStructure = distinctItems.size >= 2 || headings.length >= 2 || listRequest.test(question);
  return {
    answerFirst: !restatement && !preamble.test(leadCandidates[0] ?? '') && !firstIsSource && !leadsWithAttribution,
    noRestatement: !restatement,
    noEarlierRepetition: previousReplies.length > 0 && !intentionalRepetition.test(question) ? !repeat : null,
    appropriateStructure: !structured || (!proseRequest.test(question) && usefulStructure),
  };
}
