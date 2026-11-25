import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AgentAction, AgentBrowser, AgentPage, SearchHit, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/clarification-assessment/development-v1.json', import.meta.url));
const owner = 'clarification-assessment';
type Candidate = { sourceId: number; title: string };
type EntityGroup = { stem: string; candidates: Candidate[] };
type Scaffold = { sourceId: number; before: string; after: string };
type Locale = 'ar-SA' | 'en-US';
type Fixture = { dataset: string; archiveSha256: string; provenance: string; locales: Record<Locale, { templates: Scaffold[]; groups: EntityGroup[] }> };
function fold(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[إأآ]/gu, 'ا');
}

function evidence(locale: Locale, group: EntityGroup) {
  const arabic = locale === 'ar-SA';
  const language = arabic ? 'ar' : 'en';
  const url = (title: string) => `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
  const choices = group.candidates.map(({ title, sourceId }) => ({
    title,
    url: url(title),
    snippet: arabic
      ? `${title} — مجموعة بيانات أمازون MASSIVE 1.0، رقم العبارة ${sourceId}، اللغة ${locale}.`
      : `${title} — Amazon MASSIVE 1.0 dataset, utterance ${sourceId}, locale ${locale}.`,
  }));
  const title = `${group.stem} (${arabic ? 'توضيح' : 'disambiguation'})`;
  const text = [group.stem, ...choices.map(choice => `- ${choice.title}`)].join('\n');
  const page = { title, url: url(title), snippet: text };
  return { choices, page };
}

type Observation = {
  locale: Locale;
  sourceId: number;
  group: string;
  ambiguous: boolean;
  asked: boolean;
  question: string | null;
  options: string[];
  expectedOptions: string[];
  chosen: string | null;
  resume: 'not_applicable' | 'no_question' | 'no_choice' | 'wrong_or_incomplete' | 'dispatched' | 'completed';
  finalStatus: string;
  observedTarget: boolean;
  verifiedFixtureFact: boolean;
};

async function evaluate(fixture: Fixture, enabled: boolean) {
  const database = await createDatabase({});
  if (database.mode !== 'embedded') throw new Error('Assessment requires an isolated embedded database.');
  const forbidden = async (): Promise<never> => { throw new Error('Assessment attempted undeclared I/O.'); };
  let active: ReturnType<typeof evidence> | undefined;
  let queries: string[] = [];
  let reads: string[] = [];
  let visible: AgentPage | undefined;
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return Boolean(visible); }, async close() {},
    async observe() {
      if (!visible) return forbidden();
      return { page: visible, changed: false };
    },
    async act(_ownerId: string, _conversationId: string, action: AgentAction) {
      const source = action.kind === 'open' ? active?.choices.find(choice => choice.url === action.text) : undefined;
      if (!source) return forbidden();
      const { url, title, snippet: text } = source;
      reads.push(url);
      visible = { id: url, url, title, text, elements: [], documentStatus: 200,
        hash: createHash('sha256').update(text).digest('hex'), observedAt: new Date().toISOString(),
        signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 } };
      return { page: visible, changed: true };
    },
    prepareAction: forbidden, screen: forbidden,
  } as unknown as AgentBrowser;
  const searchProvider: SearchProvider = {
    name: 'clarification-assessment',
    async search(query: string, limit: number) {
      queries.push(query);
      if (!active) throw new Error('Unexpected assessment search.');
      const exact = active.choices.filter(choice => fold(query).includes(fold(choice.title)));
      return (exact.length ? exact : [active.page, ...active.choices]).slice(0, limit);
    },
  };
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    await migrate(database.db);
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, searchProvider, recordExperiences: false, clarifyChoices: enabled,
      fetch: forbidden,
      async readPage(url) {
        reads.push(url);
        if (!active) throw new Error('Unexpected assessment page read.');
        const pages: SearchHit[] = [active.page, ...active.choices];
        const found = pages.find(page => page.url === url);
        if (!found) throw new Error('Undeclared assessment page.');
        const links = found === active.page ? active.choices.map(choice => choice.url) : [];
        return { status: 200, title: found.title, text: found.snippet, url, links };
      },
    });
    const observations: Observation[] = [];
    for (const [locale, { groups, templates }] of Object.entries(fixture.locales) as [Locale, Fixture['locales'][Locale]][]) {
      for (const [groupIndex, group] of groups.entries()) {
        for (const [templateIndex, scaffold] of templates.entries()) {
          // Vary the selected position so always picking the first choice cannot pass.
          const selected = group.candidates[(groupIndex + templateIndex) % group.candidates.length]!;
          const expected = selected.title;
          const request = (subject: string) => scaffold.before + subject + scaffold.after;
          for (const ambiguous of [true, false]) {
            active = evidence(locale, group);
            queries = [];
            reads = [];
            visible = undefined;
            const conversation = await control.create(owner, { goal: request(ambiguous ? group.stem : expected) });
            await control.settled(conversation.id);
            const detail = await control.detail(owner, conversation.id);
            const originalRun = await database.db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
            const card = detail.question;
            const field = card?.fields?.length === 1 ? card.fields[0] : undefined;
            const options = field?.suggestions.map(suggestion => suggestion.label) ?? card?.options.map(option => option.label) ?? [];
            const label = options.find(value => fold(value) === fold(expected));
            const asked = detail.status === 'waiting_user' && Boolean(card);
            const targetUrl = active.choices.find(choice => choice.title === expected)!.url;
            const answerMatches = (answer: string) => fold(answer).includes(fold(expected)) && new RegExp(`\\b${selected.sourceId}\\b`, 'u').test(answer);
            let resume: Observation['resume'] = ambiguous ? 'no_question' : 'not_applicable';
            let finalStatus = originalRun.status;
            let answer = detail.messages.findLast(message => message.role === 'assistant')?.text ?? '';
            if (ambiguous && asked && card) {
              resume = enabled && (!label || !field) ? 'no_choice' : 'wrong_or_incomplete';
              if (resume !== 'no_choice') {
                const queryStart = queries.length;
                const readStart = reads.length;
                await control.send(owner, conversation.id, enabled && field && label
                  ? { text: label, questionId: card.id, answers: [{ fieldId: field.id, value: label }] }
                  : { text: request(expected), questionId: card.id });
                await control.settled(conversation.id);
                const resumed = await control.detail(owner, conversation.id);
                const runs = await database.db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', conversation.id).execute();
                if (runs.length === 1 && runs[0]?.id === originalRun.id) finalStatus = runs[0].status;
                const exactQuery = queries.slice(queryStart).some(query => fold(query).includes(fold(expected)));
                const targetRead = reads.slice(readStart).includes(targetUrl);
                answer = resumed.messages.findLast(message => message.role === 'assistant')?.text ?? '';
                if (runs.length === 1 && runs[0]?.id === originalRun.id && !resumed.question && finalStatus !== 'waiting_user'
                  && (exactQuery || targetRead)) resume = finalStatus === 'completed' && targetRead && answerMatches(answer) ? 'completed' : 'dispatched';
              }
            }
            observations.push({
              locale, sourceId: scaffold.sourceId, group: group.stem, ambiguous, asked, question: card?.prompt ?? null, options,
              expectedOptions: ambiguous ? group.candidates.map(candidate => candidate.title) : [], chosen: label ?? null, resume, finalStatus,
              observedTarget: queries.some(query => fold(query).includes(fold(expected))) || reads.includes(targetUrl),
              verifiedFixtureFact: finalStatus === 'completed' && reads.includes(targetUrl) && answerMatches(answer),
            });
          }
        }
      }
    }
    return observations;
  } finally {
    await control?.shutdown();
    await database.close();
  }
}

function score(observations: Observation[]) {
  const ambiguous = observations.filter(item => item.ambiguous);
  const clear = observations.filter(item => !item.ambiguous);
  const asked = ambiguous.filter(item => item.asked);
  const offered = asked.flatMap(item => item.options);
  const correctOptions = asked.reduce((count, item) => count + item.options.filter(option => item.expectedOptions.some(expected => fold(option) === fold(expected))).length, 0);
  const exactLists = asked.filter(item => item.options.length === item.expectedOptions.length && new Set(item.options.map(fold)).size === item.options.length
    && item.expectedOptions.every(expected => item.options.some(option => fold(option) === fold(expected))));
  return {
    cases: observations.length, ambiguous: ambiguous.length, clear: clear.length,
    questions: { truePositive: asked.length, falseNegative: ambiguous.length - asked.length,
      falsePositive: clear.filter(item => item.asked).length, trueNegative: clear.filter(item => !item.asked).length },
    candidates: { exactLists: exactLists.length, intendedChoiceOffered: asked.filter(item => item.chosen).length,
      correctOffered: correctOptions, offered: offered.length, expected: ambiguous.reduce((count, item) => count + item.expectedOptions.length, 0) },
    resume: { eligible: ambiguous.length, noQuestion: ambiguous.length - asked.length,
      noChoice: ambiguous.filter(item => item.resume === 'no_choice').length,
      wrongOrIncomplete: ambiguous.filter(item => item.resume === 'wrong_or_incomplete').length,
      sameRunDispatch: ambiguous.filter(item => item.resume === 'dispatched' || item.resume === 'completed').length,
      completed: ambiguous.filter(item => item.resume === 'completed').length },
    clearCompleted: clear.filter(item => !item.asked && item.verifiedFixtureFact).length,
  };
}

const [output] = process.argv.slice(2);
if (!output || process.argv.length !== 3) throw new Error('Usage: node --import tsx scripts/clarification-assessment.ts <output.json>');
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText) as Fixture;
const results = [];
for (const enabled of [false, true]) {
  const observations = await evaluate(fixture, enabled);
  const overall = score(observations);
  const localeScores = Object.fromEntries(Object.keys(fixture.locales).map(locale => [locale, score(observations.filter(item => item.locale === locale))]));
  if (overall.ambiguous !== 150 || overall.clear !== 150 || Object.values(localeScores).some(result => result.ambiguous !== 75 || result.clear !== 75)) {
    throw new Error('Assessment fixture must cover 75 ambiguous and 75 clear requests in each language.');
  }
  const summary = { enabled, overall, byLocale: localeScores };
  console.log(JSON.stringify(summary));
  results.push({ ...summary, observations });
}
await writeFile(output, JSON.stringify({
  fixture: { dataset: fixture.dataset, sourceArchiveSha256: fixture.archiveSha256, provenance: fixture.provenance, sha256: createHash('sha256').update(fixtureText).digest('hex') },
  mode: 'isolated in-process controller with declared synthetic search and read-page callbacks',
  results,
}, null, 2) + '\n', { flag: 'wx' });
