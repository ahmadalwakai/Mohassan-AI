/** Execute bounded model-produced TypeScript only inside the existing AppContainer.
 * No generated module is imported by this host process. Independent probes are
 * supplied by code_tasks.py, never inferred from the model's answer.
 * Usage: npx tsx scripts/code-training/verify.ts job.json result.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { WindowsAppContainerSandbox, type SandboxFile } from '../../packages/sandbox/src/index.ts';
import { matchesSignature } from './contract.ts';

interface Probe { args: unknown[]; expected: unknown }
interface Candidate { id: string; content: string; functionName: string; signature?: string; probes: Probe[]; language?: string; family?: string; mode?: string }
const BATCH = 80;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

// This additionally keeps a candidate from tampering with the shared batch
// harness. The AST is inspected on the host; candidate execution stays inside
// AppContainer. This is a bounded expression grammar, not a general TS checker.
function allowedSource(candidate: Candidate): boolean {
  const file = ts.createSourceFile('candidate.ts', candidate.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parsed = file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
  if (parsed.parseDiagnostics.length || file.statements.length !== 1) return false;
  const declaration = file.statements[0];
  if (!declaration || !ts.isFunctionDeclaration(declaration) || declaration.name?.text !== candidate.functionName
    || !declaration.body || declaration.asteriskToken || declaration.typeParameters?.length
    || !declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || declaration.modifiers.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword)
    || declaration.body.statements.length !== 1 || declaration.parameters.length > 4) return false;
  const allowedType = (type: ts.TypeNode | undefined): boolean => Boolean(type && (
    [ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.UndefinedKeyword].includes(type.kind)
    || (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword)
    || (ts.isUnionTypeNode(type) && type.types.every(allowedType))
    || (ts.isParenthesizedTypeNode(type) && allowedType(type.type))
    || (ts.isArrayTypeNode(type) && allowedType(type.elementType))));
  if (!allowedType(declaration.type)) return false;
  const scope = new Set<string>();
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken || parameter.modifiers
      || !allowedType(parameter.type) || scope.has(parameter.name.text)) return false;
    scope.add(parameter.name.text);
  }
  const statement = declaration.body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;
  const binaries = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
  ]);
  const expression = (node: ts.Expression, names: Set<string>): boolean => {
    if (ts.isNumericLiteral(node) || ts.isStringLiteral(node)) return node.text.length <= 128;
    if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return true;
    if (ts.isIdentifier(node)) return names.has(node.text) || node.text === 'undefined';
    if (ts.isParenthesizedExpression(node)) return expression(node.expression, names);
    if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.ExclamationToken].includes(node.operator) && expression(node.operand, names);
    if (ts.isBinaryExpression(node)) return binaries.has(node.operatorToken.kind) && expression(node.left, names) && expression(node.right, names);
    if (ts.isConditionalExpression(node)) return expression(node.condition, names) && expression(node.whenTrue, names) && expression(node.whenFalse, names);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'length' && expression(node.expression, names);
    if (!ts.isCallExpression(node) || node.typeArguments?.length || !ts.isPropertyAccessExpression(node.expression)) return false;
    const method = node.expression.name.text;
    if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math') {
      return ['min', 'max', 'abs'].includes(method) && node.arguments.length > 0 && node.arguments.length <= 3 && node.arguments.every(arg => expression(arg, names));
    }
    if (!expression(node.expression.expression, names)) return false;
    if (['trim', 'toLowerCase', 'toUpperCase'].includes(method)) return node.arguments.length === 0;
    if (!['reduce', 'filter'].includes(method)) return false;
    const callback = node.arguments[0];
    if (!callback || !ts.isArrowFunction(callback) || ts.isBlock(callback.body) || callback.modifiers?.length
      || callback.typeParameters?.length || callback.parameters.length < 1 || callback.parameters.length > 2) return false;
    const inner = new Set(names);
    for (const parameter of callback.parameters) {
      if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken || parameter.modifiers
        || (parameter.type && !allowedType(parameter.type))) return false;
      inner.add(parameter.name.text);
    }
    return expression(callback.body, inner) && (method === 'filter'
      ? node.arguments.length === 1
      : node.arguments.length === 2 && expression(node.arguments[1]!, names));
  };
  return expression(statement.expression, scope);
}

function harness(entries: { file: string; id: string; functionName: string; probes: Probe[] }[]): string {
  return `import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
const entries = ${JSON.stringify(entries)};
test('bounded generated TypeScript behavior', async () => {
  for (const entry of entries) {
    const result = { loaded: false, exported: false, passed: 0, total: entry.probes.length, failed: [], error: null };
    try {
      const module = await import('./' + entry.file);
      result.loaded = true;
      const fn = module[entry.functionName];
      if (typeof fn !== 'function') throw new Error('Expected exported function missing');
      result.exported = true;
      for (const probe of entry.probes) {
        let observed;
        try { observed = fn(...structuredClone(probe.args)); }
        catch (error) { observed = { threw: error?.name ?? 'Error' }; }
        if (isDeepStrictEqual(observed, probe.expected)) result.passed++;
        else result.failed.push({ args: probe.args, observed, expected: probe.expected });
      }
    } catch (error) { result.error = String(error?.message ?? error).slice(0, 200); }
    console.log('CODE_RESULT=' + JSON.stringify({ id: entry.id, ...result }));
  }
});
`;
}

async function main(): Promise<void> {
  const [jobPath, resultPath] = process.argv.slice(2);
  if (!jobPath || !resultPath) throw new Error('Usage: verify.ts job.json result.json');
  const jobBytes = await readFile(jobPath);
  const jobSha256 = createHash('sha256').update(jobBytes).digest('hex');
  const job = JSON.parse(jobBytes.toString('utf8')) as { candidates: Candidate[] };
  if (!Array.isArray(job.candidates) || job.candidates.length > 10000) throw new Error('Invalid candidate list');
  const seen = new Set<string>();
  for (const candidate of job.candidates) {
    if (typeof candidate.id !== 'string' || seen.has(candidate.id) || !IDENTIFIER.test(candidate.functionName)
      || typeof candidate.content !== 'string' || candidate.content.length > 4000
      || !Array.isArray(candidate.probes) || candidate.probes.length < 1 || candidate.probes.length > 30
      || candidate.probes.some(probe => !Array.isArray(probe.args) || probe.args.length > 4)) throw new Error('Invalid candidate');
    seen.add(candidate.id);
  }
  const sandbox = new WindowsAppContainerSandbox();
  const availability = await sandbox.available();
  if (!availability.available) {
    await writeFile(resultPath, JSON.stringify({ available: false, jobSha256, message: availability.message }));
    return;
  }
  const results: Record<string, unknown> = {};
  const candidateHashes = new Map(job.candidates.map(candidate => [candidate.id, createHash('sha256').update(candidate.content, 'utf8').digest('hex')]));
  const safeCandidates = job.candidates.filter(candidate => {
    if (!matchesSignature(candidate.content, candidate.signature)) {
      results[candidate.id] = { success: false, error: candidate.signature ? 'signature_mismatch' : 'missing_expected_signature', candidateSha256: candidateHashes.get(candidate.id) };
      return false;
    }
    if (allowedSource(candidate)) return true;
    results[candidate.id] = { success: false, error: 'outside_bounded_expression_grammar', candidateSha256: candidateHashes.get(candidate.id) };
    return false;
  });
  const receipts: unknown[] = [];
  for (let start = 0; start < safeCandidates.length; start += BATCH) {
    const batch = safeCandidates.slice(start, start + BATCH);
    const files: SandboxFile[] = [];
    const entries = batch.map((candidate, index) => {
      const file = `candidate${index}.ts`;
      files.push({ path: file, content: candidate.content });
      return { file, id: candidate.id, functionName: candidate.functionName, probes: candidate.probes };
    });
    files.push({ path: 'package.json', content: '{"type":"module","private":true}' });
    files.push({ path: 'verify.test.mjs', content: harness(entries) });
    const receipt = await sandbox.run({ files, testFiles: ['verify.test.mjs'], timeoutMs: 20_000 });
    const isolated = receipt.isolationVerified && receipt.network === 'denied';
    const parsed: Record<string, unknown> = {};
    if (isolated) for (const line of receipt.stdout.split(/\r?\n/)) {
      if (!line.startsWith('CODE_RESULT=')) continue;
      try {
        const row = JSON.parse(line.slice('CODE_RESULT='.length)) as { id: string; passed: number; total: number; exported: boolean; error: unknown };
        if (entries.some(entry => entry.id === row.id)) parsed[row.id] = { ...row, success: row.exported && !row.error && row.passed === row.total };
      } catch { /* Malformed/missing evidence fails closed below. */ }
    }
    for (const entry of entries) results[entry.id] = { ...(parsed[entry.id] as Record<string, unknown> | undefined
      ?? { success: false, error: isolated ? 'no_result' : 'isolation_not_verified' }), candidateSha256: candidateHashes.get(entry.id) };
    receipts.push({ batchStart: start, count: batch.length, candidateIds: entries.map(entry => entry.id), exitCode: receipt.exitCode, timedOut: receipt.timedOut,
      durationMs: receipt.durationMs, provider: receipt.provider, network: receipt.network,
      isolation: receipt.isolation, isolationVerified: receipt.isolationVerified, snapshotHash: receipt.snapshotHash });
    await writeFile(resultPath, JSON.stringify({ available: true, jobSha256, provider: availability.provider, receipts, results }, null, 2));
  }
  await writeFile(resultPath, JSON.stringify({ available: true, jobSha256, provider: availability.provider, receipts, results }, null, 2));
}

await main();
