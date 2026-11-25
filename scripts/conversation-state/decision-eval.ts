/**
 * Offline development evaluation. Source files are human-authored and stay outside
 * the repository. See docs/CONVERSATION-STATE-DECISION-EVALUATION.md for provenance.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ConversationStateV2, TurnUnderstanding } from '../../apps/server/src/assistant/conversation-state.js';
import type { ConversationTurnType } from '../../apps/server/src/assistant/conversation-state-decisions.js';

interface Score { total: number; legacy: number; correct: number }
type Resolver = typeof import('../../apps/server/src/assistant/conversation-state.js');
type Split = 'development' | 'held-out';
const baselineCommit = 'fb8e45289dd3a7b607d9c7c7b7188bf08c2c70f0';
const splitSeed = 'mohassan-conversation-decides-split-v1';
const heldOutShare = 0.30;
interface Action { act: string; slot: string; values: string[] }
interface CodTurn { speaker: 'USER' | 'SYSTEM'; utterance: string; frames: { service: string; actions: Action[] }[] }
interface CodDialogue { dialogue_id: string; turns: CodTurn[] }
interface TodAction { act: string; slot: string; value: string[] }
interface TodEvent { Agent: string; Text?: string; Actions?: TodAction[] | string; PrimaryItem?: { name?: string } | null }
interface TodDialogue { Dialogue_id: string; Events: TodEvent[] }
interface CanardRow { History: string[]; QuAC_dialog_id: string; Question: string; Question_no: number; Rewrite: string }

const score = (): Score => ({ total: 0, legacy: 0, correct: 0 });
function add(score: Score, legacy: boolean, correct: boolean): void {
  score.total++;
  score.legacy += Number(legacy);
  score.correct += Number(correct);
}

interface Failure {
  source: 'canard' | 'arabic-tod' | 'cod-ar' | 'cod-en' | 'multi3woz';
  dialogue: string;
  turn: number;
  kind: string;
  request: string;
  prior?: string;
  expected: string;
  actual: string | null;
  reason?: string[];
  candidates?: { text: string; kind: string; turnId: string; role: string; salience: number }[];
}
type Diagnose = (failure: Failure) => void;


function legacyType(turn: TurnUnderstanding): ConversationTurnType | null {
  switch (turn.type) {
    case 'new_request': case 'topic_change': case 'compound': return 'new_request';
    case 'follow_up_property': case 'follow_up_entity': case 'reference': return 'follow_up';
    case 'card_answer': return 'card_answer';
    case 'correction': return 'correction';
    case 'small_talk': return 'small_talk';
    case 'field_edit':
      return turn.edit && ['language', 'format', 'detail', 'unit'].includes(turn.edit.field) ? 'refinement' : 'follow_up';
    case 'ambiguous': return null;
  }
}

function actions(turn: CodTurn | undefined): Action[] {
  return turn?.frames.flatMap(frame => frame.actions) ?? [];
}

function expectedCodType(current: CodTurn, prior: CodTurn | undefined, index: number): ConversationTurnType | null {
  const user = actions(current);
  const acts = new Set(user.map(action => action.act));
  const previous = actions(prior);
  if ([...acts].every(act => act === 'THANK_YOU' || act === 'GOODBYE') && acts.size > 0) return 'small_talk';
  if (index === 0 && acts.has('INFORM_INTENT') && [...acts].every(act => act === 'INFORM_INTENT' || act === 'INFORM')) {
    return 'new_request';
  }
  if (acts.size !== 1) return null;
  if (acts.has('INFORM') && user.every(action =>
    previous.some(request => request.act === 'REQUEST' && request.slot === action.slot))) return 'card_answer';
  if (acts.has('AFFIRM') && previous.some(action => action.act === 'CONFIRM')) return 'confirmation';
  if (acts.has('REQUEST') && previous.some(action => action.act === 'OFFER' || action.act === 'INFORM')) return 'follow_up';
  return null;
}

function categoryScore(byType: Map<string, Score>, label: string): Score {
  let item = byType.get(label);
  if (!item) {
    item = score();
    byType.set(label, item);
  }
  return item;
}

function evalCod(resolver: Resolver, dialogues: readonly CodDialogue[], source: Failure['source'], diagnose?: Diagnose) {
  const { emptyConversationState, understandTurn, withAssistantAnswer, withPending } = resolver;
  let turns = 0;
  const total = score();
  const byType = new Map<string, Score>();
  for (const dialogue of dialogues) {
    let state = emptyConversationState();
    for (const [index, turn] of dialogue.turns.entries()) {
      const turnId = dialogue.dialogue_id + '-' + index;
      if (turn.speaker === 'SYSTEM') {
        state = withAssistantAnswer(state, turn.utterance, turnId);
        continue;
      }
      turns++;
      const previous = dialogue.turns[index - 1];
      const pending = actions(previous).some(action => action.act === 'REQUEST')
        ? { kind: 'question_card' as const, id: dialogue.dialogue_id + '-card-' + index } : null;
      const result = understandTurn(withPending(state, pending), turn.utterance, turnId);
      state = result.next;
      const expected = expectedCodType(turn, previous, index);
      if (!expected) continue;
      const before = legacyType(result) === expected;
      const after = result.decision.type === expected;
      add(total, before, after);
      add(categoryScore(byType, expected), before, after);
      if (!after) diagnose?.({ source, dialogue: dialogue.dialogue_id, turn: index,
        kind: 'turn_type', request: turn.utterance, prior: previous?.utterance, expected, actual: result.decision.type,
        reason: result.decision.reasons });
    }
  }
  return { dialogues: dialogues.length, userTurns: turns, turnType: total, byType: Object.fromEntries(byType) };
}

function comparable(text: string | null | undefined): string {
  return (text ?? '').normalize('NFKC').toLowerCase().replace(/[’']/gu, "'")
    .replace(/^[\s.?!؟]+|[\s.?!؟]+$/gu, '').replace(/\s+/gu, ' ');
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = comparable(text).replace(/[^\p{L}\p{N}]+/gu, ' ');
  const name = comparable(phrase).replace(/[^\p{L}\p{N}]+/gu, ' ');
  return name.length > 0 && (' ' + normalized + ' ').includes(' ' + name + ' ');
}

const PROPER_NAME = /\b(?:[A-Z][\p{L}\p{M}'’.-]*\s+[A-Z][\p{L}\p{M}'’.-]*|[A-Z]{2,})\b/gu;

/** Use only unambiguous, literal proper names newly supplied by a human rewrite. */
function suppliedName(row: CanardRow): string | null {
  const history = row.History.slice(2);
  const found = [...new Set([...row.Rewrite.matchAll(PROPER_NAME)].map(match => match[0].replace(/['’]s$/u, '')))];
  const candidates = found.filter(name => !containsPhrase(row.Question, name)
    && history.some(turn => containsPhrase(turn, name)));
  return candidates.length === 1 ? candidates[0]! : null;
}

function evalCanard(resolver: Resolver, rows: readonly CanardRow[], diagnose?: Diagnose) {
  const { emptyConversationState, understandTurn, withAssistantAnswer } = resolver;
  const dialogueIds = new Set<string>();
  const type = score();
  const reference = score();
  const rewrite = score();
  for (const row of rows) {
    if (row.History.length < 4 || row.History.length % 2 !== 0 || comparable(row.Question) === comparable(row.Rewrite)) continue;
    const name = suppliedName(row);
    if (!name) continue;
    dialogueIds.add(row.QuAC_dialog_id);
    let state = emptyConversationState();
    for (const [index, text] of row.History.slice(2).entries()) {
      const turnId = row.QuAC_dialog_id + '-' + index;
      state = index % 2 === 0 ? understandTurn(state, text, turnId).next
        : withAssistantAnswer(state, text, turnId, { publicLookup: true });
    }
    const result = understandTurn(state, row.Question, row.QuAC_dialog_id + '-q' + row.Question_no);
    const beforeType = legacyType(result);
    add(type, beforeType === 'follow_up', result.decision.type === 'follow_up');
    const referenceCorrect = comparable(result.decision.reference?.text) === comparable(name);
    const rewriteCorrect = comparable(result.decision.standalone) === comparable(row.Rewrite);
    add(reference, beforeType === 'follow_up' && comparable(result.entity) === comparable(name), referenceCorrect);
    add(rewrite, beforeType === 'follow_up' && comparable(result.query) === comparable(row.Rewrite), rewriteCorrect);
    if (diagnose) {
      const details = { source: 'canard' as const, dialogue: row.QuAC_dialog_id, turn: row.Question_no,
        request: row.Question, prior: row.History.at(-1), reason: result.decision.reasons };
      if (result.decision.type !== 'follow_up') diagnose({ ...details, kind: 'turn_type', expected: 'follow_up', actual: result.decision.type });
      if (!referenceCorrect) diagnoseReference(diagnose, details, state, result, name);
      if (!rewriteCorrect) diagnose({ ...details, kind: rewriteFailure(result, referenceCorrect), expected: row.Rewrite,
        actual: result.decision.standalone });
    }
  }
  return { dialogues: dialogueIds.size, turnType: type, referenceResolution: reference, standaloneRewrite: rewrite };
}

/** Use the translator's original words and embedded Latin-script entities without switching source turns. */
function evalArabicTod(resolver: Resolver, dialogues: readonly TodDialogue[], diagnose?: Diagnose) {
  const { emptyConversationState, understandTurn, withAssistantAnswer } = resolver;
  const mixed: CodDialogue[] = [];
  const references = score();
  for (const dialogue of dialogues) {
    const visible = dialogue.Events.filter(event => (event.Agent === 'User' || event.Agent === 'Wizard') && event.Text?.trim());
    if (visible.filter(event => event.Agent === 'User').length < 2
      || !visible.some(event => event.Agent === 'User' && /\p{Script=Arabic}/u.test(event.Text!)
        && /\b[A-Za-z]{2,}(?: +[A-Za-z]{2,})+\b/u.test(event.Text!))) continue;
    const turns: CodTurn[] = visible.map(event => ({
      speaker: event.Agent === 'User' ? 'USER' : 'SYSTEM',
      utterance: event.Text!,
      frames: [{ service: '', actions: Array.isArray(event.Actions) ? event.Actions.map(action => ({
        act: action.act.toUpperCase(), slot: action.slot, values: action.value,
      })) : [] }],
    }));
    mixed.push({ dialogue_id: dialogue.Dialogue_id, turns });
    let state = emptyConversationState();
    for (const [index, turn] of turns.entries()) {
      const turnId = dialogue.Dialogue_id + '-' + index;
      if (turn.speaker === 'SYSTEM') {
        state = withAssistantAnswer(state, turn.utterance, turnId, { publicLookup: true });
        continue;
      }
      const result = understandTurn(state, turn.utterance, turnId);
      const previousState = state;
      state = result.next;
      const offered = actions(turns[index - 1]).find(action => action.act === 'OFFER' && action.slot === 'name');
      const name = offered?.values.length === 1 ? offered.values[0] : undefined;
      const following = visible[index + 1];
      const user = actions(turn);
      // The following wizard event must identify the same offered item as the source of its answer.
      if (!name || following?.PrimaryItem?.name !== name || !user.length
        || !user.every(action => action.act === 'REQUEST' && action.slot !== 'name')
        || !containsPhrase(turns[index - 1]!.utterance, name) || containsPhrase(turn.utterance, name)) continue;
      const referenceCorrect = comparable(result.decision.reference?.text) === comparable(name);
      add(references, legacyType(result) === 'follow_up' && comparable(result.entity) === comparable(name), referenceCorrect);
      if (diagnose && !referenceCorrect) diagnoseReference(diagnose, { source: 'arabic-tod', dialogue: dialogue.Dialogue_id,
        turn: index, request: turn.utterance, prior: turns[index - 1]!.utterance, reason: result.decision.reasons },
      previousState, result, name);
    }
  }
  return { ...evalCod(resolver, mixed, 'arabic-tod', diagnose), referenceResolution: references };
}

interface Multi3wozTurn {
  speaker: CodTurn['speaker'];
  text: string;
  dialog_act: Record<string, [string, string][]>;
}
interface Multi3wozDialogue { log: Multi3wozTurn[] }

const dialectMarkers = {
  Egyptian: /(?<!\p{L})(?:عايز|عاوز|دلوقتي|إزاي|ازاي)(?!\p{L})/u,
  Levantine: /(?<!\p{L})(?:بدي|هلق|هلأ|شو)(?!\p{L})/u,
  Gulf: /(?<!\p{L})(?:أبغى|ابغى|إيش|ايش|شلون)(?!\p{L})/u,
};

const multi3wozActs: Readonly<Record<string, string>> = {
  INFORM: 'INFORM', REQUEST: 'REQUEST', OFFER: 'OFFER', RECOMMEND: 'OFFER', CONFIRM: 'CONFIRM',
  AFFIRM: 'AFFIRM', BYE: 'GOODBYE', THANK: 'THANK_YOU',
};

function evalMulti3woz(resolver: Resolver, dialogues: Record<string, Multi3wozDialogue>, diagnose?: Diagnose) {
  const selected: CodDialogue[] = [];
  const byMarker: Record<string, number> = {};
  for (const [id, dialogue] of Object.entries(dialogues)) {
    const user = dialogue.log.filter(turn => turn.speaker === 'USER');
    if (user.length < 2) continue;
    const markers = Object.entries(dialectMarkers).filter(([, marker]) => user.some(turn => marker.test(turn.text)));
    if (!markers.length) continue;
    for (const [label] of markers) byMarker[label] = (byMarker[label] ?? 0) + 1;
    const turns = dialogue.log.map(turn => ({
      speaker: turn.speaker,
      utterance: turn.text,
      frames: Object.entries(turn.dialog_act).map(([label, slots]) => {
        const [service, act] = label.split('-');
        return { service: service ?? '', actions: slots.map(([slot, value]) => ({
          act: multi3wozActs[act?.toUpperCase() ?? ''] ?? label, slot, values: [value],
        })) };
      }),
    }));
    selected.push({ dialogue_id: id, turns });
  }
  return { ...evalCod(resolver, selected, 'multi3woz', diagnose), byMarker };
}

function diagnoseReference(diagnose: Diagnose, details: Omit<Failure, 'kind' | 'expected' | 'actual'>,
    state: ConversationStateV2, result: TurnUnderstanding, expected: string): void {
  const candidates = state.entities.slice(0, 12);
  const found = state.entities.some(entity => comparable(entity.text) === comparable(expected));
  const selected = result.decision.reference?.text ?? null;
  const kind = !found ? 'reference_missing_entity' : selected ? 'reference_wrong_selection' : 'reference_no_selection';
  diagnose({ ...details, kind, expected, actual: selected, candidates });
}

function rewriteFailure(result: TurnUnderstanding, referenceCorrect: boolean): string {
  if (!referenceCorrect) return 'rewrite_wrong_reference';
  return result.decision.standalone ? 'rewrite_wording_mismatch' : 'rewrite_missing';
}

interface RawSources {
  codAr: CodDialogue[];
  codEn: CodDialogue[];
  canard: CanardRow[];
  arabicTod: TodDialogue[];
  multi3woz: [string, Multi3wozDialogue][];
}

interface PartitionDigest { groups: number; rows: number; sha256: string }
type Freeze = Record<string, { development: PartitionDigest; 'held-out': PartitionDigest }>;
const hashText = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function partition<T>(entries: readonly T[], groupOf: (entry: T) => string, name: string, freeze: Freeze, split: Split): T[] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const id = groupOf(entry);
    const prior = groups.get(id);
    if (prior) prior.push(entry);
    else groups.set(id, [entry]);
  }
  const ranked = [...groups].map(([id, rows]) => ({ id, rows, rank: hashText(splitSeed + '\0' + name + '\0' + id) }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id));
  const cutoff = Math.floor(ranked.length * heldOutShare);
  const partitions = { development: ranked.slice(cutoff), 'held-out': ranked.slice(0, cutoff) };
  const digest = (part: typeof ranked) => {
    const hash = createHash('sha256');
    let rows = 0;
    for (const group of part) {
      hash.update(JSON.stringify([group.id, group.rows]) + '\n');
      rows += group.rows.length;
    }
    return { groups: part.length, rows, sha256: hash.digest('hex') };
  };
  freeze[name] = { development: digest(partitions.development), 'held-out': digest(partitions['held-out']) };
  return partitions[split].flatMap(group => group.rows);
}

function makeSplit(raw: RawSources, freeze: Freeze, split: Split): RawSources {
  const cod = partition([
    ...raw.codAr.map(row => ({ locale: 'ar', row })),
    ...raw.codEn.map(row => ({ locale: 'en', row })),
  ], item => item.row.dialogue_id, 'cod', freeze, split);
  return {
    codAr: cod.filter(item => item.locale === 'ar').map(item => item.row),
    codEn: cod.filter(item => item.locale === 'en').map(item => item.row),
    // Article titles group all the CANARD section dialogues from one article together.
    canard: partition(raw.canard, row => comparable(row.History[0]) || row.QuAC_dialog_id, 'canard', freeze, split),
    arabicTod: partition(raw.arabicTod, row => row.Dialogue_id, 'arabic-tod', freeze, split),
    multi3woz: partition(raw.multi3woz, ([key]) => key, 'multi3woz', freeze, split),
  };
}

function evaluate(resolver: Resolver, sources: RawSources, diagnose?: Diagnose) {
  return {
    codArabic: evalCod(resolver, sources.codAr, 'cod-ar', diagnose),
    codEnglish: evalCod(resolver, sources.codEn, 'cod-en', diagnose),
    arabicTodMixed: evalArabicTod(resolver, sources.arabicTod, diagnose),
    canardEnglish: evalCanard(resolver, sources.canard, diagnose),
    multi3wozDialect: evalMulti3woz(resolver, Object.fromEntries(sources.multi3woz), diagnose),
  };
}

function turnTypeTotal(results: ReturnType<typeof evaluate>): Score {
  return Object.values(results).reduce((total, { turnType }) => ({
    total: total.total + turnType.total, legacy: total.legacy + turnType.legacy, correct: total.correct + turnType.correct,
  }), score());
}

const { values } = parseArgs({ options: {
  cod: { type: 'string' }, canard: { type: 'string' }, 'arabic-tod': { type: 'string' }, 'dialect-dialogues': { type: 'string' },
  split: { type: 'string', default: 'development' }, 'write-freeze': { type: 'boolean' }, diagnostics: { type: 'string' },
  'baseline-dir': { type: 'string' }, 'frozen-commit': { type: 'string' },
} });
if (!values.cod || !values.canard || !values['arabic-tod'] || !values['dialect-dialogues']) {
  throw new Error('Supply --cod, --canard, --arabic-tod and --dialect-dialogues. See docs/CONVERSATION-STATE-DECISION-EVALUATION.md.');
}
if (values.split !== 'development' && values.split !== 'held-out') throw new Error('Use development or held-out for --split.');
const split = values.split;
const currentRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = fileURLToPath(new URL('./decision-eval-freeze.json', import.meta.url));

function assertFrozen(root: string, expected: string): void {
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/u.test(expected) || git(['rev-parse', 'HEAD']) !== expected
    || git(['status', '--porcelain', '--untracked-files=all', '--', 'apps/server/src', 'packages',
      'scripts/conversation-state/decision-eval.ts', 'scripts/conversation-state/decision-eval-freeze.json'])) {
    throw new Error('Scoring requires a clean resolver checked out at commit ' + expected);
  }
}
if (split === 'held-out') {
  if (values.diagnostics || values['write-freeze'] || !values['baseline-dir'] || !values['frozen-commit']) {
    throw new Error('Held-out scoring requires --baseline-dir and --frozen-commit, without diagnostics.');
  }
  assertFrozen(currentRoot, values['frozen-commit']);
}
if (values['baseline-dir']) assertFrozen(values['baseline-dir'], baselineCommit);

const sourceHashes: Record<string, string> = {};
async function readJson<T>(file: string, label: string): Promise<T> {
  const bytes = await readFile(file);
  sourceHashes[label] = hashText(bytes);
  return JSON.parse(bytes.toString('utf8')) as T;
}
async function readCod(directory: string, locale: 'ar' | 'en'): Promise<CodDialogue[]> {
  const splits = await Promise.all(['dev', 'test'].map(split => {
    const file = locale + '_' + split + '.json';
    return readJson<CodDialogue[]>(join(directory, file), 'cod/' + file);
  }));
  return splits.flat();
}
const [codAr, codEn, canard, arabicTod, multi3woz] = await Promise.all([
  readCod(values.cod, 'ar'), readCod(values.cod, 'en'), readJson<CanardRow[]>(values.canard, 'canard/test.json'),
  readJson<Record<string, TodDialogue>>(values['arabic-tod'], 'arabic-tod/ar_test.json'),
  readJson<Record<string, Multi3wozDialogue>>(values['dialect-dialogues'], 'multi3woz/Arabic/data.json'),
]);
const freeze: Freeze = {};
const sources = makeSplit({ codAr, codEn, canard, arabicTod: Object.values(arabicTod), multi3woz: Object.entries(multi3woz) }, freeze, split);
const manifest = {
  version: 1, baselineCommit, splitSeed, heldOutShare,
  sourceSha256: Object.fromEntries(Object.entries(sourceHashes).sort()), partitions: freeze,
};
if (values['write-freeze']) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log('Wrote source data hashes and split counts without running a resolver.');
} else {
  const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Evaluation data or split failed its frozen SHA-256 check.');
  const resolver = (root: string): Promise<Resolver> =>
    import(pathToFileURL(resolve(root, 'apps/server/src/assistant/conversation-state.ts')).href);
  const failures: Failure[] = [];
  const candidate = evaluate(await resolver(currentRoot), sources, values.diagnostics ? failure => failures.push(failure) : undefined);
  if (values.diagnostics) await writeFile(values.diagnostics, failures.map(failure => JSON.stringify(failure)).join('\n') + '\n', { mode: 0o600 });
  const baseline = values['baseline-dir'] ? evaluate(await resolver(values['baseline-dir']), sources) : undefined;
  const candidateType = turnTypeTotal(candidate);
  const baselineType = baseline && turnTypeTotal(baseline);
  const turnTypeGuard = baselineType && { total: candidateType.total, before: baselineType.correct, after: candidateType.correct,
    passed: candidateType.total > 0 && candidateType.total === baselineType.total && candidateType.correct >= baselineType.correct };
  console.log(JSON.stringify({ split, baseline, candidate, turnTypeGuard }, null, 2));
  if (turnTypeGuard && !turnTypeGuard.passed) process.exitCode = 1;
}
