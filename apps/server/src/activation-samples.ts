import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';

const hidden = '[محجوب]';

export function redactActivationText(text: string, secrets: readonly string[] = []) {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) text = text.split(secret).join(hidden);
  }
  const stripped = text.replace(/\b(?:https?|ftp):\/\/[^\s<>"']+/gi, hidden)
    .replace(/\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:\s*[^\r\n]+/gi, hidden)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, hidden);
  return redactCredentialText(redactSecrets(stripped))
    .replace(/(?:\b(?:password|passphrase|pin|otp|cookie|authorization|token|api[_ -]?key|secret)\b|كلمة المرور|رمز التحقق|مفتاح الواجهة)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, hidden)
    .replace(/\b(?:gh[opurs]_|github_pat_|AIza|xox[baprs]-)[A-Za-z0-9_-]+\b/g, hidden)
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, hidden)
    .replace(/\[REDACTED\]/g, hidden)
    .slice(0, 4000);
}
