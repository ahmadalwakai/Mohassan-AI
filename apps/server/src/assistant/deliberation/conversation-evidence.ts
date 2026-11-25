import { unlocatedForecast } from './public-evidence.js';
import { emptyConversationState, understandTurn, withPending, type ConversationStateV2, type PendingStep } from '../conversation-state.js';

const followUpTypes = new Set(['follow_up_property', 'follow_up_entity', 'reference', 'correction', 'field_edit']);

/** Reuses v2's pure turn parser. It does not advance or wait for the shadow observer. */
export function conversationEvidence(text: string, turnId: string, state?: ConversationStateV2,
  previousTurns: readonly { id: string; text: string }[] = [], pending?: PendingStep | null) {
  let previousState = state ?? emptyConversationState();
  if (!state) for (const turn of previousTurns.slice(-8)) previousState = understandTurn(previousState, turn.text, turn.id).next;
  const understanding = understandTurn(withPending(previousState, pending ?? null), text, turnId);
  const entityTurn = understanding.next.topics.find(topic => topic.entity === understanding.entity)?.sourceTurnId;
  const previousText = (entityTurn ? previousTurns.find(turn => turn.id === entityTurn) : null)?.text
    ?? previousTurns.at(-1)?.text ?? null;
  return {
    followUp: followUpTypes.has(understanding.type),
    entity: understanding.entity,
    previousText,
    missingLocation: understanding.property === 'weather' && !understanding.entity && !understanding.place
      || !followUpTypes.has(understanding.type) && unlocatedForecast(text),
  };
}
