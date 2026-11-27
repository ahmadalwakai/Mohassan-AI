import { BrowserError } from '@mohassan/browser';
import { replyMessages, requestLanguage, terminalErrorMessage } from '@mohassan/contracts/reply-messages';
import { ProviderError } from '@mohassan/providers';
import { chatModelFailure } from './model-failure.js';

export function runFailureReply(request: string, limit: boolean, error: unknown): { message: string; diagnostic: string } {
  const lang = requestLanguage(request);
  const failure = !limit && (error instanceof ProviderError ? chatModelFailure(error) : error);
  if (failure instanceof BrowserError) {
    return {
      diagnostic: failure.message,
      message: terminalErrorMessage(failure, lang),
    };
  }
  const copy = limit ? replyMessages.runTimeLimit : replyMessages.runFailure;
  return { message: copy[lang], diagnostic: copy.ar };
}
