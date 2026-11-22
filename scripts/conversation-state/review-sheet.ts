/**
 * Builds the owner's Arabic review sheet: every real message (the live shadow log, then the frozen real set) where v1 and
 * conversation state v2 read the message differently, as a different kind of turn or a different web search. One verdict each.
 *
 * Usage: npx tsx scripts/conversation-state/review-sheet.ts [--out artifacts/conversation-state-20261122]
 * Then: npx tsx scripts/conversation-state/score-review.ts <the sheet, filled in>   or   … --answers "1 v2، 2 كلاهما"
 * The sheet holds the owner's own messages: it is written under artifacts/ (not tracked by git) and never sent anywhere.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyConversationState, understandTurn, type ConversationStateV2, type TurnType, type TurnUnderstanding } from '../../apps/server/src/assistant/conversation-state.js';
import type { ConversationShadowLine } from '../../apps/server/src/assistant/conversation-state-shadow.js';
import { resolveRequestContext, type RequestContextState, type RequestResolution } from '../../apps/server/src/assistant/request-context.js';
import { sameQuery, type ReviewItem, type ReviewReading } from './review-format.js';

const args = process.argv.slice(2);
const outRoot = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'artifacts/conversation-state-20261122';
const logFile = '.data/conversation/shadow.jsonl';
const realFile = 'artifacts/plan-2026-11-22/real-questions-v1.jsonl';

const V2_LABEL: Record<TurnType, string> = {
  new_request: 'طلب جديد', topic_change: 'موضوع جديد', follow_up_property: 'سؤال آخر عن الموضوع نفسه', follow_up_entity: 'السؤال نفسه عن شيء آخر',
  reference: 'إشارة إلى نتيجة معروضة', correction: 'تصحيح', field_edit: 'تغيير جزء واحد', card_answer: 'جواب لخطوة تنتظرك',
  compound: 'طلب من خطوات', small_talk: 'حديث قصير', ambiguous: 'يحتاج توضيحًا',
};
const V1_LABEL: Record<RequestResolution['kind'], string> = { new: 'طلب جديد', follow_up: 'متابعة', answer: 'جواب لخطوة تنتظرك', ambiguous: 'يحتاج توضيحًا' };
/** The v2 types each v1 kind can stand for (the same generous rule as eval.ts). */
const COMPATIBLE: Record<RequestResolution['kind'], TurnType[]> = {
  new: ['new_request', 'topic_change'], follow_up: ['follow_up_property', 'follow_up_entity', 'correction', 'field_edit'],
  answer: ['card_answer'], ambiguous: ['ambiguous'],
};

function readV1(v1: RequestResolution): ReviewReading {
  return { label: V1_LABEL[v1.kind], query: v1.query, note: v1.kind === 'ambiguous' ? 'يسألك عمّا تقصد' : null };
}
function readV2(v2: TurnUnderstanding): ReviewReading {
  const notes = [v2.assumption ? `يقول: ${v2.assumption}` : null,
    v2.needs === 'missing_reference' ? 'يسألك عمّا تقصد' : v2.needs === 'missing_value' ? 'يسألك عن الناقص' : null,
    v2.edit ? `يغيّر: ${v2.edit.field}${v2.edit.value ? ` = ${v2.edit.value}` : ''}` : null,
    v2.reference ? `النتيجة رقم ${v2.reference.index}` : null,
    v2.corrected?.length ? `قرأ «${v2.corrected.map(fix => `${fix.from}» كـ«${fix.to}`).join('», «')}»` : null].filter(Boolean);
  return { label: V2_LABEL[v2.type], query: v2.query, note: notes.length ? notes.join('؛ ') : null };
}
function differs(v1: RequestResolution, v2: TurnUnderstanding): boolean {
  const compatible = COMPATIBLE[v1.kind].includes(v2.type) || v1.kind === 'new' && v1.intent === 'chat' && v2.type === 'small_talk';
  return !compatible || !sameQuery(v1.query, v2.query);
}

const items: Omit<ReviewItem, 'number'>[] = [];

