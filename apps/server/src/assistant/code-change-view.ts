import { createHash } from 'node:crypto';
import { credentialLike } from '@mohassan/coding/security';
import { codingDeviceFailureText, codingDeviceTaskFailureText } from '@mohassan/coding-link/failures';
import { CodingResultSchema, type CodingResult, type Task } from '@mohassan/contracts';
import { containsSensitiveCredentialText } from '../sensitive-credential-text.js';
import { foldProjectText, type CodingProjectRef, type CodingReply } from './no-model-coding.js';

interface ChangeViewRuntime {
  latestCodingChange?(ownerId: string, projectId: string): Promise<Pick<Task, 'id' | 'status' | 'result' | 'error'> | null>;
}

interface ChangeViewCoding {
  available: boolean;
  verify?(raw: unknown, context: { taskId: string; ownerId: string; projectId: string; signal: AbortSignal }): Promise<CodingResult | null>;
}

interface SavedChangeView {
  status: Task['status'];
  result: CodingResult | null;
  reverified: boolean;
  taskError?: string | null;
  verificationError?: unknown;
}

/** Reads the Runtime's committed result and checks it against the review worktree when it is available. */
export function readCodeChangeView(runtime: ChangeViewRuntime, coding: ChangeViewCoding) {
  return async (ownerId: string, projectId: string, signal: AbortSignal): Promise<SavedChangeView | null> => {
    signal.throwIfAborted();
    const task = await runtime.latestCodingChange?.(ownerId, projectId);
    if (!task) return null;
    const parsed = CodingResultSchema.safeParse(task.result);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.branch !== `mohassan/${task.id}`
        || !parsed.data.sourceUnchanged || createHash('sha256').update(parsed.data.diff).digest('hex') !== parsed.data.diffHash) {
      return { status: task.status, result: null, reverified: false, taskError: task.error };
    }
    const saved = parsed.data;
    if (coding.available && coding.verify) {
      try {
        const verified = await coding.verify(saved, { taskId: task.id, ownerId, projectId, signal });
        signal.throwIfAborted();
        if (verified) return { status: task.status, result: verified, reverified: true };
      } catch (error) {
        signal.throwIfAborted();
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        return { status: task.status, result: saved, reverified: false, verificationError: code };
      }
    }
    return { status: task.status, result: saved, reverified: false };
  };
}

interface ChangeViewWork {
  inventory?(ownerId: string): Promise<CodingProjectRef[]>;
  codeChangeView?: ReturnType<typeof readCodeChangeView>;
}

const AR_REQUEST = /^اعرض (?:لي )?التعديل (?:الاخير|الاحدث) في (.+)$/u;
const EN_REQUEST = /^(?:please )?show (?:me )?the (?:last|latest) change in (.+)$/u;
const MAX_DIFF_LINES = 120;
const REVIEW_BRANCH = /^mohassan\/[a-f0-9-]{36}$/iu;
const GIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

function scrubLine(line: string, ar: boolean): string {
  return credentialLike(line) || containsSensitiveCredentialText(line)
    ? (ar ? '[سطر مخفي لأنه يشبه بيانات اعتماد]' : '[hidden: looks like a credential]') : line;
}

function displayDiff(diff: string, ar: boolean): string[] {
  const lines = diff.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  const preview = lines.slice(0, MAX_DIFF_LINES).map(line => {
    const safe = scrubLine(line, ar);
    // The chat renderer treats a trimmed triple backtick as the closing fence, including in a context line.
    return safe.trimStart().startsWith('```') ? `\u200b${safe}` : safe;
  });
  return [ar ? '**الفرق**' : '**Diff**', '```diff', ...preview, '```', ...(lines.length > MAX_DIFF_LINES
    ? ['', ar ? 'اقتُطع عرض الفرق بعد أول 120 سطرًا.' : 'Diff truncated after 120 lines.'] : [])];
}

