/**
 * Offline development evaluation. Source files are human-authored and stay outside
 * the repository. See docs/CONVERSATION-STATE-DECISION-EVALUATION.md for provenance.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  emptyConversationState, understandTurn, withAssistantAnswer, withPending,
  type TurnUnderstanding,
} from '../../apps/server/src/assistant/conversation-state.js';
import type { ConversationTurnType } from '../../apps/server/src/assistant/conversation-state-decisions.js';

interface Score { total: number; before: number; after: number }
interface Action { act: string; slot: string; values: string[] }
interface CodTurn { speaker: 'USER' | 'SYSTEM'; utterance: string; frames: { service: string; actions: Action[] }[] }
interface CodDialogue { dialogue_id: string; turns: CodTurn[] }
interface TodAction { act: string; slot: string; value: string[] }
interface TodEvent { Agent: string; Text?: string; Actions?: TodAction[] | string; PrimaryItem?: { name?: string } | null }
interface TodDialogue { Dialogue_id: string; Events: TodEvent[] }
interface CanardRow { History: string[]; QuAC_dialog_id: string; Question: string; Question_no: number; Rewrite: string }

const score = (): Score => ({ total: 0, before: 0, after: 0 });
function add(score: Score, before: boolean, after: boolean): void {
  score.total++;
  score.before += Number(before);
  score.after += Number(after);
}

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

function evalCod(dialogues: readonly CodDialogue[]) {
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

function evalCanard(rows: readonly CanardRow[]) {
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
    add(reference, beforeType === 'follow_up' && comparable(result.entity) === comparable(name),
      comparable(result.decision.reference?.text) === comparable(name));
    add(rewrite, beforeType === 'follow_up' && comparable(result.query) === comparable(row.Rewrite),
      comparable(result.decision.standalone) === comparable(row.Rewrite));
  }
  return { dialogues: dialogueIds.size, turnType: type, referenceResolution: reference, standaloneRewrite: rewrite };
}

/** Use the translator's original words and embedded Latin-script entities without switching source turns. */
function evalArabicTod(dialogues: readonly TodDialogue[]) {
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
      state = result.next;
      const offered = actions(turns[index - 1]).find(action => action.act === 'OFFER' && action.slot === 'name');
      const name = offered?.values.length === 1 ? offered.values[0] : undefined;
      const following = visible[index + 1];
      const user = actions(turn);
      // The following wizard event must identify the same offered item as the source of its answer.
      if (!name || following?.PrimaryItem?.name !== name || !user.length
        || !user.every(action => action.act === 'REQUEST' && action.slot !== 'name')
        || !containsPhrase(turns[index - 1]!.utterance, name) || containsPhrase(turn.utterance, name)) continue;
      add(references, legacyType(result) === 'follow_up' && comparable(result.entity) === comparable(name),
        comparable(result.decision.reference?.text) === comparable(name));
    }
  }
  return { ...evalCod(mixed), referenceResolution: references };
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

function evalMulti3woz(dialogues: Record<string, Multi3wozDialogue>) {
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
  return { ...evalCod(selected), byMarker };
}

async function readCod(directory: string, locale: 'ar' | 'en'): Promise<CodDialogue[]> {
  const splits = await Promise.all(['dev', 'test'].map(async split =>
    JSON.parse(await readFile(join(directory, locale + '_' + split + '.json'), 'utf8')) as CodDialogue[]));
  return splits.flat().filter(dialogue => dialogue.turns.filter(turn => turn.speaker === 'USER').length > 1);
}

const { values } = parseArgs({ options: {
  cod: { type: 'string' }, canard: { type: 'string' }, 'arabic-tod': { type: 'string' }, 'dialect-dialogues': { type: 'string' },
} });
if (!values.cod || !values.canard || !values['arabic-tod'] || !values['dialect-dialogues']) {
  throw new Error('Supply --cod, --canard, --arabic-tod and --dialect-dialogues. See docs/CONVERSATION-STATE-DECISION-EVALUATION.md.');
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
const [ar, en, canard, arabicTod, dialectDialogues] = await Promise.all([
  readCod(values.cod, 'ar'), readCod(values.cod, 'en'), readJson<CanardRow[]>(values.canard),
  readJson<Record<string, TodDialogue>>(values['arabic-tod']), readJson<Record<string, Multi3wozDialogue>>(values['dialect-dialogues']),
]);
console.log(JSON.stringify({
  codArabic: evalCod(ar),
  codEnglish: evalCod(en),
  arabicTodMixed: evalArabicTod(Object.values(arabicTod)),
  canardEnglish: evalCanard(canard),
  multi3wozDialect: evalMulti3woz(dialectDialogues),
}, null, 2));
