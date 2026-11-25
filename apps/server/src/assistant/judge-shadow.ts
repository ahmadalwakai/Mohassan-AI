import { feedbackSelectionScope, restrictFeedbackJudge } from '../feedback-selection.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  /**
   * False: the line keeps the verdict (decision, codes, counts, timing) and drops every piece of the conversation: the
   * question, the reply, the lines the judge quotes and its replacement texts. Used in production for accounts other than
   * the owner's, whose text already lives in the database under its own access rules. Default true.
   */
  keepText?: boolean;
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
  /** False when the line was written without the conversation's text (JudgeShadowInput.keepText). Absent in lines from before this field existed, which all kept it. */
  textKept?: boolean;
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

export interface JudgeSettings { enabled: boolean; logFile: string; fixForOwner: boolean; withholdForOwner: boolean; logText: 'all' | 'owner' }
/**
 * Where and how the judge runs on this server. It is on unless MOHASSAN_JUDGE_SHADOW=0; MOHASSAN_JUDGE_FIX=0 and
 * MOHASSAN_JUDGE_WITHHOLD=0 stop it changing the owner's replies. Since the owner's word of 2026-11-22 («نعم شغله») that
 * holds in production too. There the log keeps the conversation's text for the owner's own replies only, and
 * MOHASSAN_JUDGE_LOG_DIR names a folder the service may write: the application folder is read-only on the server.
 */
export function judgeSettings(production: boolean, env: NodeJS.ProcessEnv, cwd: string): JudgeSettings {
  const directory = env.MOHASSAN_JUDGE_LOG_DIR?.trim() || join(cwd, '.data', 'judge');
  return {
    enabled: env.MOHASSAN_JUDGE_SHADOW !== '0' && !env.VITEST, logFile: join(directory, 'shadow.jsonl'),
    fixForOwner: env.MOHASSAN_JUDGE_FIX !== '0', withholdForOwner: env.MOHASSAN_JUDGE_WITHHOLD !== '0', logText: production ? 'owner' : 'all',
  };
}

export function createJudgeShadow(options: { logFile: string; now?: () => Date }): JudgeShadow {
  const now = options.now ?? (() => new Date());
  let queue: Promise<void> = Promise.resolve();
  let directoryReady = false, warned = false;
  const write = (line: JudgeShadowLine) => {
    queue = queue.then(async () => {
      if (!directoryReady) { await mkdir(dirname(options.logFile), { recursive: true }); directoryReady = true; }
      await appendFile(options.logFile, `${JSON.stringify(line)}\n`, 'utf8');
    }).catch(() => {
      // A shadow log must never reach the chat. The first failed write is named once in the server log: the judge still
      // decides without its log, and a folder the service cannot write should not stay unnoticed.
      if (!warned) { warned = true; console.error(JSON.stringify({ level: 'warn', event: 'judge_log_unavailable', logFile: options.logFile })); }
    });
  };
  return {
    logFile: options.logFile,
    observe(candidate) {
      try {
        const input = restrictFeedbackJudge(candidate);
        const verdict = judge(input);
        feedbackSelectionScope.getStore()?.judgeDecision(verdict.decision);
        const applied = Boolean(input.applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim())
          || Boolean(input.applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim());
        const keep = input.keepText !== false;
        const quoted = (line: JudgeVerdict['lead']) => keep || !line ? line : { ...line, text: '' };
        write({
          at: now().toISOString(), conversationId: input.conversationId, runId: input.runId,
          question: keep ? input.question.slice(0, MAX_TEXT) : '', previous: keep && input.previous ? input.previous.slice(0, MAX_TEXT) : null, reply: keep ? input.reply.slice(0, MAX_REPLY) : '', status: input.status ?? null,
          decision: verdict.decision, applied, withholdText: keep ? verdict.withholdText : null, kind: verdict.kind, lang: verdict.lang, intent: verdict.frame.intent, answerType: verdict.frame.answerType, sourced: verdict.sourced,
          codes: verdict.codes, findings: keep ? verdict.findings : verdict.findings.map(finding => ({ ...finding, excerpt: '', detail: '' })), lead: quoted(verdict.lead), best: quoted(verdict.best),
          fixedReply: keep && verdict.fixedReply ? verdict.fixedReply.slice(0, MAX_REPLY) : null, support: verdict.support, evidence: input.evidence?.length ?? 0, ms: verdict.ms, textKept: keep,
        });
        return verdict;
      } catch {
        return null;
      }
    },
    flush: () => queue,
  };
}
