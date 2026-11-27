import type { SearchProvider } from '@mohassan/browser';
import type { Kysely } from 'kysely';
import { classifyCouncilWebTurn } from './answer-mode-scope.js';
import type { BrainState } from './brain.js';
import { runCouncilWebAnswer } from './council-web-answer.js';
import { isLiveWebQuestion } from './hands.js';
import { searchCouncilSources } from './hands-search-sources.js';
import { rankHits, type CouncilHistory, type CouncilSearchResult, type ModelCouncilService } from './model-council.js';
import { ruleBaseline } from './model-relations-shadow.js';
import { questionLanguage } from './reply-check.js';
import { chatResponsePolicyInput, readResponsePolicyHistory } from './response-policy-runtime.js';
import type { WritingPageReader } from './writing/host.js';

export function councilWebEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOHASSAN_ANSWER_MODE === 'council-web';
}

export type CouncilWebChatAnswer = Awaited<ReturnType<typeof runCouncilWebAnswer>>;

export function councilWebAccessEnded(request: string) {
  return questionLanguage(request) === 'ar'
    ? 'تعذّر إرسال قرار مجلس النماذج لأن صلاحية استخدامه تغيّرت.'
    : 'The council’s decision could not be sent because access to the council changed.';
}

interface CouncilWebChatInput {
  request: string;
  state: BrainState;
  ownerId: string;
  db: Kysely<any>;
  conversationId: string;
  recentLimit: number;
  scrub: (text: string) => string;
  signal: AbortSignal;
  workerStartedAt: number;
  firstAttempt: boolean;
  evaluatedAt: number;
  council: ModelCouncilService;
  search: SearchProvider;
  readPage?: WritingPageReader;
  authorizeSearch: (query: string) => void;
  progress: (label: string) => Promise<void>;
  history: () => Promise<CouncilHistory>;
}

export async function answerCouncilWebChat(input: CouncilWebChatInput): Promise<CouncilWebChatAnswer | undefined> {
  const { request, state, ownerId, db, conversationId, scrub, recentLimit, signal, council, search, readPage, authorizeSearch, progress, history } = input;
  const turn = classifyCouncilWebTurn(request, state, new Date(input.evaluatedAt));
  if (turn.kind === 'exempt') return;
  const ar = questionLanguage(request) === 'ar';
  if (turn.query === null) return {
    status: 'partial',
    text: turn.reason === 'search_forbidden'
      ? ar ? 'طلبك يمنع البحث في الويب، لذلك لم أتحقق من جواب.' : 'Your request rules out web search, so I could not verify an answer.'
      : ar ? 'تعذّر تحديد استعلام عام آمن لهذا الطلب، لذلك لم أتحقق من جواب.' : 'I could not form a safe public search query for this request or verify an answer.',
  };
  const query = turn.query;
  const startedAt = input.firstAttempt
    ? Math.min(input.workerStartedAt, performance.now() - Math.max(0, Date.now() - input.evaluatedAt))
    : input.workerStartedAt;
  let previous: string | null = null;
  const answer = await runCouncilWebAnswer({
    question: turn.question, previous: null, history: [], baseline: ruleBaseline(state, request), signal, startedAt,
    progress: phase => progress(phase === 'search'
      ? ar ? 'أبحث في مصادر الويب…' : 'Searching web sources…'
      : ar ? 'يناقش مجلس النماذج الأدلة…' : 'The model council is checking the evidence…'),
    search: async (_question, searchSignal): Promise<CouncilSearchResult> => {
      authorizeSearch(query);
      const recent = await readResponsePolicyHistory({ db, ownerId, conversationId, state, policy: chatResponsePolicyInput(request, state), recentLimit, scrub });
      const earlier = recent.filter(entry => entry.role === 'user')[1];
      previous = earlier ? scrub(earlier.text) : null;
      searchSignal.throwIfAborted();
      const { hits, allows, note, plan } = await searchCouncilSources(search, query, request, ownerId, searchSignal, previous);
      searchSignal.throwIfAborted();
      const ranked = rankHits(query, hits).slice(0, 3);
      const live = plan.fresh || isLiveWebQuestion(turn.question);
      const pages = await Promise.all(ranked.map(async hit => {
        const page = await readPage?.(hit.url, searchSignal, { live }).catch(() => null);
        if (!page || page === 'disallowed' || page.status >= 400 || !allows(page.url) || !page.text.trim()) return null;
        return { kind: 'page' as const, url: page.url, title: page.title || hit.title, text: page.text.slice(0, 200_000) };
      }));
      return { pages: pages.filter(page => page !== null), note };
    },
    deliberate: async turn => {
      const turns = await history();
      turn.signal.throwIfAborted();
      return council.deliberate({ ...turn, previous, history: turns });
    },
  });
  return { ...answer, text: scrub(answer.text) };
}
