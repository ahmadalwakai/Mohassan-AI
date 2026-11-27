import { replyMessages, requestLanguage, withReplyMessage, type ReplyMessageKey } from '@mohassan/contracts/reply-messages';
import { BrowserError } from './network.js';

export function browserEngineError(code: string, key: ReplyMessageKey, status?: number, diagnostic?: string): BrowserError {
  const text = replyMessages[key];
  const error = new BrowserError(code, diagnostic ?? text.ar, status);
  return withReplyMessage(error, diagnostic && requestLanguage(diagnostic) === 'ar' ? { ar: diagnostic, en: text.en } : key);
}
