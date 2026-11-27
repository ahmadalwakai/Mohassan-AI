import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Worker as NodeWorker } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pdfInfo, rotatePages, setPdfMetadata } from './edit.ts';

const workers = vi.hoisted(() => [] as NodeWorker[]);
vi.mock(import('node:worker_threads'), async importOriginal => {
  const { Worker } = await importOriginal();
  return {
    Worker: class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        workers.push(this);
      }
    },
  };
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
});

async function makePdf(title: string, pages = 1): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(title);
  for (let index = 0; index < pages; index++) document.addPage();
  return document.save();
}

describe('reused PDF edit workers', () => {
  it('runs concurrent edits and reuses a worker without carrying document state', async () => {
    const [source, otherSource] = await Promise.all([makePdf('First'), makePdf('Second', 2)]);
    const metadata = setPdfMetadata(source, { title: 'Edited', author: 'First author' });
    const rotation = rotatePages(otherSource, 90, [2]);
    const overCapacity = expect(pdfInfo(source)).rejects.toMatchObject({ code: 'PDF_EDIT_BUSY' });
    const [titled, rotated] = await Promise.all([metadata, rotation].map(async result => PDFDocument.load(await result)));
    await overCapacity;

    expect(titled.getTitle()).toBe('Edited');
    expect(titled.getAuthor()).toBe('First author');
    expect(titled.getPageCount()).toBe(1);
    expect(rotated.getTitle()).toBe('Second');
    expect(rotated.getAuthor()).toBeUndefined();
    expect(rotated.getPages().map(page => page.getRotation().angle)).toEqual([0, 90]);
    expect(workers).toHaveLength(2);

    await expect(pdfInfo(source)).resolves.toMatchObject({ title: 'First', author: null, pages: 1 });
    expect(workers).toHaveLength(2);
  });

  it('replaces a worker that exits while an edit is in flight', async () => {
    const source = await makePdf('After exit');
    await pdfInfo(source);
    const worker = workers[0];
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => { void worker.terminate(); });

    await expect(pdfInfo(source)).rejects.toMatchObject({ code: 'PDF_EDIT_FAILED' });
    expect(worker.threadId).toBe(-1);
    await expect(pdfInfo(source)).resolves.toMatchObject({ title: 'After exit', pages: 1 });
    expect(workers).toHaveLength(2);
  });

  it('replaces a worker when an edit exceeds its own deadline', async () => {
    const source = await makePdf('After timeout');
    await pdfInfo(source);
    const worker = workers[0];
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => {});

    await expect(pdfInfo(source, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'PDF_EDIT_TIMEOUT' });
    expect(worker.threadId).toBe(-1);
    await expect(pdfInfo(source)).resolves.toMatchObject({ title: 'After timeout', pages: 1 });
    expect(workers).toHaveLength(2);
  });

  it('terminates cancelled work and uses a fresh worker for the next edit', async () => {
    const source = await makePdf('After cancellation');
    await pdfInfo(source);
    const worker = workers[0];
    const send = vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => {});
    const controller = new AbortController();

    const cancelled = expect(pdfInfo(source, { signal: controller.signal })).rejects.toMatchObject({ code: 'PDF_EDIT_ABORTED' });
    controller.abort();
    await cancelled;
    expect(send).toHaveBeenCalledOnce();
    expect(worker.threadId).toBe(-1);
    await expect(pdfInfo(source)).resolves.toMatchObject({ title: 'After cancellation', pages: 1 });
    expect(workers).toHaveLength(2);
  });

  it('lets Node exit naturally after successive edits', async () => {
    const source = await makePdf('Original');
    const editModule = new URL('./edit.ts', import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--experimental-transform-types', '--input-type=module', '--eval', `
        import { pdfInfo, setPdfMetadata } from ${JSON.stringify(editModule)};
        const source = Buffer.from(process.argv[1], 'base64');
        const edited = await setPdfMetadata(source, { title: 'Edited' });
        console.log((await pdfInfo(edited)).title);
      `, Buffer.from(source).toString('base64'),
    ], { timeout: 10_000 });

    expect(stdout.trim()).toBe('Edited');
  });

  it('typically completes the second edit faster by at least 10 percent', async () => {
    const source = await makePdf('Timing');
    const metadata = { title: 'Edited' };
    const ratios = [];
    for (let sample = 0; sample < 5; sample++) {
      const coldStart = performance.now();
      await setPdfMetadata(source, metadata);
      const warmStart = performance.now();
      await setPdfMetadata(source, metadata);
      ratios.push((performance.now() - warmStart) / (warmStart - coldStart));
      await workers.at(-1)!.terminate();
    }

    // Compare the median of paired edits so a scheduler pause does not decide the result.
    expect(ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)]).toBeLessThan(0.9);
    expect(workers).toHaveLength(ratios.length);
  });
});
