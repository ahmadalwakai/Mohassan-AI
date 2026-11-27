import type { SafeNetwork } from '../../network.js';
import type { PlannedProvider } from '../source-plan.js';
import { nominatimProvider } from './travel-nominatim.js';
import { wikivoyageProviders } from './travel-wikivoyage.js';

export function travelProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  return [...wikivoyageProviders(network, now), nominatimProvider(network, now)];
}
