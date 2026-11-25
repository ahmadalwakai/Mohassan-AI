import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AgentPage } from '@mohassan/browser';
import { judge, type JudgeDecision } from './assistant/judge.js';
import { captureFeedback, feedbackEvidencePolicy, lockFeedbackQuestion, recordFeedbackAnswer } from './feedback-store.js';
import { feedbackPageKey, feedbackSourceUrls } from './feedback-page-key.js';
import { allowsFeedbackEvidence, feedbackBlockedReply, feedbackSelectionScope, type FeedbackEvidencePolicy } from './feedback-selection.js';

interface Run {
  ownerId: string;
  id: string;
  runId: string;
  request?: string;
  previousRequest?: string | null;
  state?: { routing?: { route?: string } | null };
  readPages?: AgentPage[];
  page?: AgentPage;
}

interface Observation {
  hands: Map<string, boolean>;
  mind: string[];
  route?: string;
  decision?: JudgeDecision;
  evidenceUrls?: string[];
  actionOutcome?: string;
  policy: FeedbackEvidencePolicy;
  scrub(text: string): string;
}

const runs = new WeakMap<Run, Observation>();
const emptyPolicy = { blocked: new Set<string>(), pinned: new Set<string>() };

export function run<T>(db: Kysely<any>, current: Run, scrub: Observation['scrub'], work: () => T): T {
  const observation: Observation = { hands: new Map(), mind: [], policy: emptyPolicy, scrub };
  runs.set(current, observation);
  return feedbackSelectionScope.run({
    async policy() {
      if (current.request) {
        observation.policy = await feedbackEvidencePolicy(db, current.ownerId, scrub(current.request), current.previousRequest ? scrub(current.previousRequest) : null);
      }
      return observation.policy;
    },
    evidenceAllowed: url => allowsFeedbackEvidence(observation.policy, url),
    startHands() { observation.route = 'hands'; },
    handSource(url, requiresCitation, actionOutcome) {
      // An earlier candidate considered during repair is used only if the final reply still cites it.
      observation.hands.set(url, requiresCitation && observation.hands.get(url) !== false);
      observation.actionOutcome = actionOutcome;
    },
    citedHandSources(reply) {
      const cited = new Set(feedbackSourceUrls(reply).map(feedbackPageKey));
      return [...observation.hands.keys()].filter(url => cited.has(feedbackPageKey(url)));
    },
    mindSource(evidenceUrls) { observation.route = 'mind'; observation.mind = evidenceUrls; },
    judgeDecision(decision) {
      if (!observation.decision || decision === 'withhold' || observation.decision === 'send') observation.decision = decision;
    },
  }, work);
}

function evidencedPages(current: Run) {
  const seen = new Set<string>();
  return [...(current.readPages ?? []), ...(current.page ? [current.page] : [])]
    .filter(page => page.text?.trim() && !seen.has(page.url) && seen.add(page.url))
    .map(page => ({ kind: 'page' as const, url: page.url, title: page.title, text: page.text.slice(0, 200_000) }));
}

export async function preparePublication<S extends string>(tx: Kysely<any>, current: Run | undefined, text: string, status: S) {
  const observation = current && runs.get(current);
  if (!current?.request || !observation) return { text, status };
  const { scrub } = observation;
  const question = scrub(current.request);
  const previousQuestion = current.previousRequest ? scrub(current.previousRequest) : null;
  const cited = new Set(feedbackSourceUrls(text).map(feedbackPageKey));
  const hands = observation.route === 'hands' ? [...observation.hands] : [];
  const used = hands.flatMap(([url, needsCitation]) => !needsCitation || cited.has(feedbackPageKey(url)) ? [url] : []);
  if (observation.route === 'mind') used.push(...observation.mind);
  used.push(...evidencedPages(current).flatMap(page => cited.has(feedbackPageKey(page.url)) ? [page.url] : []));
  // Only persist observed URLs that survive the same redaction used for chat messages.
  observation.evidenceUrls = [...new Set(used.filter(url => scrub(url) === url).flatMap(url => feedbackPageKey(url) ?? []))];
  await lockFeedbackQuestion(tx, question, previousQuestion);
  if (!observation.evidenceUrls.length) return { text, status };
  observation.policy = await feedbackEvidencePolicy(tx, current.ownerId, question, previousQuestion);
  if (observation.evidenceUrls.every(url => allowsFeedbackEvidence(observation.policy, url))) return { text, status };
  observation.evidenceUrls = [];
  if (observation.actionOutcome) return { text: scrub(observation.actionOutcome), status };
  return { text: feedbackBlockedReply(/\p{Script=Arabic}/u.test(question)), status: status === 'completed' ? 'partial' as const : status };
}

export async function publish(tx: Kysely<any>, id: string, current: Run | undefined, reply: string, status: string) {
  const messageId = randomUUID();
  await tx.insertInto('chat_messages').values({ id: messageId, conversation_id: id, role: 'assistant', text: reply }).execute();
  const observation = current && runs.get(current);
  if (!current?.request || !observation) return;
  const { scrub } = observation;
  const question = scrub(current.request);
  const previousQuestion = current.previousRequest ? scrub(current.previousRequest) : null;
  const evidence = evidencedPages(current);
  const judgeDecision = observation.decision ?? judge({ question, previous: previousQuestion, reply, status, ...(evidence.length ? { evidence } : {}) }).decision;
  await recordFeedbackAnswer(tx, { messageId, userId: current.ownerId, conversationId: id, question, previousQuestion,
    reply, status, evidenceUrls: observation.evidenceUrls ?? [], route: observation.route ?? current.state?.routing?.route ?? null, judgeDecision });
}

export { captureFeedback };
