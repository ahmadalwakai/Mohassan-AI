import { createHash } from 'node:crypto';
import type { BrainState } from './brain.js';
import type { RequestRoutingDecision } from './routing-decision.js';
import type { AssistantTools } from './tools.js';
import { reviewWorkRequestScope } from './work-request-scope.js';

/**
 * A coding request when no chat model exists. The route already says `coding` is ready whenever the CodingEngine is
 * available, but its only executor was the model tool `code_change`, so such requests ended «not completed». Here the
 * request names (or implies) one registered project, the same Runtime task the model tool creates is prepared, and the
 * owner's approval card is shown before anything runs. The engine then applies only proven fixes in an isolated copy,
 * verifies them, and never merges. The reply is built from the engine's verified fields, never from a claim.
 */
export interface CodingProjectRef { id: string; name: string }
export type CodingTarget =
  | { kind: 'project'; project: CodingProjectRef; named: boolean }
  | { kind: 'ambiguous'; projects: CodingProjectRef[] }
  | { kind: 'none' };
export type NoModelCodingStart =
  | { kind: 'reply'; text: string; status: 'blocked' }
  | { kind: 'approval'; task: NonNullable<BrainState['pendingTask']>; prompt: string; detail: string };
export interface CodingReply { text: string; status: 'completed' | 'partial' | 'blocked' }
type Lang = 'ar' | 'en';

const languageOf = (text: string): Lang => /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';

/** Case, Arabic letter-form and punctuation folding, so «مشروع تجربة الجمع» matches «مشروع تجربه الجمع». */
export function foldProjectText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟـ]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The project the request names as a whole phrase; with no name, the only registered project. Never a guess among several. */
export function chooseCodingProject(request: string, projects: readonly CodingProjectRef[]): CodingTarget {
  if (!projects.length) return { kind: 'none' };
  const text = ` ${foldProjectText(request)} `;
  const named = projects.filter(project => {
    const name = foldProjectText(project.name);
    return name.length > 0 && text.includes(` ${name} `);
  });
  // A longer name containing a shorter one («app» inside «app admin») is the one meant.
  const specific = named.filter(project => !named.some(other => {
    const shorter = foldProjectText(project.name), longer = foldProjectText(other.name);
    return other !== project && longer.length > shorter.length && ` ${longer} `.includes(` ${shorter} `);
  }));
  if (specific.length === 1) return { kind: 'project', project: specific[0]!, named: true };
  if (specific.length > 1) return { kind: 'ambiguous', projects: specific };
  if (projects.length === 1) return { kind: 'project', project: projects[0]!, named: false };
  return { kind: 'ambiguous', projects: [...projects] };
}

// A request to change code that the routing regexes miss because it names the project instead of saying «كود»/"code".
const EDIT_VERB = /(?:^|\s)(?:اصلح|صلح|عدل|نسق|رتب|حسن)(?=\s|$)|\b(?:fix|repair|format|lint)\b/u;

export function codingTargetReply(target: Exclude<CodingTarget, { kind: 'project' }>, lang: Lang): string {
  if (target.kind === 'none') return lang === 'ar'
    ? 'لا يوجد مشروع برمجة مسجّل بعد. سجّل المشروع من قسم «مشاريع البرمجة»، ثم أعد الطلب، وسأعرض عليك التعديل للموافقة قبل تشغيله.'
    : 'No coding project is registered yet. Register it in the Coding Projects section, then ask again; I will show the change for your approval before it runs.';
  const names = target.projects.map(project => lang === 'ar' ? `«${project.name}»` : `"${project.name}"`).join(lang === 'ar' ? '، ' : ', ');
  return lang === 'ar'
    ? `أي مشروع تقصد؟ المشاريع المسجّلة: ${names}. أعد الطلب واذكر اسم المشروع؛ لم أشغّل شيئًا.`
    : `Which project do you mean? Registered projects: ${names}. Ask again with the project's name; nothing has run.`;
}

/** Start a coding turn without a model, or null when the request is not this path's: other paths then answer it as before. */
export async function prepareNoModelCoding(request: string, routing: Pick<RequestRoutingDecision, 'handler' | 'availability'> | null | undefined,
    understanding: Parameters<typeof reviewWorkRequestScope>[2], work: AssistantTools['work'], ownerId: string,
    runId: string): Promise<NoModelCodingStart | null> {
  const routed = routing?.handler === 'coding';
  if (routed ? routing.availability !== 'ready' : !EDIT_VERB.test(foldProjectText(request))) return null;
  if (!work?.code || !work.inventory || !reviewWorkRequestScope(request, 'code_prepare', understanding).allowed) return null;
  const target = chooseCodingProject(request, await work.inventory(ownerId));
  // Outside the coding route only a request that names a registered project is this path's.
  if (!routed && !(target.kind === 'project' && target.named)) return null;
  if (target.kind !== 'project') return { kind: 'reply', text: codingTargetReply(target, languageOf(request)), status: 'blocked' };
  const key = createHash('sha256').update(`code_change|${target.project.id}|${request}`).digest('hex').slice(0, 32);
  const task = await work.code(ownerId, { id: target.project.id, goal: request }, `chat-task:${runId}:${key}`, runId);
  // The owner approves knowing what can happen: the no-model tools ignore a logic goal (packages/coding/src/deterministic.ts).
  return { kind: 'approval', task: { id: task.id, label: task.label, tool: 'code_change' }, prompt: task.prompt,
    detail: `${task.detail}\n${PROVEN_ONLY[languageOf(request)]}` };
}

