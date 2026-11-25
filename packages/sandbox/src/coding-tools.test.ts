import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { lintConfig, prepareLintCommand, prepareTsxCheck, stageCodingTool, type SandboxLintInput } from './coding-tools.ts';
import { WindowsAppContainerSandbox } from './index.ts';

const input = (configPath: string, content: string, formatting = false): SandboxLintInput => ({
  files: [{ path: configPath, content }, { path: 'src/math.mjs', content: 'let value = 3\nexport { value }\n' }],
  configPath,
  fixFiles: ['src/math.mjs'],
  formatting,
});

describe('sandbox coding tools', () => {
  it.each([
    ['eslint.config.mjs', 'export default [{ rules: { "prefer-const": "error" } }];', true],
    ['eslint.config.cjs', 'module.exports = [{ rules: { "prefer-const": "error" } }];', true],
    ['.eslintrc.json', '{"extends":"eslint:recommended","rules":{"prefer-const":"error"}}', false],
    ['package.json', '{"eslintConfig":{"rules":{"prefer-const":"error"}}}', false],
  ])('reads trusted data from %s without evaluating it', (path, content, flat) => {
    expect(lintConfig(input(path, content))).toEqual({ source: expect.stringContaining('prefer-const'), flat });
  });

  it.each([
    ['eslint.config.mjs', 'import path from "node:path"; export default [];'],
    ['eslint.config.cjs', 'module.exports = { rules: resolveRules() };'],
    ['eslint.config.mjs', 'export default [{ languageOptions: { parser: "custom" } }];'],
    ['eslint.config.mjs', 'export default [{ plugins: {} }];'],
    ['eslint.config.mjs', 'export default [{ rules: { "prefer-const": "error" } };'],
    ['.eslintrc.json', '{"overrides":[{"files":"*.js","extends":"./untrusted.cjs"}]}'],
  ])('rejects unsupported configuration in %s', (path, content) => {
    expect(() => lintConfig(input(path, content))).toThrow(expect.objectContaining({ code: 'ESLINT_CONFIG_UNSUPPORTED' }));
  });

  it('stages only installed tools and supplies fixed lint arguments without spawning a host tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mohassan-coding-tools-'));
    try {
      const tools = join(root, 'tools');
      const manifest = 'export default [{ rules: { "prefer-const": "error" } }];';
      const work = join(root, 'work');
      const args = await prepareLintCommand(tools, work, input('eslint.config.mjs', manifest));
      expect(args.slice(2)).toEqual(['true', '--no-config-lookup', '--config', join(tools, 'eslint.config.cjs'), '--fix', '--fix-type', 'problem,suggestion', '--exit-on-fatal-error', '--', './src/math.mjs']);
      await expect(readFile(args[1], 'utf8')).resolves.toContain('ESLint');
      const formatted = await prepareLintCommand(join(root, 'format'), work, input('eslint.config.mjs', manifest, true));
      expect(formatted).toContain('problem,suggestion,layout');
      const typescript = await stageCodingTool(tools, 'typescript');
      await expect(readFile(join(typescript, 'bin', 'tsc'), 'utf8')).resolves.toContain('../lib/tsc.js');
      const tsx = await prepareTsxCheck(tools, typescript, ['src/main.tsx']);
      expect(tsx.slice(1)).toEqual([join(typescript, 'lib', 'typescript.js'), './src/main.tsx']);
      const source = await readFile(tsx[0], 'utf8');
      expect(source).toContain('ts.transpileModule');
      expect(() => new Script(source)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects out-of-snapshot typecheck projects, JSON checks, and lint targets before execution', async () => {
    const sandbox = new WindowsAppContainerSandbox();
    const files = [{ path: 'math.test.mjs', content: 'test' }];
    await expect(sandbox.run({ files, testFiles: ['math.test.mjs'], typecheck: { project: '../tsconfig.json' } })).rejects.toThrow('TypeScript');
    await expect(sandbox.run({ files, testFiles: ['math.test.mjs'], jsonFiles: ['data.json'] })).rejects.toThrow('JSON');
    await expect(sandbox.lintFix({ files, fixFiles: ['../other.mjs'], configPath: 'eslint.config.mjs', formatting: false })).rejects.toThrow('ESLint');
    expect(sandbox.probeEvidence).toBeUndefined();
  });
});
