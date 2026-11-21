import { PLANNING, tidy } from './hands.js';
import { numberedAnswers, type Lang } from './writer.js';

/**
 * A week plan without a model: one card asks for the tasks, the working days and any fixed appointments,
 * then the tasks are spread over the days (important first, lightest day next). Nothing here writes free
 * text: every task and appointment appears exactly as the owner typed it.
 */
export interface PlanningTask { lang: Lang }

const ARABIC = /[؀-ۿ]/u;
const DAYS = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
/** Day names as people type them: with or without «ال», hamza or not, short English forms. */
const DAY_PATTERNS: RegExp[] = [
  /(?:ال)?[اأ]حد|\bsun(?:day)?\b/iu, /(?:ال)?[اإ]ثنين|\bmon(?:day)?\b/iu, /(?:ال)?ثلاثاء|\btue(?:s|sday)?\b/iu,
  /(?:ال)?[اأ]ربعاء|\bwed(?:nesday)?\b/iu, /(?:ال)?خميس|\bthu(?:rs|rsday)?\b/iu, /(?:ال)?جمع[ةه]|\bfri(?:day)?\b/iu, /(?:ال)?سبت|\bsat(?:urday)?\b/iu,
];
const SPANS = {
  ar: [['الأحد إلى الخميس', [0, 1, 2, 3, 4]], ['الاثنين إلى الجمعة', [1, 2, 3, 4, 5]], ['كل أيام الأسبوع', [0, 1, 2, 3, 4, 5, 6]]],
  en: [['Monday to Friday', [1, 2, 3, 4, 5]], ['Sunday to Thursday', [0, 1, 2, 3, 4]], ['Every day', [0, 1, 2, 3, 4, 5, 6]]],
} as const satisfies Record<Lang, readonly (readonly [string, readonly number[]])[]>;

/** A request to plan a week or a day, or null. */
export function planningTask(request: string): PlanningTask | null {
  const text = tidy(request);
  if (!text || text.length > 200 || !PLANNING.test(text)) return null;
  return { lang: ARABIC.test(text) ? 'ar' : 'en' };
}

/** One card with three questions; the usual working week is chosen in advance and can be changed. */
export function planningQuestion(task: PlanningTask) {
  const ar = task.lang === 'ar';
  return {
    prompt: ar ? 'أرتّب لك الأسبوع من مهامك أنت، دون أن أضيف شيئاً من عندي. أجب عن هذه الأسئلة:' : "I'll lay out your week from your own tasks, adding nothing of my own. Answer these:",
    fields: [
      { id: 'tasks', prompt: ar ? 'ما مهامك هذا الأسبوع؟ افصل بينها بفاصلة، وضع ! قبل المهم.' : 'What are your tasks this week? Separate them with commas; put ! before the important ones.', suggestions: [],
        placeholder: ar ? 'مثلاً: !تسليم التقرير، مراجعة الميزانية، الاتصال بالمورد' : 'e.g. !send the report, review the budget, call the supplier' },
      { id: 'days', prompt: ar ? 'أي أيام تعمل فيها؟' : 'Which days do you work?', suggestions: SPANS[task.lang].map(([label]) => ({ label })), selected: [0] },
      { id: 'fixed', prompt: ar ? 'هل عندك مواعيد ثابتة؟ اذكر اليوم مع كل موعد (اختياري).' : 'Any fixed appointments? Name the day with each one (optional).', suggestions: [],
        placeholder: ar ? 'مثلاً: الثلاثاء اجتماع الفريق، الخميس طبيب الأسنان' : 'e.g. Tuesday team meeting, Thursday dentist' },
    ],
  };
}

const items = (answer: string) => answer.split(/[،,;؛\n]+/u).map(item => item.trim()).filter(Boolean);
const dayOf = (text: string) => DAY_PATTERNS.findIndex(pattern => pattern.test(text));

/** The days the owner chose: a listed span, or the day names written in the answer, else the first span. */
function daysOf(answer: string, lang: Lang): number[] {
  const span = SPANS[lang].find(([label]) => answer.includes(label)) ?? SPANS[lang === 'ar' ? 'en' : 'ar'].find(([label]) => answer.includes(label));
  if (span) return [...span[1]];
  const named = DAY_PATTERNS.map((pattern, index) => (pattern.test(answer) ? index : -1)).filter(index => index >= 0);
  return named.length ? named : [...SPANS[lang][0][1]];
}

/** The plan: fixed appointments on their day, then each task on the lightest day, important tasks first. */
export function composePlan(task: PlanningTask, reply: string): { text: string; complete: boolean } {
  const ar = task.lang === 'ar';
  const [tasksAnswer, daysAnswer, fixedAnswer] = numberedAnswers(reply, 3);
  const tasks = items(tasksAnswer).map(item => ({ text: item.replace(/^!+\s*/u, ''), important: item.startsWith('!') }));
  if (!tasks.length) return { complete: false, text: ar ? 'لم تكتب أي مهمة، فلا شيء أرتّبه. اكتب مثلاً «خطط لأسبوعي» من جديد واذكر مهامك مفصولة بفواصل.' : 'You listed no tasks, so there is nothing to lay out. Ask again, for example «plan my week», and list your tasks separated by commas.' };
  const days = daysOf(daysAnswer, task.lang);
  const plan = new Map<number, string[]>(days.map(day => [day, []]));
  const unplaced: string[] = [];
  for (const fixed of items(fixedAnswer)) {
    const day = dayOf(fixed);
    const what = fixed.replace(DAY_PATTERNS[day] ?? /^$/u, '').replace(/^\s*(?:يوم|on)\s+/iu, '').trim() || fixed;
    if (day >= 0 && plan.has(day)) plan.get(day)!.push(ar ? `${what} (موعد ثابت)` : `${what} (fixed)`);
    else unplaced.push(fixed);
  }
  for (const item of [...tasks.filter(entry => entry.important), ...tasks.filter(entry => !entry.important)]) {
    const lightest = days.reduce((best, day) => (plan.get(day)!.length < plan.get(best)!.length ? day : best), days[0]);
    plan.get(lightest)!.push(item.important ? `**${item.text}**` : item.text);
  }
  const names = DAYS[task.lang];
  const body = days.map(day => `**${names[day]}**\n${plan.get(day)!.length ? plan.get(day)!.map(entry => `- ${entry}`).join('\n') : ar ? '- (يوم خفيف)' : '- (light day)'}`).join('\n\n');
  const extra = unplaced.length ? (ar ? `\n\nمواعيد لم أعرف يومها: ${unplaced.join('، ')}` : `\n\nAppointments with no day I could read: ${unplaced.join(', ')}`) : '';
  const note = ar
    ? '\n\n---\nوزّعت المهام على أخفّ الأيام، والمهم (بالخط العريض) أولاً. هذه خطة من قالب بكلماتك كما كتبتها؛ لم يكتبها نموذج، فعدّلها كما تريد.'
    : '\n\n---\nTasks go to the lightest day, important ones (in bold) first. This plan comes from a template in your own words; no model wrote it, so change it as you like.';
  return { complete: true, text: `${ar ? '**خطة الأسبوع**' : '**Your week**'}\n\n${body}${extra}${note}` };
}
