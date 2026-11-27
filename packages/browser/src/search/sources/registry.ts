import type { SafeNetwork } from '../../network.js';
import type { PlannedProvider } from '../source-plan.js';

export const plannedProviderFactories: readonly ((network: SafeNetwork, now: () => number) => PlannedProvider[])[] = [];
