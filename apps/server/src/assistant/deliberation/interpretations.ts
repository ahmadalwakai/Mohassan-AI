import { requestContextIntents } from '../request-context.js';
import type { Candidate, DeliberationInput, Interpretation } from './types.js';

const MAX_SPAN = 100_000;

export function buildInterpretations(candidates: readonly Candidate[], input: DeliberationInput): Interpretation[] {
  const { routing, text, previousText } = input;
  const { resolution } = routing;
  const contextual = input.followUp || resolution.kind === 'follow_up';
  const readings: Interpretation[] = [];
  for (const candidate of candidates) {
    if (readings.some(reading => reading.route === candidate.route)) continue;
    const matchesRoute = candidate.route === routing.route || candidate.route === routing.intent;
    const inherited = contextual && matchesRoute;
    const entity = matchesRoute ? input.entity ?? resolution.topic : null;
    const currentStart = text.length - text.trimStart().length;
    const currentEnd = text.trimEnd().length;
    const spans: Interpretation['spans'] = [];
    if (currentEnd > currentStart && currentEnd <= MAX_SPAN) {
      spans.push({ turn: 'current', start: currentStart, end: currentEnd });
      const found = entity ? text.toLowerCase().indexOf(entity.toLowerCase()) : -1;
      if (entity && found >= 0 && found + entity.length <= currentEnd && (found > currentStart || entity.length < currentEnd - currentStart)) {
        spans.push({ turn: 'current', start: found, end: found + entity.length });
      }
    }
    if (inherited && previousText) {
      const found = entity ? previousText.toLowerCase().indexOf(entity.toLowerCase()) : -1;
      const start = found >= 0 ? found : previousText.length - previousText.trimStart().length;
      const end = found >= 0 && entity ? found + entity.length : previousText.trimEnd().length;
      if (end > start && end <= MAX_SPAN) spans.push({ turn: 'previous', start, end });
    }
    const routeIntent = requestContextIntents.find(intent => intent === candidate.route);
    readings.push({
      route: candidate.route,
      intent: matchesRoute ? routing.intent : routeIntent ?? 'unknown',
      scope: routing.sourceAssessment.scope === 'private' ? 'private' : matchesRoute
        ? resolution.scope : ['web_search', 'browser_command', 'news'].includes(candidate.route) ? 'public' : 'unknown',
      request: inherited ? resolution.resolved ?? text : text,
      entity,
      spans,
    });
    if (readings.length === 4) break;
  }
  return readings;
}
