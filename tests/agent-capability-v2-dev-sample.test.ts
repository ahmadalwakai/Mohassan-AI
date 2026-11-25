import { describe, expect, it } from 'vitest';
import type { CapabilityCase, CapabilityTurn } from '../scripts/agent-capability-bench/corpus.js';
import { Mapping, type Candidate } from '../scripts/agent-capability-bench/v2/mapping.js';
import { buildDevelopmentSet } from '../scripts/agent-capability-bench/v2/sample-dev.js';
import type { Quota } from '../scripts/agent-capability-bench/v2/sample.js';
import { capabilityV2PayloadSchema } from '../scripts/agent-capability-bench/v2/sealed.js';
import { sha256 } from '../scripts/agent-capability-bench/v2/sources.js';

const developmentSeed = Buffer.alloc(32, 17);
const targets = [
  { dataset: 'massive', area: 'small-talk', language: 'en', count: 1 },
  { dataset: 'massive', area: 'small-talk', language: 'ar', count: 1 },
] as const satisfies readonly Quota[];

// Synthetic parser and sampler sentinels only.
function turn(text: string): CapabilityTurn {
  return { text, expect: {
    route: ['chat'], status: ['completed'], questionCount: 0, requiredContent: [], forbiddenContent: [], maxSteps: 0,
  } };
}

function item(language: CapabilityCase['language'], ...texts: string[]): Candidate['item'] {
  return { area: 'small-talk', language, variety: language === 'ar' ? 'unspecified' : 'english', turns: texts.map(turn) };
}

