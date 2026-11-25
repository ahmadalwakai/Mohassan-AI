import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { BrainState } from '../brain.js';
import { parseTestDrivenCodingRequest, testDrivenCodingEnabled, type TestDrivenCodingRequest } from './request.js';

const worker = fileURLToPath(new URL('./worker.py', import.meta.url));
const maxConcurrentWorkers = 2;
let activeWorkers = 0;

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('passed'), source: z.string().min(1).max(10_000) }),
  z.object({
    status: z.literal('failed'), reason: z.string(),
    assertionIndex: z.number().int().nonnegative().max(1_000).optional(), tried: z.number().int().nonnegative().optional(),
  }),
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
]);
type Result = z.infer<typeof resultSchema>;
type Reply = { status: 'completed' | 'blocked'; text: string };
const unavailable: Result = { status: 'unavailable', reason: 'isolation-unavailable' };

function requestHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function bindTestDrivenCodingHash(state: Pick<BrainState, 'routing' | 'requestOriginalHash'>, acceptedText: string): void {
  if (state.routing?.handler === 'local_coding' && state.requestOriginalHash) {
    state.requestOriginalHash = requestHash(acceptedText);
  }
}

function runWorker(request: TestDrivenCodingRequest, cwd: string, signal: AbortSignal): Promise<Result> {
  return new Promise(resolve => {
    const child = execFile('python3', ['-I', '-B', '-S', worker], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      timeout: 2_500,
      maxBuffer: 32 * 1024,
      killSignal: 'SIGKILL',
      signal,
    }, (error, stdout) => {
      if (error) {
        if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ status: 'failed', reason: 'verification-limit' });
        } else {
          resolve(unavailable);
        }
        return;
      }
      try {
        const parsed = resultSchema.safeParse(JSON.parse(stdout));
        resolve(parsed.success ? parsed.data : unavailable);
      } catch {
        resolve(unavailable);
      }
    });
    // A failed spawn or cancelled worker can close stdin before consuming the request.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ mode: 'solve', ...request }));
  });
}

export async function answerTestDrivenCoding(
  text: string, options: { authorized: boolean; signal: AbortSignal; originalHash: string | undefined; scrub: (text: string) => string },
): Promise<Reply> {
  const request = parseTestDrivenCodingRequest(text);
  const ar = /\p{Script=Arabic}/u.test(request?.description ?? text);
  const blocked = (en: string, arabic: string): Reply => ({ status: 'blocked', text: ar ? arabic : en });
  const unavailableReply = () => blocked(
    'I can’t verify Python assertions in an isolated process in this session.',
    'يتعذر عليّ التحقق من اختبارات بايثون داخل عملية معزولة في هذه المحادثة.',
  );
  if (!options.authorized) return blocked(
    'Verified Python execution is unavailable to this account.',
    'تنفيذ بايثون للتحقق من الاختبارات غير متاح لهذا الحساب.',
  );
  if (!testDrivenCodingEnabled() || process.platform !== 'linux' || options.signal.aborted) return unavailableReply();
  // The chat controller binds the accepted, trimmed input before applying redaction.
  if (requestHash(text) !== options.originalHash) return blocked(
    'I couldn’t verify the original assertion text. Please resend the description and assertions with example data.',
    'تعذر التحقق من نص الاختبارات الأصلي. أعد إرسال الوصف والاختبارات ببيانات تجريبية.',
  );
  if (!request) return blocked(
    'Please include the Python function description and its assertions in one message.',
    'أرسل وصف دالة بايثون واختباراتها في رسالة واحدة.',
  );
  if (activeWorkers >= maxConcurrentWorkers) return blocked(
    'The Python verification processes are busy. Please try again shortly.',
    'عمليات التحقق من بايثون مشغولة. حاول بعد قليل.',
  );

  let cwd: string | undefined;
  let result: Result;
  activeWorkers++;
  try {
    cwd = await mkdtemp(join(tmpdir(), 'mohassan-python-'));
    result = await runWorker(request, cwd, options.signal);
  } catch {
    return unavailableReply();
  } finally {
    activeWorkers--;
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
  if (result.status === 'unavailable' || options.signal.aborted) return unavailableReply();
  if (result.status === 'passed') {
    const intro = ar ? 'اجتازت الدالة جميع الاختبارات المرفقة.' : 'The function passed all supplied assertions.';
    const fence = '```';
    const reply = `${intro}\n\n${fence}python\n${result.source.trimEnd()}\n${fence}`;
    // The controller redacts stored replies. Withhold anything that would change
    // the verified source or could be interpreted as a closing Markdown fence.
    if (result.source.includes(fence) || options.scrub(reply) !== reply) return unavailableReply();
    return { status: 'completed', text: reply };
  }

  const index = result.assertionIndex === undefined ? null : result.assertionIndex + 1;
  if (result.tried) {
    const failure = index === null ? 'No candidate passed the full assertion block.' : `The closest candidate failed assertion ${index}.`;
    const failureAr = index === null ? 'لم يجتز أي منها جميع الاختبارات.' : `أخفق أقرب حل في الاختبار رقم ${index}.`;
    return blocked(
      `I ran the supplied assertions against ${result.tried} candidate implementations. ${failure} Please share more examples or details about the expected behavior.`,
      `شغّلت الاختبارات المرفقة على ${result.tried} من الحلول الممكنة. ${failureAr} أرسل أمثلة إضافية أو تفاصيل عن السلوك المطلوب.`,
    );
  }
  if (result.reason.endsWith('-limit')) return blocked(
    'I tried to synthesize a function and verify the assertions, but verification reached its resource limit. Please share a smaller example or more details.',
    'حاولت توليد دالة والتحقق منها، لكن التحقق بلغ حد الموارد. أرسل مثالًا أصغر أو تفاصيل إضافية.',
  );
  if (result.reason === 'no-candidate-passed') return blocked(
    'I searched the available Python operations and found no implementation that passed the supplied examples. Please share more examples or details.',
    'بحثت بين عمليات بايثون المتاحة ولم أجد حلاً يجتاز الأمثلة المرفقة. أرسل أمثلة إضافية أو تفاصيل عن السلوك المطلوب.',
  );
  if (result.reason === 'no-supported-examples') return blocked(
    'I parsed the assertions but couldn’t extract example inputs and outputs. Please share an example using a direct function call and an expected value.',
    'حللت الاختبارات لكن تعذر استخراج المدخلات والنتائج منها. أرسل مثالاً يستدعي الدالة مباشرةً ويحدد النتيجة المتوقعة.',
  );
  return blocked(
    `I tried to parse the supplied assertions${index === null ? '' : ` and could not use assertion ${index}`}. Please share examples with explicit inputs and expected outputs.`,
    `حاولت تحليل الاختبارات المرفقة${index === null ? '' : ` وتعذر استخدام الاختبار رقم ${index}`}. أرسل أمثلة بمدخلات ونتائج متوقعة صريحة.`,
  );
}
