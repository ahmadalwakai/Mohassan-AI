import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { BrainState } from '../brain.js';
import { parseTestDrivenCodingRequest, testDrivenCodingEnabled, type TestDrivenCodingRequest } from './request.js';

const worker = fileURLToPath(new URL('./worker.py', import.meta.url));
const pythonArgs = ['-I', '-B', '-S'];
const maxConcurrentWorkers = 2;
const workerWallMs = 2_500;
const accountCooldownMs = 250;
const busyAccounts = new Set<string>();
let activeWorkers = 0;
let interpreter: { configured: string; validated: Promise<string | null> } | undefined;

const failureReason = z.enum([
  'unsupported-candidate', 'assertion-failed', 'assertion-error', 'time-limit', 'output-limit', 'memory-limit',
  'no-supported-examples', 'no-candidate-passed', 'invalid-request', 'invalid-assertions', 'unsupported-assertion', 'unsupported-arguments',
  'internal-error',
]);
const searchLimit = z.enum(['search-wall-time', 'search-cpu-time', 'search-evaluations', 'search-verifications']);
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('passed'), source: z.string().min(1).max(10_000) }),
  z.object({
    status: z.literal('failed'), reason: failureReason,
    assertionIndex: z.number().int().nonnegative().max(1_000).optional(), tried: z.number().int().nonnegative().optional(),
    searchLimit: searchLimit.optional(), exampleTimeout: z.literal(true).optional(),
  }),
  z.object({ status: z.literal('unavailable'), reason: z.literal('isolation-unavailable') }),
]);
type WorkerResult = z.infer<typeof resultSchema>;
type WorkerExit = 'worker-wall-time' | 'worker-output-limit' | 'worker-start-failed' | 'worker-exit' | 'worker-signal'
  | 'invalid-worker-response' | 'cancelled';
type Result = WorkerResult | { status: 'worker-error'; reason: WorkerExit };
export interface CodingVerification {
  reason: z.infer<typeof failureReason> | WorkerExit | 'passed' | 'unauthorized' | 'disabled' | 'unsupported-platform'
    | 'request-hash-mismatch' | 'busy' | 'workspace-unavailable' | 'isolation-unavailable' | 'publication-withheld';
  searchLimit?: z.infer<typeof searchLimit>;
  exampleTimeout?: true;
}
type Reply = { status: 'completed' | 'blocked'; text: string; verification: CodingVerification };

export function publishTestDrivenCoding(state: Pick<BrainState, 'codingVerification'>, reply: Reply,
  finish: (text: string, status: Reply['status']) => Promise<void>): Promise<void> {
  state.codingVerification = reply.verification;
  return finish(reply.text, reply.status);
}

function requestHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function bindTestDrivenCodingHash(state: Pick<BrainState, 'routing' | 'requestOriginalHash'>, acceptedText: string): void {
  if (state.routing?.handler === 'local_coding' && state.requestOriginalHash) {
    state.requestOriginalHash = requestHash(acceptedText);
  }
}

async function isReadOnlyForService(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return false;
  } catch (error) {
    return ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

async function validateInterpreter(configured: string): Promise<string | null> {
  if (!isAbsolute(configured)) return null;
  try {
    const python = await realpath(configured);
    const executable = await stat(python);
    if (!executable.isFile() || executable.uid !== 0 || (executable.mode & 0o6000) !== 0 || !await isReadOnlyForService(python)) return null;
    // Keep the validated executable out of paths the service can replace.
    for (let dir = dirname(python); ; dir = dirname(dir)) {
      const directory = await stat(dir);
      if (directory.uid === process.geteuid?.() || !await isReadOnlyForService(dir)) return null;
      if (dir === dirname(dir)) break;
    }
    const supported = await new Promise<boolean>(resolve => {
      execFile(python, [...pythonArgs, '-c', 'import sys; print(*sys.version_info[:2])'], {
        env: {}, timeout: workerWallMs, maxBuffer: 128, killSignal: 'SIGKILL',
      }, (error, stdout) => {
        const version = /^(\d+) (\d+)\n$/u.exec(stdout);
        resolve(!error && !!version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 11)));
      });
    });
    return supported ? python : null;
  } catch {
    return null;
  }
}

export async function initializeTestDrivenCoding(): Promise<string | null> {
  if (!testDrivenCodingEnabled() || process.platform !== 'linux' || process.geteuid?.() === 0) return null;
  const configured = process.env.TEST_DRIVEN_CODING_PYTHON ?? '/usr/bin/python3';
  if (configured !== interpreter?.configured) interpreter = { configured, validated: validateInterpreter(configured) };
  return interpreter.validated;
}

