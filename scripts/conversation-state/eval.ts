/**
 * E1.1 of docs/RESPONSE-QUALITY-PLAN-2026-11-22.md: conversation state v2 against the current request-context
 * resolver (v1), offline, on
 *   1. scripts/conversation-state/dev-conversations.json (agent-written development turns, not a sealed measure), and
 *   2. the frozen real set artifacts/plan-2026-11-22/real-questions-v1.jsonl (107 items, unlabelled: only the
 *      v2 type distribution, the refused requests' verdicts and timings are reported there).
 *
 * Usage: npx tsx scripts/conversation-state/eval.ts [--out artifacts/conversation-state-20261122]
 *
 * Scoring rule for v1, which has only the kinds new / follow_up / answer / ambiguous: a v1 kind counts as right
 * for every v2 type it could stand for (new → new_request or topic_change; follow_up → follow_up_property,
 * follow_up_entity, correction or field_edit; answer → card_answer; ambiguous → ambiguous; a 'chat' intent → small_talk).
 * Types v1 cannot express (reference, compound) count against it, as the plan says. A turn is right when its type
 * is acceptable AND its public query meets the fixture's constraint (when one is given) AND `needs` matches (when given).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  emptyConversationState, understandTurn, withHostResults, withPending,
  type ConversationStateV2, type HostResult, type PendingStep, type TurnType, type TurnUnderstanding,
} from '../../apps/server/src/assistant/conversation-state.js';
import { resolveRequestContext, type RequestContextState, type RequestResolution } from '../../apps/server/src/assistant/request-context.js';

interface QueryExpectation { contains?: string[]; containsAny?: string[]; notContains?: string[] }
interface Expectation {
  type: TurnType[];
  entity?: string;
  property?: string;
  query?: QueryExpectation | null;
  needs?: 'missing_reference' | 'missing_value';
  edit?: string;
  reference?: number;
}
interface FixtureTurn {
  text: string;
  pending?: PendingStep;
  shown?: { label: string; kind: HostResult['kind'] }[];
  expect: Expectation;
}
interface Fixture { note: string; conversations: { id: string; dialect: string; about: string; turns: FixtureTurn[] }[] }
interface RealItem { id: string; kind: 'single' | 'pair'; text: string; previous: string | null }

const args = process.argv.slice(2);
const outRoot = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'artifacts/conversation-state-20261122';
const fixturePath = 'scripts/conversation-state/dev-conversations.json';
const realPath = 'artifacts/plan-2026-11-22/real-questions-v1.jsonl';
const REFUSED = ['rq003', 'rq004', 'rq021', 'rq047', 'rq058', 'rq059', 'rq100', 'rq105'];

const fold = (text: string) => text.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .replace(/[٠-٩]/gu, digit => String.fromCharCode(48 + digit.charCodeAt(0) - 0x0660)).toLowerCase();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const pct = (k: number, n: number) => n ? `${(100 * k / n).toFixed(1)}%` : 'n/a';
const quantile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN; };

/** Wilson 95% interval for k of n. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
/** Exact two-sided McNemar p-value from the discordant counts b (A right, B wrong) and c (A wrong, B right). */
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomial(n, i) / 2 ** n;
  return Math.min(1, 2 * tail);
}
function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - k + i) / i;
  return result;
}

function queryOk(query: string | null, expectation: QueryExpectation | null | undefined): boolean | null {
  if (expectation === undefined) return null;
  if (expectation === null) return query === null;
  if (query === null) return false;
  const have = fold(query);
  const has = (word: string) => have.includes(fold(word));
  if (expectation.contains && !expectation.contains.every(has)) return false;
  if (expectation.containsAny && !expectation.containsAny.some(has)) return false;
  if (expectation.notContains && expectation.notContains.some(has)) return false;
  return true;
}

