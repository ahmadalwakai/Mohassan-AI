import { wilson } from '../conversation-state/review-format.js';
import { checks, type Check, type Language } from './dev-conversations.js';

interface ScoredReply {
  expected: readonly Check[];
  found: readonly Check[];
}

interface Rate {
  count: number;
  total: number;
  wilson95: [number, number] | null;
}

function rate(count: number, total: number): Rate {
  return { count, total, wilson95: total ? wilson(count, total) : null };
}

export function scoreChecks(replies: readonly ScoredReply[]) {
  return checks.map(check => {
    const positives = replies.filter(reply => reply.expected.includes(check));
    const negatives = replies.filter(reply => !reply.expected.includes(check));
    return {
      check,
      caught: rate(positives.filter(reply => reply.found.includes(check)).length, positives.length),
      falseAlarms: rate(negatives.filter(reply => reply.found.includes(check)).length, negatives.length),
    };
  });
}

export function scoreCorpus(replies: readonly (ScoredReply & { language: Language })[]) {
  return {
    all: scoreChecks(replies),
    ar: scoreChecks(replies.filter(reply => reply.language === 'ar')),
    en: scoreChecks(replies.filter(reply => reply.language === 'en')),
  };
}
