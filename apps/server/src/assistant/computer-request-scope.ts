import { z } from 'zod';
import { actionOperandHash, compileActionCompletionContract, type ActionCompletionKind } from './action-completion.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { assessRequestScope, maskRequestLiteralData, parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText } from './request-scope.js';
import type { ComputerStep } from './tools.js';
import { isCurrentComputerReadRequest } from './computer-request-language.js';

export type ComputerRequestAction = { kind: 'view' } | ComputerStep;
export type ComputerRequestScope = 'none' | 'view_only' | 'exact_input' | 'bounded_current_task';
export type ComputerRequestScopeReason = 'invalid_request' | 'invalid_action' | 'request_constraint' | 'no_current_pc_scope'
  | 'supplied_content' | 'view_only' | 'preparatory_view' | 'exact_operand' | 'operand_unresolved' | 'operand_mismatch' | 'action_kind_mismatch' | 'bounded_current_task';
export interface ComputerRequestScopeReview {
  version: 1; allowed: boolean; scope: ComputerRequestScope; reason: ComputerRequestScopeReason;
}
const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('view') }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('click'), name: z.string().min(1).max(160), type: z.string().min(1).max(80) }).strict(),
]);
const fold = (value: string) => value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().replace(/\s+/gu, ' ').trim();
const courtesy = /^(?:(?:please|kindly|من فضلك|لو سمحت|رجاء)[,،:\s]+)+/u;
const PC_TASK = /^(?:open|launch|close|minimi[sz]e|maximi[sz]e|focus|switch|click|press|select|scroll|drag|افتح|شغل|اغلق|كبر|صغر|انتقل|اضغط|انقر|اختر|حدد|اسحب)(?!\p{L})/u;
const CLEAR_DELETE = /^(?:(?:delete|remove|erase)\s+(?:(?:the|my|selected|current)\s+){0,3}(?:account|file|folder|record|row)\b|(?:احذف|امسح)\s+(?:الحساب|الملف|المجلد|السجل|الصف)(?!\p{L}))/u;
const LOCAL_PC_SURFACE = /\b(?:pc|computer|notepad|desktop|terminal|application|program|window|screen)\b|(?:^|\s)(?:الكمبيوتر|الحاسوب|كمبيوتري|حاسوبي|جهازي|المفكره|البرنامج|التطبيق|النافذه|نافذه|الشاشه|شاشه)(?=\s|[\p{P}]|$)/u;
const PC_TASK_LOCATION = /\b(?:on|in|inside|within)\s+(?:(?:my|the|current|shared|open)\s+){0,3}(?:pc|computer|notepad|desktop|terminal|application|program|window|screen)\b|(?:^|\s)(?:علي|في|داخل|من)\s+(?:جهازي|كمبيوتري|حاسوبي|الكمبيوتر|الحاسوب|المفكره|البرنامج|التطبيق|النافذه|نافذه|الشاشه|شاشه)(?=\s|[\p{P}]|$)/u;
const PC_TASK_OBJECT = /^(?:(?:open|launch|close|minimi[sz]e|maximi[sz]e|focus|switch)\s+(?:(?:the|my|current|a|an|selected)\s+){0,3}(?:file|folder|document|application|program|window|screen|settings)\b|(?:افتح|شغل|اغلق|كبر|صغر|انتقل)\s+(?:الملف|ملف|المجلد|مجلد|المستند|مستند|البرنامج|برنامج|التطبيق|تطبيق|النافذه|نافذه|الشاشه|شاشه|الاعدادات)(?!\p{L}))/u;

/** Project only semantic input fields; device/grant origin is checked by the host adapter independently. */
function parseAction(value: unknown): z.infer<typeof Action> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  const projected = action.kind === 'view' ? { kind: action.kind }
    : action.kind === 'text' ? { kind: action.kind, text: action.text }
      : action.kind === 'key' ? { kind: action.kind, key: action.key }
        : action.kind === 'click' ? { kind: action.kind, name: action.name, type: action.type } : null;
  const parsed = Action.safeParse(projected); return parsed.success ? parsed.data : null;
}

