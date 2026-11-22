/**
 * Robustness of conversation state v2: the same development conversations, each turn rewritten in ways that do not
 * change its meaning (diacritics, tatweel, hamza and ة/ى spellings, Arabic-Indic digits, spacing, question marks,
 * politeness words, letter case). A reading that changes under such a rewrite is a bug, and no owner label is needed
 * to see it. Usage: npx tsx scripts/conversation-state/robustness.ts [--out artifacts/conversation-state-20261122]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emptyConversationState, understandTurn, withHostResults, withPending,
  type ConversationStateV2, type HostResult, type PendingStep, type TurnType,
} from '../../apps/server/src/assistant/conversation-state.js';

interface QueryExpectation { contains?: string[]; containsAny?: string[]; notContains?: string[] }
interface Expectation { type: TurnType[]; query?: QueryExpectation | null; needs?: 'missing_reference' | 'missing_value'; reference?: number; edit?: string }
interface FixtureTurn { text: string; pending?: PendingStep; shown?: { label: string; kind: HostResult['kind'] }[]; expect: Expectation }
interface Fixture { conversations: { id: string; dialect: string; turns: FixtureTurn[] }[] }

const args = process.argv.slice(2);
const outRoot = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'artifacts/conversation-state-20261122';
const fixturePath = 'scripts/conversation-state/dev-conversations.json';

const fold = (text: string) => text.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .replace(/[٠-٩]/gu, digit => String.fromCharCode(48 + digit.charCodeAt(0) - 0x0660)).toLowerCase();
const arabic = (text: string) => /\p{Script=Arabic}/u.test(text);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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

/** Deterministic rewrites. `ask` ones apply only to turns that are questions or commands, never to card answers or thanks. */
const QUESTION_LIKE = new Set<TurnType>(['new_request', 'topic_change', 'follow_up_property', 'follow_up_entity', 'reference', 'field_edit']);
const perturbations: Record<string, { ask?: boolean; apply(text: string): string }> = {
  spaces: { apply: text => `  ${text.replace(/ /gu, '  ')}  ` },
  no_question_mark: { apply: text => text.replace(/\s*[؟?]+$/u, '') },
  other_question_mark: { apply: text => /؟$/u.test(text) ? text.replace(/؟$/u, '?') : /\?$/u.test(text) ? text.replace(/\?$/u, '؟') : text },
  space_before_mark: { apply: text => text.replace(/([؟?])$/u, ' $1') },
  diacritics: { apply: text => text.replace(/([ء-ي])(?=[ء-ي])/gu, (letter, _rest, offset) => offset % 3 === 0 ? `${letter}َ` : letter) },
  shadda: { apply: text => text.replace(/([ب-ي])(?=[ء-ي]{2})/gu, (letter, _rest, offset) => offset % 5 === 2 ? `${letter}ّ` : letter) },
  tatweel: { apply: text => text.replace(/(\p{Script=Arabic}{2})(\p{Script=Arabic}{2,})/gu, '$1ـ$2') },
  hamza: { apply: text => text.replace(/[أإآ]/gu, 'ا') },
  taa_yaa: { apply: text => text.replace(/ة/gu, 'ه').replace(/ى/gu, 'ي') },
  arabic_digits: { apply: text => text.replace(/\d/gu, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]!) },
  polite_prefix: { ask: true, apply: text => arabic(text) ? `من فضلك ${text}` : `please ${text}` },
  polite_prefix_long: { ask: true, apply: text => arabic(text) ? `لو سمحت، ${text}` : `could you tell me ${text}` },
  polite_suffix: { ask: true, apply: text => arabic(text) ? `${text.replace(/\s*[؟?]+$/u, '')} من فضلك؟` : `${text.replace(/\s*[؟?]+$/u, '')} please?` },
  upper_case: { apply: text => arabic(text) ? text : text.toUpperCase() },
  // Typos are NOT meaning-preserving for a rule reader; they are measured to say how brittle the words are, not fixed blindly.
  typo_swap: { apply: text => text.replace(/(\p{L}{5,})/u, word => `${word.slice(0, 2)}${word[3]}${word[2]}${word.slice(4)}`) },
  typo_drop: { apply: text => text.replace(/(\p{L}{6,})/u, word => `${word.slice(0, 3)}${word.slice(4)}`) },
};

interface Failure { perturbation: string; conversation: string; turn: number; original: string; rewritten: string; baseType: TurnType; type: TurnType; baseQuery: string | null; query: string | null; reason: string }

