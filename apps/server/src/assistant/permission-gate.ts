import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DesktopCommand } from '@mohassan/desktop';
import type { AgentAction, AgentRequestPermit } from '@mohassan/browser';
import { PermissionRecordSchema, RUN_CAPABILITIES, isRunCapability, type PermissionRecord, type RunCapability, type RunLedger } from './agent-run.js';
import { desktopCapability } from './run-plans.js';
import type { ComputerStep } from './tools.js';
import type { WorkTool } from './brain.js';

/**
 * The one server-side permission gate of the chat runtime (docs/architecture/agent-execution.md). Every action that
 * waits for the owner's yes passes here twice: when the approval card is asked (`requestPermission`) and right before
 * the action runs (`checkPermission`), from whichever caller resumed the run: the approve route, a retry or a reconnect.
 *
 * The gate answers five questions in order: is the capability registered; are its arguments valid; may this actor use
 * it; do the request's own words and the platform permit it; does an existing yes cover this exact action. An approval
 * is bound to the actor, the conversation, the run and the SHA-256 of the action's material details, so a changed
 * recipient, target, path or body is a different action that the old yes does not cover. A refusal stands for the rest
 * of the run. Model text, page text, skill files, memory and client fields never reach these functions as authority.
 */

export class PermissionGateError extends Error {
  constructor(readonly code: 'PERMISSION_NOT_PENDING' | 'PERMISSION_ACTOR_MISMATCH' | 'PERMISSION_INVALID_ACTION', message: string) { super(message); this.name = 'PermissionGateError'; }
}

/** How long an asked approval stays valid: the paused run's own lease (pause() in command-chat.ts) is ten minutes. */
export const APPROVAL_TTL_MS = 10 * 60_000;

const detailValue = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const ActionMaterialSchema = z.object({
  capability: z.string().refine(isRunCapability, { message: 'unregistered capability' }),
  target: z.string().trim().min(1).max(300),
  details: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), detailValue).refine(value => Object.keys(value).length <= 16, { message: 'too many details' }),
  action: z.string().trim().min(1).max(200),
  consequence: z.string().trim().max(300),
  reversible: z.boolean().nullable(),
}).strict();
export type ActionMaterial = z.infer<typeof ActionMaterialSchema> & { capability: RunCapability };

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value ?? null);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The SHA-256 of what the action does: its capability, exact target and every argument. Labels and wording are not part of it. */
export function actionFingerprint(material: Pick<ActionMaterial, 'capability' | 'target' | 'details'>): string {
  return sha256(canonical({ capability: material.capability, target: material.target, details: material.details }));
}

const desktopTarget = (command: DesktopCommand): string => {
  const record = command as Record<string, unknown>;
  for (const key of ['path', 'name', 'target', 'command', 'combo', 'pattern', 'window'] as const) {
    if (typeof record[key] === 'string' && record[key]) return String(record[key]).slice(0, 300);
  }
  return command.kind;
};

/**
 * The material details of the action a paused run holds for approval. Only the server's own stored pending action is
 * read: nothing here comes from the approval request the client sent. `lang` only words the consequence shown on the
 * card; it is not part of the fingerprint.
 */
