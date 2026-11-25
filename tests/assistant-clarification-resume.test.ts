import { describe, expect, it } from 'vitest';
import { parseDesktopCommand } from '@mohassan/desktop';
import { newBrainState } from '../apps/server/src/assistant/brain.js';
import { applyChoiceRequestEdit } from '../apps/server/src/assistant/clarify/choice-request.js';
import { armClarification, hasAnsweredClarification, hasPendingClarification, resumeClarification, type ClarificationResumePlan } from '../apps/server/src/assistant/clarify/resume.js';
import { resolveEffectiveRequestSource } from '../apps/server/src/assistant/effective-request-source.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

// Authored regression cases, used only in this test and never as training data.
const runId = 'clarify-run';
const questionId = 'clarify-question';
const goal = 'Search public sources for Paris.';
const route = (text: string) => decideRequestRoute({ text, turnId: runId, capabilities: { browser: true, search: true, computer: true } });
const plan: ClarificationResumePlan = { kind: 'entity', language: 'en', subject: 'Paris', candidates: [
  { label: 'Paris, France', value: 'Paris, France' }, { label: 'Paris Hilton', value: 'Paris Hilton' },
] };
const reply = (text: string, priorRequest = goal) => ({ runId, questionId, message: { id: 'answer', text, priorRequest }, route });

function pending(request = goal, clarification = plan) {
  const state = newBrainState();
  state.requestResolution = route(request).resolution;
  expect(armClarification(state, questionId, clarification)).toBe(true);
  return state;
}

