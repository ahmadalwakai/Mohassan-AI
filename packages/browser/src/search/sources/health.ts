import type { SafeNetwork } from '../../network.js';
import type { PlannedProvider } from '../source-plan.js';
import { createMedlinePlusProvider } from './health-medlineplus.js';
import { createHealthRequester } from './health-network.js';
import { createWhoEditorialProviders } from './health-who-editorial.js';
import { createWhoGhoProvider } from './health-who.js';

export type { HealthHit } from './health-utils.js';

export function healthSafetyNote(language: 'ar' | 'en'): string {
  return language === 'ar'
    ? 'هذه معلومات عامة وليست استشارة طبية؛ راجع طبيباً لحالتك.'
    : 'This is general information and does not constitute medical advice, so consult a doctor about your condition.';
}

export function healthProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const request = createHealthRequester(network, now);
  // NCBI documents PubMed E-utilities, but their published robots policy
  // disallows all crawler paths: https://eutils.ncbi.nlm.nih.gov/robots.txt (2026-11-27).
  return [
    ...createWhoEditorialProviders(request, now),
    createMedlinePlusProvider(request),
    createWhoGhoProvider(request, now),
  ];
}
