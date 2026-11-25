import { z } from 'zod';
import { includesLiteral, normalizedNumber } from '../score.js';
import { Mapping, type ImportResult } from './mapping.js';

const localOnly = ['search', 'read', 'open', 'unexpected_fetch'];
const noWebClaim = ['I searched the web', 'بحثت في الويب'];
const gsm8kRow = z.object({ question: z.string(), answer: z.string() });
const mbppRow = z.object({
  task_id: z.number().int().positive(),
  prompt: z.string(),
  code: z.string(),
  test_list: z.array(z.string()).min(1),
  test_imports: z.array(z.string()),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function importGsm8k(raw: string): ImportResult {
  const mapping = new Mapping('gsm8k');
  for (const [index, line] of raw.trimEnd().split(/\r?\n/u).entries()) {
    const row = gsm8kRow.safeParse(parseJson(line));
    if (!row.success) {
      mapping.drop('invalid-row');
      continue;
    }
    const { question, answer } = row.data;
    if (!question.trim() || question.length > 4000) {
      mapping.drop('invalid-prompt');
      continue;
    }
    const finalLine = answer.trimEnd().split(/\r?\n/u).at(-1);
    const finalAnswer = finalLine?.match(/^####[ \t]+(.+)$/u)?.[1];
    const number = finalAnswer === undefined ? null : normalizedNumber(finalAnswer);
    if (number === null) {
      mapping.drop('missing-numeric-answer');
      continue;
    }
    const key = String(index + 1);
    mapping.accept(key, key, {
      area: 'calculation',
      language: 'en',
      variety: 'english',
      turns: [{
        text: question,
        expect: {
          route: ['compute'],
          requiredTools: ['calculate'],
          forbiddenTools: localOnly,
          questionCount: 0,
          status: ['completed'],
          requiredContent: [{ match: 'number', anyOf: [number] }],
          forbiddenContent: noWebClaim,
          maxSteps: 2,
        },
      }],
    });
  }
  return mapping.result();
}

function commonEntryPoint(code: string, tests: readonly string[]): string | undefined {
  const calls = tests.map(test => /^assert\s+([A-Za-z_]\w*)\s*\(/u.exec(test)?.[1]);
  const [entryPoint] = calls;
  if (!entryPoint || calls.some(call => call !== entryPoint)) {
    return undefined;
  }
  // Inspect the published reference as text. The scorer checks the public function declaration only.
  const definitions = code.matchAll(/^def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gmu);
  return Array.from(definitions).some(definition => definition[1] === entryPoint) ? entryPoint : undefined;
}

export function importMbpp(raw: string): ImportResult {
  const rows = parseJson(raw);
  if (!Array.isArray(rows)) throw new Error('Invalid MBPP source artifact.');
  const mapping = new Mapping('mbpp');
  for (const row of rows) {
    const parsed = mbppRow.safeParse(row);
    if (!parsed.success) {
      mapping.drop('invalid-row');
      continue;
    }
    const { task_id: taskId, prompt, code, test_list: tests, test_imports: imports } = parsed.data;
    // The edited subset inherits the original test split from the MBPP release.
    if (taskId < 11 || taskId > 510) {
      mapping.drop('non-test-split');
      continue;
    }
    if (imports.length) {
      mapping.drop('test-needs-imports');
      continue;
    }
    const entryPoint = commonEntryPoint(code, tests);
    if (!entryPoint) {
      mapping.drop('no-direct-entry-point');
      continue;
    }
    const text = `${prompt}\n\nYour code should pass these tests:\n${tests.join('\n')}`;
    if (!prompt.trim() || text.length > 4000) {
      mapping.drop('invalid-prompt');
      continue;
    }
    const declarations = [`def ${entryPoint}(`, `def ${entryPoint} (`];
    if (declarations.some(declaration => includesLiteral(text, declaration))) {
      mapping.drop('signature-present-in-prompt');
      continue;
    }
    mapping.accept(String(taskId), prompt.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase(), {
      area: 'coding',
      language: 'en',
      variety: 'english',
      turns: [{
        text,
        expect: {
          route: ['coding'],
          forbiddenTools: localOnly,
          questionCount: 0,
          status: ['completed'],
          requiredContent: [{ match: 'literal', anyOf: declarations }],
          forbiddenContent: noWebClaim,
          maxSteps: 5,
        },
      }],
    });
  }
  return mapping.result();
}
