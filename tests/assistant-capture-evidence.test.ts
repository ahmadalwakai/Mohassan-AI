import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentCaptureResult, AgentCaptureReceipt, AgentPage } from '@mohassan/browser';
import { validateChatCapture } from '../apps/server/src/assistant/capture-evidence.js';
import { createChatSupervisor, observeChatCapture, reviewChatAnswer } from '../apps/server/src/assistant/chat-supervision.js';

const start = Date.parse('2026-11-21T06:00:00Z');
const iso = (offset: number) => new Date(start + offset).toISOString();
function fixture() {
  const requested = { id: 'requested-observation', url: 'https://capture.test/page', hash: 'a'.repeat(24) };
  const page: AgentPage = { ...requested, id: 'captured-observation', observedAt: iso(40), title: 'Fixture', text: 'Fixture',
    documentStatus: 200, signals: { captcha: false, password: false, otp: false, card: false }, elements: [], scroll: { top: 0, height: 100, viewport: 100 } };
  // Only a byte-integrity fixture; real JPEG creation is independently covered by Chromium/controller tests.
  const image = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const receipt: AgentCaptureReceipt = { version: 1, scope: 'stable_observation_samples', ownerId: 'owner', conversationId: 'conversation',
    requestedPageId: requested.id, pageId: page.id, pageHash: page.hash, url: page.url, imageHash: createHash('sha256').update(image).digest('hex'),
    imageBytes: image.length, mimeType: 'image/jpeg', startedAt: iso(10), captureStartedAt: iso(20), captureFinishedAt: iso(30), finishedAt: iso(50),
    documentFingerprint: 'b'.repeat(64), viewportFingerprint: 'c'.repeat(64), beforeFingerprint: 'd'.repeat(64), afterFingerprint: 'd'.repeat(64) };
  const capture: Extract<AgentCaptureResult, { status: 'captured' }> = { status: 'captured', page, image, receipt };
  const scope = { ownerId: 'owner', conversationId: 'conversation', requestedPage: requested, startedAt: start, now: start + 100 };
  return { requested, capture, scope };
}
describe('host screenshot receipt validation', () => {
  it('adopts the final observation and hashes an isolated copy of the exact bytes', () => {
    const { capture, scope } = fixture();
    const checked = validateChatCapture(capture, scope)!;
    expect(checked.page.id).toBe('captured-observation');
    expect(checked.imageHash).toBe(capture.receipt.imageHash);
    capture.image[2] = 99;
    expect(checked.image[2]).toBe(1);
  });
  it.each([
    ['ownerId', 'another-owner'], ['conversationId', 'another-conversation'], ['requestedPageId', 'another-request'],
    ['pageId', 'earlier-page'], ['pageHash', 'f'.repeat(24)], ['url', 'https://capture.test/elsewhere'],
    ['imageHash', 'e'.repeat(64)], ['imageBytes', 99], ['afterFingerprint', 'e'.repeat(64)],
    ['startedAt', iso(-1)], ['captureStartedAt', iso(5)], ['captureFinishedAt', iso(60)], ['finishedAt', iso(101)],
  ])('does not certify a mismatched receipt field %s', (field, value) => {
    const { capture, scope } = fixture();
    const changed = { ...capture, receipt: { ...capture.receipt, [field]: value } };
    expect(validateChatCapture(changed as typeof capture, scope)).toBeNull();
  });
  it('rejects a changed byte buffer, future observation, invalid status and raw unbound bytes', () => {
    const { capture, scope } = fixture();
    const mutated = { ...capture, image: Buffer.from(capture.image) }; mutated.image[2] ^= 1;
    expect(validateChatCapture(mutated, scope)).toBeNull();
    expect(validateChatCapture({ ...capture, page: { ...capture.page, observedAt: iso(200) } }, scope)).toBeNull();
    expect(validateChatCapture({ ...capture, page: { ...capture.page, documentStatus: 999 } }, scope)).toBeNull();
    expect(validateChatCapture({ status: 'unavailable', reason: 'capture_failed' }, scope)).toBeNull();
  });
  it('binds the screenshot and navigation to the same final page in task supervision', () => {
    const { capture, scope } = fixture();
    const state = createChatSupervisor('capture-run', `افتح ${capture.page.url} واعرض لقطة الصفحة`, undefined, start);
    expect(observeChatCapture(state, { capture, ...scope })).toBeTruthy();
    expect(reviewChatAnswer(state, 'Captured', start + 100)).toMatchObject({ status: 'verified', allowCompletion: true });
    const observation = state.steps.at(-1)!.observations;
    expect(observation.find(item => item.kind === 'artifact')).toMatchObject({ pageRef: capture.page.id });
    expect(observation.find(item => item.kind === 'navigation')).toMatchObject({ reference: capture.page.id });
  });
  it('never promotes a screenshot of an unsuccessful page or reuses an artifact after a failed recapture', () => {
    const { capture, scope } = fixture();
    const state = createChatSupervisor('capture-run', `افتح ${capture.page.url} واعرض لقطة الصفحة`, undefined, start);
    observeChatCapture(state, { capture: { ...capture, page: { ...capture.page, documentStatus: 404 } }, ...scope });
    expect(reviewChatAnswer(state, 'Captured', start + 100).allowCompletion).toBe(false);
    const successful = createChatSupervisor('another-capture-run', `افتح ${capture.page.url} واعرض لقطة الصفحة`, undefined, start);
    observeChatCapture(successful, { capture, ...scope });
    expect(reviewChatAnswer(successful, 'Captured', start + 100).allowCompletion).toBe(true);
    observeChatCapture(successful, { capture: { status: 'unavailable', reason: 'changed' }, ...scope, startedAt: start + 100, now: start + 200 });
    expect(reviewChatAnswer(successful, 'Captured', start + 200).allowCompletion).toBe(false);
  });
});
