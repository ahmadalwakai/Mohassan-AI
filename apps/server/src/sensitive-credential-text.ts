import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';

const redacted = '[REDACTED]';
const protectedHeader = /\b(?:authorization|proxy-authorization|x-mohassan-internal|x-subscription-token)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9_]/iu;
const cookieHeader = /\b(?:cookie|set-cookie)["'`]?\s*[:=]\s*["'`]?[^\s"'`=;,:]+=/iu;
const authCookie = /\b(?:__Secure-)?better-auth\.session_token["'`]?\s*(?:=|%3d|:)\s*["'`]?[A-Za-z0-9_]/iu;
const privateSetting = /\b(?:APNS_KEY_PATH|APNS_PRIVATE_KEY|(?:WEB_PUSH_)?VAPID_(?:PRIVATE|PUBLIC)_KEY|BRAVE_SEARCH_API_KEY)["'`]?\s*[:=]\s*["'`]?[^\s["'`]/iu;
const credentialQuery = /[?&#](?:access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|authorization|BRAVE_SEARCH_API_KEY|x-subscription-token)=[^&#\s"'`[\]]/iu;
const shareCredential = /\bhttps?:\/\/[^\s<>"'`/]+\/(?:share\/[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])|[^\s<>"'`#]*#invite=[A-Za-z0-9_-]+|#invite=[A-Za-z0-9_-]+)/iu;

function hasNamedCredential(value: string) {
  return protectedHeader.test(value) || cookieHeader.test(value) || authCookie.test(value)
    || privateSetting.test(value) || credentialQuery.test(value) || shareCredential.test(value);
}

export function redactSensitiveCredentialText(value: string): string {
  return hasNamedCredential(value) ? redacted : redactCredentialText(redactSecrets(value));
}

export function containsSensitiveCredentialText(value: string | null | undefined): boolean {
  return Boolean(value && redactSensitiveCredentialText(value) !== value);
}
