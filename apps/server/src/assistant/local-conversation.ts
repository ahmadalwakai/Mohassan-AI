import { buildFrame } from './mind/frame.js';
import { limits, type LocalReply } from './mind/limits.js';
import { matchText, normalizeRequest, stripCourtesyTail } from './mind/normalize.js';
import { scratchLocalReply } from './scratch-reply.js';
import type { RequestRoutingDecision } from './routing-decision.js';

const IDENTITY = /^(?:who (?:are you|made you|created you|developed you|built you|developed this (?:app|application))|what (?:are you|is your name)|what['’]s your name|what are you called|introduce yourself|tell me (?:your name|about yourself)|من انت|انت مين|مين انت|ما اسمك|وش اسمك|ايش اسمك|من (?:صنعك|طورك|انشاك|برمجك)|من (?:صنع|طور|انشا|برمج) (?:هذا )?التطبيق|عرف بنفسك|عرف نفسك|قدم نفسك|اذكر اسمك(?: فقط)?)(?:\s+(?:يا موحسن|mohassan))?[\s.!?؟،,]*$/iu;

/** Fixed application facts and standalone greetings need no model or public lookup. */
export function evaluateLocalConversation(request: string, routing?: Pick<RequestRoutingDecision, 'reason'>): LocalReply | null {
  if (!request.trim() || request.length > 4000) return null;
  const frame = buildFrame(request);
  const learnedReply = scratchLocalReply(frame, routing);
  if (learnedReply?.status === 'blocked') return learnedReply;
  if (frame.intent === 'smalltalk') return limits(frame);
  const normalized = normalizeRequest(request);
  const text = stripCourtesyTail(matchText(normalized.text));
  if (!IDENTITY.test(text)) return learnedReply;
  const nameOnly = /^(?:اذكر اسمك|ما اسمك|وش اسمك|ايش اسمك)|\b(?:your name|called)\b/iu.test(text);
  return limits({ ...frame, intent: 'identity', valueOnly: frame.valueOnly || nameOnly });
}
