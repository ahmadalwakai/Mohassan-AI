import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';

const redacted = '[REDACTED]';
const protectedHeader = /\b(?:authorization|proxy-authorization|x-mohassan-internal)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9_]/iu;
const cookieHeader = /\b(?:cookie|set-cookie)["'`]?\s*[:=]\s*["'`]?[^\s"'`=;,:]+=/iu;
const authCookie = /\b(?:__Secure-)?better-auth\.session_token["'`]?\s*(?:=|%3d|:)\s*["'`]?[A-Za-z0-9_]/iu;
const pushSetting = /\b(?:APNS_KEY_PATH|APNS_PRIVATE_KEY|(?:WEB_PUSH_)?VAPID_(?:PRIVATE|PUBLIC)_KEY)["'`]?\s*[:=]\s*["'`]?[^\s["'`]/iu;
// The export already protects generic token query parameters (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/member-data-export.ts#L42
const credentialQuery = /[?&#](?:token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|authorization)=[^&#\s"'`[\]]/iu;
// OAuth token fields are quoted in JSON responses (retrieved 2026-11-27).
// https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1
const jsonToken = /"(?:access_token|refresh_token)"\s*:\s*"[^"\s[]/iu;
const shareCredential = /\bhttps?:\/\/[^\s<>"'`/]+\/(?:share\/[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])|[^\s<>"'`#]*#invite=[A-Za-z0-9_-]+|#invite=[A-Za-z0-9_-]+)/iu;

function hasNamedCredential(value: string) {
  return protectedHeader.test(value) || cookieHeader.test(value) || authCookie.test(value)
    || pushSetting.test(value) || credentialQuery.test(value) || jsonToken.test(value) || shareCredential.test(value);
}

export function redactSensitiveCredentialText(value: string): string {
  return hasNamedCredential(value) ? redacted : redactCredentialText(redactSecrets(value));
}

export function containsSensitiveCredentialText(value: string | null | undefined): boolean {
  return Boolean(value && redactSensitiveCredentialText(value) !== value);
}
