import type { Frame } from './mind/contract.js';
import { fixedReply, limits, type LocalReply } from './mind/limits.js';
import type { RequestRoutingDecision } from './routing-decision.js';
import { unsupportedReply } from './unsupported-request.js';

export function scratchLocalReply(frame: Frame, routing?: Pick<RequestRoutingDecision, 'reason'>): LocalReply | null {
  if (routing?.reason === 'scratch_speech_act') return limits({ ...frame, intent: 'smalltalk' });
  if (routing?.reason !== 'scratch_refuse' && routing?.reason !== 'scratch_out_of_scope') return null;
  return fixedReply(unsupportedReply({ kind: routing.reason === 'scratch_refuse' ? 'safety' : 'generic', lang: frame.lang }), 'blocked');
}