// 1. The live shadow log, conversation by conversation, both readers threading their own state on the owner's turns.
const live = (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  .flatMap(line => { try { return [JSON.parse(line) as ConversationShadowLine]; } catch { return []; } }).sort((a, b) => a.at.localeCompare(b.at));
const threads = new Map<string, { v2: ConversationStateV2; v1: RequestContextState | null; texts: string[] }>();
for (const line of live) {
  const thread = threads.get(line.conversationId) ?? { v2: emptyConversationState(), v1: null, texts: [] };
  const v2 = understandTurn(thread.v2, line.text, line.turnId);
  const v1 = resolveRequestContext(line.text, thread.v1, { turnId: line.turnId });
  if (differs(v1, v2)) items.push({ source: 'live', ref: `محادثة ${line.conversationId.slice(0, 8)}، الدور ${thread.texts.length + 1} (${line.at.slice(11, 16)} UTC)`,
    earlier: thread.texts.slice(-2), text: line.text, v1: readV1(v1), v2: readV2(v2) });
  threads.set(line.conversationId, { v2: v2.next, v1: v1.nextState ?? thread.v1, texts: [...thread.texts, line.text] });
}

// 2. The frozen real set: pairs with their previous message first, then single messages.
interface RealItem { id: string; kind: 'single' | 'pair'; text: string; previous: string | null }
const real = (await readFile(realFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RealItem);
const seen = new Set(live.map(line => line.text.trim()));
for (const item of [...real.filter(item => item.kind === 'pair'), ...real.filter(item => item.kind === 'single')]) {
  if (!item.previous && seen.has(item.text.trim())) continue; // the same message already reviewed from the live log
  let v2State = emptyConversationState();
  let v1State: RequestContextState | null = null;
  if (item.previous) {
    v2State = understandTurn(v2State, item.previous, `${item.id}-prev`).next;
    v1State = resolveRequestContext(item.previous, null, { turnId: `${item.id}-prev` }).nextState;
  }
  const v2 = understandTurn(v2State, item.text, item.id);
  const v1 = resolveRequestContext(item.text, v1State, { turnId: item.id });
  if (differs(v1, v2)) items.push({ source: 'frozen', ref: `المجموعة المجمدة، ${item.id}`, earlier: item.previous ? [item.previous] : [], text: item.text, v1: readV1(v1), v2: readV2(v2) });
}

const numbered: ReviewItem[] = items.map((item, index) => ({ ...item, number: index + 1 }));
const quote = (text: string) => `«${text.replace(/\s+/gu, ' ').trim().slice(0, 220)}»`;
const searchLine = (reading: ReviewReading) => reading.query === null ? 'لا يبحث في الويب' : `يبحث في الويب عن: ${quote(reading.query)}`;
const block = (item: ReviewItem) => [
  `### ${item.number}`,
  '',
  `**المصدر:** ${item.source === 'live' ? 'سجل الظل الحي' : ''}${item.source === 'live' ? '، ' : ''}${item.ref}`,
  ...(item.earlier.length ? [`**قبلها:** ${item.earlier.map(quote).join(' ثم ')}`] : []),
  `**رسالتك:** ${quote(item.text)}`,
  '',
  `- **v1 (الحالي):** ${item.v1.label}. ${searchLine(item.v1)}.${item.v1.note ? ` ${item.v1.note}.` : ''}`,
  `- **v2 (الجديد):** ${item.v2.label}. ${searchLine(item.v2)}.${item.v2.note ? ` ${item.v2.note}.` : ''}`,
  '',
  'الحكم: [ ]',
  '',
].join('\n');

const startedAt = new Date();
const outDir = join(outRoot, `review-${startedAt.toISOString().replace(/[:.]/gu, '-')}`);
await mkdir(outDir, { recursive: true });
const sheet = `# مراجعة: أيّ القراءتين فهمت رسالتك؟

هذه رسائلك الحقيقية التي اختلف فيها فهم موحسن الحالي (v1) عن الجديد (v2): ${numbered.length} رسالة، من سجل الظل الحي (${numbered.filter(item => item.source === 'live').length}) ومن المجموعة المجمدة (${numbered.filter(item => item.source === 'frozen').length}). الحكم على **الفهم** وحده: نوع الرسالة، وما سيبحث عنه أو يسألك عنه. لا على جودة الجواب.

اكتب بين القوسين بعد «الحكم:» كلمة واحدة:

- **v1** إن كانت القراءة الحالية هي الصحيحة
- **v2** إن كانت الجديدة هي الصحيحة
- **كلاهما** إن صحّتا معًا
- **لا أحد** إن أخطأتا معًا

أو أرسل الأحكام في المحادثة هكذا: «1 v2، 2 كلاهما، 3 v1». الرسائل التي تتركها لا تُحسب.

ملاحظة: المجموعة المجمدة لا تسجل هل كانت بطاقة أسئلة أو موافقة مفتوحة قبل الرسالة. حين تكون مفتوحة، يأخذ الكود جوابك قبل القراءتين معًا. فاحكم على ما ينبغي أن يحدث لو لم تكن هناك بطاقة.

---

${numbered.map(block).join('\n')}`;
await writeFile(join(outDir, 'REVIEW-AR.md'), sheet, 'utf8');
await writeFile(join(outDir, 'items.json'), JSON.stringify({ at: startedAt.toISOString(), logLines: live.length, realItems: real.length, items: numbered }, null, 2), 'utf8');
console.log(`${numbered.length} items (${numbered.filter(item => item.source === 'live').length} live, ${numbered.filter(item => item.source === 'frozen').length} frozen)`);
console.log(`written: ${join(outDir, 'REVIEW-AR.md')}`);
