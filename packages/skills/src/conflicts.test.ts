import { describe, expect, it } from 'vitest';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { detectSkillConflicts, requiresApproval, type ConflictNode } from './conflicts.ts';

const contract = (slug: string, tool: string, extra: Record<string, unknown> = {}): SkillContract => SkillContractSchema.parse({
  slug, name: 'مهارة اختبار', description: 'مهارة تستخدم في اختبار التعارض.', version: '1.0.0', category: 'browser', level: 'tool', requires: { tools: [tool] }, sideEffects: 'external', rollback: { mode: 'manual', note: 'يدوي' },
  steps: [{ id: 'act', kind: 'tool', title: 'تنفيذ', tool }], verification: 'تطابق النتيجة.', ...extra,
});
const instruction = (slug: string, extra: Record<string, unknown> = {}) => SkillContractSchema.parse({ slug, name: 'مهارة تعليمات', description: 'مهارة تعليمات للاختبار.', version: '1.0.0', category: 'reasoning', level: 'instruction', ...extra });
const node = (id: string, value: SkillContract, instructions = ''): ConflictNode => ({ id, contract: value, instructions });
const never = () => false, always = () => true;
const codes = (issues: { code: string }[]) => issues.map((entry) => entry.code);

describe('skill conflicts', () => {
  it('refuses two parallel writers on one resource and allows them once ordered', () => {
    const nodes = [node('a', contract('one', 'browser.interact')), node('b', contract('two', 'browser.submit'))];
    const parallel = detectSkillConflicts(nodes, never);
    expect(parallel[0]).toMatchObject({ code: 'resource_conflict', severity: 'error', category: 'conflict' });
    expect(detectSkillConflicts(nodes, always)).toEqual([]);
  });
  it('lets parallel read-only work through', () => {
    const read = (slug: string) => contract(slug, 'browser.open', { sideEffects: 'read', rollback: { mode: 'none' } });
    expect(detectSkillConflicts([node('a', read('one')), node('b', read('two'))], never)).toEqual([]);
  });
  it('treats different resources as independent', () => {
    expect(detectSkillConflicts([node('a', contract('one', 'coding.change')), node('b', contract('two', 'browser.interact'))], never)).toEqual([]);
  });
  it('counts tools declared on instruction skills too', () => {
    const guide = instruction('guide', { requires: { tools: ['browser.interact'] }, sideEffects: 'write_local', rollback: { mode: 'manual', note: 'يدوي' } });
    expect(codes(detectSkillConflicts([node('a', guide), node('b', contract('two', 'browser.submit'))], never))).toContain('resource_conflict');
  });
  it('honours a conflict declared on either side, even when ordered', () => {
    const a = contract('one', 'memory.search', { sideEffects: 'read', rollback: { mode: 'none' }, conflicts: ['two'] }), b = contract('two', 'memory.search', { sideEffects: 'read', rollback: { mode: 'none' } });
    for (const pair of [[node('a', a), node('b', b)], [node('b', b), node('a', a)]]) expect(codes(detectSkillConflicts(pair, always))).toEqual(['declared_conflict']);
  });
  it('warns when a skill appears twice', () => {
    const value = contract('one', 'memory.search', { sideEffects: 'read', rollback: { mode: 'none' } });
    expect(detectSkillConflicts([node('a', value), node('b', value)], always)[0]).toMatchObject({ code: 'duplicate_skill', severity: 'warning' });
  });
  it('warns on directly opposed instructions, in either language', () => {
    expect(detectSkillConflicts([node('a', instruction('one'), 'Always send the weekly report automatically.'), node('b', instruction('two'), 'Never send the weekly report automatically.')], always)[0]).toMatchObject({ code: 'instruction_conflict', severity: 'warning' });
    expect(codes(detectSkillConflicts([node('a', instruction('one'), 'يجب إرسال التقرير الأسبوعي للعميل.'), node('b', instruction('two'), 'ممنوع إرسال التقرير الأسبوعي للعميل.')], always))).toContain('instruction_conflict');
  });
  it('stays quiet when instructions do not disagree', () => {
    expect(detectSkillConflicts([node('a', instruction('one'), 'Always cite your sources clearly.'), node('b', instruction('two'), 'Never guess payment details.')], always)).toEqual([]);
    expect(detectSkillConflicts([node('a', instruction('one'), 'Always cite your sources clearly.'), node('b', instruction('two'), 'Always cite your sources clearly.')], always)).toEqual([]);
  });
  it('marks work that changes something as needing approval', () => {
    expect(requiresApproval(contract('one', 'browser.submit'))).toBe(true);
    expect(requiresApproval(contract('two', 'browser.open', { sideEffects: 'read', rollback: { mode: 'none' } }))).toBe(false);
    expect(requiresApproval(instruction('three'))).toBe(false);
  });
});
