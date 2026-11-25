import { cp, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { SandboxFile } from './index.ts';
import { safeSandboxPath } from './script.ts';

export interface SandboxTypecheck { project?: string }
export interface SandboxLintInput {
  files: SandboxFile[];
  configPath: string;
  fixFiles: string[];
  formatting: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type Data = null | string | number | boolean | Data[] | { [key: string]: Data };
const isObject = (value: unknown): value is Record<string, Data> => typeof value === 'object' && value !== null && !Array.isArray(value);
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);
const flatKeys = new Set(['name', 'files', 'ignores', 'languageOptions', 'linterOptions', 'rules', 'settings']);
const languageKeys = new Set(['ecmaVersion', 'sourceType', 'globals', 'parserOptions']);
const legacyKeys = new Set(['root', 'env', 'globals', 'parserOptions', 'rules', 'settings', 'ignorePatterns', 'overrides', 'noInlineConfig', 'reportUnusedDisableDirectives', 'extends']);
const legacyOverrideKeys = new Set([...legacyKeys, 'files', 'excludedFiles']);
const legacyPresets = new Set<Data>(['eslint:recommended', 'eslint:all']);
export const lintOutputMaxBytes = 128_000;
export class SandboxLintConfigError extends Error {
  readonly code = 'ESLINT_CONFIG_UNSUPPORTED';
  constructor() { super('يدعم إصلاح ESLint إعدادات ثابتة وقواعده المدمجة؛ تعذر إثبات سلامة إعداد المشروع.'); }
}
const unsupported = (): never => { throw new SandboxLintConfigError(); };

function dataExpression(node: ts.Expression, depth = 0): Data {
  if (depth > 20) return unsupported();
  if (ts.isParenthesizedExpression(node)) return dataExpression(node.expression, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => dataExpression(element, depth + 1));
  if (!ts.isObjectLiteralExpression(node)) return unsupported();
  const fields = new Map<string, Data>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) return unsupported();
    const key = property.name.text;
    if (dangerousKeys.has(key) || fields.has(key)) return unsupported();
    fields.set(key, dataExpression(property.initializer, depth + 1));
  }
  return Object.fromEntries(fields);
}

function staticJavaScript(path: string, content: string): Data {
  const { diagnostics } = ts.transpileModule(content, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext } });
  if (diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) return unsupported();
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const statements = source.statements.filter(statement => !ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression) || statement.expression.text !== 'use strict');
  const [statement] = statements;
  if (!statement || statements.length !== 1) return unsupported();
  if (!path.endsWith('.cjs') && ts.isExportAssignment(statement) && !statement.isExportEquals) return dataExpression(statement.expression);
  if (!path.endsWith('.mjs') && ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
    const { left, operatorToken, right } = statement.expression;
    if (operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports') return dataExpression(right);
  }
  return unsupported();
}

function assertData(value: Data, depth = 0): void {
  if (depth > 20 || (typeof value === 'number' && !Number.isFinite(value))) return unsupported();
  if (Array.isArray(value)) {
    for (const child of value) assertData(child, depth + 1);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (dangerousKeys.has(key)) return unsupported();
      assertData(child, depth + 1);
    }
  }
}

function validProperties(value: Data, keys: ReadonlySet<string>): value is Record<string, Data> {
  return isObject(value) && Object.keys(value).every(key => keys.has(key));
}

function validLegacyConfig(value: Data, override = false): boolean {
  return validProperties(value, override ? legacyOverrideKeys : legacyKeys)
    && (value.extends === undefined || legacyPresets.has(value.extends) || (Array.isArray(value.extends) && value.extends.every(preset => legacyPresets.has(preset))))
    && (value.overrides === undefined || (Array.isArray(value.overrides) && value.overrides.every(item => validLegacyConfig(item, true))));
}

export function lintConfig(input: SandboxLintInput): { source: string; flat: boolean } {
  const file = input.files.find(item => item.path === input.configPath);
  if (!file || !safeSandboxPath(file.path)) return unsupported();
  const name = basename(file.path), flat = /^eslint\.config\.(?:[mc]?js)$/u.test(name);
  if (!flat && !/^(?:\.eslintrc(?:\.(?:json|cjs|js))?|package\.json)$/u.test(name)) return unsupported();
  let config: Data;
  if (/\.[mc]?js$/u.test(name)) {
    config = staticJavaScript(file.path, file.content);
  } else {
    try {
      const parsed: Data = JSON.parse(file.content);
      config = name === 'package.json' && isObject(parsed) ? parsed.eslintConfig : parsed;
    } catch { return unsupported(); }
  }
  assertData(config);
  if (flat) {
    const entries = Array.isArray(config) ? config : [config];
    if (!entries.every(item => validProperties(item, flatKeys) && (item.languageOptions === undefined || validProperties(item.languageOptions, languageKeys)))) return unsupported();
  } else if (!validLegacyConfig(config)) return unsupported();
  // Generate from data so the original project configuration is never imported.
  return { source: `module.exports = JSON.parse(${JSON.stringify(JSON.stringify(config))});\n`, flat };
}