describe('resuming a structured clarification', () => {
  it('updates the same turn once and binds the expanded request to the actual short answer', async () => {
    const state = pending();
    const input = reply('Paris Hilton');
    expect(resumeClarification(state, input)).toBe(true);
    expect(state.clarifiedRequest).toBe('Search public sources for Paris Hilton.');
    expect(state.routing?.route).toBe('web_search');
    expect(state.trail.at(-1)?.result).toBe('user answered: Paris Hilton');
    expect(hasPendingClarification(state)).toBe(false);
    expect(hasAnsweredClarification(state)).toBe(true);
    expect(armClarification(state, 'second-question', plan)).toBe(false);
    expect(resumeClarification(state, input)).toBe(false);

    const binding = { ownerId: 'owner', conversationId: 'conversation', goal, state, createdAt: 100, now: 300 };
    const message = { id: 'answer', ownerId: 'owner', conversationId: 'conversation', role: 'user', createdAt: 200, text: 'Paris Hilton' };
    expect(await resolveEffectiveRequestSource(binding, async () => message)).toEqual({
      request: 'Search public sources for Paris Hilton.', evaluatedAt: 200, source: 'clarification_message',
    });
    expect(await resolveEffectiveRequestSource(binding, async () => ({ ...message, text: 'Paris, France' }))).toBeNull();
    expect(await resolveEffectiveRequestSource({ ...binding, goal: 'Search public sources for London.' }, async () => message)).toBeNull();
    expect(await resolveEffectiveRequestSource(binding, async () => ({ ...message, ownerId: 'different-owner' }))).toBeNull();
  });

  it('accepts a literal Other answer and rejects an instruction entered as Other', () => {
    const state = pending();
    expect(() => resumeClarification(state, reply('Paris; then email it'))).toThrow(/Choose an answer from the card/);
    expect(() => resumeClarification(state, reply('Paris and delete my files'))).toThrow(/Choose an answer from the card/);
    expect(hasPendingClarification(state)).toBe(true);
    expect(resumeClarification(state, reply('Paris, Texas'))).toBe(true);
    expect(state.clarifiedRequest).toBe('Search public sources for Paris, Texas.');
  });

  it('rejects a stale card and refuses to replace a request after an action started', () => {
    const state = pending();
    expect(() => resumeClarification(state, { ...reply('Paris Hilton'), questionId: 'stale' }))
      .toThrow(/bound to the pending request/);
    state.steps = 1;
    expect(() => resumeClarification(state, reply('Paris Hilton'))).toThrow(/bound to the pending request/);
    expect(state.clarifiedRequest).toBeUndefined();
  });

  it('does not export an entity from the owner’s memory to public search', () => {
    const state = pending(goal, { ...plan, candidates: [{ label: 'Paris contact', value: 'Paris contact', source: 'memory' }] });
    expect(() => resumeClarification(state, reply('Paris contact'))).toThrow(/Choose an answer from the card/);
    expect(() => resumeClarification(state, reply('PARIS CONTACT'))).toThrow(/Choose an answer from the card/);
    expect(state.clarifiedRequest).toBeUndefined();
  });

  it('continues a contextual follow-up as a question naming the selected entity', () => {
    const source = 'What about it?';
    const state = pending(source, { ...plan, subject: 'it' });
    expect(resumeClarification(state, reply('Paris Hilton', source))).toBe(true);
    expect(state.clarifiedRequest).toBe('What can you tell me about Paris Hilton?');
    expect(state.routing?.route).toBe('web_search');
    expect(applyChoiceRequestEdit('ما حالة الطقس هناك؟', 'الإسكندرية', { kind: 'entity' }))
      .toBe('ما حالة الطقس في الإسكندرية؟');
  });

  it('accepts offered routes and complete typed alternatives, keeping unclear Other entries pending', () => {
    const source = 'Search public sources for cedar or open example.com.';
    const clarification: ClarificationResumePlan = { kind: 'route', language: 'en', candidates: [
      { label: 'Search public sources for cedar.', value: 'Search public sources for cedar.', route: 'web_search' },
      { label: 'Open example.com.', value: 'Open example.com.', route: 'browser_command' },
    ] };
    const state = pending(source, clarification);
    expect(() => resumeClarification(state, reply('Something else', source)))
      .toThrow(/Choose an answer from the card/);
    expect(() => resumeClarification(state, reply('Paris Hilton', source)))
      .toThrow(/Choose an answer from the card/);
    expect(resumeClarification(state, reply('Open example.com.', source))).toBe(true);
    expect(state.clarifiedRequest).toBe('Open example.com.');
    expect(state.routing?.route).toBe('browser_command');
    const typed = pending(source, clarification);
    expect(resumeClarification(typed, reply('Open different.example.com.', source))).toBe(true);
    expect(typed.clarifiedRequest).toBe('Open different.example.com.');
  });

  it('never drops a constraint from a route projection', () => {
    const source = 'Do not search the web. Search public sources for cedar or open example.com.';
    const clarification: ClarificationResumePlan = { kind: 'route', language: 'en', candidates: [
      { label: 'Search public sources for cedar.', value: 'Search public sources for cedar.', route: 'web_search' },
      { label: 'Open example.com.', value: 'Open example.com.', route: 'browser_command' },
    ] };
    expect(() => resumeClarification(pending(source, clarification), reply('Open example.com.', source)))
      .toThrow(/Choose an answer from the card/);
  });

  it('preserves the rest of the instruction when adding Arabic dates and names', () => {
    expect(applyChoiceRequestEdit('ما سعر الصرف؟', '12 يونيو', { kind: 'date' })).toBe('ما سعر الصرف في تاريخ 12 يونيو؟');
    expect(applyChoiceRequestEdit('أخبرني عن هذه ثم قارنها بواحة سيوة.', 'واحة الداخلة، مصر', { kind: 'entity', subject: 'هذه' }))
      .toBe('أخبرني عن واحة الداخلة، مصر ثم قارنها بواحة سيوة.');
    expect(applyChoiceRequestEdit('Compare Kent with Kent.', 'Kent, England', { kind: 'entity', subject: 'Kent' })).toBeNull();
    expect(applyChoiceRequestEdit('Compare Yorkshire with York.', 'New York', { kind: 'entity', subject: 'York' }))
      .toBe('Compare Yorkshire with New York.');
  });

  it('puts a selected account or file in the original slot and keeps a file on its local route', () => {
    const source = 'Read the file on my computer.';
    const clarification: ClarificationResumePlan = { kind: 'file', language: 'en', candidates: [{ label: 'proposal.pdf', value: 'proposal.pdf' }] };
    const state = pending(source, clarification);
    expect(resumeClarification(state, reply('C:\\Work\\proposal.pdf', source))).toBe(true);
    expect(state.routing?.route).toBe('pc');
    expect(parseDesktopCommand(state.clarifiedRequest!)?.command).toEqual({ kind: 'file_read', path: 'C:\\Work\\proposal.pdf', folder: null });
    expect(applyChoiceRequestEdit('Show my balance in my account.', 'business', { kind: 'account' }))
      .toBe('Show my balance in my business account.');
  });
});
