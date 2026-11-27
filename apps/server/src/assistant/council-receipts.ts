import type { CouncilRole } from './council-scheduler.js';

export type CouncilLanguage = 'ar' | 'en' | 'other';
export type CouncilDomain = 'reading' | 'date' | 'place' | 'population' | 'arithmetic' | 'image' | 'ads' | 'code' | 'general';

export interface CouncilWeight {
  weight: number;
  weightSource: string;
  measured: boolean;
}

// Exact-match percentages and sample sizes from the forced-answer evaluation in §1.7, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/RESPONSE-QUALITY-RESULTS-2026-11-22.md#L274-L290
// The Arabic weight pools the two Arabic sets in proportion to their documented sample sizes.
const readingExactMatch = new Map([
  ['reading-v3-last', { tydi: 41.4, arcd: 10.6, squad: 16.8 }],
  ['reading-v4-head', { tydi: 7.4, arcd: 1.6, squad: 3.5 }],
  ['reading-v4-lora', { tydi: 44.9, arcd: 11.6, squad: 13.8 }],
  ['reading-v4-last2', { tydi: 25.5, arcd: 7.2, squad: 8.2 }],
]);
const tydiExamples = 903;
const arcdExamples = 696;
const squadExamples = 487;

/** Only a receipt that covers the model, role, domain, language, and decision metric has positive weight. */
export function councilWeight(member: string, role: CouncilRole | 'pipeline', language: CouncilLanguage, domain: CouncilDomain): CouncilWeight {
  const reading = readingExactMatch.get(member);
  if (role === 'reader' && domain === 'reading' && reading && language !== 'other') {
    const ar = language === 'ar';
    const percent = ar ? (reading.tydi * tydiExamples + reading.arcd * arcdExamples) / (tydiExamples + arcdExamples) : reading.squad;
    const sample = ar ? `TyDi Arabic + ARCD (n=${tydiExamples + arcdExamples})` : `SQuAD (n=${squadExamples})`;
    return {
      weight: percent / 100,
      weightSource: `2026-11-22 reading T1 §1.7 forced exact match, ${sample}`,
      measured: true,
    };
  }
  return { weight: 0, weightSource: `Minimum weight: no measured accuracy receipt for ${role}/${domain}/${language}`, measured: false };
}
