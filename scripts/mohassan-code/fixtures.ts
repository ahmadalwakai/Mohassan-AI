import { mkdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../../packages/coding/src/git.ts';

// P5 keeps the real refusal from each execution location and checks its full English reply.
export const projectOutsideRootsReplies = {
  local: 'The project was not registered. The project is outside the allowed folders.',
  device: 'The project was not registered. The project is outside the folders allowed on your PC. Add its folder from Allowed project folders… in the Mohassan tray menu on the PC, then try again.',
} as const;

export async function configureModelFreeMeasurement(checkout: string, directory: string) {
  // Do not load the owner's configuration, local models, or optional shadow classifiers.
  process.env.MOHASSAN_ISOLATED_TEST = 'true';
  process.env.VITEST = 'true';
  process.env.MOHASSAN_SCRATCH_CLASSIFIERS = '0';
  process.env.MOHASSAN_ARITHMETIC_SEARCH = '0';
  process.env.MOHASSAN_REFUSAL_POLICY = '0';
  process.env.MOHASSAN_MODEL_COUNCIL = 'off';
  process.env.MOHASSAN_MODELS_ROOT = directory;
  process.env.MOHASSAN_OCR_MODEL_DIR = join(directory, 'unused-ocr');
  const assistant = pathToFileURL(join(checkout, 'apps/server/src/assistant') + '/').href;
  // Use the same fixture-only module hook as scripts/response-policy/development-bench.mjs.
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith(assistant)) return result;
    const path = result.url.slice(assistant.length);
    if (path === 'refusal/learned-model.json' || path === 'arithmetic-search-model.json') {
      throw new Error('The measurement must not load learned weights');
    }
    const stub = path === 'refusal/learned-classifier.ts' ? 'classifyLearnedRefusal'
      : path === 'arithmetic-search-ranker.ts' ? 'selectArithmeticCandidate' : null;
    return stub ? { url: `data:text/javascript,export const ${stub} = () => null; export const weightFree = true;`, shortCircuit: true } : result;
  } });
  for (const file of ['refusal/learned-classifier.ts', 'arithmetic-search-ranker.ts']) {
    const stub = await import(new URL(file, assistant).href);
    if (stub.weightFree !== true) throw new Error(`Could not disable the learned module ${file}`);
  }
}

interface Fixture {
  id: string;
  name: string;
  allowedPaths: readonly string[];
  files: Readonly<Record<string, string>>;
}

function manifest(id: string, testFile: string, otherScripts: Record<string, string> = {}): string {
  return JSON.stringify({ name: `mohassan-eval-${id}`, private: true, type: 'module',
    scripts: { test: `node --test ${testFile}`, ...otherScripts } }, null, 2) + '\n';
}

function nodeTest(source: string, symbol: string, name: string, expression: string, expected: number): string {
  return [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    `import { ${symbol} } from "../${source}";`,
    `test("${name}", () => assert.equal(${expression}, ${expected}));`,
    '',
  ].join('\n');
}

export const fixtures: readonly Fixture[] = [
  {
    id: 'missing-import', name: 'Import Bench', allowedPaths: ['src/answer.ts'],
    files: {
      'package.json': manifest('missing-import', 'test/answer.test.mjs'),
      'src/answer.ts': 'export const answer = () => answerValue;\n',
      'src/values.mjs': 'export const answerValue = 42;\n',
      'test/answer.test.mjs': nodeTest('src/answer.ts', 'answer', 'returns the expected answer', 'answer()', 42),
    },
  },
  {
    id: 'misspelled-identifier', name: 'Spelling Bench', allowedPaths: ['src/sum.ts'],
    files: {
      'package.json': manifest('misspelled-identifier', 'test/sum.test.mjs'),
      'src/sum.ts': 'export function sum(leftHandValue: number, rightHandValue: number) {\n  return leftHandValue + rightHandVaule;\n}\n',
      'test/sum.test.mjs': nodeTest('src/sum.ts', 'sum', 'adds positive values', 'sum(2, 3)', 5),
    },
  },
  {
    id: 'eslint', name: 'Lint Bench', allowedPaths: ['src/lint.mjs'],
    files: {
      'package.json': manifest('eslint', 'test/lint.test.mjs'),
      'eslint.config.mjs': 'export default [{ rules: { "no-extra-boolean-cast": "error" } }];\n',
      'src/lint.mjs': 'export function lintValue() {\n  if (!!true) return 42;\n}\n',
      'test/lint.test.mjs': nodeTest('src/lint.mjs', 'lintValue', 'returns the linted value', 'lintValue()', 42),
    },
  },
  {
    id: 'logic', name: 'Logic Bench', allowedPaths: ['src/discount.mjs'],
    files: {
      'package.json': manifest('logic', 'test/discount.test.mjs'),
      'src/discount.mjs': 'export function discountedPrice(price, discount) {\n  return price + discount;\n}\n',
      'test/discount.test.mjs': nodeTest('src/discount.mjs', 'discountedPrice', 'subtracts the discount', 'discountedPrice(10, 2)', 8),
    },
  },
  {
    id: 'tsx', name: 'Typecheck Bench', allowedPaths: ['src/label.tsx'],
    files: {
      'package.json': manifest('tsx', 'test/label.test.mjs', { typecheck: 'tsc --noEmit -p tsconfig.json' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', jsx: 'preserve', allowJs: true, types: [] },
        include: ['src'] }, null, 2) + '\n',
      'src/label.tsx': 'export const label: number = "ready";\nimport { value } from "./value.mjs";\nexport const fallback = value;\n',
      'src/value.mjs': 'export const value = 42;\n',
      // TSX is checked by tsc. The native Node test only loads the shared JavaScript module.
      'test/label.test.mjs': nodeTest('src/value.mjs', 'value', 'reads the label value', 'value', 42),
    },
  },
];

type RegisterFixture = (project: { name: string; path: string; allowedPaths: string[] }) => Promise<{ statusCode: number }>;

/** The callback posts this payload to the same coding registration service used by the demo route. */
export async function registerFixtures(directory: string, register: RegisterFixture): Promise<void> {
  const root = join(directory, 'fixtures');
  await mkdir(root);
  for (const fixture of fixtures) {
    const path = join(root, fixture.id);
    await mkdir(path);
    await git(path, ['init', '--initial-branch=main', '--template=', '.']);
    // As with the demo, commit the raw bytes so checkout settings cannot make the fixture dirty.
    for (const [relativePath, content] of Object.entries(fixture.files)) {
      const file = join(path, ...relativePath.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, { flag: 'wx' });
      const blob = (await git(path, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).stdout.trim();
      await git(path, ['update-index', '--add', '--cacheinfo', '100644', blob, relativePath]);
    }
    const tree = (await git(path, ['write-tree'])).stdout.trim();
    const commit = (await git(path, ['commit-tree', tree, '-m', `Evaluation fixture: ${fixture.id}`], { deterministicDate: true })).stdout.trim();
    await git(path, ['update-ref', 'refs/heads/main', commit]);
    const { statusCode } = await register({ name: fixture.name, path, allowedPaths: [...fixture.allowedPaths] });
    if (statusCode !== 200) throw new Error(`Could not register ${fixture.name}: HTTP ${statusCode}`);
  }
}
