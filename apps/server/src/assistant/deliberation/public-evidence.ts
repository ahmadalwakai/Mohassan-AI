import { requestOperationText } from '../request-scope.js';

// Public lookup cannot complete actions in personal accounts or an active player.
// Treat command forms as conflicting scope evidence even when the web fallback matched.
const serviceCommandLead = /^(?:i\s+(?:want|need|would like)\s+(?:(?:you\s+)?to\s+)?|(?:(?:may|can|could|would|will)\s+(?:you|we)|let['’]s)\s+)+/iu;
const unsupportedServiceCommand =
  /^(?:(?:freeze|unfreeze|block|unblock|lock|unlock|stop|close|cancel|suspend|put|place)\b[^.!?\n]{0,100}\b(?:my|our)\b[^.!?\n]{0,60}\b(?:account|card|payment)\b|(?:play|skip|pause|resume|stop|change)\b[^.!?\n]{0,70}\b(?:song|track|playlist|tune|music|media)\b|(?:next|previous)\s+(?:song|track)\b|(?:text|whatsapp|message)\s+[\p{L}\p{N}]+|send\b[^.!?\n]{0,70}\b(?:text|sms|message|email)\b)/iu;

export function requestsUnsupportedServiceAction(text: string): boolean {
  return unsupportedServiceCommand.test(requestOperationText(text).replace(serviceCommandLead, ''));
}

const weatherWord = /\b(?:weather|forecast)\b/iu;
const weatherScaffolding = new Set([
  'a', 'about', 'and', 'are', 'be', 'can', 'could', 'current', 'day', 'do', 'does', 'expect', 'for', 'forecast', 'get', 'give',
  'going', 'gonna', 'have', 'how', 'i', 'in', 'is', 'it', 'know', 'let', 'like', 'look', 'looking', 'me', 'need', 'now',
  'of', 'out', 'outside', 'please', 'right', 's', 'see', 'show', 'tell', 'the', 'this', 'to', 'today', 'tomorrow',
  'tonight', 'upcoming', 'want', 'weather', 'week', 'weekend', 'what', 'whats', 'will', 'would', 'you',
]);

/** A forecast needs a place. Unknown words are left to the existing place/entity parser. */
export function unlocatedForecast(text: string): boolean {
  if (!weatherWord.test(text)) return false;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.length > 0 && words.every(word => weatherScaffolding.has(word));
}
