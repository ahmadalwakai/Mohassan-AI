/**
 * Replays the live conversation-state shadow log through the current v2 code, conversation by conversation and in time
 * order, and compares each turn with what the server logged at the time. Real turns, no labels needed: it shows what a code
 * change does to the owner's actual messages, and where the server lost a conversation's thread (a logged "new_request" on
 * a turn that is not the conversation's first means the in-memory state was gone, usually after a restart).
 *
 * Usage: npx tsx scripts/conversation-state/replay-shadow.ts [.data/conversation/shadow.jsonl] [--out artifacts/conversation-state-20261122]
 * Host results shown between turns and pending steps are not in the log, so references and card answers are replayed without them.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { emptyConversationState, understandTurn, type ConversationStateV2 } from '../../apps/server/src/assistant/conversation-state.js';
import type { ConversationShadowLine } from '../../apps/server/src/assistant/conversation-state-shadow.js';

const args = process.argv.slice(2);
const outRoot = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'artifacts/conversation-state-20261122';
const logFile = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--out') ?? '.data/conversation/shadow.jsonl';
const text = await readFile(logFile, 'utf8').catch(() => '');
const rows = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as ConversationShadowLine]; } catch { return []; } })
  .sort((a, b) => a.at.localeCompare(b.at));
if (!rows.length) { console.log(`no shadow lines in ${logFile}`); process.exit(0); }

const FIELDS = ['type', 'entity', 'property', 'place', 'time', 'query', 'needs'] as const;
type Field = (typeof FIELDS)[number];
interface Replayed { line: ConversationShadowLine; position: number; now: Record<Field, string | null>; changed: Field[]; lostThread: boolean; ms: number }

const states = new Map<string, ConversationStateV2>();
const positions = new Map<string, number>();
const replayed: Replayed[] = [];
for (const line of rows) {
  const position = (positions.get(line.conversationId) ?? 0) + 1;
  positions.set(line.conversationId, position);
  const started = performance.now();
  const understanding = understandTurn(states.get(line.conversationId) ?? emptyConversationState(), line.text, line.turnId);
  const ms = performance.now() - started;
  states.set(line.conversationId, understanding.next);
  const now = Object.fromEntries(FIELDS.map(field => [field, (understanding[field] as string | null | undefined) ?? null])) as Record<Field, string | null>;
  const changed = FIELDS.filter(field => (line[field] ?? null) !== now[field]);
  replayed.push({ line, position, now, changed, lostThread: position > 1 && line.type === 'new_request', ms });
}

const conversations = positions.size;
const changedTurns = replayed.filter(turn => turn.changed.length);
const lost = replayed.filter(turn => turn.lostThread);
const gained = replayed.filter(turn => turn.line.query === null && turn.now.query !== null);
const dropped = replayed.filter(turn => turn.line.query !== null && turn.now.query === null);
const loggedMs = rows.map(row => row.ms).sort((a, b) => a - b);
const replayMs = replayed.map(turn => turn.ms).sort((a, b) => a - b);
const median = (values: number[]) => values[Math.floor(values.length / 2)] ?? NaN;
const cell = (value: string | null) => value === null ? '—' : value.replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').slice(0, 70);

const startedAt = new Date();
const outDir = join(outRoot, `replay-${startedAt.toISOString().replace(/[:.]/gu, '-')}`);
await mkdir(outDir, { recursive: true });
const report = `# Conversation state v2: the live shadow log replayed through the current code

| | |
|---|---|
| Run at | ${startedAt.toISOString()} |
| Command | \`npx tsx scripts/conversation-state/replay-shadow.ts${args.length ? ' ' + args.join(' ') : ''}\` |
| Log | \`${logFile}\`, sha256 \`${createHash('sha256').update(text).digest('hex')}\`, ${rows.length} turns in ${conversations} conversations, ${rows[0]!.at} → ${rows.at(-1)!.at} |
| Logged v2 time per turn (live server) | median ${median(loggedMs).toFixed(1)} ms, max ${loggedMs.at(-1)!.toFixed(1)} ms |
| Replay time per turn (this process) | median ${median(replayMs).toFixed(1)} ms, max ${replayMs.at(-1)!.toFixed(1)} ms |

| | Turns |
|---|---|
| Reading changed since the log | ${changedTurns.length} |
| Thread lost in the live server (logged new_request on a later turn) | ${lost.length} |
| Public query gained (none logged, one now) | ${gained.length} |
| Public query dropped (one logged, none now) | ${dropped.length} |

## Every turn

| At (UTC) | Conv | # | Text | Logged type / query | Now type / query | Changed |
|---|---|---|---|---|---|---|
${replayed.map(turn => `| ${turn.line.at.slice(11, 19)} | ${turn.line.conversationId.slice(0, 8)} | ${turn.position} | ${cell(turn.line.text)} | ${turn.line.type} / ${cell(turn.line.query)} | ${turn.now.type} / ${cell(turn.now.query)} | ${turn.changed.join(', ') || '—'}${turn.lostThread ? ' (thread lost live)' : ''} |`).join('\n')}

## Changed fields in detail

${changedTurns.map(turn => `- ${turn.line.at.slice(11, 19)} «${cell(turn.line.text)}»: ${turn.changed.map(field => `${field} ${JSON.stringify(turn.line[field] ?? null)} → ${JSON.stringify(turn.now[field])}`).join('; ')}`).join('\n') || 'None.'}
`;
await writeFile(join(outDir, 'report.md'), report, 'utf8');
await writeFile(join(outDir, 'replayed.jsonl'), replayed.map(turn => JSON.stringify({ at: turn.line.at, conversationId: turn.line.conversationId,
  position: turn.position, text: turn.line.text, logged: Object.fromEntries(FIELDS.map(field => [field, turn.line[field] ?? null])), now: turn.now,
  changed: turn.changed, lostThread: turn.lostThread })).join('\n') + '\n', 'utf8');
console.log(report);
console.log(`\nwritten: ${outDir}`);
