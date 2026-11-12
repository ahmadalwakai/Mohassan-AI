import {
  ExecutionTaskContractSchema, type ExecutionFailure, type ExecutionIssue, type ExecutionTaskContract,
  type MissingContextItem, type MissingContextRequest, type UnsupportedExecutionResult,
} from './schemas.ts';
import { boundedJsonBytes, contentHash, executionFailure, sameWorkspace, schemaIssues, unsupportedExecution } from './boundaries.ts';

/** Versioned local operation vocabulary. Future categories remain explicitly unsupported. */
export const SUPPORTED_EXECUTION_OPERATIONS = Object.freeze({
  structured_specification: Object.freeze({ category: 'structured', name: 'structured.replace-file.v1', output: 'operation' }),
  typescript_implementation: Object.freeze({ category: 'typescript', name: 'typescript.implement.v1', output: 'typescript_edit' }),
  local_code_repair: Object.freeze({ category: 'code_repair', name: 'typescript.repair.v1', output: 'typescript_edit' }),
} as const);

export type ExecutionContractValidation =
  | { ok: true; task: ExecutionTaskContract }
  | { ok: false; result: ExecutionFailure | MissingContextRequest | UnsupportedExecutionResult };

/** Shape, references and policy declarations only; does not prove source semantics or grant permissions. */
export class ExecutionContractValidator {
  validate(raw: unknown): ExecutionContractValidation {
    if (boundedJsonBytes(raw) === null) return { ok: false, result: executionFailure(null, 'invalid_contract', 'Contract must be bounded plain JSON without cycles or accessors.') };
    const parsed = ExecutionTaskContractSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, result: executionFailure(null, 'invalid_contract', 'Execution contract is malformed or incomplete.', schemaIssues(parsed.error.issues)) };
    const task = parsed.data;
    const supported = SUPPORTED_EXECUTION_OPERATIONS[task.family];
    if (task.operation.category !== supported.category || task.operation.name !== supported.name) {
      return { ok: false, result: unsupportedExecution(task, 'This operation is outside the Phase 1 vocabulary.') };
    }
    const issues: ExecutionIssue[] = [];
    const add = (path: (string | number)[], code: string, message: string) => { issues.push({ path, code, message }); };
    const unique = (values: readonly string[], path: (string | number)[], caseInsensitive = false) => {
      if (new Set(values.map(value => caseInsensitive ? value.toLowerCase() : value)).size !== values.length) add(path, 'duplicate_reference', 'References must be unique, including case aliases for file paths.');
    };
    if (task.output.category !== supported.output) add(['output', 'category'], 'output_mismatch', 'The output category does not match this task family.');
    if (!task.constraints.requiredCapabilities.includes('coding.change') || !task.constraints.requiredTools.includes('coding.change')
      || !task.constraints.requiredScopes.includes('code:write')) add(['constraints'], 'missing_dispatch_requirement', 'Existing-file proposals must declare coding.change capability/tool and code:write; live registry scopes are also required at dispatch.');
    unique(task.acceptanceCriteria.map(value => value.id), ['acceptanceCriteria']);
    unique(task.constraints.architecture.decisions.map(value => value.id), ['constraints', 'architecture', 'decisions']);
    unique(task.constraints.requiredCapabilities, ['constraints', 'requiredCapabilities']);
    unique(task.constraints.requiredTools, ['constraints', 'requiredTools']);
    unique(task.constraints.requiredScopes, ['constraints', 'requiredScopes']);
    unique(task.context.files.map(value => value.path), ['context', 'files'], true);
    for (const key of ['symbols', 'imports', 'types', 'signatures', 'documentation', 'evidence'] as const) {
      unique(task.context[key].map(value => value.id), ['context', key]);
    }
    for (const key of ['files', 'symbols', 'imports', 'types', 'signatures', 'documentation', 'evidence'] as const) {
      unique(task.context.required[key], ['context', 'required', key], key === 'files');
    }
    for (const [index, file] of task.context.files.entries()) {
      if (Buffer.byteLength(file.content, 'utf8') > 64_000 || contentHash(file.content) !== file.hash) add(['context', 'files', index], 'invalid_file_content', 'Supplied content must fit the byte limit and match its SHA-256 hash.');
    }
    for (const [index, entry] of task.context.imports.entries()) unique(entry.symbolIds, ['context', 'imports', index, 'symbolIds']);
    const target = task.family === 'structured_specification' ? task.input.path : task.input.targetPath;
    if (task.constraints.allowedFiles[0] !== target) add(['constraints', 'allowedFiles'], 'target_not_allowed', 'The exact target file must be the single allowed file.');
    if (task.family !== 'structured_specification') {
      for (const key of ['signatureIds', 'typeIds', 'symbolIds', 'importIds'] as const) unique(task.input[key], ['input', key]);
    }
    if (task.family === 'local_code_repair') unique(task.input.evidenceIds, ['input', 'evidenceIds']);
    if (task.family === 'structured_specification' && Buffer.byteLength(task.input.content, 'utf8') > task.output.maxBytes) add(['input', 'content'], 'output_limit', 'The supplied replacement already exceeds the output byte budget.');
    if (issues.length) return { ok: false, result: executionFailure(task.taskId, 'invalid_contract', 'Execution contract references or boundaries are inconsistent.', issues) };