describe('capability v2 development sampling', () => {
  it('blocks sealed provenance, normalized text in any turn position, and localizations of the same source item', () => {
    const mapping = new Mapping('massive');
    mapping.accept('en-US:1', '1', item('en', 'Current source wording'));
    mapping.accept('ar-SA:1', '1', item('ar', 'رسالة مترجمة'));
    mapping.accept('en-US:2', '2', item('en', '  CAFE\u0301\n  REQUEST  '));
    mapping.accept('en-US:3', '3', item('en', 'Separate English sample'));
    mapping.accept('ar-SA:4', '4', item('ar', 'رسالة عربية مستقلة'));

    const built = buildDevelopmentSet([mapping.result()], targets, developmentSeed, [{
      provenance: { author: 'human', source: 'massive:en-US:1' },
      turns: [turn('Earlier source wording'), turn('Café request')],
    }]);
    const { cases } = capabilityV2PayloadSchema.parse(JSON.parse(built.payload));

    expect(cases.map(entry => entry.provenance.source).sort()).toEqual(['massive:ar-SA:4', 'massive:en-US:3']);
    expect(JSON.parse(built.accounting)).toMatchObject({
      areas: {
        'small-talk': {
          available: 5, selected: 2, discarded: { sealedSourceId: 1, sealedText: 1, sealedFamily: 1 },
        },
      },
      strata: {
        'massive/small-talk/ar': { available: 2, selected: 1, discarded: { sealedFamily: 1 } },
        'massive/small-talk/en': { available: 3, selected: 1, discarded: { sealedSourceId: 1, sealedText: 1 } },
      },
    });
  });

  it('produces the same bytes from the same seed regardless of row order and pins the result', () => {
    const mapping = new Mapping('massive');
    for (let index = 1; index <= 10; index++) {
      mapping.accept(`en-US:${index}`, String(index), item('en', `English parser sentinel ${index}`));
      mapping.accept(`ar-SA:${index + 10}`, String(index + 10), item('ar', `عبارة اختبار ${index}`));
    }
    const source = mapping.result();
    const first = buildDevelopmentSet([source], targets, developmentSeed, []);
    const second = buildDevelopmentSet([{ ...source, candidates: [...source.candidates].reverse() }], targets, developmentSeed, []);

    expect(second).toEqual(first);
    expect(JSON.parse(first.manifest)).toMatchObject({
      development: { sha256: sha256(first.payload), caseCount: 2, arabicCount: 1 },
    });
    expect(JSON.parse(first.accounting)).toMatchObject({ areas: { 'small-talk': { discarded: { quota: 18 } } } });
    expect(buildDevelopmentSet([source], targets, Buffer.alloc(32, 18), []).payload).not.toBe(first.payload);
    expect(() => buildDevelopmentSet([source], targets, Buffer.alloc(31), [])).toThrow(/32/u);
  });

  it('counts duplicate development text, duplicate families and candidates outside the sampling policy once each', () => {
    const mapping = new Mapping('massive');
    mapping.accept('en-US:1', '1', item('en', ' First TEST sentinel  '));
    mapping.accept('en-US:2', '2', item('en', 'first test sentinel'));
    mapping.accept('en-US:3', '3', item('en', 'Second test sentinel'));
    mapping.accept('en-US:4', '3', item('en', 'Third test sentinel'));
    mapping.accept('ar-SA:5', '5', item('ar', 'عبارة اختبار إضافية'));
    const built = buildDevelopmentSet([mapping.result()], [{ ...targets[0], count: 2 }], developmentSeed, []);

    expect(JSON.parse(built.accounting)).toMatchObject({
      areas: {
        'small-talk': {
          available: 5, selected: 2, discarded: { developmentText: 1, developmentFamily: 1, outsidePolicy: 1 },
        },
      },
    });
  });

  it('fails when the mapped inputs cannot identify a sealed source family', () => {
    const mapping = new Mapping('massive');
    mapping.accept('en-US:1', '1', item('en', 'English parser sentinel'));
    expect(() => buildDevelopmentSet([mapping.result()], targets, developmentSeed, [{
      provenance: { author: 'human', source: 'massive:en-US:missing' },
      turns: [turn('Missing source sentinel')],
    }])).toThrow('A sealed source item was absent from the mapped development inputs.');
  });

  it('uses another source in the same area before filling a shortage from another area in the same language', () => {
    const mintaka = new Mapping('mintaka');
    mintaka.accept('1:en', '1', { ...item('en', 'Mintaka factual sentinel'), area: 'factual' });
    const tydiqa = new Mapping('tydiqa');
    tydiqa.accept('1:en', '1', { ...item('en', 'TyDi QA factual sentinel one'), area: 'factual' });
    tydiqa.accept('2:en', '2', { ...item('en', 'TyDi QA factual sentinel two'), area: 'factual' });
    const gsm8k = new Mapping('gsm8k');
    gsm8k.accept('1', '1', { ...item('en', 'GSM8K calculation sentinel one'), area: 'calculation' });
    const massive = new Mapping('massive');
    massive.accept('ar-SA:1', '1', item('ar', 'عبارة الاختبار الأولى'));
    massive.accept('ar-SA:2', '2', item('ar', 'عبارة الاختبار الثانية'));
    const shortageTargets = [
      { dataset: 'mintaka', area: 'factual', language: 'en', count: 3 },
      { dataset: 'tydiqa', area: 'factual', language: 'en', count: 1 },
      { dataset: 'gsm8k', area: 'calculation', language: 'en', count: 1 },
      targets[1],
    ] as const satisfies readonly Quota[];
    const results = () => [mintaka, tydiqa, gsm8k, massive].map(mapping => mapping.result());

    expect(() => buildDevelopmentSet(results(), shortageTargets, developmentSeed, []))
      .toThrow('Could not fill the development language targets after excluding overlaps.');
    gsm8k.accept('2', '2', { ...item('en', 'GSM8K calculation sentinel two'), area: 'calculation' });
    const built = buildDevelopmentSet(results(), shortageTargets, developmentSeed, []);

    expect(JSON.parse(built.manifest)).toMatchObject({ development: { caseCount: 6, arabicCount: 1 } });
    expect(JSON.parse(built.accounting)).toMatchObject({
      strata: {
        'mintaka/factual/en': { target: 3, selected: 1 },
        'tydiqa/factual/en': { target: 1, selected: 2 },
        'gsm8k/calculation/en': { target: 1, selected: 2 },
        'massive/small-talk/ar': { target: 1, selected: 1 },
      },
    });
  });
});
