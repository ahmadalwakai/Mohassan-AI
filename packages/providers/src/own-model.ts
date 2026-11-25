import type { PermanentModelWorker } from '../../execution-integration/src/permanent-worker.js';
import { ModelTransportError, type ModelIdentity } from '../../execution-integration/src/transport.js';
import { ProviderError, redactSecrets, type ModelProvider, type ModelRequest, type ModelResult } from './index.js';

const OPTION_CODES = 'ABCDEFGHIJKLMNOP';
const MAX_MESSAGE_LENGTH = 8_000;
const UNSUPPORTED_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\p{Surrogate}]/u;
type Worker = Pick<PermanentModelWorker, 'status' | 'request'>;
type Capability = 'generation' | 'decisions';

interface OwnModelProviderOptions {
  worker: () => Worker | undefined;
  head?: string;
  scoreHead?: string;
  timeoutMs?: number;
}

export interface OwnModelDecisionCalibration {
  temperature: number;
  minConfidence: number;
  minMargin: number;
}

interface OwnModelDecisionRequest<T extends string> {
  goal: string;
  system?: string;
  options: readonly { id: T; label: string }[];
  calibration: OwnModelDecisionCalibration;
  signal?: AbortSignal;
  expectedConfigSha256?: string;
}

type OwnModelRequest = ModelRequest & { expectedConfigSha256?: string };
export type OwnModelHealth = { state: 'unavailable' } | {
  state: 'ready';
  identity: ModelIdentity;
  configSha256?: string;
  generation: boolean;
  decisions: boolean;
};

function rejected(): ProviderError {
  return new ProviderError('REQUEST_REJECTED', 'الطلب غير صالح لنموذج موحسن المحلي.');
}

function unavailable(): ProviderError {
  return new ProviderError('MODEL_UNAVAILABLE', 'نموذج موحسن المحلي غير متاح.');
}

function invalidResponse(): ProviderError {
  return new ProviderError('INVALID_RESPONSE', 'رد نموذج موحسن المحلي غير صالح.');
}

function translateError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof ModelTransportError)) return unavailable();
  switch (error.code) {
    case 'timeout': return new ProviderError('TIMEOUT', 'انتهت مهلة نموذج موحسن المحلي.');
    case 'cancelled': return new ProviderError('ABORTED', 'أُلغي طلب نموذج موحسن المحلي.');
    case 'invalid_request': return rejected();
    case 'invalid_model_output': return invalidResponse();
    default: return unavailable();
  }
}

function message(goal: string, system?: string): string {
  if (!goal.trim() || goal.length > MAX_MESSAGE_LENGTH * 2 || (system?.length ?? 0) > MAX_MESSAGE_LENGTH * 2) throw rejected();
  const text = system?.trim() ? `${system}\n\n${goal}` : goal;
  if (Array.from(text).length > MAX_MESSAGE_LENGTH || UNSUPPORTED_TEXT.test(text)) throw rejected();
  return redactSecrets(text);
}

