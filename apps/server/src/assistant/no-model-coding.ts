import { createHash } from 'node:crypto';
import { BrowserError } from '@mohassan/browser';
import type { CheckFailure, CodingCheckResult, ImportsLookup, ProjectSearchResult } from '@mohassan/coding';
import { addEvidence, appendStep, planStep, settleStep, startStep, tryEnterPhase, type RunLedger } from './agent-run.js';
import type { BrainState } from './brain.js';
import { codeLogicReply, recognizeCodeLogicRequest } from './code-logic-request.js';
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
  | { kind: 'reply'; text: string; status: 'blocked'; direct?: true }
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
// «صحح» also corrects text, so like the others it counts only with a registered project named and the scope review passed.
const EDIT_VERB = /(?:^|\s)(?:اصلح|صلح|صحح|عدل|نسق|رتب|حسن)(?=\s|$)|\b(?:fix|repair|format|lint)\b/u;

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
  const logic = !EDIT_VERB.test(foldProjectText(request)) && recognizeCodeLogicRequest(request);
  if (logic && work?.inventory) {
    const target = chooseCodingProject(request, await work.inventory(ownerId));
    if (target.kind === 'project' && target.named) return codeLogicReply(request, target.project.name, logic, Boolean(work.codeCheck && work.code));
  }
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

/*
 * Reading a registered project without a model: run its own checks once in the sandbox and explain what failed, search
 * its committed files, or say which files import which. Only a request that names a registered project as a whole phrase
 * is this path's, so file searches on the computer, text corrections and web questions keep their own paths. Nothing is
 * changed and nothing waits for approval: reads see only the committed files inspectProject allows, and the checks run
 * in the AppContainer sandbox with no network on a copy of the files, exactly as a change task's baseline run does.
 */
export type CodeReadIntent =
  | { kind: 'check' }
  | { kind: 'search'; query: string }
  | { kind: 'imports'; reference: string; direction: 'importers' | 'imports' };
export interface CodeReadAnswer {
  text: string;
  status: 'completed' | 'partial' | 'blocked';
  /** The run ledger's one step for this read (agent-run.ts: code.read or code.check). */
  step: { id: 'code-read' | 'code-check'; capability: 'code.read' | 'code.check'; label: string; ok: boolean; evidence: string };
  trail: { action: string; result: string };
}

// Diacritics and tatweel off, letters, case and punctuation kept: search terms and file references come from this.
const unmarked = (text: string) => text.normalize('NFKC').replace(/[ً-ٰٟـ]/gu, '').replace(/\s+/gu, ' ').trim();

// A cheap first look on the folded text, so most requests never read the project list.
const READ_CUE = /(?:^|\s)(?:ابحث|فتش|دور|اين|وين|تستورد|يستورد|تستدعي|يستدعي|شغل|نفذ|اجر|افحص|اختبر|اختبارات|فحوص|فحوصات|تفشل|يفشل)(?:\s|$)|\b(?:search|grep|find|locate|where|imports?|run|execute|rerun|tests?|checks?)\b/u;