function v1Acceptable(v1: RequestResolution): TurnType[] {
  switch (v1.kind) {
    case 'new': return v1.intent === 'chat' ? ['new_request', 'topic_change', 'small_talk'] : ['new_request', 'topic_change'];
    case 'follow_up': return ['follow_up_property', 'follow_up_entity', 'correction', 'field_edit'];
    case 'answer': return ['card_answer'];
    case 'ambiguous': return ['ambiguous'];
  }
}

interface TurnScore {
  conversation: string; dialect: string; turn: number; text: string; expected: TurnType[];
  v2: { type: TurnType; query: string | null; needs: string | null; entity: string | null; property: string | null; ms: number; typeOk: boolean; queryOk: boolean | null; needsOk: boolean | null; ok: boolean;
    /** Entity, property, edit field and reference index, scored only where the fixture names them; v1 has no such fields. */
    fieldsOk: boolean | null; fieldMisses: string[] };
  v1: { kind: string; intent: string; query: string | null; ambiguities: string[]; typeOk: boolean; queryOk: boolean | null; needsOk: boolean | null; ok: boolean };
}

async function scoreFixture(fixture: Fixture): Promise<TurnScore[]> {
  const scores: TurnScore[] = [];
  for (const conversation of fixture.conversations) {
    let state: ConversationStateV2 = emptyConversationState();
    let v1State: RequestContextState | null = null;
    conversation.turns.forEach((turn, index) => {
      const turnId = `${conversation.id}-u${index + 1}`;
      const before = turn.pending ? withPending(state, turn.pending) : state;
      const started = performance.now();
      const v2 = understandTurn(before, turn.text, turnId);
      const ms = performance.now() - started;
      const pendingQuestion = turn.pending?.kind === 'question_card' ? { id: turn.pending.id, fields: turn.pending.fields } : undefined;
      const v1 = resolveRequestContext(turn.text, v1State, { turnId, pendingQuestion });
      const expectation = turn.expect;
      const v2TypeOk = expectation.type.includes(v2.type);
      const v2QueryOk = queryOk(v2.query, expectation.query);
      const v2NeedsOk = expectation.needs === undefined ? null : v2.needs === expectation.needs;
      const v1TypeOk = v1Acceptable(v1).some(type => expectation.type.includes(type));
      const v1QueryOk = queryOk(v1.query, expectation.query);
      const v1NeedsOk = expectation.needs === undefined ? null
        : expectation.needs === 'missing_reference' ? v1.ambiguities.includes('missing_reference') : false;
      const fieldMisses: string[] = [];
      let fieldsNamed = 0;
      const check = (name: string, want: unknown, have: unknown, same: boolean) => { fieldsNamed++; if (!same) fieldMisses.push(`${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(have ?? null)}`); };
      if (expectation.entity !== undefined) check('entity', expectation.entity, v2.entity, fold(v2.entity ?? '') === fold(expectation.entity));
      if (expectation.property !== undefined) check('property', expectation.property, v2.property, v2.property === expectation.property);
      if (expectation.edit !== undefined) check('edit', expectation.edit, v2.edit?.field, v2.edit?.field === expectation.edit);
      if (expectation.reference !== undefined) check('reference', expectation.reference, v2.reference?.index, v2.reference?.index === expectation.reference);
      scores.push({
        conversation: conversation.id, dialect: conversation.dialect, turn: index + 1, text: turn.text, expected: expectation.type,
        v2: { type: v2.type, query: v2.query, needs: v2.needs, entity: v2.entity, property: v2.property, ms: Number(ms.toFixed(3)),
          typeOk: v2TypeOk, queryOk: v2QueryOk, needsOk: v2NeedsOk, ok: v2TypeOk && v2QueryOk !== false && v2NeedsOk !== false,
          fieldsOk: fieldsNamed ? fieldMisses.length === 0 : null, fieldMisses },
        v1: { kind: v1.kind, intent: v1.intent, query: v1.query, ambiguities: v1.ambiguities,
          typeOk: v1TypeOk, queryOk: v1QueryOk, needsOk: v1NeedsOk, ok: v1TypeOk && v1QueryOk !== false && v1NeedsOk !== false },
      });
      // The host's own display after the reply; only v2 can take it. v1 threads its own state.
      state = turn.shown ? withHostResults(v2.next, turn.shown, `${turnId}-shown`) : v2.next;
      if (turn.pending) state = withPending(state, null);
      v1State = v1.nextState ?? v1State;
    });
  }
  return scores;
}