/** The local worker uses the same conversation framing and tokenizer as training. */
export class OwnModelProvider implements ModelProvider {
  readonly id = 'own-model';
  readonly supportsImages = false;
  private readonly head: string;
  private readonly scoreHead: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OwnModelProviderOptions) {
    this.head = options.head ?? 'lm';
    this.scoreHead = options.scoreHead ?? 'options';
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new ProviderError('NOT_CONFIGURED', 'مهلة نموذج موحسن المحلي غير صالحة.');
  }

  health(): OwnModelHealth {
    const status = this.options.worker()?.status;
    if (status?.state !== 'ready' || status.ready.text !== true) return { state: 'unavailable' };
    const { identity, configSha256, heads } = status.ready;
    const generation = heads[this.head] === 'generate';
    const decisions = heads[this.scoreHead] === 'score-options';
    return generation || decisions ? { state: 'ready', identity, configSha256, generation, decisions } : { state: 'unavailable' };
  }

  private available(capability: Capability, signal?: AbortSignal, expectedConfigSha256?: string) {
    if (signal?.aborted) throw new ProviderError('ABORTED', 'أُلغي طلب نموذج موحسن المحلي.');
    const worker = this.options.worker();
    const status = worker?.status;
    const head = capability === 'generation' ? this.head : this.scoreHead;
    const kind = capability === 'generation' ? 'generate' : 'score-options';
    if (!worker || status?.state !== 'ready' || status.ready.text !== true || status.ready.heads[head] !== kind
      || (expectedConfigSha256 !== undefined && status.ready.configSha256 !== expectedConfigSha256)) throw unavailable();
    return { worker, ready: status.ready, head, timeoutMs: Math.min(this.timeoutMs, status.ready.limits.maxTimeoutMs) };
  }

  async choose<T extends string>(request: OwnModelDecisionRequest<T>): Promise<{ option: T | null; confidence: number }> {
    const { options, calibration, signal, expectedConfigSha256 } = request;
    const { temperature, minConfidence, minMargin } = calibration;
    const probability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
    if (options.length < 2 || options.length > OPTION_CODES.length || new Set(options.map(({ id }) => id)).size !== options.length
      || options.some(({ id, label }) => !id.trim() || !label.trim() || label.length > 320 || UNSUPPORTED_TEXT.test(label))
      || !Number.isFinite(temperature) || temperature <= 0 || !probability(minConfidence) || !probability(minMargin)) throw rejected();
    const text = message(`${request.goal}\n\nChoose one of these options. Reply with its letter only.\n${JSON.stringify(options.map(
      ({ label }, index) => ({ letter: OPTION_CODES[index], label }),
    ))}`, request.system);
    const { worker, head, timeoutMs } = this.available('decisions', signal, expectedConfigSha256);
    // Byte BPE assigns ASCII bytes to their literal token IDs. Equal token lengths
    // avoid bias toward labels with shorter tokenizations.
    const result = await worker.request({ operation: 'score-options', head, input: {
      text, options: options.map((_, index) => [OPTION_CODES.charCodeAt(index)]),
    }, timeoutMs, signal }).catch(error => { throw translateError(error); });
    const scores = result.scores;
    if (!Array.isArray(scores) || scores.length !== options.length
      || !scores.every((score): score is number => typeof score === 'number' && Number.isFinite(score) && score <= 0)) throw invalidResponse();
    const best = Math.max(...scores);
    const weights = scores.map(score => Math.exp((score - best) / temperature));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const winner = scores.indexOf(best);
    const next = Math.max(...weights.filter((_, index) => index !== winner));
    const confidence = 1 / total;
    const margin = (1 - next) / total;
    return { option: margin > 0 && margin >= minMargin && confidence >= minConfidence ? options[winner].id : null, confidence };
  }

  generate(request: OwnModelRequest): Promise<ModelResult> {
    return this.generateText(request);
  }

  /** Stream provisional text to internal consumers. Evidence review happens before publication. */
  generateStream(request: OwnModelRequest, onUnreviewedChunk: (chunk: string) => void): Promise<ModelResult> {
    return this.generateText(request, onUnreviewedChunk);
  }

  private async generateText(request: OwnModelRequest, onChunk?: (chunk: string) => void): Promise<ModelResult> {
    if (request.image) throw new ProviderError('IMAGE_UNSUPPORTED', 'نموذج موحسن المحلي لا يقرأ الصور.');
    if (request.structured) throw new ProviderError('STRUCTURED_UNSUPPORTED', 'نموذج موحسن المحلي لا يولد نتائج مهيكلة.');
    const { signal, expectedConfigSha256 } = request;
    const text = message(request.goal, request.system);
    const { worker, ready, head, timeoutMs } = this.available('generation', signal, expectedConfigSha256);
    const maxNewTokens = request.maxTokens ?? Math.min(48, ready.limits.maxOutputTokens);
    if (!Number.isSafeInteger(maxNewTokens) || maxNewTokens < 1 || maxNewTokens > ready.limits.maxOutputTokens) throw rejected();
    const result = await worker.request({ operation: 'generate', head, input: { text, maxNewTokens }, timeoutMs, signal,
      onToken: onChunk && (token => { if (token.text) onChunk(token.text); }),
    }).catch(error => { throw translateError(error); });
    const { text: output, tokenIds, stopReason, inputTokens } = result;
    if (!Array.isArray(tokenIds) || typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens <= 0
      || typeof output !== 'string') throw invalidResponse();
    const usage = { inputTokens, outputTokens: tokenIds.length };
    if (stopReason !== 'eos') {
      const error = new ProviderError('INCOMPLETE_RESPONSE', 'لم تكتمل نتيجة نموذج موحسن المحلي ضمن الحد المسموح.');
      error.usage = usage;
      throw error;
    }
    const cleaned = redactSecrets(output.trim());
    if (!cleaned || UNSUPPORTED_TEXT.test(cleaned) || /\uFFFD/u.test(cleaned)) {
      const error = invalidResponse();
      error.usage = usage;
      throw error;
    }
    return { text: cleaned, model: ready.identity.modelId, provider: this.id, usage };
  }
}