// On the folded text (foldProjectText): «شغّل» reads «شغل», «أجرِ» reads «اجر».
const CHECK = [
  /(?:^|\s)(?:شغل|نفذ|اجر|اعمل|سوي|افحص|اختبر|جرب)\s+(?:لي\s+)?(?:ال)?(?:اختبارات|اختبار|فحوص|فحوصات|فحص|تيست|تستات|tests?)(?:\s|$)/u,
  /(?:^|\s)(?:لماذا|ليش|ليه|لم|ما سبب|سبب)\s+(?:تفشل|يفشل|فشلت|فشل|تتعطل)\s+(?:ال)?(?:اختبارات|اختبار|فحوص|فحوصات|فحص)(?:\s|$)/u,
  /^(?:من فضلك\s+)?(?:افحص|اختبر)\s+(?:لي\s+)?(?:ال)?(?:مشروع|كود)(?:\s|$)/u,
  /\b(?:run|execute|rerun|re-run)\s+(?:the\s+|all\s+(?:the\s+)?|my\s+)?(?:unit\s+)?(?:tests?|checks?|test\s+suite|specs?)\b/u,
  /\bwhy\s+(?:do|does|did|are|is)\s+(?:the\s+|my\s+)?(?:tests?|checks?)\s+fail/u,
];
// On the unmarked text; the term is the first group.
const SEARCH = [
  /(?:^|\s)(?:ابحث|أبحث|إبحث|فتش|دور)\s+(?:لي\s+)?(?:في|داخل)\s+\S.*\s+عن\s+(.+)$/u,
  /(?:^|\s)(?:ابحث|أبحث|إبحث|فتش|دور)\s+(?:لي\s+)?عن\s+(.+?)\s+(?:في|داخل)\s+\S.*$/u,
  /(?:^|\s)(?:أين|اين|وين)\s+(?:تستخدم|يستخدم|استخدمت|استخدم|تستعمل|يستعمل|يظهر|تظهر|يرد|ترد|ورد|وردت|توجد|يوجد|تعرف|يعرف|عرفت|عرف)\s+(?:(?:ال)?(?:دالة|داله|متغير|كلمة|كلمه|ثابت|صنف|كلاس|نص|اسم)\s+)?(.+?)\s+(?:في|داخل)\s+\S.*$/u,
  /\b(?:search|grep)\s+(?:in\s+|through\s+|inside\s+)?\S.*?\s+for\s+(.+)$/iu,
  /\b(?:search\s+for|find|look\s+for|grep\s+for|locate)\s+(.+?)\s+(?:in|inside|within)\s+\S.*$/iu,
  /\bwhere\s+(?:is|are|does)\s+(?:the\s+)?(?:(?:function|variable|word|constant|class|name)\s+)?(.+?)\s+(?:used|defined|called|referenced|mentioned|appears?)\s+(?:in|inside|within)\s+\S.*$/iu,
];
const IMPORTS: readonly (readonly [RegExp, 'importers' | 'imports'])[] = [
  [/(?:^|\s)(?:ماذا|ما الذي|ما اللي|شو|وش|ايش|إيش)\s+(?:يستورد|تستورد|يستدعي|تستدعي)\s+(?:الملف\s+|ملف\s+)?(.+?)(?:\s+(?:في|داخل|ضمن)\s+\S.*)?$/u, 'imports'],
  [/\bwhat\s+does\s+(?:the\s+)?(?:file\s+)?(.+?)\s+import\b/iu, 'imports'],
  [/(?:^|\s)(?:ما|ماهي|ما هي|اي|أي|من)\s+(?:(?:ال)?ملفات\s+|(?:ال)?ملف\s+)?(?:(?:التي|الذي|اللي)\s+)?(?:تستورد|يستورد|تستدعي|يستدعي)\s+(?:الملف\s+|ملف\s+)?(.+?)(?:\s+(?:في|داخل|ضمن)\s+\S.*)?$/u, 'importers'],
  [/\b(?:which|what)\s+files?\s+imports?\s+(?:the\s+file\s+|file\s+)?(.+?)(?:\s+(?:in|inside|within)\s+\S.*)?$/iu, 'importers'],
  [/\b(?:who|what)\s+imports\s+(?:the\s+file\s+|file\s+)?(.+?)(?:\s+(?:in|inside|within)\s+\S.*)?$/iu, 'importers'],
];

