import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactSensitiveCredentialText } from '../apps/server/src/sensitive-credential-text.js';
import { publicSearchText } from '../packages/browser/src/search/local-index.js';

afterEach(() => vi.unstubAllEnvs());

describe('Brave Search credential masks', () => {
  it.each([redactSensitiveCredentialText, redactCredentialText, redactSecrets, publicSearchText])(
    '%s masks the subscription header and server setting by name', mask => {
      const syntheticValue = 'search-credential-marker';
      vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
      expect(mask(`x-subscription-token: ${syntheticValue}`).includes(syntheticValue)).toBe(false);
      expect(mask(JSON.stringify({ BRAVE_SEARCH_API_KEY: syntheticValue })).includes(syntheticValue)).toBe(false);
      expect(mask('Brave Search is optional.')).toBe('Brave Search is optional.');
    },
  );

  it('masks the exact configured key even without a name in search and server text', () => {
    const syntheticValue = 'configured-search-credential-marker&opaque-suffix';
    vi.stubEnv('BRAVE_SEARCH_API_KEY', syntheticValue);
    const text = `A diagnostic includes ${syntheticValue}.`;
    expect(publicSearchText(text)).toBe('A diagnostic includes [REDACTED].');
    expect(redactSensitiveCredentialText(text)).toBe('A diagnostic includes [مفتاح محجوب].');
    expect(redactSecrets(`x-subscription-token: ${syntheticValue}`)).toBe('x-subscription-token: [مفتاح محجوب]');
  });
});
