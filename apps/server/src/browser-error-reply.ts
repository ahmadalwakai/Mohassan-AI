import { replyMessageForError, type ReplyLanguage } from '@mohassan/contracts/reply-messages';
import type { FastifyRequest } from 'fastify';

// Supported language ranges and weights from RFC 4647 §2.1 and RFC 9110 §§12.4.2, 12.5.4 (retrieved 2026-11-27).
// https://www.rfc-editor.org/rfc/rfc4647.html#section-2.1
// https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.4
const supportedRange = /^\s*(ar|en)(?:-[a-z0-9]{1,8})*\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i;

function preferredLanguage(header: string | undefined): ReplyLanguage | undefined {
  let language: ReplyLanguage | undefined;
  let bestWeight = 0;
  for (const range of header?.split(',') ?? []) {
    const match = supportedRange.exec(range);
    if (!match) continue;
    const weight = Number(match[2] ?? 1);
    if (weight > bestWeight) {
      language = match[1].toLowerCase() === 'en' ? 'en' : 'ar';
      bestWeight = weight;
    }
  }
  return language;
}

export function browserApiErrorMessage(error: Error, request: FastifyRequest): string {
  if (!request.routeOptions.url?.startsWith('/api/browser/sessions/')) return error.message;
  const language = preferredLanguage(request.headers['accept-language']);
  return (language && replyMessageForError(error, language)) ?? error.message;
}