const PROVEN_ONLY: Record<Lang, string> = {
  ar: 'من دون نموذج تُطبَّق الإصلاحات المؤكدة فقط: تشخيصات TypeScript ذات الإصلاح المعروف، وإصلاحات ESLint، والتنسيق عند طلبه. لا يُنفَّذ أي تغيير في المنطق.',
  en: 'Without a model only proven fixes are applied: TypeScript diagnostics with a known fix, ESLint fixes, and formatting when asked. No logic change is made.',
};

// The Runtime's fixed refusal for coding.change when the tools found nothing provable (packages/runtime/src/index.ts).
const NO_PROVEN_FIX = /إصلاحًا يمكن إثباته/u;

/** The reply after the approved task settled, from the facts tools.work.outcome reported (assistant/tools.ts describeOutcome). */
export function codingOutcomeReply(outcome: string, label: string, request: string): CodingReply {
  const lang = languageOf(request);
  const field = (key: string) => outcome.match(new RegExp(`^${key}: (.*)$`, 'mu'))?.[1]?.trim() || null;
  const failed = /^failed: /u.test(outcome) ? outcome.slice('failed: '.length).trim() : null;
  const status = field('task status'), result = field('outcome'), summary = field('summary'), branch = field('review branch');
  const error = field('error') ?? failed;
  const name = label.replace(/^تعديل (?:مشروع )?/u, '').trim() || label;
  const project = lang === 'ar' ? `«${name}»` : `"${name}"`;
  const unchanged = lang === 'ar' ? 'مشروعك الأصلي لم يتغيّر ولم يُدمج شيء.' : 'Your original project is unchanged and nothing was merged.';
  const withSummary = (text: string) => summary ? `${text}\n\n${summary}` : text;
  if (status === 'completed' && result === 'ready_for_review') return {
    status: 'completed',
    text: withSummary(lang === 'ar'
      ? `طبّقت أدوات الإصلاح المؤكد ما وجدته في ${project}، واجتاز الناتج الاختبارات والمراجعة المستقلة في نسخة معزولة.`
      : `The proven-fix tools applied what they found in ${project}; the result passed the tests and the independent review in an isolated copy.`)
      + (branch ? (lang === 'ar' ? `\n\nفرع المراجعة: \`${branch}\`. ${unchanged} راجع الفرع وادمجه بنفسك إن أردت.`
        : `\n\nReview branch: \`${branch}\`. ${unchanged} Review the branch and merge it yourself if you want it.`) : `\n\n${unchanged}`)
      + (lang === 'ar' ? '\n\nإن كان طلبك تغييرًا في المنطق فلم يُنفَّذ؛ ذلك يحتاج نموذجًا لا يعمل الآن.'
        : '\n\nIf you asked for a logic change, it was not made; that needs a model, which is not running now.'),
  };
  if (status === 'completed' && (result === 'tests_failed' || result === 'review_failed')) return {
    status: 'partial',
    text: withSummary(lang === 'ar'
      ? `طبّقت الإصلاحات المثبتة على ${project} في نسخة معزولة، لكن ${result === 'tests_failed' ? 'الاختبارات فشلت بعدها' : 'المراجعة المستقلة لم تجتزها'}، فلم أحفظ فرعًا للمراجعة. النسخة المعزولة محفوظة في قسم المهام.`
      : `I applied the proven fixes to ${project} in an isolated copy, but ${result === 'tests_failed' ? 'the tests failed afterwards' : 'the independent review did not pass'}, so no review branch was saved. The isolated copy is kept in the Tasks section.`)
      + `\n\n${unchanged}`,
  };
  if (error && NO_PROVEN_FIX.test(error)) return {
    status: 'blocked',
    text: lang === 'ar'
      ? `لم أجد إصلاحًا يمكن إثباته لهذا الطلب في ${project}، فلم يتغيّر شيء. من دون نموذج أطبّق الإصلاحات المؤكدة فقط: تشخيصات TypeScript ذات الإصلاح المعروف، ومشكلات ESLint القابلة للإصلاح، والتنسيق عند طلبه. تعديل المنطق يحتاج نموذجًا لا يعمل الآن.`
      : `I found no provable fix for this request in ${project}, so nothing changed. Without a model I apply only proven fixes: TypeScript diagnostics with a known fix, fixable ESLint problems, and formatting when asked. A logic change needs a model, which is not running now.`,
  };
  if (status === 'cancelled') return {
    status: 'blocked',
    text: lang === 'ar' ? `أُلغيت مهمة تعديل ${project}. ${unchanged}` : `The change to ${project} was cancelled. ${unchanged}`,
  };
  if (status === 'waiting_approval' || status === 'paused') return {
    status: 'partial',
    text: lang === 'ar' ? `توقفت مهمة تعديل ${project} لمراجعتك في قسم المهام. ${unchanged}` : `The change to ${project} stopped for your review in the Tasks section. ${unchanged}`,
  };
  return {
    status: 'blocked',
    text: (lang === 'ar' ? `لم يكتمل تعديل ${project}` : `The change to ${project} did not complete`)
      + (error ? (lang === 'ar' ? `: ${error}` : `: ${error}`) : '.') + `\n\n${unchanged}`,
  };
}
