import type { AgentCaptureResult, AgentPage } from '@mohassan/browser';
import { validateChatCapture, type ValidatedChatCapture } from './capture-evidence.js';
import { recognizeRuntimeStatusRequest } from './runtime-status.js';
import { createComputationMemoryReceipt, type ComputationMemoryBinding } from './computation-memory-receipt.js';
import { directRoute } from './brain.js';
import { buildFrame } from './mind/frame.js';
import type { Claim, Evidence } from './mind/contract.js';
import { requestActionText, type RequestResolution } from './request-context.js';
import { requestScopeActionText } from './request-scope.js';
import { memoryRecallFormat, verifyMemoryRecall } from './memory-recall.js';
import { assessRecallCoverage } from './mind/recall.js';
import { explicitKnowledgeDocumentRequest, knowledgeSummaryRequest, matchesKnowledgeTitle } from './knowledge-document-request.js';
import { knowledgeQuoteClaim } from './knowledge-summary.js';
import {
  compileTaskSupervisor, createTaskSupervisor, observeTaskStep, restoreTaskSupervisor,
  reviewTaskCompletion, taskEvidenceHash,
  type TaskCompletionReview, type TaskObservation, type TaskSupervisorState,
} from './task-supervisor.js';

/** Declare only criteria the host actually knows how to check. Other conversation stays unscoped. */
export function createChatSupervisor(id: string, request: string, resolution?: RequestResolution, now = Date.now(), memoryBinding?: ComputationMemoryBinding): TaskSupervisorState {
  if (recognizeRuntimeStatusRequest(requestActionText(requestScopeActionText(request)))) return compileTaskSupervisor({ id, objective: request, mode: 'advisory', now, operation: { kind: 'conversation' } });
  const actionRequest = requestActionText(requestScopeActionText(request));
  const route = directRoute(actionRequest);
  if (route?.finishes) {
    const url = URL.parse(/^https?:\/\//i.test(route.url) ? route.url : `https://${route.url}`);
    if (url && !url.username && !url.password) return compileTaskSupervisor({
      id, objective: request, mode: 'advisory', now,
      operation: { kind: 'navigation', url: url.href, screenshot: route.screenshot },
    });
  }
  const receipt = memoryBinding && memoryBinding.runId === id ? createComputationMemoryReceipt(request, memoryBinding) : null;
  if (receipt) return createTaskSupervisor({ id, objective: request, now, mode: 'advisory', criteria: [{
    id: 'computed-answer', kind: 'answer_evidence', target: `computation:${taskEvidenceHash(request)}`,
    description: 'The final answer preserves the host-verified calculation from this request.',
  }, {
    id: 'computed-memory-save', kind: 'effect', target: `memory:result:${receipt.operationKey}`, expectationHash: receipt.payload.hash,
    description: 'Read-only owner-scoped reconciliation confirms the exact computed payload is actively persisted with its original provenance.',
  }] });
  const frame = buildFrame(actionRequest);
  if (explicitKnowledgeDocumentRequest(actionRequest)) return createTaskSupervisor({ id, objective: request, now, mode: 'advisory', criteria: [{
    id: 'document-answer', kind: 'answer_evidence', target: `knowledge:${taskEvidenceHash(request)}`,
    description: 'The answer uses independently matched excerpts from the requested stored document.',
  }] });
  if (frame.intent === 'memory_recall' || resolution?.kind === 'follow_up' && resolution.intent === 'memory') {
    return compileTaskSupervisor({ id, objective: request, mode: 'advisory', now,
      operation: { kind: 'memory_recall', target: `memory:${taskEvidenceHash(request)}` } });
  }
  if (frame.intent === 'compute' || resolution?.intent === 'compute' && resolution.sourceAssessment?.source === 'supplied_content') return createTaskSupervisor({ id, objective: request, now, mode: 'advisory', criteria: [{
    id: 'computed-answer', kind: 'answer_evidence', target: `computation:${taskEvidenceHash(request)}`,
    description: 'The rendered answer preserves the value and support produced by the local computation service.',
  }] });
  if (frame.intent === 'fact_question') return createTaskSupervisor({ id, objective: request, now, mode: 'advisory', criteria: [{
    id: 'factual-answer', kind: 'answer_evidence', target: `fact:${taskEvidenceHash(request)}`,
    description: 'The source-supported factual answer covers the requested subject and fields.',
  }] });
  return compileTaskSupervisor({ id, objective: request, mode: 'advisory', now, operation: { kind: 'conversation' } });
}

/** A stored snapshot is reusable only for the current host-declared objective. */
export function resumeChatSupervisor(id: string, request: string, value: unknown, resolution?: RequestResolution, now = Date.now(), memoryBinding?: ComputationMemoryBinding): TaskSupervisorState {
  const expected = createChatSupervisor(id, request, resolution, now, memoryBinding);
  return restoreTaskSupervisor(value, expected.contract, { now }) ?? expected;
}

export function observeChatTool(state: TaskSupervisorState, input: {
  tool: string; startedAt: number; result: string; failed?: boolean; unknown?: boolean;
  page?: AgentPage; screenshot?: Buffer | null; now?: number;
}): void {
  const finishedAt = input.now ?? Date.now();
  const startedAt = Math.max(state.startedAt, input.startedAt);
  const observations: TaskObservation[] = [];
  const page = input.page;
  const observedAt = page ? Date.parse(page.observedAt) : NaN;
  const freshPage = page && Number.isFinite(observedAt) && observedAt >= startedAt && observedAt <= finishedAt
    && /^(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(page.hash) && page.id.length > 0 && page.id.length <= 300;
  if (freshPage && Number.isInteger(page.documentStatus) && page.documentStatus! >= 100 && page.documentStatus! <= 599) {
    for (const criterion of state.contract.criteria) {
      if (criterion.kind === 'navigation') observations.push({
        criterionId: criterion.id, kind: 'navigation', source: 'browser-observation', target: page.url,
        reference: page.id, observedAt, contentHash: page.hash, httpStatus: page.documentStatus!,
      });
      // screen() bytes alone are not bound to this observation. The dedicated
      // capture adapter validates the stronger sampled-stability receipt.
    }
  }
  const content = page ? `${page.url}\n${page.hash}\n${input.result}` : input.result;
  observeTaskStep(state, {
    stepId: `${state.contract.id}:${state.lastSequence + 1}`, sequence: state.lastSequence + 1,
    tool: input.tool, startedAt, finishedAt: Math.max(startedAt, finishedAt),
    result: input.failed ? 'failed' : input.unknown ? 'unknown' : 'succeeded',
    ...(content.trim() ? { resultHash: taskEvidenceHash(content) } : {}), observations,
  });
}

/** Bind navigation and a real captured artifact to the same final observation. */
export function observeChatCapture(state: TaskSupervisorState, input: {
  capture: AgentCaptureResult; ownerId: string; conversationId: string;
  requestedPage: Pick<AgentPage, 'id' | 'url' | 'hash'>; startedAt: number; now?: number;
}): ValidatedChatCapture | null {
  const now = input.now ?? Date.now();
  const checked = validateChatCapture(input.capture, { ...input, now });
  const observations: TaskObservation[] = [];
  if (checked) for (const criterion of state.contract.criteria) {
    if (criterion.kind === 'navigation' && Number.isInteger(checked.page.documentStatus)) observations.push({
      criterionId: criterion.id, kind: 'navigation', source: 'browser-observation', target: checked.page.url,
      reference: checked.page.id, observedAt: Date.parse(checked.page.observedAt), contentHash: checked.page.hash,
      httpStatus: checked.page.documentStatus!,
    });
    if (criterion.kind === 'artifact' && criterion.artifactType === 'screenshot') observations.push({
      criterionId: criterion.id, kind: 'artifact', source: 'artifact', target: checked.page.url,
      reference: `capture:${checked.imageHash}`, observedAt: checked.capturedAt,
      artifactType: 'screenshot', artifactHash: checked.imageHash, pageRef: checked.page.id,
    });
  }
  observeTaskStep(state, {
    stepId: `${state.contract.id}:${state.lastSequence + 1}`, sequence: state.lastSequence + 1,
    tool: 'screenshot', startedAt: Math.max(state.startedAt, input.startedAt), finishedAt: Math.max(now, input.startedAt),
    result: checked ? 'succeeded' : 'unknown',
    resultHash: taskEvidenceHash(checked ? `${checked.page.hash}:${checked.imageHash}` : 'capture-unverified'),
    affects: state.contract.criteria.filter(item => item.kind === 'artifact' && item.artifactType === 'screenshot').map(item => item.id),
    observations,
  });
  return checked;
}

/**
 * Checks source alignment for a host-produced local answer. It does not certify
 * arbitrary semantic correctness or trust a model's own claimed support.
 */
export function observeChatLocalAnswer(state: TaskSupervisorState, input: {
  source: 'memory-read' | 'computation' | 'knowledge-verifier'; text: string; claims: readonly Claim[]; evidence: readonly Evidence[];
  status: 'completed' | 'partial' | 'blocked' | 'waiting_user'; startedAt: number; now?: number; contextTopic?: string;
}): void {
  const criterion = state.contract.criteria.find(item => item.kind === 'answer_evidence');
  if (!criterion) return;
  const now = input.now ?? Date.now();
  const objective = actionRequestForCoverage(state.contract.objective);
  const summary = input.source === 'knowledge-verifier' && explicitKnowledgeDocumentRequest(objective) ? knowledgeSummaryRequest(objective) : null;
  const alignedClaims = input.claims.map(claim => claim.text).join('\n') === input.text;
  const sourceAlignment = input.source === 'computation'
    ? input.claims.every(claim => claim.support.some(id => input.evidence.some(item => item.id === id
      && (claim.text === item.quote || item.value !== undefined && claim.text === item.value))))
    : input.claims.every(claim => {
      const quotes = claim.support.flatMap(id => input.evidence.filter(item => item.id === id).map(item => item.quote));
      const format = memoryRecallFormat(state.contract.objective);
      if (format && verifyMemoryRecall(claim.text, format, quotes) === claim.text) return true;
      if (verifyMemoryRecall(claim.text, { kind: 'value' }, quotes) === claim.text) return true;
      if (input.source === 'knowledge-verifier') return claim.support.some(id => input.evidence.some(item => item.id === id && item.title
        && (claim.text === knowledgeQuoteClaim(item.title, item.quote, 'ar', summary?.bullet)
          || claim.text === knowledgeQuoteClaim(item.title, item.quote, 'en', summary?.bullet))));
      return quotes.some(quote => claim.text === `من الذاكرة: «${quote}»` || claim.text === `From memory: «${quote}»`);
    });
  const coversRequestedFact = input.source === 'computation' || (summary
    ? input.evidence.every(item => item.title && matchesKnowledgeTitle(summary.title, item.title))
    : assessRecallCoverage(objective, input.evidence, { contextTopic: input.contextTopic }).status === 'complete');
  const supported = input.status === 'completed' && coversRequestedFact && alignedClaims && sourceAlignment && input.evidence.length > 0 && input.evidence.every(item => item.quote.trim() &&
    item.source === (input.source === 'memory-read' ? 'memory' : input.source === 'computation' ? 'computed' : 'knowledge'))
    && input.claims.length > 0 && input.claims.every(claim =>
      (claim.status === 'confirmed' || claim.status === 'single_source')
      && claim.support.length > 0 && claim.support.every(id => input.evidence.some(item => item.id === id)));
  observeTaskStep(state, {
    stepId: `${state.contract.id}:${state.lastSequence + 1}`, sequence: state.lastSequence + 1,
    tool: input.source === 'computation' ? 'calculate' : input.source === 'memory-read' ? 'memory_search' : 'knowledge_search',
    startedAt: Math.max(state.startedAt, input.startedAt), finishedAt: now, result: supported ? 'succeeded' : 'unknown',
    resultHash: taskEvidenceHash(JSON.stringify(input.evidence)), observations: [{
      criterionId: criterion.id, kind: 'answer_evidence', source: input.source, target: criterion.target,
      reference: `${state.contract.id}:local-answer`, observedAt: now, answerHash: taskEvidenceHash(input.text),
      independentlyVerified: supported, outcome: supported ? 'confirmed' : 'unknown',
    }],
  });
}

const actionRequestForCoverage = (request: string) => requestActionText(requestScopeActionText(request));

export function reviewChatAnswer(state: TaskSupervisorState, text: string, now = Date.now()): TaskCompletionReview {
  return reviewTaskCompletion(state, { now, answerHash: taskEvidenceHash(text) });
}
