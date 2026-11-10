import { describe, expect, it } from 'vitest';
import { applyAnswer, assessReadiness, interpretGoal, markAsked, reviseFromMessage } from '@mohassan/cognitive';
import { cognitiveLabCases } from '../packages/learning/src/cognitive-lab.js';
import { CLARIFICATION_SCENARIOS } from './fixtures/clarification-scenarios.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const STATUS = { ASK_USER: 'NEEDS_CLARIFICATION', PROCEED: 'READY', RESEARCH: 'NEEDS_RESEARCH', REQUEST_APPROVAL: 'NEEDS_APPROVAL', BLOCKED: 'BLOCKED', PREPARE_DRAFT: 'BLOCKED' } as const;

/** Deterministic evaluation of the core. The engine makes no model calls, so model overhead is zero by construction. */
export function evaluateClarification() {
  const rows = CLARIFICATION_SCENARIOS.map(scenario => {
    const context = { ...scenario.context, now: NOW };
    const started = performance.now();
    const frame = interpretGoal(context);
    const assessment = assessReadiness(frame, context);
    const micros = (performance.now() - started) * 1000;
    const asked = assessment.outcome === 'ASK_USER';
    const slotsOk = !scenario.slots || scenario.slots.every(slot => assessment.question?.slots.includes(slot));
    return { id: scenario.id, category: scenario.category, expected: scenario.expected, actual: assessment.outcome, correct: assessment.outcome === scenario.expected && slotsOk, statusCorrect: assessment.status === STATUS[scenario.expected], critical: Boolean(scenario.critical), detected: asked && slotsOk, asked, micros };
  });
  const critical = rows.filter(row => row.critical), notAsk = rows.filter(row => row.expected !== 'ASK_USER');
  const lab = cognitiveLabCases.map(spec => { const context = { request: spec.prompt.replaceAll('{{url}}', 'http://127.0.0.1:4555/'), capabilities: { models: true, search: true, browser: true }, now: NOW }; return assessReadiness(interpretGoal(context), context).outcome; });
  return {
    scenarios: rows.length,
    decisionCorrectness: rows.filter(row => row.correct).length / rows.length,
    readinessAccuracy: rows.filter(row => row.statusCorrect).length / rows.length,
    criticalRecall: critical.filter(row => row.detected).length / critical.length,
    criticalCases: critical.length,
    unnecessaryQuestionRate: notAsk.filter(row => row.asked).length / notAsk.length,
    heldOutLabCases: lab.length,
    heldOutLabInterruptions: lab.filter(outcome => outcome === 'ASK_USER' || outcome === 'BLOCKED').length,
    meanMicros: Math.round(rows.reduce((sum, row) => sum + row.micros, 0) / rows.length),
    maxMicros: Math.round(Math.max(...rows.map(row => row.micros))),
    modelCalls: 0,
    failures: rows.filter(row => !row.correct || !row.statusCorrect).map(row => `${row.id}: expected ${row.expected}, got ${row.actual}`),
  };
}

describe('clarification evaluation (deterministic)', () => {
  it('meets the development-set targets and reports the metrics', () => {
    const report = evaluateClarification();
    console.info(`[clarification-eval] ${JSON.stringify(report)}`);
    expect(report.scenarios).toBeGreaterThanOrEqual(25);
    expect(report.failures).toEqual([]);
    expect(report.criticalRecall).toBe(1);
    expect(report.unnecessaryQuestionRate).toBe(0);
    expect(report.heldOutLabInterruptions).toBe(0);
    // A simple request must stay fast: the gate runs before every model loop.
    expect(report.meanMicros).toBeLessThan(5000);
  });

  it('runs a multi-turn clarification to readiness and lets the user change their mind', () => {
    const context = { request: 'أنشئ حملة في حسابي على Google Ads لمحل حلويات', signals: { adsCreateInAccount: true }, capabilities: { models: true, ads: true, adsCreate: true, search: true }, now: NOW };
    let frame = interpretGoal(context);
    let assessment = assessReadiness(frame, context);
    const turns: string[] = [];
    for (const reply of ['الميزانية 20 دولار يوميًا', 'https://sweets.example.com في القاهرة']) {
      expect(assessment.outcome).toBe('ASK_USER');
      frame = applyAnswer(markAsked(frame, assessment.question!, NOW), assessment.question!, { text: reply }, context, NOW).frame;
      assessment = assessReadiness(frame, context);
      turns.push(assessment.outcome);
    }
    expect(turns).toEqual(['ASK_USER', 'REQUEST_APPROVAL']);
    const changed = reviseFromMessage(frame, 'غيّر الميزانية إلى 30 دولار', context, NOW)!;
    expect(changed.changed).toEqual(['ads_budget']);
    expect(changed.frame.version).toBeGreaterThan(frame.version);
  });
});
