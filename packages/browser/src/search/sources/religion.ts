import type { SafeNetwork } from '../../network.js';
import type { PlannedProvider } from '../source-plan.js';
import { hadithProvider } from './religion-hadith.js';
import { quranProvider } from './religion-quran.js';

export function religionProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  return [quranProvider(network, now), hadithProvider(network, now)];
}

/** Append to source-backed replies to requests for a fatwa. */
export function religionScholarNote(language: 'ar' | 'en'): string {
  return language === 'ar'
    ? 'للحصول على فتوى تناسب حالتك، يُرجى الرجوع إلى عالم مؤهل.'
    : 'For a religious ruling specific to your situation, consult a qualified scholar.';
}
