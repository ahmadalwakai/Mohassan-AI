import { randomUUID } from 'node:crypto';
import { SafeNetwork } from '@mohassan/browser';
import { describe, expect, it } from 'vitest';
import { planLongRun } from '../apps/server/src/assistant/long-run/host.js';
import { initialLongRunState, LONG_RUN_WORKER } from '../apps/server/src/assistant/long-run/state.js';
import { backgroundRunView } from '../apps/server/src/assistant/long-run/view.js';

describe('durable work credential privacy', () => {
  it('does not admit a capability link as a public monitoring source', () => {
    const syntheticCapability = 'x'.repeat(22);
    const task = `Monitor https://example.test/share/${syntheticCapability} for 20 minutes.`;
    expect(planLongRun(task, {}, new SafeNetwork())).toBeNull();
  });

  it('keeps a credential-bearing goal private in the view of an existing background run', () => {
    const id = randomUUID();
    const at = Date.UTC(2026, 10, 25, 10, 0);
    const state = initialLongRunState(id, { language: 'en', background: { replyLength: 'short' },
      steps: [{ kind: 'search', query: 'tidal power' }] }, at);
    const syntheticValue = 'background-view-fixture-marker';
    const view = backgroundRunView({ id, worker_id: LONG_RUN_WORKER, status: 'running', state, created_at: new Date(at),
      goal: `Cookie: fixture_session=${syntheticValue}` }, id);
    expect(JSON.stringify(view).includes(syntheticValue)).toBe(false);
    expect(view.backgroundRun).toMatchObject({ id, task: '[REDACTED]', step: 'Find public sources' });
  });
});
