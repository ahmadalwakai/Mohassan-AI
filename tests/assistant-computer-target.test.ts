import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WindowsView } from '@mohassan/windows';
import { createAssistantTools, elementCenter } from '../apps/server/src/assistant/tools.js';

type Modules = Parameters<typeof createAssistantTools>[0];
type Element = WindowsView['frame']['elements'][number];
const OWNER = 'isolated-computer-target-owner';
const target = { title: 'Synthetic target window', width: 800, height: 600 };
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('An unrelated module was reached by the computer target fixture.'); };
const element = (name = 'Continue', x = 20, overrides: Partial<Element> = {}): Element =>
  ({ name, type: 'ControlType.Button', x, y: 20, width: 100, height: 40, password: false, ...overrides });
function frame(elements: Element[]): WindowsView['frame'] {
  return { id: randomUUID(), targetKey: 'a'.repeat(64), capturedAt: new Date().toISOString(), width: 800, height: 600,
    jpeg: Buffer.from('synthetic frame boundary; no user pixels'.repeat(4)).toString('base64'), elements };
}
/** The trusted Windows port captures proposals; it never queues real desktop input. */
function fixture(initial: Element[], fresh = initial) {
  const frames = [frame(initial), frame(fresh)]; let reads = 0;
  const view = vi.fn(async (_owner: string): Promise<WindowsView> => ({ scope: 'control', target, frame: frames[Math.min(reads++, 1)]! }));
  const act = vi.fn(async (_owner: string, _frame: string, _action: unknown) => ({ id: randomUUID(), status: 'queued' }));
  const command = vi.fn(async (_owner: string, _id: string) => ({ status: 'applied', code: null }));
  const modules: Modules = { memory: { search: unused, create: unused }, coding: { available: false, workspace: unused },
    studio: { workspace: unused, detail: unused }, studioChange: false,
    runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused },
    windows: { enabled: true, view, act, command } };
  const computer = createAssistantTools(modules).computer!;
  const select = async (ref: string, propagateAmbiguity = true) => {
    const screen = await computer.view(OWNER), selected = screen.elements.find(entry => entry.ref === ref)!;
    return computer.perform(OWNER, { kind: 'click', name: selected.name, type: selected.type,
      ...(propagateAmbiguity && selected.ambiguous ? { ambiguous: true as const } : {}) }, new AbortController().signal);
  };
  return { computer, select, frames, view, act, command };
}

