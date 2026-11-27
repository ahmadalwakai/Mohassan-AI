import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { type BrainState } from '../apps/server/src/assistant/brain.js';
import { createModelRelationsObserver } from '../apps/server/src/assistant/model-relations-shadow.js';
import { ModelRelationsManager } from '../packages/model-relations/src/manager.js';
import type { ModelRunResult } from '../packages/model-relations/src/runtime.js';

describe('published chat model relations', () => {
  it('schedules a decision receipt off the publication path and omits private content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-relations-shadow-'));
    const logFile = join(directory, 'shadow.jsonl');
    try {
      const run = vi.fn(async (): Promise<ModelRunResult> => ({ ok: false, reason: 'absent', elapsedMs: 1 }));
      const manager = new ModelRelationsManager({ run }, { hashKey: 'fixture' });
      const inspector = vi.fn(async () => manager);
      const observe = createModelRelationsObserver({ env: {}, logFile, inspector });
      const state = {
        routing: { route: 'unsupported', reason: 'request_refused' },
      } as BrainState;
      expect(observe('private-turn-id', state, { request: 'private request text' }, 'private response text', 'blocked')).toBeUndefined();
      expect(inspector).not.toHaveBeenCalled();
      const raw = await vi.waitFor(() => readFile(logFile, 'utf8'));
      expect(raw).not.toContain('private');
      const decision = JSON.parse(raw);
      expect(decision).toMatchObject({
        event: 'model_relations_turn', mode: 'shadow', language: 'en',
        arbitration: { winner: 'existing-rules', reason: 'host-refusal' },
        stages: expect.arrayContaining([expect.objectContaining({
          stage: 'refusal', models: expect.arrayContaining([expect.objectContaining({ outcome: 'absent' })]),
        })]),
      });
      expect(decision.schedulingMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('skips observations entirely when turned off', async () => {
    const inspector = vi.fn(async () => { throw new Error('unexpected initialization'); });
    const observe = createModelRelationsObserver({ env: { MOHASSAN_MODEL_RELATIONS: 'off' }, inspector });
    observe('id', {} as BrainState, { request: 'test' }, 'reply', 'completed');
    await setImmediate();
    expect(inspector).not.toHaveBeenCalled();
  });
});
