import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { judge, type JudgeCode, type JudgeDecision, type JudgeInput, type JudgeVerdict, type ReplyKind } from './judge.js';

/**
 * The judge in shadow: the chat sends what it sends, and this records what the judge would have decided about it,
 * one JSON line per reply, for the owner's review and the report (`npx tsx scripts/judge/shadow-report.ts`). Like
 * the router and conversation-state shadows it changes nothing: it never throws into the chat, a failed write is
 * dropped, and the reply text is truncated. Wiring it is two lines in command-chat.ts finish(); see
 * docs/HANDOVER-2026-11-22-JUDGE-SHADOW.md.
 */
export interface JudgeShadowInput extends JudgeInput {
  conversationId: string;
  runId: string;
  /** The host will send the judge's fixed reply when the decision is fix (owner's own account only, by the owner's word of 2026-11-22). */
  applyFix?: boolean;
  /** The host will send the judge's withhold text when the decision is withhold (owner's own account only, by the owner's word of 2026-11-22). */
  applyWithhold?: boolean;
}
export interface JudgeShadowLine {
  at: string;
  conversationId: string;
  runId: string;
  question: string;
  /** The user's previous turn when the host knew it; null for a first turn or a reply finished before the history was read. */
  previous: string | null;
  reply: string;
  status: string | null;
  decision: JudgeDecision;
  /** True when the host sent `fixedReply` (decision fix) or `withholdText` (decision withhold) instead of `reply`; `reply` stays the text as the chat first wrote it. */
  applied: boolean;
  /** The fixed text the host sends instead of a withheld reply. */
  withholdText: string | null;
  kind: ReplyKind;
  lang: 'ar' | 'en';
  intent: string;
  answerType: string | null;
  sourced: boolean;
  codes: JudgeCode[];
  findings: JudgeVerdict['findings'];
  lead: JudgeVerdict['lead'];
  best: JudgeVerdict['best'];
  fixedReply: string | null;
  support: JudgeVerdict['support'];
  /** How many evidence texts the host passed; 0 when none (support not measured). */
  evidence: number;
  ms: number;
}
export interface JudgeShadow {
  readonly logFile: string;
  /** Judges one reply in shadow and logs the verdict. Returns null when judging itself failed. */
  observe(input: JudgeShadowInput): JudgeVerdict | null;
  /** Resolves once every line queued so far is on disk (for tests and shutdown). */
  flush(): Promise<void>;
}

const MAX_TEXT = 2000;
const MAX_REPLY = 4000;

export function createJudgeShadow(options: { logFile: string; now?: () => Date }): JudgeShadow {
  const now = options.now ?? (() => new Date());
  let queue: Promise<void> = Promise.resolve();
  let directoryReady = false;
  const write = (line: JudgeShadowLine) => {
    queue = queue.then(async () => {
      if (!directoryReady) { await mkdir(dirname(options.logFile), { recursive: true }); directoryReady = true; }
      await appendFile(options.logFile, `${JSON.stringify(line)}\n`, 'utf8');
    }).catch(() => { /* a shadow log must never reach the chat */ });
  };
  return {
    logFile: options.logFile,
    observe(input) {
      try {
        const verdict = judge(input);
        const applied = Boolean(input.applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim())
          || Boolean(input.applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim());
        write({
          at: now().toISOString(), conversationId: input.conversationId, runId: input.runId,
          question: input.question.slice(0, MAX_TEXT), previous: input.previous ? input.previous.slice(0, MAX_TEXT) : null, reply: input.reply.slice(0, MAX_REPLY), status: input.status ?? null,
          decision: verdict.decision, applied, withholdText: verdict.withholdText, kind: verdict.kind, lang: verdict.lang, intent: verdict.frame.intent, answerType: verdict.frame.answerType, sourced: verdict.sourced,
          codes: verdict.codes, findings: verdict.findings, lead: verdict.lead, best: verdict.best,
          fixedReply: verdict.fixedReply ? verdict.fixedReply.slice(0, MAX_REPLY) : null, support: verdict.support, evidence: input.evidence?.length ?? 0, ms: verdict.ms,
        });
        return verdict;
      } catch {
        return null;
      }
    },
    flush: () => queue,
  };
}