export function pendingActionMaterial(state: {
  pendingAction?: { action: AgentAction; permit: AgentRequestPermit; label: string } | null;
  pendingHeld?: { id: string; label: string } | null;
  pendingTask?: { id: string; label: string; tool: WorkTool } | null;
  pendingComputer?: { step: ComputerStep; label: string } | null;
  pendingDesktop?: { command: DesktopCommand; label: string; lang: 'ar' | 'en' } | null;
}, lang: 'ar' | 'en' = 'en'): { kind: 'action' | 'held' | 'task' | 'computer' | 'desktop'; material: ActionMaterial } | null {
  const say = (ar: string, en: string) => (lang === 'ar' ? ar : en).slice(0, 300);
  if (state.pendingAction) {
    const { permit, action, label } = state.pendingAction;
    const host = URL.parse(permit.url)?.host ?? permit.url;
    return { kind: 'action', material: { capability: 'browser.submit', target: `${permit.method} ${permit.url}`.slice(0, 300),
      details: { method: permit.method, bodyHash: permit.bodyHash, pageHash: permit.pageHash, actionHash: permit.actionHash, actionKind: action.kind },
      action: label.slice(0, 200) || 'browser request', reversible: null,
      consequence: say(`يُرسَل طلب ${permit.method} إلى ${host} بالقيم المعروضة، مرة واحدة.`, `A ${permit.method} request is sent to ${host} with the values shown, once.`) } };
  }
  if (state.pendingHeld) return { kind: 'held', material: { capability: 'browser.submit', target: `held:${state.pendingHeld.id}`,
    details: { heldId: state.pendingHeld.id }, action: state.pendingHeld.label.slice(0, 200) || 'held request', reversible: null,
    consequence: say('يُرسَل الطلب الذي أوقفته الصفحة مرة واحدة كما هو.', 'The request the page tried to send is sent once, exactly as held.') } };
  if (state.pendingTask) return { kind: 'task', material: { capability: 'runtime.task', target: `task:${state.pendingTask.id}`,
    details: { tool: state.pendingTask.tool }, action: state.pendingTask.label.slice(0, 200) || state.pendingTask.tool, reversible: null,
    consequence: say('تعمل المهمة المعدّة على مشاريعك.', 'The prepared task runs on the owner\'s projects.') } };
  if (state.pendingComputer) {
    const step = state.pendingComputer.step;
    const value = step.kind === 'click' ? step.name : step.kind === 'text' ? step.text : step.key;
    return { kind: 'computer', material: { capability: 'computer.input', target: `${step.kind}:${value}`.slice(0, 300),
      details: { kind: step.kind, valueHash: sha256(value), origin: step.origin ? sha256(canonical(step.origin)) : null },
      action: state.pendingComputer.label.slice(0, 200) || step.kind, reversible: false,
      consequence: say('يُرسَل الإدخال إلى النافذة المشاركة على كمبيوترك.', 'Input is sent to the shared window on the owner\'s computer.') } };
  }
  if (state.pendingDesktop) {
    const { command, label } = state.pendingDesktop;
    const capability = desktopCapability(command);
    return { kind: 'desktop', material: { capability, target: desktopTarget(command), details: { kind: command.kind, commandHash: sha256(canonical(command)) },
      action: label.slice(0, 200) || command.kind,
      consequence: capability === 'desktop.delete' ? say('يُنقل العنصر إلى سلة المحذوفات.', 'The item is moved to the Recycle Bin.')
        : capability === 'desktop.run' ? say('يعمل أمر أو إدخال على كمبيوترك.', 'A command or input runs on the owner\'s computer.') : say('تتغير ملفات على كمبيوترك.', 'Files on the owner\'s computer change.'),
      reversible: capability === 'desktop.delete' ? true : capability === 'desktop.run' ? false : null } };
  }
  return null;
}

