import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MODEL_COUNCIL_LIMITS } from '../../apps/server/src/assistant/model-council-limits.ts';

export function memberCouncilPreflightConfig(env: NodeJS.ProcessEnv) {
  if (env.MOHASSAN_MODEL_COUNCIL !== 'all') return undefined;
  const { concurrent, queued } = MODEL_COUNCIL_LIMITS;
  return {
    hasLimits: Number.isSafeInteger(concurrent) && concurrent > 0 && Number.isSafeInteger(queued) && queued > 0,
    modelStore: env.MOHASSAN_MODELS_ROOT?.trim() ?? '',
  };
}

export function memberCouncilModelStorePresent(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
