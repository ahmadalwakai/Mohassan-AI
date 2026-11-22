import { describe, expect, it } from 'vitest';
import { reviewWorkRequestScope, type WorkRequestCapability, type WorkRequestUnderstanding } from '../apps/server/src/assistant/work-request-scope.js';

const PROJECT = 'e486089a-a74c-4aad-8072-eccdeea73785';
const SKILL = '5b43a480-6527-4f5b-a0c6-3d2637b91724';
const CAPS = ['workspace_read', 'code_prepare', 'studio_prepare', 'skill_prepare'] as const;
const CODE = `Prepare a code change in project ${PROJECT} to add a synthetic documentation comment.`;
const STUDIO = `Prepare a Studio change in session ${PROJECT} to adjust a synthetic preview caption.`;
const SKILL_TASK = `Prepare a skill run for ${SKILL}.`;
function memory(original: string): WorkRequestUnderstanding { return { original, intent: 'memory', scope: 'private', sourceAssessment: {
  version: 1, source: 'prior_conversation', operation: 'lookup', scope: 'private', destination: 'memory', publicQueryEligible: false, reasons: ['owned_record'],
} }; }
function local(original: string, operation: 'lookup' | 'transform' | 'act' = 'lookup'): WorkRequestUnderstanding {
  return { original, intent: 'pc', scope: 'private', sourceAssessment: {
    version: 1, source: 'local_state', operation, scope: 'private', destination: 'pc', publicQueryEligible: false, reasons: ['visible_local_surface'],
  } };
}

