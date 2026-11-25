import { createDatabase, migrate } from '@mohassan/database';
import type { AgentBrowser } from '@mohassan/browser';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrateActivationConsole } from '../apps/server/src/activation-migration.js';
import { activationScopeDatabase, activationScopeOwnerId, attachActivationRuntime, bindActivationRuntime, isActivationRuntimeReady, registerActivationConsumer } from '../apps/server/src/activation-runtime.js';
import { commandChatMigration, createCommandChatControl } from '../apps/server/src/command-chat.js';

let database: Awaited<ReturnType<typeof createDatabase>>;
const flag = 'MOHASSAN_PLAN_COMPILER';

beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  await commandChatMigration(database.db);
  await migrateActivationConsole(database.db);
  attachActivationRuntime(database.db);
});

afterAll(async () => {
  await database?.close();
});

async function setCompiler(enabled: boolean) {
  await database.db.insertInto('activation_changes').values({ capability_id: 'plan-compiler', enabled,
    actor_id: 'fixture-owner', reason: 'Flag-reader fixture', evidence: '{}' }).execute();
}

it('requires a consumer and reads each committed state through the chat controller', async () => {
  expect(isActivationRuntimeReady(flag)).toBe(false);
  expect(isActivationRuntimeReady(null)).toBe(false);
  const scoped = bindActivationRuntime(database.db, { send: async (_ownerId: string) => [activationScopeDatabase(), activationScopeOwnerId()] });
  const [db, ownerId] = await scoped.send('fixture-owner');
  expect(db).toBe(database.db);
  expect(ownerId).toBe('fixture-owner');
  expect(activationScopeDatabase()).toBeUndefined();
  expect(activationScopeOwnerId()).toBeUndefined();
  expect(() => registerActivationConsumer(flag, 'decide', null)).toThrow('Unknown activation flag or mode');
  const compilerMode = registerActivationConsumer(flag, 'on', 'shadow');
  expect(isActivationRuntimeReady(flag)).toBe(true);

  const observed: string[] = [];
  const fixtureBrowser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
  } as unknown as AgentBrowser;
  const chat = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser: fixtureBrowser,
    fullAccess: async () => { observed.push(`${activationScopeOwnerId()}:${compilerMode('on')}`); return true; },
  });
  try {
    for (const state of [null, true, false]) {
      if (state !== null) await setCompiler(state);
      const conversation = await chat.create('fixture-owner', { goal: 'كم ٣ + ٥؟' });
      await chat.settled(conversation.id);
      expect(new Set(observed.splice(0))).toEqual(new Set([`fixture-owner:${state === true ? 'on' : 'shadow'}`]));
    }
    expect(compilerMode('unmanaged')).toBe('unmanaged');
  } finally {
    await chat.shutdown();
  }
});

it('isolates an in-flight run from later changes and detached callers', async () => {
  const compilerMode = registerActivationConsumer(flag, 'on', 'shadow');
  await setCompiler(true);
  const detached = bindActivationRuntime(database.db.withSchema('public'), { send: async () => [activationScopeOwnerId(), compilerMode('unmanaged')] });
  const control = bindActivationRuntime(database.db, { send: async (_ownerId: string, pause: () => Promise<void>) => {
    const before = compilerMode('unmanaged');
    await pause();
    return [activationScopeOwnerId(), before, compilerMode('unmanaged'), await detached.send()];
  } });
  let resume = () => {};
  let started = () => {};
  const firstRead = new Promise<void>(resolve => { started = resolve; });
  const waitForChange = new Promise<void>(resolve => { resume = resolve; });
  const inFlight = control.send('first-owner', async () => { started(); await waitForChange; });
  try {
    await firstRead;
    await setCompiler(false);
    expect(await control.send('second-owner', async () => {})).toEqual(['second-owner', 'shadow', 'shadow', [undefined, 'unmanaged']]);
  } finally {
    resume();
  }
  expect(await inFlight).toEqual(['first-owner', 'on', 'on', [undefined, 'unmanaged']]);
});
