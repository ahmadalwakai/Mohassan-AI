import { Worker } from 'node:worker_threads';
import type { EditOptions } from './edit.ts';
import { PdfError } from './errors.ts';
import { PDF_LIMITS } from './limits.ts';

interface EditRequest {
  op: string;
  inputs: Uint8Array<ArrayBuffer>[];
  params: Record<string, unknown>;
}

interface WorkerSlot {
  worker: Worker;
  // A slot stays busy until the reply arrives or its failed worker has exited.
  fail?: (error: PdfError) => void;
  crashed?: boolean;
}

const workers = new Set<WorkerSlot>();
const editFailed = () => new PdfError('PDF_EDIT_FAILED', 'تعذر تعديل ملف PDF.', 500);
const editAborted = () => new PdfError('PDF_EDIT_ABORTED', 'أُلغي تعديل PDF.', 409);

function acquireWorker(): WorkerSlot {
  for (const slot of workers) {
    if (!slot.fail && !slot.crashed) return slot;
  }
  if (workers.size >= PDF_LIMITS.workers) {
    throw new PdfError('PDF_EDIT_BUSY', 'معالجة الملفات مشغولة؛ أعد المحاولة بعد قليل.', 429);
  }

  const worker = new Worker(new URL('./edit-worker.mjs', import.meta.url), {
    workerData: { limits: { pages: PDF_LIMITS.pages, outputBytes: PDF_LIMITS.outputBytes } },
    execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
  });
  const slot: WorkerSlot = { worker };
  workers.add(slot);
  worker.on('error', () => {
    slot.crashed = true;
    slot.fail?.(new PdfError('PDF_EDIT_FAILED', 'تعذر تعديل PDF ضمن حدود الموارد.', 500));
  });
  worker.once('exit', () => {
    workers.delete(slot);
    slot.fail?.(new PdfError('PDF_EDIT_FAILED', 'توقفت معالجة PDF قبل اكتمالها.', 500));
  });
  return slot;
}

export async function postPdfEdit(request: EditRequest, { signal, timeoutMs }: EditOptions): Promise<unknown> {
  if (signal?.aborted) throw editAborted();
  const slot = acquireWorker();
  const { worker } = slot;
  const timeout = Math.max(1, Math.min(PDF_LIMITS.editTimeoutMs, Math.floor(timeoutMs ?? PDF_LIMITS.editTimeoutMs)));
  let terminate = false;
  worker.ref();
  try {
    // Each slot has at most one request in flight, so a response belongs to its current edit.
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: PdfError | null, message?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.off('message', receive);
        worker.off('messageerror', messageError);
        if (error) reject(error);
        else resolve(message);
      };
      const fail = (error: PdfError) => {
        if (settled) return;
        terminate = true;
        finish(error);
      };
      const abort = () => fail(editAborted());
      const receive = (message: unknown) => finish(null, message);
      const messageError = () => fail(editFailed());
      const timer = setTimeout(() => fail(new PdfError('PDF_EDIT_TIMEOUT', 'تجاوز تعديل PDF المهلة المسموحة.', 504)), timeout);
      slot.fail = fail;
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', receive);
      worker.once('messageerror', messageError);
      try {
        worker.postMessage(request, request.inputs.map(copy => copy.buffer));
      } catch {
        fail(editFailed());
      }
    });
  } finally {
    if (terminate) {
      // Hold the slot until exit, so cancelled or timed-out work stops before we replace it.
      await worker.terminate().catch(() => {});
      workers.delete(slot);
    } else {
      slot.fail = undefined;
      worker.unref();
    }
  }
}
