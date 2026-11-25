import { z } from 'zod';
import { GoogleAdsCustomerIdSchema, GoogleAdsReadbackSchema, type CampaignCheck, type GoogleAdsDraft } from '@mohassan/contracts';
import type { ChatSkillContext, CommandChatConfig } from '../command-chat.js';
import { campaignReadbackChecks } from './campaign-run.js';

export type CampaignVerificationSkill =
  | { status: 'loaded'; id: string; slug: string; contentHash: string; sourceHash: string; version: string | null }
  | { status: 'unavailable'; reason: 'loader_unavailable' | 'active_skill_unavailable' };
export interface CampaignCompletionVerification { passed: boolean; checks: CampaignCheck[]; skill: CampaignVerificationSkill }
export interface CampaignCompletionVerificationInput {
  ownerId: string;
  expectedCustomerId: string | null;
  draft: GoogleAdsDraft;
  loadSkill?: CommandChatConfig['loadSkill'];
  signal?: AbortSignal;
}

const HASH = /^[a-f0-9]{64}$/;
const SKILL_SLUGS = ['verify-before-done-en', 'verify-before-done'] as const;
const LOAD_TIMEOUT_MS = 4000;

/** The existing loader checks activation, inspection and file hashes. This
 * receipt adds no authority and never treats guidance text as executable code. */
function skillReceipt(context: ChatSkillContext, slug: string): CampaignVerificationSkill | null {
  if (!context.text || context.text.length > 4000) return null;
  const metadata = context.skills.find(item => item.slug === slug && z.uuid().safeParse(item.id).success && HASH.test(item.contentHash ?? ''));
  const source = metadata && context.sources?.find(item => item.skillId === metadata.id && item.path === 'SKILL.md' && HASH.test(item.contentHash));
  if (!metadata || !source) return null;
  let envelope: unknown;
  try { envelope = JSON.parse(context.text); } catch { return null; }
  const parsed = z.object({ kind: z.literal('skill_context'), trust: z.literal('untrusted_instructions'), permissionsGranted: z.literal(false),
    skills: z.array(z.object({ id: z.string(), slug: z.string(), contentHash: z.string(), sources: z.array(z.object({ path: z.string(), contentHash: z.string(), text: z.string().min(1) }).passthrough()) }).passthrough()) }).passthrough().safeParse(envelope);
  const loaded = parsed.success && parsed.data.skills.find(item => item.id === metadata.id && item.slug === slug && item.contentHash === metadata.contentHash);
  if (!loaded || !loaded.sources.some(item => item.path === source.path && item.contentHash === source.contentHash)) return null;
  return { status: 'loaded', id: metadata.id, slug, contentHash: metadata.contentHash!, sourceHash: source.contentHash, version: metadata.version ?? null };
}

async function loadVerificationSkill(input: CampaignCompletionVerificationInput): Promise<CampaignVerificationSkill> {
  if (!input.loadSkill) return { status: 'unavailable', reason: 'loader_unavailable' };
  for (const slug of SKILL_SLUGS) {
    input.signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS); timer.unref?.(); });
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(input.signal?.reason ?? new Error('CAMPAIGN_VERIFICATION_CANCELLED'));
      input.signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      const context = await Promise.race([Promise.resolve().then(() => input.loadSkill!(input.ownerId, slug, 4000)).catch(() => null), deadline, cancelled]);
      input.signal?.throwIfAborted();
      const receipt = context && skillReceipt(context, slug);
      if (receipt) return receipt;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) input.signal?.removeEventListener('abort', abort);
    }
  }
  return { status: 'unavailable', reason: 'active_skill_unavailable' };
}

// API evidence currently uses plain strings. Accept a JSON string encoding of
// the same literal too, without evaluating or interpreting instruction text.
const literal = (value: string | null): string | null => {
  if (value?.startsWith('"')) try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* retain the recorded literal */ }
  return value;
};

/** Fixed host checks implement the playbook's evidence-before-claims step.
 * Missing guidance is disclosed separately; no skill can override a mismatch. */
export async function verifyCampaignCompletion(input: CampaignCompletionVerificationInput): Promise<CampaignCompletionVerification> {
  input.signal?.throwIfAborted();
  const skill = await loadVerificationSkill(input);
  input.signal?.throwIfAborted();
  const parsed = GoogleAdsReadbackSchema.safeParse(input.draft.readback), read = parsed.success ? parsed.data : null;
  const account = GoogleAdsCustomerIdSchema.safeParse(input.expectedCustomerId);
  const resource = input.draft.campaignResourceName;
  const accountMatches = account.success && input.draft.customerId === account.data && read?.customerId === account.data;
  const resourceMatches = account.success && read !== null && typeof resource === 'string' && new RegExp(`^customers/${account.data}/campaigns/\\d+$`).test(resource)
    && read.campaignResourceName === resource && read.resourceNames.includes(resource)
    && read.resourceNames.every(name => !name.startsWith('customers/') || name.startsWith(`customers/${account.data}/`));
  const statusFields = read?.fields.filter(field => field.field === 'campaign.status') ?? [];
  const checks: CampaignCheck[] = [
    { id: 'authorized_account', passed: Boolean(accountMatches), detail: account.success ? `Readback must belong to authorized account ${account.data}.` : 'The authorized target account is missing or invalid.' },
    { id: 'resource_in_account', passed: Boolean(resourceMatches), detail: 'The campaign and returned resource identifiers must belong to the authorized account.' },
    { id: 'paused_state', passed: statusFields.length === 1 && statusFields[0].passed && literal(statusFields[0].expected) === 'PAUSED' && literal(statusFields[0].actual) === 'PAUSED', detail: 'A fresh campaign.status read must confirm PAUSED; saved does not mean enabled or eligible.' },
    { id: 'field_values', passed: Boolean(read && read.fields.length && read.fields.every(field => field.passed && literal(field.expected) === literal(field.actual))), detail: 'Every recorded expected field value must match the observed value, independently of the supplied pass flags.' },
    ...campaignReadbackChecks(input.draft),
  ];
  // The shared progress event accepts 20 checks. Aggregate checks precede any
  // mismatch details, so truncation never drops a decision-relevant condition.
  return { passed: checks.every(check => check.passed), checks: checks.slice(0, 20), skill };
}
