import { isAbsolute } from 'node:path';
import { assessRequestScope, requestCapabilityAllowed, type UserRequestConstraints } from './request-scope.js';

export async function tryOfflineKnowledge(
  request: string,
  action: string,
  constraints: UserRequestConstraints | null,
  publish: (text: string) => Promise<void>,
): Promise<boolean> {
  if (process.env.MOHASSAN_OFFLINE_KNOWLEDGE !== '1') return false;
  const databasePath = process.env.MOHASSAN_OFFLINE_KNOWLEDGE_STORE;
  if (!databasePath || !isAbsolute(databasePath) || !requestCapabilityAllowed(constraints, 'knowledge_read')) return false;
  const source = assessRequestScope(request);
  if (source.scope !== 'public' || source.operation !== 'lookup' || source.source !== 'public_lookup') return false;

  let answer: string | undefined;
  try {
    const { answerOfflineQuestion } = await import('@mohassan/knowledge-base');
    answer = answerOfflineQuestion(databasePath, action);
  } catch {
    // An unavailable or unreadable snapshot is a lookup miss.
    return false;
  }
  if (!answer) return false;
  await publish(answer);
  return true;
}