/**
 * A CURRENT original-user scope veto, never permission or proof of completion.
 * History, notes, model proposals and observed device grants cannot supply scope.
 * Account, constraints, origin, approval and unknown-effect fences remain required.
 */
export function reviewComputerRequestScope(request: unknown, proposed: unknown): ComputerRequestScopeReview {
  const result = (allowed: boolean, scope: ComputerRequestScope, reason: ComputerRequestScopeReason): ComputerRequestScopeReview => ({ version: 1, allowed, scope, reason });
  try {
    if (typeof request !== 'string' || !request.trim() || request.length > 4000 || /[\u0000\ud800-\udfff]/u.test(request)) return result(false, 'none', 'invalid_request');
    const action = parseAction(proposed);
    if (!action) return result(false, 'none', 'invalid_action');
    const constraints = parseUserRequestConstraints(request);
    if (!requestCapabilityAllowed(constraints, action.kind === 'view' ? 'computer_read' : 'computer_action')) return result(false, 'none', 'request_constraint');
    const contract = compileActionCompletionContract({ runId: 'current-computer-request-scope', request });
    if (!contract) return result(false, 'none', 'invalid_request');
    const pc = contract.requirements.filter(item => item.kind.startsWith('computer_'));
    const inputs = pc.filter(item => item.kind !== 'computer_view');
    if (inputs.length) {
      if (action.kind === 'view') return result(true, 'exact_input', 'preparatory_view');
      const kind: ActionCompletionKind = action.kind === 'text' ? 'computer_type' : action.kind === 'key' ? 'computer_key' : 'computer_click';
      const matching = inputs.filter(item => item.kind === kind);
      if (!matching.length) return result(false, 'exact_input', 'action_kind_mismatch');
      if (matching.some(item => item.binding !== 'operand')) return result(false, 'exact_input', 'operand_unresolved');
      const value = action.kind === 'text' ? action.text : action.kind === 'key' ? action.key : action.name;
      return matching.some(item => item.targetHash === actionOperandHash(kind, value))
        ? result(true, 'exact_input', 'exact_operand') : result(false, 'exact_input', 'operand_mismatch');
    }
    if (pc.some(item => item.kind === 'computer_view')) return result(action.kind === 'view', 'view_only', 'view_only');

    const source = assessRequestScope(request);
    if (source.source === 'supplied_content' || source.operation === 'transform') return result(false, 'none', 'supplied_content');
    const matchingText = requestScopeActionText(request), analysis = analyzeCompoundRequest(matchingText);
    if (analysis.kind === 'invalid') return result(false, 'none', 'invalid_request');
    const outer = fold(maskRequestLiteralData(analysis.outerText)).replace(courtesy, '');
    // Complete CURRENT wording independently requests a view; it supplies no
    // scope for inputs and uses no inherited context.
    if (source.operation === 'lookup' && LOCAL_PC_SURFACE.test(outer) && isCurrentComputerReadRequest(outer))
      return result(action.kind === 'view', 'view_only', 'view_only');
    const positiveLocalTask = PC_TASK.test(outer) && source.source === 'local_state' && source.operation === 'act'
      && (PC_TASK_LOCATION.test(outer) || PC_TASK_OBJECT.test(outer));
    const clearDeletion = CLEAR_DELETE.test(outer) && LOCAL_PC_SURFACE.test(outer)
      && !/\b(?:text|sentence|phrase|story|fiction|example)\b|(?:^|\s)(?:النص|الجمله|العباره|القصه|مثال)(?=\s|$)/u.test(outer);
    return positiveLocalTask || clearDeletion
      ? result(true, 'bounded_current_task', 'bounded_current_task') : result(false, 'none', 'no_current_pc_scope');
  } catch { return result(false, 'none', 'invalid_request'); }
}
