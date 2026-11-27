import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerOptions } from 'node:worker_threads';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOcrModelFromBytes, readImage, type ImageReading } from '@mohassan/vision';
import { composeImageReply, contentWords, imageIntent, readingForTrail } from '../apps/server/src/assistant/image-reading.js';
import { createImageReader, ImageReaderUnavailable } from '../apps/server/src/image-reader.js';
import { createTinyOcrModel } from '../packages/vision/src/ocr-test-model.js';

let failStartup: EventEmitter | undefined;

vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: function (source: string, options: WorkerOptions) {
      if (!failStartup) return new actual.Worker(source, options);
      const worker = failStartup;
      failStartup = undefined;
      return Object.assign(worker, { unref() {}, async terminate() { return 0; } });
    },
  };
});

function reading(lines: string[], overrides: Partial<ImageReading> = {}): ImageReading {
  const rtl = lines.some(line => /[؀-ۿ]/u.test(line));
  return {
    facts: { width: 1200, height: 800, format: 'png', orientation: 'landscape', meanBrightness: 230, darkBackground: false, colorfulness: 4, distinctColors: 120, flatShare: 0.8,
      dominant: [{ hex: '#f0f0f0', share: 0.8, name: 'أبيض' }, { hex: '#101010', share: 0.1, name: 'أسود' }], surface: 'graphic' },
    lines: lines.map((text, index) => ({ text, visual: text, confidence: 0.95, box: { x: 10, y: 10 + index * 30, w: 300, h: 20 }, block: 0, row: index, direction: /[؀-ۿ]/u.test(text) ? 'rtl' : 'ltr' })),
    blocks: [lines.join('\n')], text: lines.join('\n'), direction: rtl ? 'rtl' : lines.length ? 'ltr' : 'none', kind: 'screenshot', candidates: lines.length, dropped: 0, durationMs: 12, modelId: 'a'.repeat(64),
    ...overrides,
  };
}

describe('image intents', () => {
  it('recognises the common requests in Arabic and English', () => {
    expect(imageIntent('')).toBe('read');
    expect(imageIntent('اقرأ لي ما في الصورة')).toBe('read');
    expect(imageIntent('ما المكتوب هنا؟')).toBe('read');
    expect(imageIntent('ترجم هذا')).toBe('translate');
    expect(imageIntent('لخص النص')).toBe('summarize');
    expect(imageIntent('كم عدد الكلمات؟')).toBe('count');
    expect(imageIntent('كم السعر في الصورة؟')).toBe('numbers');
    expect(imageIntent('ما هذه الصورة؟')).toBe('describe');
    expect(imageIntent('what does it say?')).toBe('read');
    expect(imageIntent('هل يوجد موعد التسليم؟')).toBe('question');
  });
  it('keeps the content words of a question', () => {
    expect(contentWords('هل يوجد موعد التسليم في الصورة؟')).toEqual(['موعد', 'تسليم']);
    expect(contentWords('what is the delivery date?')).toEqual(['delivery', 'date']);
  });
});

describe('image replies', () => {
  it('returns the read text with line count and confidence', () => {
    const reply = composeImageReply({ request: '', readings: [reading(['السعر 150 ريال', 'التسليم خلال 3 أيام'])] });
    expect(reply.outcome).toBe('read');
    expect(reply.language).toBe('ar');
    expect(reply.text).toContain('عدد الأسطر: 2');
    expect(reply.text).toContain('السعر 150 ريال');
    expect(reply.text).toContain('الثقة عالية');
  });
  it('answers a question from the matching lines first', () => {
    const reply = composeImageReply({ request: 'متى موعد التسليم؟', readings: [reading(['السعر 150 ريال', 'التسليم خلال 3 أيام'])] });
    expect(reply.intent).toBe('question');
    expect(reply.text.indexOf('التسليم خلال 3 أيام')).toBeLessThan(reply.text.indexOf('السعر 150 ريال'));
    expect(reply.text).toContain('بخصوص سؤالك');
  });
  it('lists numbers with their lines', () => {
    const reply = composeImageReply({ request: 'كم السعر؟', readings: [reading(['السعر 150 ريال', 'الخصم 12.5%'])] });
    expect(reply.text).toContain('- 150 ريال');
    expect(reply.text).toContain('- 12.5%');
  });
  it('says plainly that translation needs a model it does not have', () => {
    const reply = composeImageReply({ request: 'ترجم هذا النص', readings: [reading(['Total: $27.95'])] });
    expect(reply.text).toContain('يحتاج نموذج لغة');
    expect(reply.text).toContain('Total: $27.95');
  });
  it('describes an image without text from its facts only', () => {
    const reply = composeImageReply({ request: 'what is this picture?', readings: [reading([], { kind: 'photo', direction: 'none' })] });
    expect(reply.outcome).toBe('no_text');
    expect(reply.language).toBe('en');
    expect(reply.text).toContain('no readable text');
    expect(reply.text).toContain('1200×800');
    expect(reply.text).toContain('do not recognise objects');
  });
  it('numbers several images', () => {
    const reply = composeImageReply({ request: '', readings: [reading(['one']), reading(['اثنان'])] });
    expect(reply.text).toContain('الصورة 1');
    expect(reply.text).toContain('الصورة 2');
  });
  it('gives the brain a short trail note', () => {
    expect(readingForTrail(reading(['Sign in', 'Password']))).toBe('2 text lines read (own OCR): Sign in Password');
    expect(readingForTrail(reading([], { kind: 'photo' }))).toContain('no readable text');
  });
});

