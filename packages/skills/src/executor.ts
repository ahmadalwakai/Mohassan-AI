import { SkillError } from './errors.ts';
import { hashSkillData } from './evidence.ts';
import { sha256 } from './hash.ts';

/** The fixed name a script writes its declared outputs to, inside its output directory. */
export const SKILL_SCRIPT_RESULT_FILE = 'result.json';

interface SandboxReadiness { enabled: boolean; provider: string; gates: readonly { id: string; status: string }[] }
interface SandboxOutput { path: string; content: string; bytes: number; sha256: string }
interface SandboxScriptRun {
  exitCode: number | null; timedOut: boolean; durationMs: number; provider: string; isolation: string;
  network: 'denied'; isolationVerified: boolean; snapshotHash: string; stdout: string; stderr: string;
  outputs: SandboxOutput[]; outputManifestHash: string;
}
/** Structural on purpose: this package never imports a process or sandbox implementation. */
export interface SkillScriptSandbox {
  executableReadiness?(): Promise<SandboxReadiness>;
  runScript?(input: { files: { path: string; content: string }[]; entry: string; inputJson: string; signal?: AbortSignal; timeoutMs?: number; memoryMb?: number; outputMaxBytes?: number }): Promise<SandboxScriptRun>;
}
export interface SkillScriptReceipt {
  scriptHash: string; snapshotHash: string; inputsHash: string; outputManifestHash: string; resultHash: string | null;
  outputs: { path: string; bytes: number; sha256: string }[]; stdoutHash: string; stderrHash: string;
  gates: string[]; provider: string; isolation: string; sharesHostKernel: true; network: 'denied';
  durationMs: number; exitCode: number | null; timedOut: boolean;
}
export interface SkillScriptRequest {
  entry: string; inputs: Record<string, unknown>; signal: AbortSignal;
  files: readonly { path: string; kind: string; content: string }[];
  limits?: { timeoutMs: number; memoryMb: number; outputMaxBytes: number };
}
export interface SkillScriptExecutor {
  ready(): Promise<boolean>;
  execute(request: SkillScriptRequest): Promise<{ outputs: Record<string, unknown>; receipt: SkillScriptReceipt }>;
}
/** Carries the receipt of a run that ended badly, so a failure keeps its evidence. */
export class SkillScriptError extends SkillError {
  constructor(code: string, message: string, readonly receipt: SkillScriptReceipt) { super(code, message, 409); }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Runs one verified snapshot through the sandbox's only script entry. Readiness is read again for every run,
 * and there is no host or lower-level fallback: a closed gate stops the run with no process started.
 */
export function createScriptExecutor(sandbox: SkillScriptSandbox): SkillScriptExecutor {
  const readiness = async () => (await sandbox.executableReadiness?.().catch(() => undefined));
  return {
    async ready() { return (await readiness())?.enabled === true && typeof sandbox.runScript === 'function'; },
    async execute({ entry, inputs, files, limits, signal }) {
      const report = await readiness();
      if (report?.enabled !== true || !sandbox.runScript) throw new SkillError('SKILL_SANDBOX_UNVERIFIED', 'المهارات التنفيذية محجوبة حتى إثبات بوابات العزل.', 409);
      const snapshot = files.filter(file => file.kind === 'script' || file.kind === 'data').map(({ path, content }) => ({ path, content }));
      const script = snapshot.find(file => file.path === entry);
      if (!script) throw new SkillError('SKILL_SCRIPT_ENTRY_MISSING', 'ملف دخول السكربت غير موجود في النسخة المثبتة.', 409);
      const run = await sandbox.runScript({ files: snapshot, entry, inputJson: JSON.stringify(inputs), signal, ...limits });
      const result = run.outputs.find(file => file.path === SKILL_SCRIPT_RESULT_FILE);
      const receipt: SkillScriptReceipt = {
        scriptHash: sha256(script.content), snapshotHash: run.snapshotHash, inputsHash: hashSkillData(inputs), outputManifestHash: run.outputManifestHash, resultHash: null,
        outputs: run.outputs.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash })), stdoutHash: sha256(run.stdout), stderrHash: sha256(run.stderr),
        gates: report.gates.filter(gate => gate.status === 'verified').map(gate => gate.id), provider: run.provider, isolation: run.isolation,
        sharesHostKernel: true, network: run.network, durationMs: run.durationMs, exitCode: run.exitCode, timedOut: run.timedOut,
      };
      if (!run.isolationVerified) throw new SkillScriptError('SKILL_SCRIPT_ISOLATION_UNVERIFIED', 'لم يثبت العزل لهذا التشغيل.', receipt);
      if (run.timedOut) throw new SkillScriptError('SKILL_SCRIPT_TIMEOUT', 'تجاوز السكربت مهلته.', receipt);
      if (run.exitCode !== 0) throw new SkillScriptError('SKILL_SCRIPT_FAILED', 'انتهى السكربت برمز فشل.', receipt);
      if (!result) throw new SkillScriptError('SKILL_SCRIPT_RESULT_MISSING', `لم يكتب السكربت ${SKILL_SCRIPT_RESULT_FILE}.`, receipt);
      let outputs: unknown;
      try { outputs = JSON.parse(result.content); } catch { throw new SkillScriptError('SKILL_SCRIPT_RESULT_INVALID', 'ناتج السكربت ليس JSON صالحًا.', receipt); }
      if (!object(outputs)) throw new SkillScriptError('SKILL_SCRIPT_RESULT_INVALID', 'ناتج السكربت يجب أن يكون كائن JSON.', receipt);
      return { outputs, receipt: { ...receipt, resultHash: hashSkillData(outputs) } };
    },
  };
}
