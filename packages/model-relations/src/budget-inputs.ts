import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mannersDevelopmentCases } from '../../../tests/fixtures/manners-development.js';
import { developmentNow } from '../../../tests/fixtures/reasoning-development.js';
import { wordProblemCases } from '../../../tests/fixtures/reasoning-word-problems.js';
import { arabicRefusals, englishRefusals } from '../../../tests/fixtures/refusal-development.js';
import { budgetProbeTimeoutMs, hashBudgetBytes, type BudgetLanguage } from './budget-receipt.js';
import { monitorDecisionModelId } from './monitor-decision.js';
import type { ResolvedModel } from './registry.js';

export interface BudgetInput {
  input: unknown;
  source: string;
  sourceSha256: string;
  inputSha256: string;
}

const mannersFixture = 'tests/fixtures/manners-development.ts';
const refusalFixture = 'tests/fixtures/refusal-development.ts';
const arithmeticFixture = 'tests/fixtures/reasoning-word-problems.ts';
const slotFixture = 'tests/fixtures/slot-tagger-v1/parity.json';
const ocrFixture = 'apps/android/docs/screenshots/image-done.jpg';
// Fixed source pixel rectangles for the Arabic interface and English prompt, inspected at 29448ae.
const ocrCrops = {
  ar: { left: 90, top: 138, width: 430, height: 187 },
  en: { left: 138, top: 364, width: 346, height: 47 },
};

// Limited generation workload from the two-token inference test in runtime-worker.e2e.test.ts.
const generationSettings = { maxNewTokens: 2, seed: 0 };

async function textFor(root: string, id: string, language: BudgetLanguage) {
  const arabic = language === 'ar';
  if (id === 'arithmetic') {
    const selector = `word-problem-written-operands-${language}`;
    const row = wordProblemCases.find(item => item.id === selector);
    if (!row) throw new Error('Missing arithmetic fixture case.');
    return { file: arithmeticFixture, selector, text: row.request };
  }
  if (id === 'refusal' || id === 'scratch-refusal') {
    const cases = arabic ? arabicRefusals : englishRefusals;
    return { file: refusalFixture, selector: `${arabic ? 'arabic' : 'english'}Refusals.no_capability[0]`, text: cases.no_capability[0] };
  }
  if (id === 'slot-tagger' || id === 'slot-date-place-tagger') {
    const { cases } = JSON.parse(await readFile(join(root, slotFixture), 'utf8')) as { cases: { text: string }[] };
    const index = cases.findIndex(({ text }) => arabic === /\p{Script=Arabic}/u.test(text));
    if (index < 0) throw new Error('Missing slot fixture case.');
    return { file: slotFixture, selector: `cases[${index}].text`, text: cases[index]!.text };
  }
  const group = arabic ? 'standardArabic' : 'english';
  const cases = mannersDevelopmentCases[group];
  const index = id === 'scratch-speech-act' ? 0 : 16;
  return { file: mannersFixture, selector: `${group}[${index}][0]`, text: cases[index]![0] };
}

async function encodeExecutionProbe(root: string, model: ResolvedModel, text: string): Promise<number[]> {
  const pathFor = (role: string) => {
    const artifact = model.artifacts.find(item => item.present && item.role === role);
    if (!artifact) throw new Error('Missing execution probe tokenizer or manifest.');
    return artifact.path;
  };
  const tokenizer = pathFor('tokenizer');
  const manifest = JSON.parse(await readFile(pathFor('manifest'), 'utf8')) as { tokenizer_identity: string };
  const python = resolve(root, process.env.EXECUTOR_PYTHON?.trim() || '.venv-execution/bin/python');
  const payload = { text, tokenizer: { path: tokenizer, sha256: hashBudgetBytes(await readFile(tokenizer)) },
    tokenizerId: `sha256:${manifest.tokenizer_identity}` };
  return new Promise((done, fail) => {
    const child = execFile(python, ['-I', '-B', join(root, 'packages/model-relations/src/encode-input.py'), 'ads-encode'],
      { cwd: root, env: {}, timeout: budgetProbeTimeoutMs, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error) return fail(new Error('Cannot encode the execution probe with its local tokenizer.'));
        try { done(JSON.parse(stdout)); } catch { fail(new Error('Invalid encoded execution probe.')); }
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

export async function prepareProbe(root: string, scratch: string, model: ResolvedModel, language: BudgetLanguage): Promise<BudgetInput> {
  const { id, workerHead } = model.entry;
  if (id === 'ocr' || id.startsWith('ocr-')) {
    const { default: sharp } = await import('sharp');
    const source = await readFile(join(root, ocrFixture));
    const crop = ocrCrops[language];
    const bytes = await sharp(source).extract(crop).png().toBuffer();
    const path = join(scratch, `${language}.png`);
    await writeFile(path, bytes, { mode: 0o600 });
    return { input: { path }, source: `${ocrFixture}#crop(${crop.left},${crop.top},${crop.width},${crop.height})`,
      sourceSha256: hashBudgetBytes(source), inputSha256: hashBudgetBytes(bytes) };
  }
  const { file, selector, text } = await textFor(root, id, language);
  let input: unknown = { text };
  let source = `${file}#${selector}`;
  if (id === monitorDecisionModelId) {
    const { monitorDecisionFeatures } = await import('../../../apps/server/src/monitors/decision/features.js');
    const { buildMonitorContextFrame } = await import('../../../apps/server/src/monitors/decision/frame.js');
    const { frameFeatures, textFeatureIds } = monitorDecisionFeatures(buildMonitorContextFrame({ text, now: developmentNow }));
    input = { frameFeatures, textFeatureIds };
  } else if (id === 'question-edit' || id === 'head-answer-sentence') {
    const group = language === 'ar' ? 'standardArabic' : 'english';
    const cases = mannersDevelopmentCases[group];
    input = { text, candidates: [cases[17]![0], cases[18]![0]] };
    source += `,${group}[17][0],${group}[18][0]`;
  } else if (id.startsWith('reading-') && workerHead === 'lm') {
    input = { prompt: text, ...generationSettings };
  } else if (id === 'execution' || id.startsWith('execution-')) {
    input = { inputIds: await encodeExecutionProbe(root, model, text), ...generationSettings };
  } else if (workerHead === 'lm') {
    input = { text, ...generationSettings };
  }
  return { input, source, sourceSha256: hashBudgetBytes(await readFile(join(root, file))),
    inputSha256: hashBudgetBytes(JSON.stringify(input)) };
}
