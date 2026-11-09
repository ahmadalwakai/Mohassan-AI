import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentPage } from './agent-browser.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const PageHash = z.string().regex(/^[a-f0-9]{24}$/);
export const AgentSessionCheckpointSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  accountId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  savedAt: z.string().datetime(),
  status: z.enum(['ready', 'action_pending', 'approval_pending', 'effect_pending', 'review_required', 'closed']),
  actionKind: z.enum(['open', 'click', 'type', 'select', 'press', 'form', 'back', 'scroll', 'wait']).nullable(),
  resumeUrl: z.string().url().max(2500).nullable(),
  urlHash: Hash.nullable(),
  pageHash: PageHash.nullable(),
  observedAt: z.string().datetime().nullable(),
  documentStatus: z.number().int().min(100).max(599).nullable(),
  effect: z.object({ method: z.string().regex(/^[A-Z]{3,10}$/), urlHash: Hash, bodyHash: Hash }).strict().nullable(),
}).strict();
export type AgentSessionCheckpoint = z.infer<typeof AgentSessionCheckpointSchema>;

export const AgentPostconditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), equals: z.string().url().max(2500) }).strict(),
  z.object({ kind: z.literal('text'), contains: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('title'), equals: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('http_status'), allowed: z.array(z.number().int().min(100).max(599)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal('field'), ref: z.string().regex(/^(?:f\d+)?e\d+$/), equals: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('element'), role: z.string().min(1).max(80), label: z.string().min(1).max(90) }).strict(),
]);
export type AgentPostcondition = z.infer<typeof AgentPostconditionSchema>;
export interface AgentVerificationCheck { kind: AgentPostcondition['kind']; status: 'passed' | 'failed' | 'unavailable'; expectedHash: string; actualHash: string | null }
export interface AgentVerificationReport {
  scope: 'declared_postconditions';
  status: 'passed' | 'failed' | 'unavailable';
  pageId: string;
  pageHash: string;
  observedAt: string;
  checks: AgentVerificationCheck[];
  samples: number;
}
export const evidenceHash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Refuse to persist credential-bearing URLs rather than silently changing their meaning. */
export function safeResumeUrl(input: string, secrets: readonly string[] = []): string | null {
  if (input.length > 2500 || input.includes('[محجوب]') || secrets.some(secret => secret.length >= 4 && input.includes(secret))) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { return null; }
  if (secrets.some(secret => secret.length >= 4 && (decodedPath.includes(secret) || [...url.searchParams.values()].some(value => value.includes(secret))))) return null;
  for (const [key, value] of url.searchParams) {
    if (/token|password|passwd|secret|authorization|api[_-]?key|credential|session|signature|^code$|^otp$|^pin$|^key$|^state$/i.test(key) || /^(?:sk-|ghp_|github_pat_|eyJ)[a-zA-Z0-9._-]{12,}$/.test(value)) return null;
  }
  if (/\/(?:token|password|secret|credential|session)\//i.test(decodedPath)) return null;
  return url.href;
}

export function pagePostcondition(page: AgentPage, expected: Exclude<AgentPostcondition, { kind: 'field' }>): AgentVerificationCheck {
  let passed: boolean | undefined, actual: unknown;
  switch (expected.kind) {
    case 'url': actual = page.url; passed = page.url === expected.equals; break;
    case 'title': actual = page.title; passed = page.title === expected.equals; break;
    case 'text': actual = page.text; passed = page.text.includes(expected.contains); break;
    case 'http_status': actual = page.documentStatus; passed = actual === undefined ? undefined : expected.allowed.includes(page.documentStatus!); break;
    case 'element': actual = page.elements.filter(element => element.role === expected.role && element.label === expected.label).map(element => element.ref); passed = (actual as string[]).length === 1; break;
  }
  return { kind: expected.kind, status: passed === undefined ? 'unavailable' : passed ? 'passed' : 'failed', expectedHash: evidenceHash(JSON.stringify(expected)), actualHash: actual === undefined ? null : evidenceHash(JSON.stringify(actual)) };
}
