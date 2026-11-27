import { BrowserError } from '@mohassan/browser';
import type { CodeReadAnswer, CodingProjectRef } from './no-model-coding.js';
import type { AssistantTools } from './tools.js';

type Lang = 'ar' | 'en';
type ReadInstructions = NonNullable<NonNullable<AssistantTools['work']>['codeInstructions']>;
interface InstructionsRequest { name: string; lang: Lang }

export function recognizeInstructionsRequest(request: string, folded: string): InstructionsRequest | null {
  if (!/^\p{L}/u.test(request.trimStart())) return null;
  const arabic = /^ما تعليمات (مشروع .+)$/u.exec(folded);
  if (arabic) return { name: arabic[1]!, lang: 'ar' };
  const english = /^show (?:the )?instructions of (.+)$/u.exec(folded);
  return english ? { name: english[1]!, lang: 'en' } : null;
}

export async function answerProjectInstructions(request: InstructionsRequest, project: CodingProjectRef, foldedName: string,
    read: ReadInstructions | undefined, ownerId: string, signal: AbortSignal, progress: (label: string) => Promise<void>): Promise<CodeReadAnswer | null> {
  const ar = request.lang === 'ar';
  if (!read || (request.name !== foldedName && !(ar && request.name === `مشروع ${foldedName}`))) return null;
  const name = ar ? `«${project.name}»` : `"${project.name}"`;
  const label = ar ? `قراءة تعليمات ${name}` : `Reading the instructions of ${name}`;
  const action = `code_instructions ${project.name}`;
  const answer = (text: string, status: 'completed' | 'blocked', evidence: string): CodeReadAnswer => ({
    text, status, step: { id: 'code-read', capability: 'code.read', label, ok: status === 'completed', evidence }, trail: { action, result: evidence },
  });
  try {
    signal.throwIfAborted();
    await progress(label);
    const instructions = await read(ownerId, project.id);
    signal.throwIfAborted();
    if (!instructions) return answer(ar ? `لا يوجد ملف تعليمات محفوظ في Git للمشروع ${name}.`
      : `There is no instructions file committed to Git for ${name}.`, 'completed', 'no committed instructions file');
    const { notes, protectedGlobs, warnings } = instructions;
    const globs = protectedGlobs.map(glob => `- \`${glob}\``);
    const text = [ar ? `تعليمات ${name} المحفوظة في Git` : `Instructions committed to Git for ${name}`, '',
      ar ? 'أنماط المسارات المحمية' : 'Protected path globs',
      ...(globs.length ? globs : [ar ? 'لا توجد أنماط مسجّلة.' : 'No globs are listed.']), '',
      ar ? 'ملاحظات المشروع' : 'Project notes',
      ...(notes ? notes.split('\n').map(line => `> ${line}`) : [ar ? 'لا توجد ملاحظات.' : 'No notes are listed.'])];
    if (warnings.length) text.push('', ...(ar ? warnings : ['Some invalid protection globs were ignored.']));
    return answer(text.join('\n'), 'completed', `committed instructions: ${protectedGlobs.length} globs, ${notes.length} note characters, ${warnings.length} warnings`);
  } catch (error) {
    if (!(error instanceof BrowserError)) throw error;
    return answer(ar ? `تعذّرت قراءة تعليمات ${name}. ${error.message}`
      : `I could not read the instructions of ${name}. ${error.message}`, 'blocked', `failed: ${error.code}`);
  }
}

export async function projectNotesLine(read: ReadInstructions | undefined, ownerId: string, projectId: string, lang: Lang,
    baseCommit?: string): Promise<string> {
  if (!read) return '';
  try {
    const instructions = await read(ownerId, projectId, baseCommit);
    const notes = instructions?.notes.replace(/\s+/gu, ' ').trim();
    if (!notes) return '';
    const preview = notes.length <= 400 ? notes : `${notes.slice(0, 399).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()}…`;
    return `\n${lang === 'ar' ? 'ملاحظات المشروع' : 'Project notes'} — ${preview}`;
  } catch (error) {
    if (!(error instanceof BrowserError)) throw error;
    return '';
  }
}
