import { randomUUID } from 'node:crypto';
import { CodingError } from '@mohassan/coding';
import { codingDeviceFailureText } from '@mohassan/coding-link/failures';
import { RegisterProjectSchema, type ChatApproval, type ChatQuestion } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { createCodingControl } from '../coding.js';
import type { BrainState } from './brain.js';
import type { RunLedger } from './agent-run.js';
import { checkPermission, consumePermission, requestPermission, type ActionMaterial } from './permission-gate.js';
import { gateRefusalText } from './run-plans.js';

export type CodeProjectsPort = Pick<Awaited<ReturnType<typeof createCodingControl>>, 'projects' | 'inspect' | 'register'>;

type Language = 'ar' | 'en';
type ProjectRequest = { name: string; path: string };
type Selection = ProjectRequest & { lang: Language; baseCommit: string; allowedPaths: string[] };
type FileQuestion = Selection & { phase: 'files'; candidates: string[]; offset: number; trailLength: number };
type RegistrationApproval = Selection & { phase: 'approval'; approvalId: string };

type ChatState = BrainState & { codeProjectsChat?: FileQuestion | RegistrationApproval };
interface ChatContext {
  request: string;
  state: ChatState;
  ownerId: string;
  id: string;
  runId: string;
  signal: AbortSignal;
  port?: CodeProjectsPort;
  ledger(): RunLedger;
  checkpoint(): Promise<void>;
  transaction<T>(work: (tx: Kysely<any>) => Promise<T>): Promise<T>;
  ownerAccess(): Promise<void>;
  lockOwner(tx: Kysely<any>): Promise<boolean>;
  scrub(text: string): string;
  pause(status: 'waiting_user' | 'waiting_approval', fields: Record<string, unknown>, text: string): Promise<void>;
  finish(text: string, status: 'completed' | 'blocked'): Promise<void>;
}

const MAX_EDITABLE_FILES = 5;
const PAGE_SIZE = 3;
const ProjectRequestSchema = RegisterProjectSchema.omit({ allowedPaths: true });
const quotedValue = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|`[^`\\r\\n]+`|«[^»\\r\\n]+»)';
const value = `(${quotedValue}|[^\\r\\n]+?)`;
const arabicRegistration = new RegExp(`^سجّ?ل\\s+مشروع\\s+${value}\\s+باسم\\s+${value}(?:\\s+بالملفات:?\\s+([^\\r\\n]+))?$`, 'u');
const englishRegistration = new RegExp(`^register\\s+project\\s+${value}\\s+as\\s+${value}(?:\\s+with\\s+files:?\\s+([^\\r\\n]+))?$`, 'iu');

const say = (lang: Language, ar: string, en: string) => lang === 'ar' ? ar : en;
const showFiles = (files: readonly string[]) => files.map(path => `\`${path}\``).join(', ');
const unwrap = (text: string) => text.trim().replace(/^(?:"(.*)"|'(.*)'|`(.*)`|«(.*)»)$/u, '$1$2$3$4');

function recognize(request: string) {
  const text = request.trim();
  if (/^ما\s+مشاريعي\s+البرمجية\s*[؟?]?$/u.test(text)) return { kind: 'list', lang: 'ar' } as const;
  if (/^list\s+my\s+coding\s+projects\s*[?.]?$/iu.test(text)) return { kind: 'list', lang: 'en' } as const;
  const ar = arabicRegistration.exec(text);
  const registration = ar ?? englishRegistration.exec(text);
  return registration ? {
    kind: 'register', lang: ar ? 'ar' : 'en', path: unwrap(registration[1]!), name: unwrap(registration[2]!), files: registration[3],
  } as const : null;
}

function refusalReason(error: unknown, lang: Language): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const pathDenied = code === 'PROJECT_OUTSIDE_ROOTS' || code === 'CODING_DEVICE_PATH_DENIED';
  const deviceReason = codingDeviceFailureText(pathDenied ? 'CODING_DEVICE_PATH_DENIED' : code, lang);
  if (deviceReason) {
    // Keep the established project-registration diagnosis available in Arabic too.
    return pathDenied && lang === 'en' ? `${deviceReason} ${codingDeviceFailureText('CODING_DEVICE_PATH_DENIED', 'ar')}` : deviceReason;
  }
  if (error instanceof CodingError) return error.message;
  if (code === 'ENOENT') return say(lang, 'مسار المشروع غير موجود.', 'The project path does not exist.');
  if (code === 'EACCES' || code === 'EPERM') return say(lang, 'تعذرت قراءة مسار المشروع بسبب صلاحيات الوصول.', 'Access to the project path was denied.');
  if (error instanceof Error && (code === 'CODING_NOT_CONFIGURED' || code === 'INVALID_EDIT_SCOPE' || code === 'PROJECT_HEAD_CHANGED')) return error.message;
}

