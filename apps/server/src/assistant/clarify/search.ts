import { parseHands, webQuestion } from '../hands.js';

/** Use the ordinary query and limit so the shared engine can reuse its existing cache. */
export function ordinaryClarificationQuery(text: string, history: readonly { role: string; text: string }[]): string | undefined {
  const userTurns = history.filter(turn => turn.role === 'user').map(turn => turn.text).slice(-4);
  const plan = parseHands(text) ?? webQuestion(text, userTurns);
  const step = plan?.length === 1 ? plan[0] : undefined;
  return step?.kind === 'search' && !step.site && !step.here ? step.query : undefined;
}