function describeChange(view: SavedChangeView, project: string, ar: boolean): CodingReply & { evidence: string } {
  const { status, result, reverified } = view;
  const lang = ar ? 'ar' : 'en';
  const title = ar ? `آخر تعديل في «${project}»` : `Last change in "${project}"`;
  const unchanged = ar ? 'لم يُدمج شيء.' : 'Nothing was merged.';
  if (!result) {
    const outcome = status === 'failed' ? (ar ? 'فشلت مهمة التعديل.' : 'The change task failed.')
      : status === 'cancelled' ? (ar ? 'أُلغيت مهمة التعديل.' : 'The change task was cancelled.') : '';
    const missing = ar ? 'لا توجد نتيجة متحقَّق منها لهذه المهمة.' : 'There is no verified result for this task.';
    const reason = codingDeviceTaskFailureText(view.taskError ?? null, lang);
    return { text: [title, '', outcome, reason, missing, unchanged].filter(Boolean).join('\n'), status: 'partial', evidence: `task ${status}, no verified coding result` };
  }
  const outcome = result.outcome === 'ready_for_review' ? (ar ? 'النتيجة المحفوظة جاهزة للمراجعة.' : 'The saved result is ready for review.')
    : result.outcome === 'tests_failed' ? (ar ? 'فشلت الاختبارات بعد التعديل.' : 'Tests failed after the change.')
      : (ar ? 'لم يجتز التعديل المراجعة المستقلة.' : 'The change did not pass independent review.');
  const verification = reverified ? (ar ? 'أعدت التحقق من النتيجة المحفوظة.' : 'Re-verified the saved result.')
    : (ar ? 'تعذّر إعادة التحقق من النتيجة المحفوظة.' : 'The saved result could not be re-verified.');
  const checkpoint = result.checkpoint;
  const mergeable = status === 'completed' && result.outcome === 'ready_for_review' && checkpoint
    && GIT_HASH.test(checkpoint) && REVIEW_BRANCH.test(result.branch);
  const parts = [title, '', outcome, verification];
  const verificationFailure = codingDeviceFailureText(view.verificationError, lang);
  if (verificationFailure) parts.push(verificationFailure);
  if (mergeable) parts.push('', ar ? `فرع المراجعة: \`${result.branch}\`` : `Review branch: \`${result.branch}\``);
  if (result.changes.length) parts.push('', ar ? '**الملفات المعدّلة (قبل ← بعد)**' : '**Changed files (before → after)**',
    ...result.changes.map(({ path, beforeHash, afterHash }) => scrubLine(`- \`${path}\`: \`${beforeHash.slice(0, 12)}\` → \`${afterHash.slice(0, 12)}\``, ar)));
  if (result.diff) parts.push('', ...displayDiff(result.diff, ar));
  parts.push('', unchanged);
  if (mergeable) parts.push(ar
    ? 'للدمج يدويًا، افتح مستودع المشروع على الفرع الذي تريد الدمج فيه. تأكد من نظافة مجلد العمل، ثم ادمج نقطة المراجعة المحفوظة:'
    : 'To merge manually, open the project repository on the target branch. Confirm the working tree is clean, then merge the saved review commit:',
  '```sh', 'git status --short', `git merge --ff-only -- ${checkpoint}`, '```');
  return { text: parts.join('\n'), status: mergeable && reverified ? 'completed' : 'partial', evidence: `task ${status}, ${result.outcome}, ${reverified ? 're-verified' : 'saved result'}` };
}

/** Only the explicit show command is accepted, with a complete registered project name. */
export async function answerCodeChangeView(request: string, work: ChangeViewWork | undefined, ownerId: string, signal: AbortSignal,
    authorize: () => Promise<void>): Promise<(CodingReply & { evidence: string }) | null> {
  if (!work?.inventory || !work.codeChangeView) return null;
  const folded = foldProjectText(request);
  const arabic = AR_REQUEST.exec(folded);
  const name = (arabic ?? EN_REQUEST.exec(folded))?.[1];
  if (!name) return null;
  const ar = Boolean(arabic);
  await authorize();
  signal.throwIfAborted();
  const projects = await work.inventory(ownerId);
  const matches = (value: string) => projects.filter(project => foldProjectText(project.name) === value);
  let named = matches(name);
  if (!named.length) named = matches(name.replace(/^(?:مشروع|project) /u, ''));
  if (named.length > 1) return { status: 'blocked', evidence: 'ambiguous project', text: ar
    ? 'هناك أكثر من مشروع برمجة مسجّل بهذا الاسم.' : 'More than one registered coding project has that name.' };
  const project = named[0];
  if (!project) return { status: 'blocked', evidence: 'no registered project', text: ar
    ? 'لا توجد مهمة تعديل. لم أجد مشروع برمجة مسجّلًا بهذا الاسم.' : 'No change task was found. There is no registered coding project with that name.' };
  const view = await work.codeChangeView(ownerId, project.id, signal);
  const displayName = scrubLine(project.name, ar);
  return view ? describeChange(view, displayName, ar) : { status: 'completed', evidence: 'no coding change task', text: ar
    ? `لا توجد مهمة تعديل في «${displayName}».` : `No change task was found for "${displayName}".` };
}