function cleanTerm(text: string): string {
  // «ملف اسمه sum» and "the file named sum" ask for a name: the search also matches tracked paths.
  let value = text.trim().replace(/[\s؟?!.,،:;]+$/u, '')
    .replace(/^(?:(?:ال)?ملف(?:ات)?\s+(?:(?:اسمه|اسمها|باسم|يسمى|تسمى)\s+)?|(?:the\s+)?files?\s+(?:(?:named|called)\s+)?)(?=\S)/iu, '');
  const quoted = /^[«"“`](.+)[»"”`]$/u.exec(value);
  if (quoted) value = quoted[1]!;
  return value.trim();
}
const mentionsProject = (term: string, projectName: string) => ` ${foldProjectText(term)} `.includes(` ${foldProjectText(projectName)} `);

/** What the owner asks of the named project: run its checks, search it, or its import relations; null for anything else. */
export function recognizeCodeRead(request: string, projectName: string): CodeReadIntent | null {
  const text = unmarked(request), folded = foldProjectText(request);
  const usable = (term: string | undefined) => {
    const value = cleanTerm(term ?? '');
    return value && value.length <= 200 && !mentionsProject(value, projectName) ? value : null;
  };
  for (const [pattern, direction] of IMPORTS) {
    const reference = usable(pattern.exec(text)?.[1]);
    if (reference) return { kind: 'imports', reference, direction };
  }
  for (const pattern of SEARCH) {
    const match = pattern.exec(text);
    if (!match) continue;
    // A quoted term is taken as written, so «ابحث في مشروع X عن "a في b"» searches the whole phrase.
    const quoted = [...text.matchAll(/[«"“`]([^«»"“”`]{1,200})[»"”`]/gu)].map(item => item[1]!.trim()).find(term => term && !mentionsProject(term, projectName));
    const query = quoted ?? usable(match[1]);
    if (query) return { kind: 'search', query };
  }
  return CHECK.some(pattern => pattern.test(folded)) ? { kind: 'check' } : null;
}

/** The request's language without the project's own name, so "Run the tests in مشروع X" is answered in English. */
function requestLanguage(request: string, projectName: string): Lang {
  return /\p{Script=Arabic}/u.test(` ${foldProjectText(request)} `.replace(` ${foldProjectText(projectName)} `, ' ')) ? 'ar' : 'en';
}

const code = (text: string) => `\`${text.replace(/`/gu, "'")}\``;
type Counted = readonly [one: string, two: string, few: string, many: string];
const LINES: Counted = ['سطر واحد', 'سطران', 'أسطر', 'سطرًا'];
const FILES: Counted = ['ملف واحد', 'ملفان', 'ملفات', 'ملفًا'];
/** Arabic counted nouns: «سطر واحد»، «سطران»، «3 أسطر»، «11 سطرًا»، «100 سطر». */
function countAr(count: number, forms: Counted): string {
  if (count === 1) return forms[0];
  if (count === 2) return forms[1];
  const rest = count % 100;
  return `${count} ${rest >= 3 && rest <= 10 ? forms[2] : rest >= 11 ? forms[3] : forms[0].split(' ')[0]}`;
}
const countEn = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const where = (location: { path: string; line: number } | null) => location ? code(`${location.path}:${location.line}`) : null;

function failureLines(failures: readonly CheckFailure[], lang: Lang): string[] {
  const lines: string[] = [];
  failures.forEach((failure, index) => {
    const previous = failures[index - 1];
    const declared = where(failure.location);
    lines.push(`${index + 1}. ${lang === 'ar' ? `«${failure.test}»` : `"${failure.test}"`}${declared ? (lang === 'ar' ? ` في ${declared}` : ` at ${declared}`) : ''}`);
    if (previous && previous.error === failure.error && where(previous.origin) === where(failure.origin) && !failure.comparison) {
      lines.push(lang === 'ar' ? `   الخطأ نفسه${failure.origin ? `، من ${where(failure.origin)}` : ''}.` : `   The same error${failure.origin ? `, from ${where(failure.origin)}` : ''}.`);
      return;
    }
    lines.push(`   ${lang === 'ar' ? 'الخطأ' : 'Error'}: ${failure.error}`);
    if (failure.expected !== null || failure.actual !== null) {
      lines.push(lang === 'ar'
        ? `   المتوقَّع: ${failure.expected ?? '—'}، الفعلي: ${failure.actual ?? '—'}${failure.operator ? ` (${failure.operator})` : ''}`
        : `   Expected: ${failure.expected ?? '—'}, actual: ${failure.actual ?? '—'}${failure.operator ? ` (${failure.operator})` : ''}`);
    } else if (failure.comparison) lines.push(`   ${failure.comparison.split('\n').join(' ')}`);
    if (failure.origin) lines.push(lang === 'ar' ? `   مصدره: ${where(failure.origin)}` : `   Raised at: ${where(failure.origin)}`);
  });
  return lines;
}

function checkAnswer(result: CodingCheckResult, name: string, lang: Lang): { text: string; status: CodeReadAnswer['status']; ok: boolean; evidence: string } {
  const { report, diagnostics, receipt } = result;
  const ar = lang === 'ar';
  const project = ar ? `«${name}»` : `"${name}"`;
  const counts = report.counts;
  const unchanged = ar ? 'لم يتغيّر شيء في المشروع.' : 'Nothing in the project changed.';
  const evidence = `${receipt.provider}: exit ${receipt.exitCode ?? 'none'}${receipt.timedOut ? ', timed out' : ''}; tests ${counts ? `${counts.pass}/${counts.tests} passed` : 'not counted'}; network ${receipt.network}; snapshot ${receipt.snapshotHash.slice(0, 12)}`;
  if (report.status === 'timed_out') return { status: 'blocked', ok: false, evidence, text: ar
    ? `شغّلت فحوص ${project} في نسخة معزولة بلا شبكة، لكنها لم تنتهِ خلال المهلة، فلا أعرف نتيجتها. ${unchanged}`
    : `I ran the checks of ${project} in an isolated copy with no network, but they did not finish within the time limit, so their result is unknown. ${unchanged}` };
  const tally = counts ? (ar ? ` نجح ${counts.pass} وفشل ${counts.fail} من أصل ${counts.tests}${counts.skipped ? `، وتُخطّي ${counts.skipped}` : ''}.`
    : ` ${counts.pass} passed and ${counts.fail} failed out of ${counts.tests}${counts.skipped ? `; ${counts.skipped} skipped` : ''}.`) : '';
  if (report.status === 'passed') return { status: 'completed', ok: true, evidence, text: ar
    ? `شغّلت فحوص ${project} مرة واحدة في نسخة معزولة بلا شبكة، ونجحت كلها.${tally} ${unchanged}`
    : `I ran the checks of ${project} once in an isolated copy with no network, and they all passed.${tally} ${unchanged}` };
  const parts = [ar ? `شغّلت فحوص ${project} مرة واحدة في نسخة معزولة بلا شبكة، وفشلت.${tally} ${unchanged}`
    : `I ran the checks of ${project} once in an isolated copy with no network, and they failed.${tally} ${unchanged}`];
  if (report.failures.length) {
    parts.push('', ar ? 'الاختبارات الفاشلة:' : 'Failing tests:', ...failureLines(report.failures, lang));
    if (report.omittedFailures) parts.push(ar ? `وفشل ${report.omittedFailures} غيرها لم أعرضها.` : `${report.omittedFailures} more failed; not shown.`);
  }
  if (report.syntax.length) parts.push('', ar ? 'أخطاء الصياغة:' : 'Syntax errors:',
    ...report.syntax.map(item => `- ${item.location ? `${where(item.location)} — ` : ''}${item.message}`));
  if (report.typecheck.length) parts.push('', ar ? 'أخطاء فحص الأنواع (tsc):' : 'Type check errors (tsc):',
    ...report.typecheck.map(item => `- ${where(item)} — ${item.message} (${item.code})`));
  if (diagnostics.length) parts.push('', ar ? 'تشخيص TypeScript للملفات نفسها، دون تشغيل:' : 'TypeScript diagnostics for the same files, without running anything:',
    ...diagnostics.map(item => `- ${where(item)} — ${item.message} (${item.code})`));
  const explained = report.failures.length + report.syntax.length + report.typecheck.length > 0;
  if (!explained && report.unparsed) parts.push('', ar ? 'لم أستطع قراءة سبب الفشل من المخرجات. آخر ما طبعته الفحوص:' : 'I could not read the cause from the output. The last lines the checks printed:',
    '```text', report.unparsed, '```');
  if (diagnostics.length || report.typecheck.length) parts.push('', ar
    ? `قد تصلح أدوات الإصلاح المؤكد هذا التشخيص: اطلب «أصلح ${name}» وسأعرض التعديل عليك للموافقة قبل تشغيله.`
    : `The proven-fix tools may fix this diagnostic: ask "fix ${name}" and I will show you the change for approval before it runs.`);
  return { text: parts.join('\n'), status: explained || diagnostics.length ? 'completed' : 'partial', ok: true, evidence };
}

function searchAnswer(result: ProjectSearchResult, name: string, lang: Lang): { text: string; evidence: string } {
  const ar = lang === 'ar';
  const project = ar ? `«${name}»` : `"${name}"`;
  const term = ar ? `«${result.query}»` : `"${result.query}"`;
  const evidence = `search "${result.query.slice(0, 60)}": ${result.total} lines in ${result.files} files, ${result.matches.length} shown, ${result.masked} masked, ${result.pathMatches.length} paths`;
  const named = result.pathMatches.length ? (ar ? `ملفات يطابق مسارها ${term}: ${result.pathMatches.map(code).join('، ')}.` : `Files whose path matches ${term}: ${result.pathMatches.map(code).join(', ')}.`) : null;
  if (!result.total) return { evidence, text: named
    ? (ar ? `لم أجد ${term} داخل ملفات ${project} المحفوظة في Git. ${named}` : `I did not find ${term} inside the committed files of ${project}. ${named}`)
    : (ar ? `لم أجد ${term} في ملفات ${project} المحفوظة في Git.` : `I did not find ${term} in the committed files of ${project}.`) };
  const parts = [ar
    ? `وجدت ${term} في ${project}: ${countAr(result.total, LINES)} في ${countAr(result.files, FILES)}، من الملفات المحفوظة في Git${result.wholeWord ? '، بالكلمة كاملة' : ''}.`
    : `I found ${term} in ${project}: ${countEn(result.total, 'line')} in ${countEn(result.files, 'file')} of the committed files${result.wholeWord ? ', as a whole word' : ''}.`, '',
  ...result.matches.map(match => `- ${code(`${match.path}:${match.line}`)} — ${code(match.text)}`)];
  const hidden = result.total - result.matches.length - result.masked;
  if (hidden > 0) parts.push(ar ? `وعرضت أول ${result.matches.length} فقط.` : `Only the first ${result.matches.length} are shown.`);
  if (result.masked) parts.push(ar ? `وأخفيت ما يشبه كلمات سر أو مفاتيح: ${countAr(result.masked, LINES)}.` : `Hidden because they look like a password or key: ${countEn(result.masked, 'line')}.`);
  if (named) parts.push('', named);
  return { evidence, text: parts.join('\n') };
}

function importsAnswer(result: ImportsLookup, intent: Extract<CodeReadIntent, { kind: 'imports' }>, name: string, lang: Lang): { text: string; status: CodeReadAnswer['status']; evidence: string } {
  const ar = lang === 'ar';
  const project = ar ? `«${name}»` : `"${name}"`;
  if (result.kind === 'none') return { status: 'blocked', evidence: `no file matches "${intent.reference.slice(0, 60)}"`,
    text: ar ? `لم أجد ملفًا باسم ${code(intent.reference)} بين ملفات ${project} المحفوظة.` : `No committed file of ${project} matches ${code(intent.reference)}.` };
  if (result.kind === 'ambiguous') return { status: 'blocked', evidence: `${result.paths.length} files match "${intent.reference.slice(0, 60)}"`,
    text: ar ? `أي ملف تقصد؟ ${result.paths.map(code).join('، ')}. أعد الطلب بمسار الملف كاملًا.` : `Which file do you mean? ${result.paths.map(code).join(', ')}. Ask again with the full path.` };
  const { target, imports, importedBy } = result.relations;
  const evidence = `${target}: imports ${imports.length}, imported by ${importedBy.length}`;
  if (intent.direction === 'importers') return { status: 'completed', evidence, text: importedBy.length
    ? [ar ? `الملفات التي تستورد ${code(target)} في ${project}، من الملفات المحفوظة في Git:` : `Files in ${project} that import ${code(target)}, from the committed files:`,
      ...importedBy.map(item => `- ${code(item.path)} (${ar ? 'عبر' : 'via'} ${code(item.specifier)})`)].join('\n')
    : ar ? `لا يستورد أي ملف في ${project} الملف ${code(target)}.` : `No file in ${project} imports ${code(target)}.` };
  return { status: 'completed', evidence, text: imports.length
    ? [ar ? `يستورد ${code(target)} في ${project}:` : `${code(target)} in ${project} imports:`,
      ...imports.map(item => item.path ? `- ${code(item.specifier)} ← ${code(item.path)}` : `- ${code(item.specifier)} — ${ar ? 'وحدة مدمجة أو حزمة خارج المشروع' : 'a built-in module or a package outside the project'}`)].join('\n')
    : ar ? `الملف ${code(target)} لا يستورد شيئًا.` : `${code(target)} imports nothing.` };
}

const READ_FAILURES: Record<string, Record<Lang, string>> = {
  SANDBOX_UNAVAILABLE: { ar: 'بيئة العزل غير متاحة هنا، فلم أشغّل أي كود. تعمل الفحوص في تطبيق سطح المكتب على Windows.', en: 'The isolated sandbox is not available here, so no code ran. The checks run in the desktop app on Windows.' },
  DIRTY_PROJECT: { ar: 'في المشروع تغييرات غير محفوظة في Git، وأنا أقرأ وأفحص النسخة المحفوظة فقط. احفظ تغييراتك (commit) ثم أعد الطلب.', en: 'The project has changes not committed to Git, and I read and check only the committed version. Commit your changes, then ask again.' },
  PROJECT_HEAD_CHANGED: { ar: 'تغيّر آخر commit في المشروع منذ تسجيله. حدّث تسجيل المشروع من قسم «مشاريع البرمجة» ثم أعد الطلب.', en: 'The project\'s latest commit changed since it was registered. Update its registration in the Coding Projects section, then ask again.' },
};

/** A read the owner asked of a named registered project, answered from the committed files or one sandbox run; null when not this path's. */
export async function answerNoModelCodeRead(request: string, work: AssistantTools['work'], ownerId: string, signal: AbortSignal,
    progress: (label: string) => Promise<void>): Promise<CodeReadAnswer | null> {
  if (!work?.inventory || !READ_CUE.test(foldProjectText(request))) return null;
  const target = chooseCodingProject(request, await work.inventory(ownerId));
  if (target.kind !== 'project' || !target.named) return null;
  const { name, id: projectId } = target.project;
  const intent = recognizeCodeRead(request, name);
  if (!intent || (intent.kind !== 'check' && (!work.codeSearch || !work.codeImports))) return null;
  const lang = requestLanguage(request, name), ar = lang === 'ar';
  const check = intent.kind === 'check';
  const label = check ? (ar ? `تشغيل فحوص «${name}» في نسخة معزولة` : `Running the checks of "${name}" in an isolated copy`)
    : intent.kind === 'search' ? (ar ? `البحث في ملفات «${name}»` : `Searching the files of "${name}"`)
      : (ar ? `قراءة استيرادات «${name}»` : `Reading the imports of "${name}"`);
  const step = (ok: boolean, evidence: string): CodeReadAnswer['step'] => ({ id: check ? 'code-check' : 'code-read', capability: check ? 'code.check' : 'code.read', label, ok, evidence });
  const action = check ? `code_check ${name}` : intent.kind === 'search' ? `code_search ${name}` : `code_imports ${name}`;
  try {
    if (check && !work.codeCheck) throw new BrowserError('SANDBOX_UNAVAILABLE', READ_FAILURES.SANDBOX_UNAVAILABLE!.ar, 503);
    await progress(label);
    if (check) {
      const answer = checkAnswer(await work.codeCheck!(ownerId, projectId, signal), name, lang);
      return { text: answer.text, status: answer.status, step: step(answer.ok, answer.evidence), trail: { action, result: answer.evidence } };
    }
    if (intent.kind === 'search') {
      const answer = searchAnswer(await work.codeSearch!(ownerId, projectId, intent.query), name, lang);
      return { text: answer.text, status: 'completed', step: step(true, answer.evidence), trail: { action, result: answer.evidence } };
    }
    const answer = importsAnswer(await work.codeImports!(ownerId, projectId, intent.reference), intent, name, lang);
    return { text: answer.text, status: answer.status, step: step(answer.status === 'completed', answer.evidence), trail: { action, result: answer.evidence } };
  } catch (error) {
    if (!(error instanceof BrowserError)) throw error;
    const reason = READ_FAILURES[error.code]?.[lang] ?? error.message;
    const text = (ar ? `لم أكمل ${check ? 'فحص' : 'قراءة'} «${name}»: ` : `I could not ${check ? 'check' : 'read'} "${name}": `) + reason;
    return { text, status: 'blocked', step: step(false, error.code), trail: { action, result: `failed: ${error.code}` } };
  }
}

/** The run ledger's record of one read: a step settled from its own outcome, with the evidence it rests on. */
export function recordCodeRead(ledger: RunLedger, answer: CodeReadAnswer, at: number): void {
  const { step } = answer;
  const checkStep = step.capability === 'code.check';
  if (!ledger.plan?.steps.some(item => item.id === step.id)) appendStep(ledger, planStep({ id: step.id, capability: step.capability, outcome: step.label, input: null,
    acceptance: [checkStep ? 'The sandbox receipt proves isolation for the files sent' : 'Read from the project\'s committed files'] }), at);
  startStep(ledger, step.id, at);
  tryEnterPhase(ledger, 'executing', at);
  settleStep(ledger, step.id, step.ok ? 'verified' : 'failed', at);
  addEvidence(ledger, { stepId: step.id, kind: checkStep ? 'adapter_report' : 'readback', label: step.evidence.slice(0, 200), independent: false }, at);
}
