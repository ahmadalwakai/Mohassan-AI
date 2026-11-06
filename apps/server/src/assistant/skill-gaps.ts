import { BrowserError } from '@mohassan/browser';
import type { SkillGapSignal } from '@mohassan/contracts';
import { ProviderError } from '@mohassan/providers';
import { SkillError, classifyGap } from '@mohassan/skills';

const modelLimits = new Set(['INCOMPLETE_RESPONSE', 'RESPONSE_TOO_LARGE', 'SCHEMA_TOO_LARGE', 'IMAGE_TOO_LARGE']);
const browserEnvironment = new Set(['ASSISTANT_UNCONFIGURED', 'AGENT_BROWSER_UNAVAILABLE']);

/** Only errors produced by trusted boundaries can contribute an observation.
 * The shared classifier rejects unknown/ambiguous codes and keeps no message. */
export function trustedSkillGapSignal(error: unknown): SkillGapSignal | null {
  let signal: SkillGapSignal;
  if (error instanceof ProviderError) signal = { source: modelLimits.has(error.code) ? 'model' : 'environment', code: error.code };
  else if (error instanceof BrowserError) signal = { source: browserEnvironment.has(error.code) ? 'environment' : 'tool', code: error.code };
  else if (error instanceof SkillError) signal = { source: 'planner', code: error.code };
  else return null;
  return classifyGap(signal).signal;
}
