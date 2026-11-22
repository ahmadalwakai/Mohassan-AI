import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WindowsInputOptions, WindowsOrigin, WindowsView } from '@mohassan/windows';
import { createAssistantTools, type ComputerStep } from '../apps/server/src/assistant/tools.js';

type Modules = Parameters<typeof createAssistantTools>[0];
const OWNER = 'isolated-computer-scope-owner';
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('An unrelated port was reached.'); };
function origin(): WindowsOrigin { return { deviceId: randomUUID(), grantId: randomUUID(), targetKey: 'a'.repeat(64) }; }
function fixture(changes: Partial<WindowsOrigin> = {}, options: { legacy?: boolean; onFresh?: () => void; invokeFence?: boolean } = {}) {
  const initial = origin(), fresh = { ...initial, ...changes }; let reads = 0;
  const observations = [initial, fresh].map((scope, index): WindowsView => ({ scope: 'control',
    target: { title: `Synthetic window title ${index}`, width: index ? 1000 : 800, height: 600 },
    ...(!options.legacy ? { origin: scope } : {}),
    frame: { id: randomUUID(), targetKey: scope.targetKey, capturedAt: new Date().toISOString(), width: 800, height: 600,
      jpeg: Buffer.from('synthetic frame; no actual user pixels'.repeat(4)).toString('base64'),
      elements: index ? [{ name: 'Back', type: 'ControlType.Button', x: 20, y: 20, width: 100, height: 40, password: false },
        { name: 'Confirm', type: 'ControlType.Button', x: 500, y: 20, width: 100, height: 40, password: false }]
        : [{ name: 'Confirm', type: 'ControlType.Button', x: 20, y: 20, width: 100, height: 40, password: false }] } }));
  const view = vi.fn(async (): Promise<WindowsView> => { const at = Math.min(reads++, 1); if (at === 1) options.onFresh?.(); return observations[at]!; });
  const act = vi.fn(async (_owner: string, _frame: string, _action: unknown, _expected?: WindowsOrigin, inputOptions?: WindowsInputOptions) => {
    if (options.invokeFence) await inputOptions?.fence?.({} as Parameters<NonNullable<WindowsInputOptions['fence']>>[0]);
    return { id: randomUUID(), status: 'queued' };
  });
  const command = vi.fn(async () => ({ status: 'applied', code: null }));
  const modules: Modules = { memory: { search: unused, create: unused }, coding: { available: false, workspace: unused },
    studio: { workspace: unused, detail: unused }, studioChange: false, runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused },
    windows: { enabled: true, view, act, command, ...(!options.legacy ? { requiresViewOrigin: true as const } : {}) } };
  return { computer: createAssistantTools(modules).computer!, initial, fresh, observations, view, act, command };
}