interface RealScore { id: string; kind: string; previous: string | null; text: string; type: TurnType; query: string | null; needs: string | null; entity: string | null; property: string | null; place: string | null; time: string | null;assumption: string | null; v1Kind: string; v1Intent: string; v1Query: string | null; ms: number }

function scoreReal(items: RealItem[]): RealScore[] {
  return items.map(item => {
    let state = emptyConversationState();
    let v1State: RequestContextState | null = null;
    if (item.previous) {
      const earlier = understandTurn(state, item.previous, `${item.id}-prev`);
      state = earlier.next;
      v1State = resolveRequestContext(item.previous, null, { turnId: `${item.id}-prev` }).nextState;
    }
    const started = performance.now();
    const v2: TurnUnderstanding = understandTurn(state, item.text, item.id);
    const ms = performance.now() - started;
    const v1 = resolveRequestContext(item.text, v1State, { turnId: item.id });
    return { id: item.id, kind: item.kind, previous: item.previous, text: item.text, type: v2.type, query: v2.query, needs: v2.needs, entity: v2.entity,
      place: v2.place, time: v2.time,
      property: v2.property, assumption: v2.assumption, v1Kind: v1.kind, v1Intent: v1.intent, v1Query: v1.query, ms: Number(ms.toFixed(3)) };
  });
}

function tally<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((all, value) => ({ ...all, [value]: (all[value] ?? 0) + 1 }), {});
}

const startedAt = new Date();
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText) as Fixture;
const realText = await readFile(realPath, 'utf8');
const real = realText.trim().split('\n').map(line => JSON.parse(line) as RealItem);

const dev = await scoreFixture(fixture);
const realScores = scoreReal(real);

const n = dev.length;
const v2Right = dev.filter(score => score.v2.ok).length;
const v1Right = dev.filter(score => score.v1.ok).length;
const b = dev.filter(score => score.v2.ok && !score.v1.ok).length;
const c = dev.filter(score => !score.v2.ok && score.v1.ok).length;
const p = mcnemarExact(b, c);
const v2TypeRight = dev.filter(score => score.v2.typeOk).length;
const v1TypeRight = dev.filter(score => score.v1.typeOk).length;
const scoredQueries = dev.filter(score => score.v2.queryOk !== null);
const v2QueryRight = scoredQueries.filter(score => score.v2.queryOk).length;
const v1QueryRight = scoredQueries.filter(score => score.v1.queryOk).length;
const followUps = dev.filter(score => score.expected.some(type => ['follow_up_property', 'follow_up_entity', 'correction', 'reference'].includes(type)) && score.v2.queryOk !== null);
const v2FollowRight = followUps.filter(score => score.v2.queryOk).length;
const v1FollowRight = followUps.filter(score => score.v1.queryOk).length;
const byDialect = Object.entries(tally(dev.map(score => score.dialect))).map(([dialect, count]) => {
  const rows = dev.filter(score => score.dialect === dialect);
  return { dialect, count, v2: rows.filter(score => score.v2.ok).length, v1: rows.filter(score => score.v1.ok).length };
});
const byType = Object.entries(tally(dev.map(score => score.expected[0]!))).map(([type, count]) => {
  const rows = dev.filter(score => score.expected[0] === type);
  return { type, count, v2: rows.filter(score => score.v2.ok).length, v1: rows.filter(score => score.v1.ok).length };
});
const ms = dev.map(score => score.v2.ms).concat(realScores.map(score => score.ms));
const realTypes = tally(realScores.map(score => score.type));
const realPairs = realScores.filter(score => score.kind === 'pair');
const realPairTypes = tally(realPairs.map(score => score.type));
const refused = realScores.filter(score => REFUSED.includes(score.id));