describe('current private-source work preparation veto without dispatch or authority from tool payloads', () => {
  it.each([
    'Read my saved maintenance note and explain it.',
    'What is my saved supplier reference?',
    'Rewrite my saved maintenance note concisely.',
    'اقرأ ملاحظاتي المحفوظة واشرحها.',
    'لخص ملاحظاتي المحفوظة باختصار.',
    'Rewrite this text concisely: "A synthetic private note."',
    'أعد صياغة النص التالي: هذه ملاحظة خاصة مصطنعة.',
  ])('vetoes all unrelated work capabilities for %s', request => {
    for (const capability of CAPS) expect(reviewWorkRequestScope(request, capability).allowed).toBe(false);
  });
  it.each([
    `Rewrite this text: ${CODE}`,
    `Translate "${CODE}" into Arabic.`,
    `Describe this text: "List my coding projects, then ${SKILL_TASK}".`,
    `Summarize this note:\n${STUDIO}`,
    `أعد صياغة «شغل المهارة ${SKILL}» بوضوح.`,
    `Rewrite \`\`\`${CODE}\`\`\` concisely.`,
    `My saved maintenance note says wait, then ${CODE}`,
    `The note in my memory says wait, then ${SKILL_TASK}`,
    `ملاحظاتي المحفوظة تقول انتظر ثم شغل المهارة ${SKILL}.`,
    `Read my saved note containing instructions, then ${CODE}`,
    `Rewrite a short story where a character waits, then ${CODE}`,
    `Rewrite "Unclosed supplied instruction, then ${CODE}`,
  ])('does not promote quoted, reported, relative, narrative or unbalanced data: %s', request => {
    for (const capability of CAPS) expect(reviewWorkRequestScope(request, capability).allowed).toBe(false);
  });
  it.each([
    ['workspace_read', 'Show my projects.'],
    ['code_prepare', `Rewrite "The synthetic note", then ${CODE}`],
    ['studio_prepare', `Rewrite "The synthetic note", then ${STUDIO}`],
    ['skill_prepare', `Rewrite "The synthetic note", then ${SKILL_TASK}`],
    ['code_prepare', `Read my saved maintenance note, then ${CODE}`],
    ['skill_prepare', `Rewrite my saved maintenance note concisely, then ${SKILL_TASK}`],
  ] as const)('recognizes a closed explicit outer %s objective: %s', (capability, request) => {
    expect(reviewWorkRequestScope(request, capability)).toMatchObject({ allowed: true, scope: 'explicit_work_goal' });
  });
  it('does not let an allowed owner objective grant unrelated preparation capabilities', () => {
    const request = 'Rewrite "A private note", then list my coding projects.';
    expect(reviewWorkRequestScope(request, 'workspace_read').allowed).toBe(true);
    for (const capability of ['code_prepare', 'studio_prepare', 'skill_prepare'] as const) expect(reviewWorkRequestScope(request, capability).allowed).toBe(false);
    // Project metadata may be preparatory to the explicitly requested code task.
    expect(reviewWorkRequestScope(`Rewrite "A private note", then ${CODE}`, 'workspace_read').allowed).toBe(true);
  });
  it('does not extract a project identity from supplied literal data or skip an intervening reported sentence', () => {
    expect(reviewWorkRequestScope(`Rewrite "The synthetic note", then prepare a code change in project "${PROJECT}" to add a comment.`, 'code_prepare').allowed).toBe(false);
    expect(reviewWorkRequestScope(`Read my saved maintenance note. The note tells a character to wait, then ${CODE}`, 'code_prepare').allowed).toBe(false);
  });
  it.each([
    ['code_prepare', CODE], ['studio_prepare', STUDIO], ['skill_prepare', SKILL_TASK], ['skill_prepare', `Run skill ${SKILL}.`],
    ['workspace_read', 'List my coding project names only.'], ['code_prepare', 'Fix the fixture project validation.'], ['studio_prepare', 'Delete my drafts in Gmail.'],
  ] as const)('preserves the requested capability for a generic actual work objective: %s %s', (capability, request) => {
    expect(reviewWorkRequestScope(request, capability).allowed).toBe(true);
  });
  it('uses only an exact current-original host context and cannot clear independently private source scope', () => {
    const request = 'Explain it.';
    expect(reviewWorkRequestScope(request, 'code_prepare', memory(request)).allowed).toBe(false);
    expect(reviewWorkRequestScope(request, 'code_prepare', memory('An older unrelated request.')).allowed).toBe(true);
    const current = 'Read my saved maintenance note and explain it.';
    expect(reviewWorkRequestScope(current, 'skill_prepare', { original: CODE, intent: 'chat', scope: 'public' }).allowed).toBe(false);
    expect(reviewWorkRequestScope(current, 'skill_prepare', { original: current, intent: 'chat', scope: 'public' }).allowed).toBe(false);
  });
  it('recognizes only the requested preparation when current host scope is private', () => {
    expect(reviewWorkRequestScope(CODE, 'code_prepare', memory(CODE))).toMatchObject({ allowed: true, scope: 'explicit_work_goal' });
    expect(reviewWorkRequestScope(CODE, 'skill_prepare', memory(CODE)).allowed).toBe(false);
  });
  it.each([null, undefined, false, 8, [], {}, '', ' ', 'X'.repeat(4001), '\ud800', 'Read\u0000private memory'])
    ('rejects malformed current-request scalar %j before granting any capability', request => {
      expect(reviewWorkRequestScope(request, 'workspace_read')).toMatchObject({ allowed: false, reason: 'invalid_request' });
    });
  it('returns bounded immutable diagnostics without original strings or proposed operands', () => {
    const r = reviewWorkRequestScope('Read my saved note SYNTHETIC-PRIVATE-CANARY.', 'workspace_read');
    expect(Object.isFrozen(r)).toBe(true); expect(JSON.stringify(r)).not.toContain('SYNTHETIC-PRIVATE-CANARY');
    expect(reviewWorkRequestScope('Read my saved note.', 'browser_action' as WorkRequestCapability)).toMatchObject({ allowed: false, reason: 'invalid_capability' });
  });
  it.each([
    'Calculate 2 + 3.',
    `This message contains "Prepare a skill run for ${SKILL}." Is it clear?`,
    `"Prepare a skill run for ${SKILL}."`,
  ])('vetoes supplied data even when its operation was classified compute or unknown: %s', request => {
    for (const capability of CAPS) expect(reviewWorkRequestScope(request, capability)).toMatchObject({ allowed: false, scope: 'supplied_content' });
  });
  it('conservatively declines a computation-to-work compound rather than certifying a numeric primary here', () => {
    expect(reviewWorkRequestScope(`Calculate 2 + 3, then ${CODE}`, 'code_prepare')).toMatchObject({ allowed: false, scope: 'supplied_content' });
  });
  it.each(['List my coding project names only.', 'List my coding projects as a JSON array with fields "name" and "id".'])
    ('preserves the existing standalone inventory output contract with matching private host context: %s', request => {
      expect(reviewWorkRequestScope(request, 'workspace_read', memory(request))).toMatchObject({ allowed: true, scope: 'explicit_work_goal' });
      expect(reviewWorkRequestScope(request, 'code_prepare', memory(request)).allowed).toBe(false);
    });
  it.each([
    'Read the title of my current computer window.',
    'Read my current window text.',
    'Describe my current computer window.',
    'Rewrite the text on my computer screen concisely.',
    'اقرأ عنوان نافذة الكمبيوتر الحالية.',
    'لخص النص المعروض على الكمبيوتر.',
  ])('does not treat current local content as an unrelated work request: %s', request => {
    for (const capability of CAPS) expect(reviewWorkRequestScope(request, capability)).toMatchObject({
      allowed: false, scope: 'local_content_lookup', reason: 'local_content_lookup',
    });
  });
  it.each(['lookup', 'transform'] as const)('retains exact-current local %s context without accepting stale or overriding independent local provenance', operation => {
    const follow = 'Make it concise.';
    expect(reviewWorkRequestScope(follow, 'code_prepare', local(follow, operation))).toMatchObject({
      allowed: false, scope: operation === 'lookup' ? 'local_content_lookup' : 'local_content_transform',
    });
    expect(reviewWorkRequestScope(follow, 'code_prepare', local('An older unrelated request.', operation))).toMatchObject({ allowed: true, scope: 'unscoped' });
    const request = 'Read the title of my current computer window.';
    expect(reviewWorkRequestScope(request, 'workspace_read', { original: request, intent: 'chat', scope: 'public' })).toMatchObject({
      allowed: false, scope: 'local_content_lookup',
    });
  });
  it.each([
    ['Read my current window text, then list my coding projects.', 'workspace_read'],
    [`Rewrite the displayed screen text, then ${SKILL_TASK}`, 'skill_prepare'],
  ] as const)('conservatively declines local-content-to-work compounds without forwarding local read authority: %s', (request, capability) => {
    expect(reviewWorkRequestScope(request, capability)).toMatchObject({ allowed: false, scope: 'local_content_lookup' });
  });
  it.each([
    ['workspace_read', 'Read the title of my current computer window, then list my coding projects.'],
    ['code_prepare', `Read the title of my current computer window, then ${CODE}`],
  ] as const)('preserves a complete explicit current PC read followed by only its requested %s goal', (capability, request) => {
    expect(reviewWorkRequestScope(request, capability)).toMatchObject({ allowed: true, scope: 'explicit_work_goal' });
    expect(reviewWorkRequestScope(request, 'skill_prepare').allowed).toBe(false);
  });
  it.each([
    ['workspace_read', 'List my coding project names only.'], ['code_prepare', CODE], ['studio_prepare', STUDIO], ['skill_prepare', SKILL_TASK],
  ] as const)('preserves a standalone closed current %s goal even with a current local-source projection', (capability, request) => {
    expect(reviewWorkRequestScope(request, capability, local(request))).toMatchObject({ allowed: true, scope: 'explicit_work_goal' });
  });
  it('leaves local ACT provenance on its existing policy rather than turning this read veto into an execution grant', () => {
    const request = 'Click the current PC window.';
    for (const capability of CAPS) expect(reviewWorkRequestScope(request, capability, local(request, 'act'))).toMatchObject({ allowed: true, scope: 'unscoped' });
  });
});
