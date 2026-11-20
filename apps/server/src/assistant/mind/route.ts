import type { Frame, Source } from './contract.js';

export function route(frame: Frame): Source[] {
  if (frame.personal || frame.intent === 'memory_recall' || frame.intent === 'memory_save') return ['memory'];
  if (frame.intent === 'compute') return ['computed'];
  if (frame.intent === 'open_site' || frame.intent === 'site_check') return ['site'];
  if (frame.urls.length) return ['site', 'index', 'web'];
  if (frame.intent === 'fact_question' || frame.intent === 'compare') {
    return frame.timeSensitive ? ['web'] : ['knowledge', 'index', 'web'];
  }
  return ['fixed'];
}