const stamp = startedAt.toISOString().replace(/[:.]/gu, '-');
const outDir = join(outRoot, `run-${stamp}`);
await mkdir(outDir, { recursive: true });
const fmt = ([low, high]: [number, number]) => `${(100 * low).toFixed(1)}–${(100 * high).toFixed(1)}%`;
const wrong = dev.filter(score => !score.v2.ok);
const fieldScored = dev.filter(score => score.v2.fieldsOk !== null);
const fieldRight = fieldScored.filter(score => score.v2.fieldsOk).length;
const fieldMissed = dev.filter(score => score.v2.fieldsOk === false);

const report = `# Conversation state v2 vs v1: offline comparison (E1.1 preparation)

| | |
|---|---|
| Run at | ${startedAt.toISOString()} |
| Command | \`npx tsx scripts/conversation-state/eval.ts${args.length ? ' ' + args.join(' ') : ''}\` |
| Module | \`apps/server/src/assistant/conversation-state.ts\` (v2), \`apps/server/src/assistant/request-context.ts\` (v1) |
| Fixture | \`${fixturePath}\`, sha256 \`${sha256(fixtureText)}\`, ${fixture.conversations.length} conversations, ${n} turns. **Agent-written development data**, not an independent measure |
| Real set | \`${realPath}\`, sha256 \`${sha256(realText)}\`, ${real.length} items (${realPairs.length} pairs). Unlabelled: no accuracy is computed on it |
| Raw outputs | \`dev-results.jsonl\`, \`real-results.jsonl\`, \`summary.json\` beside this file |

## 1. Development turns: a turn is right when type, query and needs all match

| | v2 | v1 (current resolver) |
|---|---|---|
| Turns right | ${v2Right}/${n} = ${pct(v2Right, n)} (Wilson 95% ${fmt(wilson(v2Right, n))}) | ${v1Right}/${n} = ${pct(v1Right, n)} (Wilson 95% ${fmt(wilson(v1Right, n))}) |
| Type acceptable | ${v2TypeRight}/${n} = ${pct(v2TypeRight, n)} | ${v1TypeRight}/${n} = ${pct(v1TypeRight, n)} |
| Public query meets its constraint (${scoredQueries.length} scored) | ${v2QueryRight}/${scoredQueries.length} = ${pct(v2QueryRight, scoredQueries.length)} | ${v1QueryRight}/${scoredQueries.length} = ${pct(v1QueryRight, scoredQueries.length)} |
| Follow-up, correction and reference queries only (${followUps.length} scored) | ${v2FollowRight}/${followUps.length} = ${pct(v2FollowRight, followUps.length)} | ${v1FollowRight}/${followUps.length} = ${pct(v1FollowRight, followUps.length)} |
| McNemar exact, paired on the same turns | v2 right & v1 wrong: ${b}; v1 right & v2 wrong: ${c}; **p = ${p.toExponential(2)}** | |
| v2 time per turn | p50 ${quantile(ms, 0.5).toFixed(2)} ms, p95 ${quantile(ms, 0.95).toFixed(2)} ms, max ${Math.max(...ms).toFixed(2)} ms (${ms.length} turns, warm process) | |

v1 scoring is generous: each v1 kind counts for every v2 type it could stand for (see the header of \`eval.ts\`). Types v1 has no word for (reference, compound) count against it, as the plan says.

**v2 named fields** (entity, property, edit field, reference index, scored only where the fixture names them; v1 has no such fields, so this is not part of the comparison): ${fieldRight}/${fieldScored.length} turns.

### By dialect

| Dialect | Turns | v2 right | v1 right |
|---|---|---|---|
${byDialect.map(row => `| ${row.dialect} | ${row.count} | ${row.v2} | ${row.v1} |`).join('\n')}

### By expected type (first listed type)

| Expected type | Turns | v2 right | v1 right |
|---|---|---|---|
${byType.map(row => `| ${row.type} | ${row.count} | ${row.v2} | ${row.v1} |`).join('\n')}

### v2 turns that are wrong (${wrong.length})

| Conversation | Turn | Text | Expected | v2 type | v2 query | v2 needs |
|---|---|---|---|---|---|---|
${wrong.map(score => `| ${score.conversation} | ${score.turn} | ${score.text.replace(/\|/gu, '\\|')} | ${score.expected.join(' / ')} | ${score.v2.type}${score.v2.typeOk ? '' : ' ✗'} | ${score.v2.query === null ? '—' : score.v2.query.replace(/\|/gu, '\\|')}${score.v2.queryOk === false ? ' ✗' : ''} | ${score.v2.needs ?? '—'}${score.v2.needsOk === false ? ' ✗' : ''} |`).join('\n') || '| — | — | none | | | | |'}

### v2 named-field misses (${fieldMissed.length})

| Conversation | Turn | Text | Misses |
|---|---|---|---|
${fieldMissed.map(score => `| ${score.conversation} | ${score.turn} | ${score.text.replace(/\|/gu, '\\|')} | ${score.v2.fieldMisses.join('; ').replace(/\|/gu, '\\|')} |`).join('\n') || '| — | — | none | |'}

## 2. Frozen real set (unlabelled)

v2 turn types over the ${real.length} items (pairs are run with their previous message first):

| Type | All ${real.length} | Pairs only (${realPairs.length}) |
|---|---|---|
${Object.entries(realTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `| ${type} | ${count} | ${realPairTypes[type] ?? 0} |`).join('\n')}

Note: the ${realPairs.length} "pairs" are adjacent messages from the logs; most are topic changes, not follow-ups, so they cannot measure follow-up resolution on their own. The 60 owner conversations of the plan are still needed.

### The ${refused.length} requests that ended in «لا يمكن تحويله إلى بحث عام» on 2026-11-22

The plan's E1.1 asks that each of these ends in a correct route, a question, or an honest reply. What v2 says about each (the chat hook that acts on it is not wired yet):

| Id | Text | v2 type | v2 needs | v2 query | v1 kind / intent |
|---|---|---|---|---|---|
${refused.map(score => `| ${score.id} | ${score.text.replace(/\|/gu, '\\|').slice(0, 90)} | ${score.type} | ${score.needs ?? '—'} | ${score.query === null ? '—' : score.query.replace(/\|/gu, '\\|').slice(0, 60)} | ${score.v1Kind} / ${score.v1Intent} |`).join('\n')}

## 3. What this run does not show

- Accuracy on real messages: the 107 items have no owner labels (0/107 on 2026-11-22).
- Behaviour in the app: v2 is not wired into the chat; nothing here changed a reply.
- Independence: the development turns were written by the same agent that evaluates them, so they can guide fixes but cannot accept the module.
`;

await writeFile(join(outDir, 'report.md'), report, 'utf8');
await writeFile(join(outDir, 'dev-results.jsonl'), dev.map(score => JSON.stringify(score)).join('\n') + '\n', 'utf8');
await writeFile(join(outDir, 'real-results.jsonl'), realScores.map(score => JSON.stringify(score)).join('\n') + '\n', 'utf8');
await writeFile(join(outDir, 'summary.json'), JSON.stringify({
  at: startedAt.toISOString(), fixtureSha256: sha256(fixtureText), realSha256: sha256(realText), turns: n,
  v2: { right: v2Right, typeRight: v2TypeRight, queryRight: v2QueryRight, queriesScored: scoredQueries.length, followQueryRight: v2FollowRight, followScored: followUps.length },
  v1: { right: v1Right, typeRight: v1TypeRight, queryRight: v1QueryRight, followQueryRight: v1FollowRight },
  fields: { right: fieldRight, scored: fieldScored.length }, mcnemar: { b, c, p }, msP50: quantile(ms, 0.5), msP95: quantile(ms, 0.95), realTypes, realPairTypes,
}, null, 2), 'utf8');
console.log(report);
console.log(`\nwritten: ${outDir}`);