function publish(ctx: ChatContext, text: string, status: 'completed' | 'blocked') {
  delete ctx.state.codeProjectsChat;
  return ctx.finish(ctx.scrub(text), status);
}

async function listProjects(ctx: ChatContext, port: CodeProjectsPort, lang: Language) {
  const projects = await port.projects(ctx.ownerId);
  if (!projects.length) return publish(ctx, say(lang, 'ليست لديك مشاريع برمجية مسجّلة.', 'You have no registered coding projects.'), 'completed');

  const rows: string[] = [];
  for (const project of projects) {
    ctx.signal.throwIfAborted();
    const editable = showFiles(project.allowedPaths);
    let tests: string;
    try {
      const inspection = await port.inspect(project.path, { ownerId: ctx.ownerId, projectId: project.id, signal: ctx.signal });
      tests = showFiles(inspection.testFiles);
      if (inspection.baseCommit !== project.baseCommit) tests += say(lang,
        ' (من HEAD الحالي. تغير HEAD منذ تسجيل المشروع، ويلزم تحديث التسجيل قبل العمل.)',
        ' (From the current HEAD. HEAD changed since registration. Update the registration before working on the project.)');
    } catch (error) {
      const reason = refusalReason(error, lang) ?? say(lang, 'تعذرت قراءة المستودع.', 'The repository could not be read.');
      tests = say(lang, `تعذّر فحص المشروع. ${reason}`, `Could not inspect the project. ${reason}`);
    }
    rows.push(`- **${project.name}**\n  - ${say(lang, 'الملفات القابلة للتعديل', 'Editable files')}: ${editable}\n  - ${say(lang, 'ملفات الاختبار', 'Test files')}: ${tests}`);
  }
  return publish(ctx, [say(lang, 'مشاريعك البرمجية المسجّلة', 'Your registered coding projects'), ...rows].join('\n\n'), 'completed');
}