function runConversation(conversation: Fixture['conversations'][number], rewrite: ((text: string, turn: FixtureTurn) => string) | null) {
  let state: ConversationStateV2 = emptyConversationState();
  return conversation.turns.map((turn, index) => {
    const turnId = `${conversation.id}-u${index + 1}`;
    const before = turn.pending ? withPending(state, turn.pending) : state;
    const text = rewrite ? rewrite(turn.text, turn) : turn.text;
    const understanding = understandTurn(before, text, turnId);
    state = turn.shown ? withHostResults(understanding.next, turn.shown, `${turnId}-shown`) : understanding.next;
    if (turn.pending) state = withPending(state, null);
    const typeOk = turn.expect.type.includes(understanding.type);
    const queriesOk = queryOk(understanding.query, turn.expect.query);
    const needsOk = turn.expect.needs === undefined ? null : understanding.needs === turn.expect.needs;
    return { text, type: understanding.type, query: understanding.query, ok: typeOk && queriesOk !== false && needsOk !== false };
  });
}

const startedAt = new Date();
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText) as Fixture;
const baseline = new Map(fixture.conversations.map(conversation => [conversation.id, runConversation(conversation, null)]));
const failures: Failure[] = [];
const rows: { name: string; applied: number; right: number; sameType: number; sameQueryVerdict: number }[] = [];

for (const [name, perturbation] of Object.entries(perturbations)) {
  let applied = 0, right = 0, sameType = 0, sameQueryVerdict = 0;
  for (const conversation of fixture.conversations) {
    const base = baseline.get(conversation.id)!;
    const results = runConversation(conversation, (text, turn) => perturbation.ask && !QUESTION_LIKE.has(turn.expect.type[0]!) ? text : perturbation.apply(text));
    results.forEach((result, index) => {
      const turn = conversation.turns[index]!;
      if (perturbation.ask && !QUESTION_LIKE.has(turn.expect.type[0]!)) return;
      if (result.text === turn.text) return;
      applied++;
      const before = base[index]!;
      if (result.ok) right++;
      if (result.type === before.type) sameType++;
      if ((result.query === null) === (before.query === null)) sameQueryVerdict++;
      if (!result.ok || result.type !== before.type) failures.push({
        perturbation: name, conversation: conversation.id, turn: index + 1, original: turn.text, rewritten: result.text, baseType: before.type, type: result.type,
        baseQuery: before.query, query: result.query, reason: !result.ok ? (turn.expect.type.includes(result.type) ? 'query or needs' : 'type') : 'type changed',
      });
    });
  }
  rows.push({ name, applied, right, sameType, sameQueryVerdict });
}

const total = rows.reduce((sum, row) => sum + row.applied, 0);
const totalRight = rows.reduce((sum, row) => sum + row.right, 0);
const baselineRight = [...baseline.values()].flat().filter(result => result.ok).length;
const baselineTurns = [...baseline.values()].flat().length;
const stamp = startedAt.toISOString().replace(/[:.]/gu, '-');
const outDir = join(outRoot, `robustness-${stamp}`);
await mkdir(outDir, { recursive: true });
const report = `# Conversation state v2: robustness under meaning-preserving rewrites

| | |
|---|---|
| Run at | ${startedAt.toISOString()} |
| Command | \`npx tsx scripts/conversation-state/robustness.ts${args.length ? ' ' + args.join(' ') : ''}\` |
| Fixture | \`${fixturePath}\`, sha256 \`${sha256(fixtureText)}\`, ${fixture.conversations.length} conversations, ${baselineTurns} turns; baseline right ${baselineRight}/${baselineTurns} |
| Rule | a turn counts as robust when the rewritten turn is still right by the fixture's own expectation; "same type" compares with the unrewritten reading |

| Rewrite | Turns rewritten | Still right | Same type | Same query verdict (null / non-null) |
|---|---|---|---|---|
${rows.map(row => `| ${row.name} | ${row.applied} | ${row.right} (${row.applied ? (100 * row.right / row.applied).toFixed(1) : '0.0'}%) | ${row.sameType} | ${row.sameQueryVerdict} |`).join('\n')}
| **all** | ${total} | **${totalRight} (${total ? (100 * totalRight / total).toFixed(1) : '0.0'}%)** | | |

## Failures (${failures.length})

| Rewrite | Conv | Turn | Rewritten text | Base type → type | Base query → query | Why |
|---|---|---|---|---|---|---|
${failures.slice(0, 120).map(failure => `| ${failure.perturbation} | ${failure.conversation} | ${failure.turn} | ${failure.rewritten.replace(/\|/gu, '\\|').trim()} | ${failure.baseType} → ${failure.type} | ${failure.baseQuery ?? '—'} → ${failure.query ?? '—'} | ${failure.reason} |`).join('\n') || '| — | — | — | none | | | |'}
${failures.length > 120 ? `\n…and ${failures.length - 120} more in failures.jsonl.` : ''}
`;
await writeFile(join(outDir, 'report.md'), report, 'utf8');
await writeFile(join(outDir, 'failures.jsonl'), failures.map(failure => JSON.stringify(failure)).join('\n') + (failures.length ? '\n' : ''), 'utf8');
console.log(report);
console.log(`\nwritten: ${outDir}`);