function runWorker(python: string, request: TestDrivenCodingRequest, cwd: string, signal: AbortSignal, timeout: number): Promise<Result> {
  return new Promise(resolve => {
    const child = execFile(python, [...pythonArgs, worker], {
      cwd,
      env: {},
      timeout,
      maxBuffer: 32 * 1024,
      killSignal: 'SIGKILL',
      signal,
    }, (error, stdout) => {
      if (error) {
        const reason = signal.aborted ? 'cancelled'
          : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'worker-output-limit'
          : error.killed ? 'worker-wall-time' : error.signal ? 'worker-signal'
          : typeof error.code === 'string' ? 'worker-start-failed' : 'worker-exit';
        resolve({ status: 'worker-error', reason });
        return;
      }
      try {
        const parsed = resultSchema.safeParse(JSON.parse(stdout));
        resolve(parsed.success ? parsed.data : { status: 'worker-error', reason: 'invalid-worker-response' });
      } catch {
        resolve({ status: 'worker-error', reason: 'invalid-worker-response' });
      }
    });
    // A failed spawn or cancelled worker can close stdin before consuming the request.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ mode: 'solve', ...request }));
  });
}

export async function answerTestDrivenCoding(
  text: string, options: { accountId: string; authorized: boolean; signal: AbortSignal; originalHash: string | undefined; scrub: (text: string) => string },
): Promise<Reply> {
  const request = parseTestDrivenCodingRequest(text);
  const ar = /\p{Script=Arabic}/u.test(request?.description ?? text);
  let retriedLimit: 'search-cpu-time' | undefined;
  const blocked = (verification: CodingVerification, en: string, arabic: string): Reply => ({ status: 'blocked', text: ar ? arabic : en, verification });
  const unavailableReply = (reason: CodingVerification['reason']) => blocked({ reason, ...(retriedLimit && { searchLimit: retriedLimit }) },
    'I can’t verify Python assertions in an isolated process in this session.',
    'يتعذر عليّ التحقق من اختبارات بايثون داخل عملية معزولة في هذه المحادثة.',
  );
  const limitReply = (verification: CodingVerification) => blocked(verification,
    'I tried to synthesize a function and verify the assertions, but verification reached its resource limit. Please share a smaller example or more details.',
    'حاولت توليد دالة والتحقق منها، لكن التحقق بلغ حد الموارد. أرسل أمثلة أصغر أو تفاصيل إضافية.',
  );
  if (!options.authorized) return blocked({ reason: 'unauthorized' },
    'Verified Python execution is unavailable to this account.',
    'تنفيذ بايثون للتحقق من الاختبارات غير متاح لهذا الحساب.',
  );
  if (!testDrivenCodingEnabled()) return unavailableReply('disabled');
  if (process.platform !== 'linux') return unavailableReply('unsupported-platform');
  if (process.geteuid?.() === 0) return unavailableReply('isolation-unavailable');
  if (options.signal.aborted) return unavailableReply('cancelled');
  // The chat controller binds the accepted, trimmed input before applying redaction.
  if (requestHash(text) !== options.originalHash) return blocked({ reason: 'request-hash-mismatch' },
    'I couldn’t verify the original assertion text. Please resend the description and assertions with example data.',
    'تعذر التحقق من نص الاختبارات الأصلي. أعد إرسال الوصف والاختبارات ببيانات تجريبية.',
  );
  if (!request) return blocked({ reason: 'invalid-request' },
    'Please include the Python function description and its assertions in one message.',
    'أرسل وصف دالة بايثون واختباراتها في رسالة واحدة.',
  );
  if (activeWorkers >= maxConcurrentWorkers || busyAccounts.has(options.accountId)) return blocked({ reason: 'busy' },
    'The Python verification processes are busy. Please try again shortly.',
    'عمليات التحقق من بايثون مشغولة. حاول بعد قليل.',
  );

  let cwd: string | undefined;
  let result: Result;
  activeWorkers++;
  busyAccounts.add(options.accountId);
  try {
    const python = await initializeTestDrivenCoding();
    if (options.signal.aborted) return unavailableReply('cancelled');
    if (!python) return unavailableReply('worker-start-failed');
    cwd = await mkdtemp(join(tmpdir(), 'mohassan-python-'));
    const deadline = performance.now() + workerWallMs;
    result = await runWorker(python, request, cwd, options.signal, workerWallMs);
    const remaining = Math.floor(deadline - performance.now());
    // A diagnostic fallback can fail after a search timeout. All attempts share the same wall deadline.
    if (result.status === 'failed' && result.searchLimit === 'search-cpu-time' && !result.exampleTimeout
      && ['assertion-failed', 'assertion-error', 'no-candidate-passed'].includes(result.reason) && !options.signal.aborted && remaining > 0) {
      retriedLimit = result.searchLimit;
      result = await runWorker(python, request, cwd, options.signal, remaining);
    }
  } catch {
    return unavailableReply(options.signal.aborted ? 'cancelled' : cwd ? 'worker-start-failed' : 'workspace-unavailable');
  } finally {
    activeWorkers--;
    setTimeout(() => busyAccounts.delete(options.accountId), accountCooldownMs).unref();
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
  if (options.signal.aborted) return unavailableReply('cancelled');
  if (result.status === 'unavailable') return unavailableReply(result.reason);
  if (result.status === 'worker-error') {
    return result.reason === 'worker-wall-time' || result.reason === 'worker-output-limit'
      ? limitReply({ reason: result.reason, ...(retriedLimit && { searchLimit: retriedLimit }) }) : unavailableReply(result.reason);
  }
  if (result.status === 'failed' && result.reason === 'internal-error') return unavailableReply(result.reason);
  if (result.status === 'passed') {
    const intro = ar ? 'اجتازت الدالة جميع الاختبارات المرفقة.' : 'The function passed all supplied assertions.';
    const fence = '```';
    const reply = `${intro}\n\n${fence}python\n${result.source.trimEnd()}\n${fence}`;
    // The controller redacts stored replies. Withhold anything that would change
    // the verified source or could be interpreted as a closing Markdown fence.
    if (result.source.includes(fence) || options.scrub(reply) !== reply) return unavailableReply('publication-withheld');
    return { status: 'completed', text: reply, verification: { reason: 'passed', ...(retriedLimit && { searchLimit: retriedLimit }) } };
  }

  const index = result.assertionIndex === undefined ? null : result.assertionIndex + 1;
  const stoppedAt = result.searchLimit ?? retriedLimit;
  const verification: CodingVerification = {
    reason: result.reason, ...(stoppedAt && { searchLimit: stoppedAt }),
    ...(result.exampleTimeout && { exampleTimeout: result.exampleTimeout }),
  };
  if (result.tried) {
    const failure = index === null ? 'No candidate passed the full assertion block.' : `The closest candidate failed assertion ${index}.`;
    const failureAr = index === null ? 'لم يجتز أي منها جميع الاختبارات.' : `أخفق أقرب حل في الاختبار رقم ${index}.`;
    return blocked(verification,
      `I ran the supplied assertions against ${result.tried} candidate implementations. ${failure} Please share more examples or details about the expected behavior.`,
      `شغّلت الاختبارات المرفقة على ${result.tried} من الحلول الممكنة. ${failureAr} أرسل أمثلة إضافية أو تفاصيل عن السلوك المطلوب.`,
    );
  }
  if (result.reason.endsWith('-limit')) return limitReply(verification);
  if (result.reason === 'no-candidate-passed') return blocked(verification,
    'I searched the available Python operations and found no implementation that passed the supplied examples. Please share more examples or details.',
    'بحثت بين عمليات بايثون المتاحة ولم أجد حلاً يجتاز الأمثلة المرفقة. أرسل أمثلة إضافية أو تفاصيل عن السلوك المطلوب.',
  );
  if (result.reason === 'no-supported-examples') return blocked(verification,
    'I parsed the assertions but couldn’t extract example inputs and outputs. Please share an example using a direct function call and an expected value.',
    'حللت الاختبارات لكن تعذر استخراج المدخلات والنتائج منها. أرسل مثالاً يستدعي الدالة مباشرةً ويحدد النتيجة المتوقعة.',
  );
  return blocked(verification,
    `I tried to parse the supplied assertions${index === null ? '' : ` and could not use assertion ${index}`}. Please share examples with explicit inputs and expected outputs.`,
    `حاولت تحليل الاختبارات المرفقة${index === null ? '' : ` وتعذر استخدام الاختبار رقم ${index}`}. أرسل أمثلة بمدخلات ونتائج متوقعة صريحة.`,
  );
}
