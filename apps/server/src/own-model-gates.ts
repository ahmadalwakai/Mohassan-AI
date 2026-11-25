import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const capabilities = ['route-choice', 'follow-up-turn-type', 'phrasing'] as const;
const maxConfigBytes = 64 * 1024;
const maxReportBytes = 16 * 1024 * 1024;

export const OWN_MODEL_PHRASING_MAX_TOKENS = 64;
export type OwnModelCapability = typeof capabilities[number];
export type OwnModelDecisionCapability = Exclude<OwnModelCapability, 'phrasing'>;
type FilePin = Readonly<{ path: string; sha256: string }>;
export type OwnModelGateConfig = Readonly<Partial<Record<OwnModelCapability, FilePin>>>;

interface DecisionGate {
  readonly mode: 'shadow';
  readonly calibration: Readonly<{ temperature: number; minConfidence: number; minMargin: number }>;
}

interface RouteGate extends DecisionGate {
  readonly routerSha256: string;
}

interface PhrasingGate {
  readonly mode: 'active';
}

export interface OwnModelGates {
  get(capability: 'route-choice', workerConfigSha256: string | undefined): RouteGate | undefined;
  get(capability: OwnModelDecisionCapability, workerConfigSha256: string | undefined): DecisionGate | undefined;
  get(capability: 'phrasing', workerConfigSha256: string | undefined): PhrasingGate | undefined;
}

type VerifiedGate = (RouteGate | DecisionGate | PhrasingGate) & { readonly workerConfigSha256: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/.test(value);
}

function filePin(value: unknown, baseDir: string): FilePin | undefined {
  const pin = record(value);
  const path = pin?.path;
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || /^[\\/]{2}/.test(path) || !isSha256(pin?.sha256)) {
    return undefined;
  }
  return Object.freeze({ path: resolve(baseDir, path), sha256: pin.sha256 });
}

async function readJson(path: string, limit: number, sha256?: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) return undefined;
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) return undefined;
      const bytes = buffer.subarray(0, length);
      if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) return undefined;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

export async function readOwnModelGateConfig(path: string): Promise<OwnModelGateConfig> {
  const configured = record(record(await readJson(path, maxConfigBytes))?.gates);
  const config: Partial<Record<OwnModelCapability, FilePin>> = {};
  for (const capability of capabilities) {
    const pin = filePin(configured?.[capability], dirname(path));
    if (pin) config[capability] = pin;
  }
  return Object.freeze(config);
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 1;
}

function calibration(value: unknown): DecisionGate['calibration'] | undefined {
  const config = record(value);
  const { temperature, minConfidence, minMargin } = config ?? {};
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature <= 0
      || !probability(minConfidence) || !probability(minMargin)) return undefined;
  return Object.freeze({ temperature, minConfidence, minMargin });
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function loadGate(capability: OwnModelCapability, pin: FilePin): Promise<VerifiedGate | undefined> {
  const gate = record(await readJson(pin.path, maxConfigBytes, pin.sha256));
  const mode = capability === 'phrasing' ? 'active' : 'shadow';
  if (gate?.schemaVersion !== 1 || gate.capability !== capability || gate.mode !== mode
      || !isSha256(gate.workerConfigSha256)) return undefined;
  const reportPin = filePin(gate.report, dirname(pin.path));
  if (!reportPin) return undefined;

  const report = record(await readJson(reportPin.path, maxReportBytes, reportPin.sha256));
  if (report?.schema_version !== 1 || !positiveInteger(report.version) || report.decision !== 'pass'
      || report.gate_id !== `own-model.${capability}.${mode}`
      || report.adapter !== (capability === 'phrasing' ? 'generation' : 'classifier')
      || record(record(report.hashes)?.candidate)?.sha256 !== gate.workerConfigSha256
      || !positiveInteger(report.case_count) || !Array.isArray(report.checks) || !report.checks.length
      || !report.checks.every(check => record(check)?.status === 'pass')) return undefined;

  const workerConfigSha256 = gate.workerConfigSha256;
  if (mode === 'active') {
    const generation = record(report.generation);
    if (generation?.temperature !== 0 || generation.max_tokens !== OWN_MODEL_PHRASING_MAX_TOKENS
        || generation.eos_rule !== 'require_eos') return undefined;
    return Object.freeze({ mode, workerConfigSha256 });
  }

  const calibrated = calibration(gate.calibration);
  // The classifier run must have passed its registered calibration check.
  if (!calibrated || !report.checks.some(check => record(check)?.rule === 'classifier.max_ece')) return undefined;
  if (capability === 'route-choice') {
    if (!isSha256(gate.routerSha256)) return undefined;
    return Object.freeze({ mode, workerConfigSha256, calibration: calibrated, routerSha256: gate.routerSha256 });
  }
  return Object.freeze({ mode, workerConfigSha256, calibration: calibrated });
}

export async function loadOwnModelGates(config?: OwnModelGateConfig): Promise<OwnModelGates> {
  const gates = new Map<OwnModelCapability, VerifiedGate>();
  await Promise.all(capabilities.map(async capability => {
    const pin = filePin(config?.[capability], process.cwd());
    const gate = pin && await loadGate(capability, pin);
    if (gate) gates.set(capability, gate);
  }));

  function get(capability: 'route-choice', workerConfigSha256: string | undefined): RouteGate | undefined;
  function get(capability: OwnModelDecisionCapability, workerConfigSha256: string | undefined): DecisionGate | undefined;
  function get(capability: 'phrasing', workerConfigSha256: string | undefined): PhrasingGate | undefined;
  function get(capability: OwnModelCapability, workerConfigSha256: string | undefined): DecisionGate | PhrasingGate | undefined {
    const gate = gates.get(capability);
    return gate?.workerConfigSha256 === workerConfigSha256 ? gate : undefined;
  }
  return Object.freeze({ get });
}
