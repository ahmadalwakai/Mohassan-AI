import { describe, expect, it } from 'vitest';
import { SkillCompositionRequestSchema, SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { assignable, composeSkillGraph, layers, validateStepGraph } from './composer.ts';
import { buildPermissionSnapshot } from './permissions.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const contract = (slug: string, extra: Record<string, unknown> = {}): SkillContract => SkillContractSchema.parse({
  slug, name: 'مهارة اختبار', description: 'مهارة تستخدم في اختبار التركيب.', version: '1.0.0', category: 'research', level: 'tool', requires: { tools: ['browser.open'] }, sideEffects: 'read',
  steps: [{ id: 'open', kind: 'tool', title: 'فتح', tool: 'browser.open' }], verification: 'تطابق النتيجة.', ...extra,
});
const fetcher = contract('fetcher', { outputs: [{ name: 'page', type: 'url', description: 'رابط' }, { name: 'count', type: 'number', description: 'عدد' }] });
const writer = contract('writer', { inputs: [{ name: 'text', type: 'string', description: 'نص' }] });
const request = (nodes: unknown[], inputs: unknown[] = []) => SkillCompositionRequestSchema.parse({ nodes, inputs });
const compose = (nodes: { id: string; skillId?: string; inputs?: object; dependsOn?: string[] }[], map: Record<string, SkillContract>, inputs: unknown[] = []) => composeSkillGraph(request(nodes.map((node, index) => ({ skillId: id(index + 1), ...node })), inputs), new Map(Object.entries(map)));
const codes = (result: { issues: { code: string }[] }) => result.issues.map((entry) => entry.code);

describe('graph ordering', () => {
  it('groups independent work into one batch and orders dependencies', () => {
    const graph = compose([{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['a', 'b'] }], { a: fetcher, b: fetcher, c: fetcher });
    expect(graph.batches).toEqual([['a', 'b'], ['c']]);
    expect(graph.issues).toEqual([]);
    expect(graph.ordered('a', 'c')).toBe(true);
    expect(graph.ordered('a', 'b')).toBe(false);
  });
  it('derives an order from a data binding', () => {
    const graph = compose([{ id: 'w', inputs: { text: 'f.page' } }, { id: 'f' }], { w: writer, f: fetcher });
    expect(graph.batches).toEqual([['f'], ['w']]);
  });
  it('follows order transitively', () => {
    const graph = compose([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }], { a: fetcher, b: fetcher, c: fetcher });
    expect(graph.ordered('a', 'c')).toBe(true);
  });
  it('reports cycles without hanging', () => {
    expect(codes(compose([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], { a: fetcher, b: fetcher }))).toContain('cycle');
    const { cyclic } = layers(['a', 'b', 'c'], new Map([['a', new Set(['b'])], ['b', new Set(['a'])], ['c', new Set<string>()]]));
    expect(cyclic).toEqual(['a', 'b']);
  });
  it('finishes on the largest allowed graph with a cycle through every node', () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, dependsOn: [`n${(index + 1) % 12}`] }));
    const graph = compose(nodes, {});
    expect(codes(graph)).toContain('cycle');
    expect(graph.ordered('n0', 'n5')).toBeTypeOf('boolean');
  });
});

describe('typed bindings', () => {
  it('follows the assignment rules', () => {
    expect(assignable('url', 'string')).toBe(true);
    expect(assignable('file', 'string')).toBe(true);
    expect(assignable('number', 'json')).toBe(true);
    expect(assignable('string', 'url')).toBe(false);
    expect(assignable('number', 'string')).toBe(false);
  });
  it('accepts a compatible binding and refuses a mismatched one', () => {
    expect(compose([{ id: 'f' }, { id: 'w', inputs: { text: 'f.page' } }], { w: writer, f: fetcher }).issues).toEqual([]);
    expect(codes(compose([{ id: 'f' }, { id: 'w', inputs: { text: 'f.count' } }], { w: writer, f: fetcher }))).toContain('type_mismatch');
  });
  it.each([
    ['a required input left unbound', [{ id: 'w' }], 'missing_input'],
    ['an input the skill does not accept', [{ id: 'f', inputs: { ghost: 'input.x' } }], 'unknown_input'],
    ['an undeclared plan input', [{ id: 'w', inputs: { text: 'input.topic' } }], 'unknown_plan_input'],
    ['a missing source node', [{ id: 'w', inputs: { text: 'ghost.page' } }], 'unknown_dependency'],
    ['a missing output', [{ id: 'f' }, { id: 'w', inputs: { text: 'f.ghost' } }], 'unknown_output'],
    ['a self binding', [{ id: 'w', inputs: { text: 'w.text' } }], 'self_dependency'],
    ['a self dependency', [{ id: 'f', dependsOn: ['f'] }], 'self_dependency'],
    ['an unknown dependency', [{ id: 'f', dependsOn: ['ghost'] }], 'unknown_dependency'],
    ['duplicate node ids', [{ id: 'f' }, { id: 'f' }], 'duplicate_node'],
    ['the reserved node id', [{ id: 'input' }], 'reserved_node_id'],
  ])('refuses %s', (_name, nodes, code) => {
    const map = Object.fromEntries((nodes as { id: string }[]).map((node) => [node.id, node.id === 'w' ? writer : fetcher]));
    expect(codes(compose(nodes, map))).toContain(code);
  });
  it('binds a declared plan input by type', () => {
    expect(compose([{ id: 'w', inputs: { text: 'input.topic' } }], { w: writer }, [{ name: 'topic', type: 'string', description: 'موضوع' }]).issues).toEqual([]);
    expect(codes(compose([{ id: 'w', inputs: { text: 'input.topic' } }], { w: writer }, [{ name: 'topic', type: 'number', description: 'موضوع' }]))).toContain('type_mismatch');
  });
  it('requires a skill dependency to be present and ordered first', () => {
    const needsWriter = contract('needs-writer', { dependsOn: ['fetcher'] });
    expect(compose([{ id: 'n' }], { n: needsWriter }).issues[0]).toMatchObject({ code: 'missing_skill_dependency', category: 'missing_skill' });
    expect(codes(compose([{ id: 'n' }, { id: 'f' }], { n: needsWriter, f: fetcher }))).toContain('skill_dependency_unordered');
    expect(compose([{ id: 'n', dependsOn: ['f'] }, { id: 'f' }], { n: needsWriter, f: fetcher }).issues).toEqual([]);
  });
});