    const missing: MissingContextItem[] = [];
    const missingKeys = new Set<string>();
    const need = (kind: MissingContextItem['kind'], reference: string, present: boolean) => {
      const key = `${kind}:${reference}`;
      if (!present && !missingKeys.has(key)) { missingKeys.add(key); missing.push({ kind, reference, reason: 'Supply the declared project context; the executor must not infer it.' }); }
    };
    const files = new Map(task.context.files.map(value => [value.path, value]));
    const symbols = new Set(task.context.symbols.map(value => value.id));
    const imports = new Set(task.context.imports.map(value => value.id));
    const types = new Set(task.context.types.map(value => value.id));
    const signatures = new Set(task.context.signatures.map(value => value.id));
    const documents = new Set(task.context.documentation.map(value => value.id));
    const evidence = new Set(task.context.evidence.map(value => value.id));
    need('file', target, files.has(target));
    task.context.required.files.forEach(id => need('file', id, files.has(id)));
    task.context.required.symbols.forEach(id => need('symbol', id, symbols.has(id)));
    task.context.required.imports.forEach(id => need('import', id, imports.has(id)));
    task.context.required.types.forEach(id => need('type', id, types.has(id)));
    task.context.required.signatures.forEach(id => need('signature', id, signatures.has(id)));
    task.context.required.documentation.forEach(id => need('documentation', id, documents.has(id)));
    task.context.required.evidence.forEach(id => need('evidence', id, evidence.has(id)));
    task.context.symbols.forEach(value => need('file', value.sourcePath, files.has(value.sourcePath)));
    task.context.types.forEach(value => { if (value.sourcePath !== null) need('file', value.sourcePath, files.has(value.sourcePath)); });
    task.context.signatures.forEach(value => need('symbol', value.symbolId, symbols.has(value.symbolId)));
    task.context.imports.forEach(value => value.symbolIds.forEach(id => need('symbol', id, symbols.has(id))));
    task.context.evidence.forEach(value => need('file', value.sourcePath, files.has(value.sourcePath)));
    if (task.family !== 'structured_specification') {
      task.input.signatureIds.forEach(id => need('signature', id, signatures.has(id)));
      task.input.typeIds.forEach(id => need('type', id, types.has(id)));
      task.input.symbolIds.forEach(id => need('symbol', id, symbols.has(id)));
      task.input.importIds.forEach(id => need('import', id, imports.has(id)));
    }
    if (task.family === 'local_code_repair') task.input.evidenceIds.forEach(id => need('evidence', id, evidence.has(id)));
    if (task.context.evidence.some(value => !sameWorkspace(value.workspace, task.workspace))
      || task.family === 'structured_specification' && files.has(target) && files.get(target)!.hash !== task.input.expectedHash) {
      return { ok: false, result: executionFailure(task.taskId, 'stale_workspace', 'Supplied failure evidence or replacement preimage belongs to a different workspace version.') };
    }
    if (missing.length > 128) return { ok: false, result: executionFailure(task.taskId, 'invalid_contract', 'Too many unresolved context references; narrow the task or supply its declared context.') };
    if (missing.length) return { ok: false, result: { kind: 'missing_context', taskId: task.taskId, missing, disposition: task.policy.missingContext, executionAllowed: false } };
    return { ok: true, task };
  }
}
