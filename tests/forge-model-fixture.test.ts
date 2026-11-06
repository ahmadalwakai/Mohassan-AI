import { describe, expect, it } from 'vitest';
import { SkillContractSchema, SkillForgeGeneratedSchema } from '@mohassan/contracts';
import { createMockGroq, rawPlanFixture } from './fixtures/planning';
import { E2E_FORGE_BASELINE_MARKER, E2E_FORGE_BASELINE_SLUG, E2E_FORGE_CANDIDATE_MARKER, forgeCandidateFixture } from './fixtures/forge';

const contract = SkillContractSchema.parse({ slug: E2E_FORGE_BASELINE_SLUG, name: 'قاعدة Forge الاختبارية',
  description: 'تعليمات ثابتة لاختبار مسار توليد محلي معزول بلا أدوات أو تنفيذ.', category: 'documents', level: 'instruction', version: '1.0.0' });
const prompt = () => ({ target: { slug: 'm13-forge-approved-fork', version: '1.0.1' }, baseline: { pin: {}, contract, instructions: { text: E2E_FORGE_BASELINE_MARKER, truncated: false } }, goal: 'fixture only', trainingContext: null, failureAnalysis: null });

describe('controlled Forge model fixture', () => {
  it('returns only the fixed instruction source and the server-pinned identity through the mock transport', async () => {
    const mock = createMockGroq();
    const response = await mock.fetch('https://local-fixture.invalid/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture-model', response_format: { json_schema: { name: 'skill_forge_candidate' } }, messages: [{ role: 'user', content: JSON.stringify(prompt()) }] }) });
    const body = await response.json(), result = SkillForgeGeneratedSchema.parse(JSON.parse(body.choices[0].message.content));
    expect(result.contract).toMatchObject({ slug: prompt().target.slug, version: prompt().target.version, level: 'instruction', steps: [], requires: { tools: [], scopes: [], paths: [] } });
    expect(result.files).toHaveLength(1); expect(result.files[0].path).toBe('SKILL.md'); expect(result.files[0].content).toContain(E2E_FORGE_CANDIDATE_MARKER);
    expect(body.model).toBe('fixture-model'); expect(body.usage.prompt_tokens).toBe(700); expect(mock.requests).toHaveLength(1);
  });
  it('rejects unknown sources and any added tool or scope instead of producing executable artifacts', () => {
    const unmarked = prompt(); unmarked.baseline.instructions.text = 'unconfigured source';
    expect(() => forgeCandidateFixture(JSON.stringify(unmarked))).toThrow('FORGE_FIXTURE_BASELINE_REQUIRED');
    const different = prompt(); different.baseline.contract = { ...contract, slug: 'some-other-source' };
    expect(() => forgeCandidateFixture(JSON.stringify(different))).toThrow('FORGE_FIXTURE_BASELINE_REQUIRED');
    const authority = prompt(); authority.baseline.contract = { ...contract, requires: { tools: ['file.write'], scopes: [], paths: [] } };
    expect(() => forgeCandidateFixture(JSON.stringify(authority))).toThrow('FORGE_FIXTURE_BASELINE_REQUIRED');
    const scope = prompt(); scope.baseline.contract = { ...contract, requires: { tools: [], scopes: ['model:generate'], paths: [] } };
    expect(() => forgeCandidateFixture(JSON.stringify(scope))).toThrow('FORGE_FIXTURE_BASELINE_REQUIRED');
  });
  it('rejects oversized prompts and invalid server target identities', () => {
    expect(() => forgeCandidateFixture(' '.repeat(65537))).toThrow('FORGE_FIXTURE_PROMPT_LIMIT');
    const invalid = prompt(); invalid.target.slug = '../escape';
    expect(() => forgeCandidateFixture(JSON.stringify(invalid))).toThrow();
  });
  it('preserves the existing planning and browser decision branches', async () => {
    const mock = createMockGroq();
    async function call(name: string, content: string) {
      const response = await mock.fetch('https://local-fixture.invalid/chat/completions', { method: 'POST', body: JSON.stringify({ response_format: { json_schema: { name } }, messages: [{ role: 'user', content }] }) });
      return JSON.parse((await response.json()).choices[0].message.content);
    }
    expect(await call('cognitive_plan', 'unchanged plan')).toEqual(rawPlanFixture);
    expect(await call('decision', 'حسابي التجريبي')).toMatchObject({ tool: 'open', url: 'http://127.0.0.1:4201/account' });
  });
});