describe('steps inside a skill', () => {
  const step = (name: string, extra: object) => ({ id: name, kind: 'tool', title: name, tool: 'browser.open', ...extra });
  it('finds cycles created through bindings', () => {
    const looped = contract('looped', { steps: [step('a', { inputs: { x: 'b.out' }, outputs: [{ name: 'out', type: 'string', description: 'ن' }] }), step('b', { inputs: { x: 'a.out' }, outputs: [{ name: 'out', type: 'string', description: 'ن' }] })] });
    expect(validateStepGraph(looped, null).map((entry) => entry.code)).toContain('step_cycle');
  });
  it('finds cycles created through dependsOn', () => {
    expect(validateStepGraph(contract('looped', { steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] }), null).map((entry) => entry.code)).toContain('step_cycle');
  });
  it('finds bindings to undeclared inputs and outputs', () => {
    expect(validateStepGraph(contract('bad', { steps: [step('a', { inputs: { x: 'input.ghost' } })] }), 'n').map((entry) => entry.code)).toEqual(['step_binding_unknown']);
    expect(validateStepGraph(contract('bad', { steps: [step('a', { inputs: { x: 'nope.out' } })] }), 'n').map((entry) => entry.code)).toEqual(['step_binding_unknown']);
    expect(validateStepGraph(contract('bad', { steps: [step('a', { inputs: { x: 'broken' } })] }), 'n').map((entry) => entry.code)).toEqual(['step_binding_invalid']);
  });
  it('accepts a declared chain', () => {
    const chain = contract('chain', { inputs: [{ name: 'url', type: 'url', description: 'رابط' }], steps: [step('a', { inputs: { target: 'input.url' }, outputs: [{ name: 'out', type: 'string', description: 'ن' }] }), step('b', { inputs: { x: 'a.out' } })] });
    expect(validateStepGraph(chain, null)).toEqual([]);
  });
});

describe('permission snapshot', () => {
  const capability = (id: string, status: 'active' | 'planned' | 'needs_configuration') => ({ id, name: id, description: id, version: '1', risk: 'low' as const, status, requiredScopes: [] });
  const environment = { capabilities: [capability('browser.open', 'active'), capability('browser.research', 'active'), capability('coding.change', 'needs_configuration'), capability('device.remote', 'planned')], modelReady: true, visionReady: false, executableReady: false };
  it('reports each tool from the capability behind it', () => {
    const { tools } = buildPermissionSnapshot(environment);
    expect(tools['browser.open']).toEqual({ available: true });
    expect(tools['coding.change']).toMatchObject({ available: false, reason: 'القدرة تحتاج إعداداً.' });
    expect(tools['computer.act']).toMatchObject({ available: false });
    expect(tools['studio.change']).toMatchObject({ available: false });
  });
  it('never reports a tool available that has no implementation or no model', () => {
    const { tools } = buildPermissionSnapshot({ ...environment, visionReady: true });
    expect(tools['file.write']).toEqual({ available: false, reason: 'الأداة غير منفذة بعد.' });
    expect(tools['file.read']).toEqual({ available: false, reason: 'الأداة غير منفذة بعد.' });
    expect(tools['vision.inspect']).toEqual({ available: true });
    expect(buildPermissionSnapshot(environment).tools['vision.inspect']).toMatchObject({ available: false });
  });
});