describe('server image reader', () => {
  const { modelId, manifestBytes, weightsBytes } = createTinyOcrModel();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mohassan-image-reader-'));
    await Promise.all([writeFile(join(dir, 'manifest.json'), manifestBytes), writeFile(join(dir, 'weights.bin'), weightsBytes)]);
  });
  afterEach(async () => {
    failStartup = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses reads during a worker startup failure, then reads from the recovered pool', async () => {
    const width = 80, height = 40;
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#fff' } }).png().toBuffer();
    const firstWorker = failStartup = new EventEmitter();
    const reader = await createImageReader({ modelDir: dir, workers: 1 });
    try {
      const reading = reader.read(bytes);
      firstWorker.emit('message', { v: 1, type: 'failed', error: 'fixture startup failure' });
      await expect(reading).rejects.toBeInstanceOf(ImageReaderUnavailable);
      await vi.waitFor(async () => {
        expect(await reader.read(bytes)).toMatchObject({ modelId, facts: { width, height, format: 'png' } });
      }, { timeout: 20_000 });
    } finally {
      await reader.close();
    }
  });

  it('keeps the event loop responsive while reading a full page through a ready pool', async () => {
    const lineCount = 120, glyphHeight = 14, rowHeight = 20, margin = 10;
    const width = 1280, height = lineCount * rowHeight + 2 * margin;
    const pixels = new Uint8Array(width * height).fill(255);
    for (let line = 0; line < lineCount; line++) {
      const top = margin + line * rowHeight;
      for (let x = margin; x < 240; x += 12) {
        for (let y = top; y < top + glyphHeight; y++) pixels.fill(0, y * width + x, y * width + x + 8);
      }
    }
    const bytes = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const model = loadOcrModelFromBytes(manifestBytes, weightsBytes);
    const reader = await createImageReader({ modelDir: dir, workers: 1 });
    try {
      await reader.read(bytes);
      await readImage(bytes, { model });
      const baseline = await measureImageRead(() => readImage(bytes, { model }));
      const worker = await measureImageRead(() => reader.read(bytes));
      expect(baseline.reading.candidates).toBe(lineCount);
      // Zero weights decode to blanks. Dropped lines confirm the page reached recognition.
      expect(baseline.reading.dropped).toBe(lineCount);
      expect(worker.reading).toEqual({ ...baseline.reading, durationMs: expect.any(Number) });
      const delayLimitMs = baseline.elapsedMs / 2;
      expect(baseline.maxDelayMs).toBeGreaterThan(delayLimitMs);
      expect(worker.maxDelayMs).toBeLessThan(delayLimitMs);
    } finally {
      await reader.close();
    }
  });
});

async function measureImageRead(read: () => Promise<ImageReading>) {
  const resolution = 5;
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  try {
    // Prime the timer and give the sample that overlaps the last synchronous work time to report.
    await delay(2 * resolution);
    histogram.reset();
    const started = performance.now();
    const reading = await read();
    const elapsedMs = performance.now() - started;
    await delay(2 * resolution);
    expect(histogram.count).toBeGreaterThan(0);
    return { reading, elapsedMs, maxDelayMs: histogram.max / 1_000_000 };
  } finally {
    histogram.disable();
  }
}