describe('observed native computer scope binding, without desktop input', () => {
  it.each(['window', 'grant', 'device'] as const)('rejects an identical label in a newly selected %s scope before queueing', async changed => {
    const f = fixture(changed === 'window' ? { targetKey: 'b'.repeat(64), grantId: randomUUID() }
      : changed === 'grant' ? { grantId: randomUUID() } : { deviceId: randomUUID(), grantId: randomUUID() });
    const screen = await f.computer.view(OWNER), selected = screen.elements[0]!;
    await expect(f.computer.perform(OWNER, { kind: 'click', name: selected.name, type: selected.type, origin: screen.origin }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' });
    expect(f.view).toHaveBeenCalledTimes(2); expect(f.act).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'text', text: 'Synthetic text' }, { kind: 'key', key: 'Escape' }] as const)('binds %s inputs to the same observed grant', async step => {
    const f = fixture({ grantId: randomUUID() }), screen = await f.computer.view(OWNER);
    await expect(f.computer.perform(OWNER, { ...step, origin: screen.origin }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' }); expect(f.act).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'click', name: 'Confirm', type: 'Button' }, { kind: 'text', text: 'Synthetic text' }, { kind: 'key', key: 'Escape' }] as const)
    ('requires an explicit prior native view for %s rather than acquiring input authority from the internal fresh read', async step => {
      const f = fixture(); expect(f.computer.requiresViewOrigin).toBe(true);
      await expect(f.computer.perform(OWNER, step, new AbortController().signal)).rejects.toMatchObject({ code: 'COMPUTER_SCOPE_REQUIRED' });
      expect(f.act).not.toHaveBeenCalled();
    });
  it('retains harmless same-scope frame refresh, title/size change and element reorder', async () => {
    const f = fixture(), screen = await f.computer.view(OWNER);
    expect(screen.origin).toEqual(f.initial);
    await f.computer.perform(OWNER, { kind: 'click', name: 'Confirm', type: 'Button', origin: screen.origin }, new AbortController().signal);
    expect(f.observations[0]!.frame.id).not.toBe(f.observations[1]!.frame.id);
    expect(f.act).toHaveBeenCalledWith(OWNER, f.observations[1]!.frame.id, { type: 'click', button: 'left', x: 0.55, y: 40 / 600 }, f.initial, { signal: expect.any(AbortSignal) });
  });
  it.each([{ kind: 'text', text: 'Synthetic text' }, { kind: 'key', key: 'Escape' }] as const)('forwards the expected origin with a valid same-scope %s input', async step => {
    const f = fixture(), screen = await f.computer.view(OWNER);
    await f.computer.perform(OWNER, { ...step, origin: screen.origin }, new AbortController().signal);
    expect(f.act).toHaveBeenCalledWith(OWNER, f.observations[1]!.frame.id, step.kind === 'text' ? { type: 'text', text: step.text } : { type: 'key', key: step.key }, f.initial, { signal: expect.any(AbortSignal) });
  });
  it('does not downgrade a bound step when fresh metadata is missing or inconsistent with the frame', async () => {
    for (const malformed of ['missing', 'other_frame', 'bad_shape']) {
      const f = fixture(), screen = await f.computer.view(OWNER);
      if (malformed === 'missing') delete f.observations[1]!.origin;
      else if (malformed === 'other_frame') f.observations[1]!.frame.targetKey = 'c'.repeat(64);
      else f.observations[1]!.origin = { ...f.fresh, grantId: 'not-a-host-grant' };
      await expect(f.computer.perform(OWNER, { kind: 'click', name: 'Confirm', type: 'Button', origin: screen.origin }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' }); expect(f.act).not.toHaveBeenCalled();
    }
  });
  it('copies host origin data instead of retaining a writable alias to the Windows port', async () => {
    const f = fixture(), expectedDevice = f.initial.deviceId, screen = await f.computer.view(OWNER);
    screen.origin!.deviceId = randomUUID(); expect(f.initial.deviceId).toBe(expectedDevice);
    await expect(f.computer.perform(OWNER, { kind: 'click', name: 'Confirm', type: 'Button', origin: screen.origin }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' }); expect(f.act).not.toHaveBeenCalled();
  });
  it('does not dispatch after cancellation before the view or during its fresh refresh', async () => {
    const stopped = new AbortController(), reason = new Error('Synthetic cancelled input'); stopped.abort(reason);
    const first = fixture(); await expect(first.computer.perform(OWNER, { kind: 'key', key: 'Escape' }, stopped.signal)).rejects.toBe(reason);
    expect(first.view).not.toHaveBeenCalled(); expect(first.act).not.toHaveBeenCalled();
    const active = new AbortController(), f = fixture({}, { onFresh: () => active.abort(reason) }), screen = await f.computer.view(OWNER);
    await expect(f.computer.perform(OWNER, { kind: 'key', key: 'Escape', origin: screen.origin }, active.signal)).rejects.toBe(reason);
    expect(f.act).not.toHaveBeenCalled();
  });
  it('keeps old injected unbound ports explicitly limited to current-frame checks', async () => {
    const f = fixture({ targetKey: 'b'.repeat(64) }, { legacy: true });
    expect(f.computer.requiresViewOrigin).toBeUndefined(); expect((await f.computer.view(OWNER)).origin).toBeUndefined();
    // This legacy path has no claim of binding an earlier window/grant. New
    // genuine domain adapters advertise requiresViewOrigin and never use it.
    const step: ComputerStep = { kind: 'click', name: 'Confirm', type: 'Button' };
    await f.computer.perform(OWNER, step, new AbortController().signal);
    expect(f.act).toHaveBeenCalledWith(OWNER, f.observations[1]!.frame.id, { type: 'click', button: 'left', x: 0.55, y: 40 / 600 });
  });
  it('passes the actual signal and host-only fence, preserving a coded lifecycle error and callback receiver', async () => {
    const f = fixture({}, { invokeFence: true }), screen = await f.computer.view(OWNER), controller = new AbortController();
    const failure = Object.assign(new Error('Synthetic host run ended'), { code: 'SYNTHETIC_RUN_ENDED' });
    const hostOptions = { expected: 'host-only', async fence(this: { expected: string }) {
      expect(this.expected).toBe('host-only'); throw failure;
    } };
    await expect(f.computer.perform(OWNER, { kind: 'key', key: 'Escape', origin: screen.origin }, controller.signal, hostOptions)).rejects.toBe(failure);
    expect(f.act.mock.calls[0]?.[4]?.signal).toBe(controller.signal); expect(f.command).not.toHaveBeenCalled();
  });
});