/** Records that the owner is being asked about this exact action. Any earlier unanswered ask in this run is replaced. */
export function requestPermission(ledger: RunLedger, input: { approvalId: string; actorId: string; conversationId: string; runId: string;
  material: ActionMaterial; stepId?: string | null; at: number; ttlMs?: number }): PermissionRecord {
  const material = ActionMaterialSchema.safeParse(input.material);
  if (!material.success) throw new PermissionGateError('PERMISSION_INVALID_ACTION', 'The action awaiting approval is not a registered, valid action.');
  const at = new Date(input.at).toISOString();
  for (const record of ledger.permissions) if (record.decision === 'asked') { record.decision = 'invalidated'; record.reason = 'replaced'; record.decidedAt = at; }
  const record = PermissionRecordSchema.parse({
    id: input.approvalId, stepId: input.stepId ?? null, action: material.data.action, target: material.data.target, consequence: material.data.consequence,
    reversible: material.data.reversible, fingerprint: actionFingerprint(material.data), decision: 'asked', reason: 'approval_required', decidedAt: at,
    actorId: input.actorId, conversationId: input.conversationId, runId: input.runId, capability: material.data.capability,
    askedAt: at, expiresAt: new Date(input.at + Math.max(1000, input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
  });
  ledger.permissions.push(record);
  // Bounded: answered records older than the newest twelve give way first.
  while (ledger.permissions.length > 12) {
    const index = ledger.permissions.findIndex(item => item.decision !== 'asked' && item.decision !== 'granted');
    ledger.permissions.splice(index >= 0 ? index : 0, 1);
  }
  ledger.sequence++; ledger.updatedAt = at;
  return record;
}

/** The owner's answer to one asked approval. Only the actor who was asked, in the same conversation, can answer it. */
export function recordDecision(ledger: RunLedger, input: { approvalId: string; actorId: string; conversationId: string; approved: boolean; at: number }): PermissionRecord {
  const record = ledger.permissions.find(item => item.id === input.approvalId && item.decision === 'asked');
  if (!record) throw new PermissionGateError('PERMISSION_NOT_PENDING', 'This approval is not waiting for an answer.');
  if (record.actorId !== input.actorId || record.conversationId !== input.conversationId) throw new PermissionGateError('PERMISSION_ACTOR_MISMATCH', 'Only the account that was asked can answer this approval.');
  const at = new Date(input.at).toISOString();
  if (input.at > Date.parse(record.expiresAt)) { record.decision = 'expired'; record.reason = 'approval_expired'; }
  else if (input.approved) { record.decision = 'granted'; record.reason = 'owner_approved'; }
  else { record.decision = 'refused'; record.reason = 'owner_refused'; }
  record.decidedAt = at;
  ledger.sequence++; ledger.updatedAt = at;
  return record;
}

export type GateDecision =
  | { decision: 'allow'; reason: 'granted'; fingerprint: string; record: PermissionRecord }
  | { decision: 'ask'; reason: 'approval_required' | 'grant_consumed'; fingerprint: string }
  | { decision: 'deny'; reason: 'capability_unregistered' | 'invalid_arguments' | 'actor_not_allowed' | 'platform_restricted' | 'owner_refused'
    | 'approval_mismatch' | 'approval_expired' | 'awaiting_decision'; fingerprint: string | null };

/**
 * The decision right before an action runs. `actorAllowed` is the account's reach for this capability, read by the
 * caller at this moment; `platformAllowed` is whether the request's own words and the server permit it. `approvalId`
 * names the yes the caller believes covers the action: if that yes was given for different details, the action is denied.
 */
export function checkPermission(ledger: RunLedger, input: { material: unknown; actorId: string; conversationId: string; runId: string;
  actorAllowed: boolean; platformAllowed: boolean; approvalId?: string | null; at: number }): GateDecision {
  const raw = input.material as Partial<ActionMaterial> | null;
  if (!raw || typeof raw.capability !== 'string' || !isRunCapability(raw.capability)) return { decision: 'deny', reason: 'capability_unregistered', fingerprint: null };
  const material = ActionMaterialSchema.safeParse(input.material);
  if (!material.success) return { decision: 'deny', reason: 'invalid_arguments', fingerprint: null };
  const fingerprint = actionFingerprint(material.data);
  if (!input.actorAllowed) return { decision: 'deny', reason: 'actor_not_allowed', fingerprint };
  if (!input.platformAllowed) return { decision: 'deny', reason: 'platform_restricted', fingerprint };
  const mine = ledger.permissions.filter(item => item.actorId === input.actorId && item.conversationId === input.conversationId && item.runId === input.runId);
  if (input.approvalId) {
    const named = mine.find(item => item.id === input.approvalId);
    if (named && named.fingerprint !== fingerprint) return { decision: 'deny', reason: 'approval_mismatch', fingerprint };
  }
  const same = mine.filter(item => item.fingerprint === fingerprint);
  if (same.some(item => item.decision === 'refused')) return { decision: 'deny', reason: 'owner_refused', fingerprint };
  const granted = same.find(item => item.decision === 'granted');
  if (granted) return input.at > Date.parse(granted.expiresAt) ? { decision: 'deny', reason: 'approval_expired', fingerprint } : { decision: 'allow', reason: 'granted', fingerprint, record: granted };
  if (same.some(item => item.decision === 'asked')) return { decision: 'deny', reason: 'awaiting_decision', fingerprint };
  if (same.some(item => item.decision === 'consumed')) return { decision: 'ask', reason: 'grant_consumed', fingerprint };
  return { decision: 'ask', reason: 'approval_required', fingerprint };
}

/** A yes covers one execution: once the action is dispatched, the same action needs a new yes. */
export function consumePermission(ledger: RunLedger, approvalId: string, at: number) {
  const record = ledger.permissions.find(item => item.id === approvalId && item.decision === 'granted');
  if (!record) return;
  record.decision = 'consumed'; record.reason = 'executed'; record.decidedAt = new Date(at).toISOString();
  ledger.sequence++; ledger.updatedAt = record.decidedAt;
}

/** A correction or a stop: every ask and every unused yes of this run stops covering anything. */
export function invalidatePermissions(ledger: RunLedger, reason: 'superseded' | 'owner_cancelled' | 'replaced', at: number) {
  const iso = new Date(at).toISOString();
  let changed = false;
  for (const record of ledger.permissions) if (record.decision === 'asked' || record.decision === 'granted') {
    record.decision = 'invalidated'; record.reason = reason; record.decidedAt = iso; changed = true;
  }
  if (changed) { ledger.sequence++; ledger.updatedAt = iso; }
}

/** The risk the runtime assigns to a capability, for the approval card. */
export const capabilityRisk = (capability: RunCapability) => RUN_CAPABILITIES[capability].risk;