function readFileSelection(text: string, candidates: readonly string[]): string[] {
  return text.trim().split(/[\s,،]+/u).filter(Boolean).map(value => {
    if (/^\d+$/u.test(value)) return candidates[Number(value) - 1] ?? value;
    return unwrap(value).replace(/\\/g, '/').replace(/^\.\//u, '');
  });
}

function validSelection(selection: Selection, candidates: readonly string[]) {
  const { name, path, allowedPaths } = selection;
  return RegisterProjectSchema.safeParse({ name, path, allowedPaths }).success
    && new Set(allowedPaths).size === allowedPaths.length && allowedPaths.every(file => candidates.includes(file));
}

function askForFiles(ctx: ChatContext, pending: FileQuestion, note?: string) {
  const { lang, candidates, allowedPaths } = pending;
  const remaining = candidates.filter(path => !allowedPaths.includes(path));
  const offset = pending.offset < remaining.length ? pending.offset : 0;
  const options = remaining.slice(offset, offset + PAGE_SIZE).map(path => ({
    id: `file-${candidates.indexOf(path) + 1}`, label: path.length <= 160 ? path : `${path.slice(0, 159)}…`,
  }));
  if (remaining.length > PAGE_SIZE) options.push({ id: 'more-files', label: say(lang, 'ملفات أخرى', 'More files') });
  if (allowedPaths.length) options.push({ id: 'confirm-files', label: say(lang, 'اعتماد الملفات المختارة', 'Confirm selected files') });
  const instructions = say(lang,
    `اختر من ملف واحد إلى 5 ملفات قابلة للتعديل لمشروع «${pending.name}». يمكنك الضغط على الخيارات أو كتابة أسماء الملفات أو أرقامها مفصولة بفواصل.`,
    `Choose 1 to 5 editable files for “${pending.name}”. Use the options or type the file names or numbers separated by commas.`);
  const selected = allowedPaths.length ? say(lang, `الملفات المختارة (${allowedPaths.length} من 5).`, `Selected files (${allowedPaths.length} of 5).`) : '';
  const prompt = ctx.scrub([note, instructions, selected].filter(Boolean).join('\n'));
  const question: ChatQuestion = { id: randomUUID(), prompt, options: options.map(option => ({ ...option, label: ctx.scrub(option.label) })) };
  const listed = candidates.map((path, index) => `${index + 1}. \`${path}\``).join('\n');
  ctx.state.codeProjectsChat = { ...pending, offset, trailLength: ctx.state.trail.length };
  ctx.state.lastChoice = null;
  return ctx.pause('waiting_user', { question: JSON.stringify(question) }, ctx.scrub(`${prompt}\n\n${listed}`));
}

function materialOf(selection: Selection): ActionMaterial {
  const { lang, name, path, baseCommit, allowedPaths } = selection;
  return {
    capability: 'runtime.task', target: path.slice(0, 300),
    details: { operation: 'register coding project', name, path, baseCommit, allowedPaths: JSON.stringify(allowedPaths) },
    action: say(lang, `تسجيل مشروع «${name}»`, `Register coding project “${name}”`),
    consequence: say(lang, 'سيُحفظ تسجيل المشروع ونطاق الملفات المختارة.', 'The project registration and selected file scope will be saved.'),
    reversible: null,
  };
}

function askForApproval(ctx: ChatContext, selection: Selection) {
  const { lang, name, path, allowedPaths, baseCommit } = selection;
  const material = materialOf(selection);
  const approvalId = randomUUID();
  requestPermission(ctx.ledger(), { approvalId, actorId: ctx.ownerId, conversationId: ctx.id, runId: ctx.runId, material, at: Date.now() });
  ctx.state.codeProjectsChat = { phase: 'approval', lang, name, path, allowedPaths, baseCommit, approvalId };
  const prompt = ctx.scrub(say(lang, `هل توافق على تسجيل مشروع «${name}» في «${path}»؟`, `Approve registering coding project “${name}” at “${path}”?`));
  const detail = ctx.scrub(`${say(lang, 'الملفات القابلة للتعديل', 'Editable files')}: ${allowedPaths.join(', ')}\nGit HEAD: ${baseCommit.slice(0, 12)}`);
  const approval: ChatApproval = { id: approvalId, prompt, detail, target: ctx.scrub(material.target), consequence: material.consequence, reversible: null };
  return ctx.pause('waiting_approval', { approval: JSON.stringify(approval) }, prompt);
}

async function resumeFileChoice(ctx: ChatContext, pending: FileQuestion) {
  const answer = ctx.state.trail.at(-1);
  if (ctx.state.trail.length !== pending.trailLength + 1 || answer?.action !== 'asked the user') {
    return publish(ctx, say(pending.lang, 'تعذّر التحقق من إجابة اختيار الملفات.', 'Could not verify the file selection answer.'), 'blocked');
  }
  const choice = ctx.state.lastChoice;
  if (choice === 'more-files') return askForFiles(ctx, { ...pending, offset: pending.offset + PAGE_SIZE });
  if (choice === 'confirm-files') return askForApproval(ctx, pending);

  let allowedPaths: string[];
  if (choice?.startsWith('file-')) {
    const selected = pending.candidates[Number(choice.slice('file-'.length)) - 1];
    allowedPaths = selected ? [...pending.allowedPaths, selected] : [];
  } else {
    // The native text-answer endpoint keeps the full answer in the accepted user message.
    // Its run trail keeps only a prefix, which binds that message to this question response.
    const message = await ctx.transaction(tx => tx.selectFrom('chat_messages').select('text').where('conversation_id', '=', ctx.id)
      .where('role', '=', 'user').orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst());
    const text = message?.text as string | undefined;
    allowedPaths = text && answer.result === `user answered: ${text.slice(0, 400)}` ? readFileSelection(text, pending.candidates) : [];
  }
  const selection = { ...pending, allowedPaths, offset: 0 };
  if (!validSelection(selection, pending.candidates)) {
    return askForFiles(ctx, pending, say(pending.lang, 'اختر ملفات مختلفة من القائمة، بحد أقصى 5.', 'Choose up to 5 distinct files from the list.'));
  }
  if (!choice || allowedPaths.length === MAX_EDITABLE_FILES || allowedPaths.length === pending.candidates.length) return askForApproval(ctx, selection);
  return askForFiles(ctx, selection);
}

async function resumeRegistration(ctx: ChatContext, port: CodeProjectsPort, pending: RegistrationApproval) {
  const { lang, name, path, allowedPaths, baseCommit, approvalId } = pending;
  const ledger = ctx.ledger();
  const decision = checkPermission(ledger, { material: materialOf(pending), actorId: ctx.ownerId, conversationId: ctx.id,
    runId: ctx.runId, actorAllowed: true, platformAllowed: true, approvalId, at: Date.now() });
  if (decision.decision !== 'allow' || decision.record.id !== approvalId) {
    const reason = decision.decision === 'allow' ? 'approval_mismatch' : decision.reason;
    return publish(ctx, gateRefusalText(reason, lang), 'blocked');
  }
  consumePermission(ledger, approvalId, Date.now());
  await ctx.checkpoint();
  try {
    const project = await port.register(ctx.ownerId, { name, path, allowedPaths }, {
      expectedBaseCommit: baseCommit, signal: ctx.signal,
      persist: write => ctx.transaction(async tx => {
        if (!await ctx.lockOwner(tx)) throw new CodingError('PROJECT_FORBIDDEN', gateRefusalText('actor_not_allowed', lang));
        if (Date.now() > Date.parse(decision.record.expiresAt)) throw new CodingError('PROJECT_APPROVAL_EXPIRED', gateRefusalText('approval_expired', lang));
        return write(tx);
      }),
    });
    const result = project.name === name ? say(lang, `سُجّل مشروع «${project.name}».`, `Registered coding project “${project.name}”.`)
      : say(lang, `هذا النطاق مسجّل بالفعل باسم «${project.name}».`, `This scope is already registered as “${project.name}”.`);
    return publish(ctx, `${result}\n${say(lang, 'الملفات القابلة للتعديل', 'Editable files')}: ${showFiles(project.allowedPaths)}`, 'completed');
  } catch (error) {
    const reason = refusalReason(error, lang);
    if (!reason) throw error;
    return publish(ctx, say(lang, `لم يُسجّل المشروع. ${reason}`, `The project was not registered. ${reason}`), 'blocked');
  }
}

export async function handleCodeProjectsChat(ctx: ChatContext): Promise<boolean> {
  const pending = ctx.state.codeProjectsChat;
  const command = recognize(ctx.request);
  if (!pending && (!command || ctx.state.steps || ctx.state.trail.length || ctx.state.pendingTask)) return false;
  const lang = pending?.lang ?? command!.lang;
  const port = ctx.port;
  if (!port) {
    await publish(ctx, say(lang, 'محرك البرمجة غير مجهز.', 'Coding project registration is unavailable.'), 'blocked');
    return true;
  }

  await ctx.ownerAccess();
  if (pending?.phase === 'approval') await resumeRegistration(ctx, port, pending);
  else if (pending) await resumeFileChoice(ctx, pending);
  else if (command?.kind === 'list') await listProjects(ctx, port, lang);
  else if (command?.kind === 'register') {
    const request = ProjectRequestSchema.safeParse({ name: command.name, path: command.path });
    if (!request.success) {
      await publish(ctx, say(lang, 'أدخل مسار المشروع واسماً من حرفين إلى 100 حرف.', 'Provide a project path and a name of 2 to 100 characters.'), 'blocked');
      return true;
    }
    let inspection;
    try { inspection = await port.inspect(request.data.path, { ownerId: ctx.ownerId, signal: ctx.signal }); }
    catch (error) {
      const reason = refusalReason(error, lang);
      if (!reason) throw error;
      await publish(ctx, say(lang, `لم يُسجّل المشروع. ${reason}`, `The project was not registered. ${reason}`), 'blocked');
      return true;
    }
    const candidates = inspection.candidateEditablePaths;
    const selection = { lang, name: request.data.name, path: inspection.path, baseCommit: inspection.baseCommit,
      allowedPaths: command.files ? readFileSelection(command.files, candidates) : [] };
    if (!candidates.length) {
      await publish(ctx, say(lang, 'لم أجد ملفات قابلة للتعديل تسمح بتسجيل المشروع.', 'The project has no eligible editable files to register.'), 'blocked');
    } else if (!command.files) {
      await askForFiles(ctx, { ...selection, phase: 'files', candidates, offset: 0, trailLength: 0 });
    } else if (validSelection(selection, candidates)) {
      await askForApproval(ctx, selection);
    } else {
      await publish(ctx, say(lang, 'اختر من ملف واحد إلى 5 ملفات مختلفة من الملفات القابلة للتعديل.', 'Choose 1 to 5 distinct editable files.'), 'blocked');
    }
  }
  return true;
}
