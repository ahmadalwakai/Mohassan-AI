import { describe, expect, it } from 'vitest';
import { ProviderError } from '@mohassan/providers';
import { chatModelFailure, failureCauses } from '../apps/server/src/assistant/model-failure.ts';
import { classifyFailure } from '../apps/server/src/assistant/recovery.ts';

const GENERIC = 'تعذر الوصول إلى النموذج الآن';
const none = (causes: string[], last?: ProviderError, retryable = false) => {
  const error = new ProviderError('NO_ELIGIBLE_PROVIDER', 'لا يوجد مزود نموذج مؤهل متبقٍ لهذا الطلب.', retryable);
  error.causes = causes;
  if (last) error.cause = last;
  return error;
};

describe('chat model failure naming', () => {
  it('reports a closed FreeLLMAPI gateway as such, on the first request and inside the cool-down', () => {
    // The reported case: the lab's FreeLLMAPI URL is an SSH tunnel that was not open.
    const first = chatModelFailure(none(['GATEWAY_UNREACHABLE', 'GATEWAY_UNREACHABLE'], new ProviderError('GATEWAY_UNREACHABLE', 'refused'), true));
    const cooling = chatModelFailure(none(['GATEWAY_UNREACHABLE', 'GATEWAY_UNREACHABLE']));
    for (const failure of [first, cooling]) {
      expect(failure.code).toBe('CHAT_GATEWAY_UNREACHABLE');
      expect(failure.message).toContain('FreeLLMAPI');
      expect(failure.message).toContain('«المجاني فقط»');
      expect(failure.message).not.toContain(GENERIC);
      // Not "busy": waiting alone does not open a tunnel.
      expect(failure.message).not.toContain('مشغولة');
    }
    expect(classifyFailure(first)).toMatchObject({ category: 'provider', retryable: false, strategy: 'stop_and_report' });
  });

  it('tells a connected gateway without provider keys apart from an unconfigured server', () => {
    const failure = chatModelFailure(none(['GATEWAY_NO_PROVIDERS', 'GATEWAY_NO_PROVIDERS']));
    expect(failure.code).toBe('CHAT_GATEWAY_NO_PROVIDERS');
    expect(failure.message).toContain('Keys');
    expect(failure.message).not.toContain('على الخادم');
    expect(classifyFailure(failure)).toMatchObject({ retryable: false, strategy: 'stop_and_report' });
  });

  it('keeps a real rate limit as busy and names other causes by priority', () => {
    expect(chatModelFailure(none(['RATE_LIMITED'], undefined, true)).code).toBe('ASSISTANT_MODEL_BUSY');
    expect(chatModelFailure(none(['COOLING_DOWN'])).code).toBe('ASSISTANT_MODEL_BUSY');
    expect(chatModelFailure(none(['RATE_LIMITED', 'AUTHENTICATION_FAILED'])).code).toBe('CHAT_PROVIDER_REJECTED');
    expect(chatModelFailure(new ProviderError('NOT_CONFIGURED', 'x')).code).toBe('CHAT_PROVIDER_NOT_CONFIGURED');
    expect(chatModelFailure(new ProviderError('MODEL_UNAVAILABLE', 'x')).code).toBe('CHAT_MODEL_UNAVAILABLE');
    expect(chatModelFailure(new ProviderError('ABORTED', 'x')).code).toBe('CHAT_PROVIDER_UNREACHABLE');
    expect(chatModelFailure(new ProviderError('INVALID_RESPONSE', 'x')).code).toBe('CHAT_MODEL_INVALID');
  });

  it('separates a policy exclusion from a failure, and never shows provider text', () => {
    const policy = chatModelFailure(none([]));
    expect(policy.code).toBe('CHAT_NO_ELIGIBLE_PROVIDER');
    const unknown = chatModelFailure(new ProviderError('SOMETHING_NEW', 'raw upstream text with a secret gsk_abcdefghijklmnop'));
    expect(unknown.code).toBe('CHAT_PROVIDER_FAILED');
    expect(unknown.message).toContain('SOMETHING_NEW');
    expect(unknown.message).not.toContain('gsk_');
    expect(failureCauses(none(['RATE_LIMITED'], new ProviderError('RATE_LIMITED', 'x')))).toEqual(['RATE_LIMITED']);
  });
});
