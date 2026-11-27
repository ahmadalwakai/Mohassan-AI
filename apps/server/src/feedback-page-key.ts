import { safeResumeUrl } from '@mohassan/browser';
import { containsSensitiveCredentialText } from './sensitive-credential-text.js';

/** A feedback rule identifies a page, without storing fragments or tracking parameters. */
export function feedbackPageKey(input: string): string | null {
  try {
    if (containsSensitiveCredentialText(input) || containsSensitiveCredentialText(decodeURIComponent(input))) return null;
    const url = new URL(input);
    const fragment = url.hash.slice(1);
    url.hash = '';
    if (!safeResumeUrl(url.href) || (fragment && !safeResumeUrl('https://review.invalid/?' + fragment))) return null;
    const parameters = url.search.slice(1).split('&');
    const retained = parameters.filter(parameter => !/^(?:utm_.+|fbclid|gclid|msclkid)$/iu.test(
      new URLSearchParams(parameter).keys().next().value ?? '',
    ));
    if (retained.length !== parameters.length) url.search = retained.join('&');
    return url.href;
  } catch {
    return null;
  }
}

export function safeFeedbackText(value: string | null | undefined): string | null {
  if (!value || containsSensitiveCredentialText(value)) return null;
  const urls = value.match(/https?:\/\/[^\s<>«»"'`\]]+/giu) ?? [];
  return urls.every(url => feedbackPageKey(url) !== null) ? value : null;
}
