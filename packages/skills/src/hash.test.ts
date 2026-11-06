import { describe, expect, it } from 'vitest';
import { SkillContractSchema } from '@mohassan/contracts';
import { sha256, skillContentHash, skillContentMatches } from './hash.ts';

const contract = SkillContractSchema.parse({ slug: 'hash-fixture', name: 'Hash fixture', description: 'Validate canonical contract hashes.', version: '1.0.0', category: 'research', level: 'tool', sideEffects: 'read', requires: { tools: ['research.run'] }, verification: 'Check fixture evidence.', steps: [{ id: 'search', kind: 'tool', title: 'Search fixture', tool: 'research.run', inputs: { longerKey: 'input.query', a: 'input.path' } }] });
const files = [{ path: 'SKILL.md', content: 'Fixture instructions.' }, { path: 'references/guide.md', content: 'Fixture reference.' }];
const legacy = () => sha256(JSON.stringify({ contract, files: [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(file => ({ path: file.path, hash: sha256(file.content) })) }));

describe('immutable skill content hashes', () => {
  it('is stable across nested JSONB key reordering and file row order', () => {
    const reordered = SkillContractSchema.parse({ ...contract, steps: [{ ...contract.steps[0], inputs: { a: 'input.path', longerKey: 'input.query' } }] });
    expect(skillContentHash(reordered, [...files].reverse())).toBe(skillContentHash(contract, files));
  });
  it('accepts both canonical and previously valid legacy hashes without changing them', () => {
    expect(legacy()).not.toBe(skillContentHash(contract, files));
    expect(skillContentMatches(contract, files, legacy())).toBe(true);
    expect(skillContentMatches(contract, files, skillContentHash(contract, files))).toBe(true);
  });
  it.each(['legacy', 'canonical'])('rejects changed contract, path or body with the %s hash', algorithm => {
    const stored = algorithm === 'legacy' ? legacy() : skillContentHash(contract, files);
    expect(skillContentMatches({ ...contract, description: 'Changed instructions and permissions.' }, files, stored)).toBe(false);
    expect(skillContentMatches(contract, [{ ...files[0], path: 'other.md' }, files[1]], stored)).toBe(false);
    expect(skillContentMatches(contract, [{ ...files[0], content: 'Changed body.' }, files[1]], stored)).toBe(false);
  });
});
