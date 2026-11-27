import { publicSearchScan, publicSearchText, safeResumeUrl } from '@mohassan/browser';
import { parseHands } from './hands.js';
import { judge, resolvedQuestion, type JudgeEvidence, type JudgeVerdict } from './judge.js';
import type { JudgeShadowInput } from './judge-shadow.js';
import { buildFrame } from './mind/frame.js';
import { ownFactQuestion } from './own-fact-question.js';
import { inspectTruth, type TruthFinding } from './truth-agreement.js';

export type TruthCheckMode = 'shadow' | 'on';

export interface TruthCheckRecord {
  decision: 'send' | 'withhold' | 'outside_scope' | 'unavailable';
  codes: (TruthFinding | 'evidence_unavailable' | 'unread_citation')[];
  applied: boolean;
}

export function truthCheckMode(env: NodeJS.ProcessEnv): TruthCheckMode | undefined {
  const mode = env.MOHASSAN_TRUTH_CHECK;
  return mode === 'shadow' || mode === 'on' ? mode : undefined;
}

const sourceLine = /^[ \t]*(?:\*\*)?(?:Source(?: link)?|المصدر|رابط المصدر):(?:\*\*)?[ \t]+([^\n]+)/gimu;
const markdownAddress = /\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/giu;
const plainAddress = /https?:\/\/[^\s<>]+/giu;

function sourceKey(address: string): string | undefined {
  const url = URL.parse(address);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  url.hash = '';
  return url.href;
}

function readPages(evidence: JudgeShadowInput['evidence']): JudgeEvidence[] {
  return evidence?.filter(item => item.kind === 'page' && !item.searchSnippet && item.text.trim()) ?? [];
}

function safeSources(pages: readonly JudgeEvidence[], scrub?: (text: string) => string): string[] {
  const links = new Set<string>();
  for (const { url } of pages) {
    if (!url || (scrub && scrub(url) !== url)) continue;
    const key = sourceKey(url);
    const safe = key && safeResumeUrl(key);
    if (!safe) continue;
    const decoded = publicSearchScan(safe);
    if (publicSearchText(decoded) !== decoded) continue;
    links.add(`[${new URL(safe).hostname}](${safe.replaceAll('(', '%28').replaceAll(')', '%29')})`);
  }
  return [...links];
}

function cannotConfirm(lang: JudgeVerdict['lang'], pages: readonly JudgeEvidence[], scrub?: (text: string) => string): string {
  const message = lang === 'ar' ? 'لم أتمكن من تأكيد إجابة سؤالك من الأدلة المتاحة.' : 'I could not confirm an answer to your question from the available evidence.';
  const links = safeSources(pages, scrub);
  return links.length ? `${message}\n\n**${lang === 'ar' ? 'الصفحات التي قرأتها' : 'Pages I read'}:** ${links.join(' · ')}` : message;
}

function assessCandidate(input: JudgeShadowInput, verdict: JudgeVerdict, candidate: string, pages: readonly JudgeEvidence[]): TruthCheckRecord {
  const outside: TruthCheckRecord = { decision: 'outside_scope', codes: [], applied: false };
  if (!candidate.trim() || input.status === 'blocked' || input.status?.startsWith('waiting_')
    || !['answer', 'quote', 'computed'].includes(verdict.kind)) return outside;
  const lastStep = verdict.kind === 'quote' ? parseHands(input.question)?.at(-1) : undefined;
  const pageQuestion = lastStep?.kind === 'ask_page' ? lastStep.question : undefined;
  const question = pageQuestion ?? resolvedQuestion(input.question, input.previous);
  const frame = buildFrame(question);
  if (!pageQuestion && (frame.personal || ownFactQuestion(question) || frame.intent !== 'fact_question')) return outside;

  const cited = [...candidate.matchAll(sourceLine)].flatMap(([, source]) => {
    const linked = [...source!.matchAll(markdownAddress)].map(match => match[1]!);
    return (linked.length ? linked : source!.match(plainAddress) ?? []).map(sourceKey);
  });
  const pageKeys = new Map(pages.map(page => [page, page.url ? sourceKey(page.url) : undefined]));
  const relevant = cited.length ? pages.filter(page => {
    const key = pageKeys.get(page);
    return key && cited.includes(key);
  }) : pages;
  const inspection = inspectTruth(question, candidate, relevant);
  if (!inspection.answerType) return outside;
  const knownKeys = new Set(pageKeys.values());
  if (cited.some(key => !key || !knownKeys.has(key))) return { decision: 'withhold', codes: ['unread_citation'], applied: false };
  if (!relevant.length) return { decision: 'withhold', codes: ['evidence_unavailable'], applied: false };
  const codes = [...new Set(inspection.fragments.flatMap(fragment => fragment.finding ?? []))];
  if (inspection.supportedAnswer && !codes.length) return { decision: 'send', codes: [], applied: false };
  return { decision: 'withhold', codes: codes.length ? codes : ['wrong_relation'], applied: false };
}

/** Evaluate the candidate from the existing judge and return its normal publication verdict. */
export function evaluateJudgeReply(input: JudgeShadowInput, mode?: TruthCheckMode): { verdict: JudgeVerdict; truth?: TruthCheckRecord } {
  const existing = input.priorVerdict ?? judge(input);
  if (!mode) return { verdict: existing };

  // The council already judged its selected reply and did not apply a legacy fix at publication.
  const verdict: JudgeVerdict = input.truthOnly
    ? { ...existing, decision: 'send', fixedReply: null, withholdText: null }
    : existing;
  const legacyWithhold = input.applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim();
  const candidate = input.applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim()
    ? verdict.fixedReply : input.reply;

  try {
    const pages = readPages(input.evidence);
    const truth = assessCandidate(input, verdict, candidate, pages);
    if (mode !== 'on' || !input.applyWithhold || legacyWithhold || truth.decision !== 'withhold') return { verdict, truth };

    const withholdText = cannotConfirm(verdict.lang, pages, input.scrubTruthText);
    return {
      verdict: {
        ...verdict, decision: 'withhold', fixedReply: null, withholdText,
        codes: [...verdict.codes, 'truth_check_failed'],
        findings: [{ code: 'truth_check_failed', severity: 'block', line: 0, excerpt: '', detail: '' }, ...verdict.findings],
      },
      truth: { ...truth, applied: true },
    };
  } catch {
    return { verdict, truth: { decision: 'unavailable', codes: [], applied: false } };
  }
}
