import { describe, expect, it } from 'vitest';
import { monitorDecisionFeatures, monitorProposalDecisionSnapshot } from '../apps/server/src/monitors/decision/features.js';
import { buildMonitorContextFrame } from '../apps/server/src/monitors/decision/frame.js';
import { reasonMonitorContext } from '../apps/server/src/monitors/decision/reasoner.js';

describe('monitor decision feature privacy', () => {
  const frame = (text: string) => buildMonitorContextFrame({ text: 'Watch the public registration page.', history: [{ role: 'assistant', text }] });

  it('derives the same lexical features regardless of the value in a copied cookie field', () => {
    const first = monitorDecisionFeatures(frame('Cookie: fixture=paper-lantern'));
    const second = monitorDecisionFeatures(frame('Cookie: fixture=folding-map'));
    expect(first.textFeatureIds).toEqual(second.textFeatureIds);
  });

  it('omits proposal recording when decision context contains a copied credential field', () => {
    const privateFrame = frame('Cookie: fixture=paper-lantern');
    const ordinaryFrame = frame('The registration page is open.');
    expect(monitorProposalDecisionSnapshot(ordinaryFrame, reasonMonitorContext(ordinaryFrame), 'propose')).toBeDefined();
    expect(monitorProposalDecisionSnapshot(privateFrame, reasonMonitorContext(privateFrame), 'propose') === undefined).toBe(true);
  });
});