describe('fresh exact-name computer target adapter', () => {
  it('keeps full domain-bounded names and distinguishes long common prefixes', async () => {
    const prefix = 'X'.repeat(150), left = element(`${prefix}-left`, 20), right = element(`${prefix}-right`, 520);
    const f = fixture([left, right]);
    const screen = await f.computer.view(OWNER);
    expect(screen.elements.map(entry => entry.name)).toEqual([left.name, right.name]);
    expect(screen.elements.every(entry => entry.ambiguous === undefined)).toBe(true);
    await f.computer.perform(OWNER, { kind: 'click', ...screen.elements[1]! }, new AbortController().signal);
    expect(f.act).toHaveBeenCalledWith(OWNER, f.frames[1]!.id, { type: 'click', button: 'left', ...elementCenter(right, target) });
  });
  it.each([false, true])('rejects two equal fresh names/types before queueing; reordered=%s', async reordered => {
    const left = element('Continue', 20), right = element('Continue', 520);
    const f = fixture([left, right], reordered ? [right, left] : [left, right]);
    await expect(f.select('w2', false)).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_AMBIGUOUS', statusCode: 409 });
    expect(f.act).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled(); expect(f.view).toHaveBeenCalledTimes(2);
  });
  it('rejects observed ambiguity after the selected duplicate disappears and fresh matching becomes unique', async () => {
    const left = element('Continue', 20), right = element('Continue', 520), f = fixture([left, right], [left]);
    const screen = await f.computer.view(OWNER); expect(screen.elements[1]?.ambiguous).toBe(true);
    await expect(f.computer.perform(OWNER, { kind: 'click', ...screen.elements[1]! }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_AMBIGUOUS' });
    expect(f.view).toHaveBeenCalledTimes(2); expect(f.act).not.toHaveBeenCalled();
  });
  it('computes ambiguity across eligible elements outside the 24-element listing cap', async () => {
    const elements = [element('Continue'), ...Array.from({ length: 23 }, (_, at) => element(`Other ${at}`, 200)), element('Continue', 520)];
    const f = fixture(elements, [elements[0]!]);
    const screen = await f.computer.view(OWNER); expect(screen.elements).toHaveLength(24); expect(screen.elements[0]?.ambiguous).toBe(true);
    await expect(f.computer.perform(OWNER, { kind: 'click', ...screen.elements[0]! }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_AMBIGUOUS' }); expect(f.act).not.toHaveBeenCalled();
  });
  it.each(['gone', 'changed_suffix'] as const)('does not match a different full name with the same first 50 characters: %s', async scenario => {
    const prefix = 'P'.repeat(50), left = element(`${prefix}-left`), right = element(`${prefix}-right`, 520);
    const f = fixture([left, right], scenario === 'gone' ? [left] : [element(`${prefix}-replacement`, 520)]);
    await expect(f.select('w2')).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_GONE' }); expect(f.act).not.toHaveBeenCalled();
  });
  it.each([{ width: 0 }, { height: 0 }, { password: true }])('uses the same eligible set in view and fresh matching: %j', hidden => {
    return (async () => {
      const shown = element('Continue', 520), f = fixture([element('Continue', 20, hidden), shown]);
      await f.select('w1');
      expect(f.act).toHaveBeenCalledWith(OWNER, f.frames[1]!.id, { type: 'click', button: 'left', ...elementCenter(shown, target) });
    })();
  });
  it('omits whitespace-only names and does not count an ineligible duplicate as ambiguous', async () => {
    const f = fixture([element('   '), element('Continue', 20, { width: 0 }), element('Continue', 520)]);
    expect((await f.computer.view(OWNER)).elements).toEqual([{ ref: 'w1', name: 'Continue', type: 'Button' }]);
  });
  it('treats raw and ControlType-prefixed representations as the same short type', async () => {
    const f = fixture([element('Continue'), element('Continue', 520, { type: 'Button' })]);
    expect((await f.computer.view(OWNER)).elements.every(entry => entry.ambiguous === true)).toBe(true);
  });
  it('does not conflate different control types with equal full names', async () => {
    const chosen = element('Continue', 520), f = fixture([element('Continue', 20, { type: 'ControlType.Text' }), chosen]);
    await f.select('w1');
    expect(f.act).toHaveBeenCalledWith(OWNER, f.frames[1]!.id, { type: 'click', button: 'left', ...elementCenter(chosen, target) });
  });
  it('preserves unique exact-label selection across harmless enumeration reorder and binds fresh frame ID', async () => {
    const a = element('Back'), b = element('Continue', 520), f = fixture([a, b], [b, a]);
    await f.select('w2');
    expect(f.act).toHaveBeenCalledWith(OWNER, f.frames[1]!.id, { type: 'click', button: 'left', ...elementCenter(b, target) });
    expect(f.act.mock.calls[0]?.[1]).not.toBe(f.frames[0]!.id);
  });
  it('still rejects targets that became ineligible in the fresh frame', async () => {
    const f = fixture([element('Continue')], [element('Continue', 20, { password: true })]);
    await expect(f.select('w1')).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_GONE' }); expect(f.act).not.toHaveBeenCalled();
  });
  it('propagates fresh-screen and domain-consent failures without inventing an input acknowledgment', async () => {
    const f = fixture([element('Continue')]);
    const failure = Object.assign(new Error('Synthetic view permission expired.'), { code: 'WINDOWS_FRAME_UNAVAILABLE', statusCode: 409 });
    f.view.mockRejectedValueOnce(failure);
    await expect(f.computer.perform(OWNER, { kind: 'click', name: 'Continue', type: 'Button' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WINDOWS_FRAME_UNAVAILABLE' }); expect(f.act).not.toHaveBeenCalled();
    f.act.mockRejectedValueOnce(Object.assign(new Error('Synthetic control grant was revoked.'), { code: 'WINDOWS_CONTROL_DENIED', statusCode: 403 }));
    await expect(f.select('w1')).rejects.toMatchObject({ code: 'WINDOWS_CONTROL_DENIED' }); expect(f.command).not.toHaveBeenCalled();
  });
  it('does not change the native text/password guard or key path', async () => {
    const f = fixture([element('Password', 20, { password: true })]);
    await expect(f.computer.perform(OWNER, { kind: 'text', text: 'synthetic' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ASSISTANT_SECRET_FIELD' }); expect(f.act).not.toHaveBeenCalled();
    await f.computer.perform(OWNER, { kind: 'key', key: 'Escape' }, new AbortController().signal);
    expect(f.act).toHaveBeenCalledWith(OWNER, f.frames[1]!.id, { type: 'key', key: 'Escape' });
  });
  it('documents the conservative legacy boundary without claiming object identity', async () => {
    const left = element('Continue', 20), right = element('Continue', 520), f = fixture([left, right], [left]);
    // Old/unbound callers lack the observed-ambiguity flag. Only the CURRENT
    // full-name uniqueness is checked; arbitrary same-name replacement/ABA is
    // not detectable from this descriptor. New controller clicks must forward it.
    await f.computer.view(OWNER);
    await f.computer.perform(OWNER, { kind: 'click', name: 'Continue', type: 'Button' }, new AbortController().signal);
    expect(f.act).toHaveBeenCalledWith(OWNER, f.frames[1]!.id, expect.objectContaining(elementCenter(left, target)));
  });
});
