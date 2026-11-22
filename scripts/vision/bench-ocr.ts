/**
 * Time the own OCR forward pass on synthetic lines, apart from layout and decoding.
 *
 *   npx tsx scripts/vision/bench-ocr.ts [--model artifacts/vision/ocr-v1] [--widths 200,400,800]
 */
import { join } from 'node:path';
import { loadOcrModel, prepareInput, forward } from '../../packages/vision/src/index.ts';

const arg = (name: string, fallback: string) => { const index = process.argv.indexOf(name); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; };

async function main() {
  const model = await loadOcrModel(arg('--model', process.env.MOHASSAN_OCR_MODEL_DIR ?? join(process.cwd(), 'artifacts', 'vision', 'ocr-v1')));
  const widths = arg('--widths', '200,400,800').split(',').map(Number);
  for (const width of widths) {
    const pixels = new Uint8Array(32 * width);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7919) % 251;
    const input = prepareInput(model, { pixels, width });
    forward(model, input.data, input.width);
    const runs = 3, started = performance.now(), cpuStart = process.cpuUsage();
    for (let i = 0; i < runs; i++) forward(model, input.data, input.width);
    const ms = (performance.now() - started) / runs, cpu = process.cpuUsage(cpuStart);
    console.log(`  cpu time ${((cpu.user + cpu.system) / 1000 / runs).toFixed(0)} ms per line (wall ${ms.toFixed(0)} ms): ${((cpu.user + cpu.system) / 1000 / runs / ms * 100).toFixed(0)}% of a core`);
    const [c1, c2, c3, c4, c5] = model.channels, w = input.width;
    const macs = c1 * 9 * 32 * w + c2 * c1 * 9 * 16 * (w / 2) + c3 * c2 * 9 * 8 * (w / 4) + c4 * c3 * 9 * 8 * (w / 4) + c5 * c4 * 9 * 4 * (w / 4)
      + (w / 4) * 2 * 3 * model.hidden * (c5 * 2 + model.hidden) + (w / 4) * model.classes.length * 2 * model.hidden;
    console.log(`width ${width}: ${ms.toFixed(0)} ms per line, ${(macs / 1e6).toFixed(0)} M MACs, ${(macs / ms / 1e6).toFixed(0)} M MAC/s`);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
