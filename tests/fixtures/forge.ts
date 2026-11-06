import { z } from 'zod';
import { SkillContractSchema, SkillForgeGeneratedSchema } from '@mohassan/contracts';

export const E2E_FORGE_BASELINE_SLUG = 'm13-forge-guide';
export const E2E_FORGE_BASELINE_MARKER = 'M13_FORGE_BASELINE';
export const E2E_FORGE_CANDIDATE_MARKER = 'M13_FORGE_CANDIDATE';

/** A fixed repository-owned instruction fixture, not a general model or code generator. */
export function forgeCandidateFixture(prompt: string) {
  if (Buffer.byteLength(prompt, 'utf8') > 65536) throw new Error('FORGE_FIXTURE_PROMPT_LIMIT');
  const input = z.object({
    target: z.object({ slug: z.string(), version: z.string() }).strict(),
    baseline: z.object({ contract: SkillContractSchema, instructions: z.object({ text: z.string(), truncated: z.boolean() }).strict() }),
  }).parse(JSON.parse(prompt));
  const baseline = input.baseline.contract;
  if (baseline.slug !== E2E_FORGE_BASELINE_SLUG || baseline.level !== 'instruction'
    || baseline.requires.tools.length || baseline.requires.scopes.length || baseline.requires.paths.length
    || baseline.steps.length || baseline.sideEffects !== 'none'
    || !input.baseline.instructions.text.includes(E2E_FORGE_BASELINE_MARKER)) throw new Error('FORGE_FIXTURE_BASELINE_REQUIRED');
  const contract = SkillContractSchema.parse({
    slug: input.target.slug, version: input.target.version, name: 'مرشح Forge الاختباري',
    description: 'تعليمات اختبارية ثابتة لمراجعة الدليل والحفاظ على مرجعه وشرح حدود الثقة.',
    category: 'documents', level: 'instruction',
  });
  return SkillForgeGeneratedSchema.parse({ contract, files: [{ path: 'SKILL.md', content:
    `---\nname: ${contract.slug}\ndescription: ${contract.description}\nversion: ${contract.version}\n---\n${E2E_FORGE_CANDIDATE_MARKER}: احتفظ بمعنى المصدر ومعرّفات الأدلة. اذكر حدود المعرفة ولا تصف أثرًا لم يُلاحظ.\n`,
  }] });
}