const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const toolPackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
async function installedPackage(root: string, from: string, name: string): Promise<string> {
  if (!toolPackage.test(name)) throw new Error('Unexpected sandbox tool package name.');
  for (let directory = from; ; directory = dirname(directory)) {
    if (basename(directory) !== 'node_modules') {
      const candidate = join(directory, 'node_modules', name);
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      if (info) {
        const canonical = await realpath(candidate);
        const inside = relative(root, canonical);
        if (!info.isDirectory() || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unexpected sandbox tool package location.');
        return candidate;
      }
    }
    if (directory === root) break;
  }
  throw new Error(`Sandbox tool dependency is not installed: ${name}`);
}

/** Stages only this application's locked packages. No project package manager or lifecycle script runs. */
export async function stageCodingTool(tools: string, name: 'eslint' | 'typescript'): Promise<string> {
  const root = await realpath(checkout);
  const seen = new Set<string>();
  async function stage(packageName: string, from: string): Promise<string> {
    const source = await installedPackage(root, from, packageName);
    const target = join(tools, 'npm', relative(root, source));
    if (seen.has(source)) return target;
    seen.add(source);
    const metadata: { name: string; dependencies?: Record<string, string> } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (metadata.name !== packageName) throw new Error('Unexpected sandbox tool package metadata.');
    await cp(source, target, {
      recursive: true,
      filter: async (path) => path === source || (basename(path) !== 'node_modules' && !(await lstat(path)).isSymbolicLink()),
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await stage(dependency, source);
    return target;
  }
  return stage(name, join(root, 'packages', 'sandbox'));
}

export const jsonCheck = "const fs=require('node:fs');for(const path of process.argv.slice(1))JSON.parse(fs.readFileSync(path,'utf8'));";

export async function prepareTsxCheck(tools: string, typescript: string, files: string[]): Promise<string[]> {
  const entry = join(tools, 'check-tsx.cjs');
  await writeFile(entry, `const {readFileSync}=require('node:fs');
const [, , typescript, ...paths]=process.argv;
const ts=require(typescript);
const compilerOptions={jsx:ts.JsxEmit.Preserve,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.Preserve};
for (const fileName of paths) {
  const result=ts.transpileModule(readFileSync(fileName,'utf8'),{fileName,compilerOptions,reportDiagnostics:true});
  const errors=result.diagnostics.filter(diagnostic=>diagnostic.category===ts.DiagnosticCategory.Error);
  if (errors.length) {
    console.error(ts.formatDiagnostics(errors,{getCurrentDirectory:process.cwd,getCanonicalFileName:name=>name,getNewLine:()=>'\\n'}));
    process.exitCode=1;
  }
}\n`, { flag: 'wx' });
  return [entry, join(typescript, 'lib', 'typescript.js'), ...files.map(path => `./${path}`)];
}

export async function prepareLintCommand(tools: string, work: string, input: SandboxLintInput): Promise<string[]> {
  const config = lintConfig(input);
  const eslint = await stageCodingTool(tools, 'eslint');
  const entry = join(tools, 'lint.mjs'), configPath = join(tools, 'eslint.config.cjs');
  await Promise.all([
    writeFile(configPath, config.source, { flag: 'wx' }),
    writeFile(entry, `import {constants, copyFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [, , eslint, mode, ...args] = process.argv;
const source = process.cwd(), output = process.env.MOHASSAN_OUTPUT_DIR;
for (const path of args.slice(args.indexOf('--') + 1)) {
  const target = join(output, path);
  mkdirSync(dirname(target), {recursive:true});
  copyFileSync(join(source, path), target, constants.COPYFILE_EXCL);
}
process.chdir(output);
process.env.ESLINT_USE_FLAT_CONFIG=mode;
process.argv=[process.execPath, eslint, ...args];
await import(pathToFileURL(eslint));\n`, { flag: 'wx' }),
  ]);
  const ignore = !config.flat && input.files.some(file => file.path === '.eslintignore') ? ['--ignore-path', join(work, '.eslintignore')] : [];
  return [entry, join(eslint, 'bin', 'eslint.js'), String(config.flat), config.flat ? '--no-config-lookup' : '--no-eslintrc',
    '--config', configPath, ...ignore, '--fix', '--fix-type', input.formatting ? 'problem,suggestion,layout' : 'problem,suggestion',
    '--exit-on-fatal-error', '--', ...input.fixFiles.map(path => `./${path}`)];
}
