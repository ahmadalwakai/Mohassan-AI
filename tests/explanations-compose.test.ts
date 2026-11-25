import { describe, expect, it } from 'vitest';
import { composeExplanation } from '../apps/server/src/assistant/writing/multisource/compose.js';
import type { Claim, ClaimGroup } from '../apps/server/src/assistant/writing/multisource/types.js';
import type { ExtractiveWritingTask } from '../apps/server/src/assistant/writing/request.js';

function claim(kind: Claim['kind'], text: string, title: string, url: string, fields: Omit<Partial<Claim>, 'kind' | 'span'> = {}): Claim {
  const prefix = 'Heading\n\n';
  return { kind, span: { source: { title, url, text: `${prefix}${text}\n\nFooter` }, start: prefix.length, end: prefix.length + text.length, text }, ...fields };
}

function group(...claims: Claim[]): ClaimGroup {
  return { claims, support: claims.length };
}

function explanation(intent: 'why' | 'how', topic: string, format: ExtractiveWritingTask['format'] = 'paragraph'): ExtractiveWritingTask {
  return { kind: 'explanation', language: 'en', format, intent, topic, instruction: `${intent} ${topic}`,
    source: { kind: 'search', query: topic }, structure: { format } };
}

describe('quote-only explanation composition', () => {
  it('opens with the most supported relevant cause and uses each source’s own quote', () => {
    const a = claim('causal', 'The lamp glows because the filament heats up.', 'First source', 'https://first.test/', { effect: 'The lamp glows' });
    const mirror = claim('causal', 'The filament heats up, so the lamp glows.', 'First source mirror', 'https://mirror.first.test/', { effect: 'The lamp glows' });
    const syndicated = claim('causal', a.span.text, 'Syndicated copy', 'https://syndication.test/', { effect: 'The lamp glows' });
    const b = claim('causal', 'The heated filament causes the lamp to glow.', 'Second source', 'https://second.test/', { effect: 'the lamp to glow' });
    const weaker = claim('causal', 'The lamp glows due to the circuit being closed.', 'Third source', 'https://third.test/');
    const irrelevant = claim('causal', 'The sky is blue because sunlight scatters.', 'Astronomy', 'https://sky.test/');
    const reply = composeExplanation(explanation('why', 'the lamp glows'), [group(weaker), { claims: [a, mirror, syndicated, b], support: 2 }, group(irrelevant, irrelevant)], []);
    expect(reply.text).toMatch(/^«The lamp glows because the filament heats up\.» \[First source\]/u);
    expect(reply.text).toContain('«The heated filament causes the lamp to glow.» [Second source](https://second.test/)');
    expect(reply.text).toContain('**Factors**');
    expect(reply.text).not.toMatch(/sky is blue|First source mirror|Syndicated copy/u);
    expect(reply.evidence).toEqual([a.span, b.span, weaker.span]);
    expect(reply.complete).toBe(true);
  });

  it('orders mechanism steps and examples and shows conflicting quotes with both citations', () => {
    const topic = 'Lamp circuit';
    const summarize = claim('mechanism', 'The lamp circuit works by passing electricity through a filament.', topic, 'https://first.test/');
    const second = claim('mechanism', 'Second, electricity passes through the filament.', topic, 'https://first.test/step-2', { step: 2 });
    const first = claim('mechanism', 'First, the switch closes the circuit.', topic, 'https://second.test/', { step: 1 });
    const factor = claim('causal', 'The lamp circuit needs a power supply because current must flow.', topic, 'https://second.test/power');
    const switchFactor = claim('causal', 'The lamp circuit stays dark when the switch breaks the path.', topic, 'https://third.test/switch');
    const example = claim('example', 'For example, a flashlight uses a lamp circuit.', topic, 'https://third.test/');
    const limit = claim('limit', 'This lamp circuit only works with a closed switch.', topic, 'https://third.test/limits');
    const negative = claim('causal', 'The lamp circuit does not need a power supply.', topic, 'https://fourth.test/');
    const reply = composeExplanation(explanation('how', topic), [group(summarize), group(second), group(first), group(factor), group(switchFactor), group(example), group(limit)],
      [{ left: factor, right: negative }]);
    const lines = reply.text.split('\n');
    expect(lines[0]).toContain(summarize.span.text);
    expect(lines.indexOf('**Mechanism**')).toBeLessThan(lines.indexOf('**Factors**'));
    expect(reply.text.indexOf(first.span.text)).toBeLessThan(reply.text.indexOf(second.span.text));
    expect(lines.indexOf('**Examples**')).toBeLessThan(lines.indexOf('**Limits**'));
    expect(lines.findIndex(line => line.includes(factor.span.text))).toBeGreaterThan(lines.indexOf('**Conflicting sources**'));
    expect(reply.text).toMatch(/\*\*Conflicting sources\*\*[\s\S]+https:\/\/second\.test\/power\) · «The lamp circuit does not need a power supply\.» \[Lamp circuit\]\(https:\/\/fourth\.test\/\)/u);
    for (const { start, end, source, text } of reply.evidence) expect(source.text.slice(start, end)).toBe(text);
  });

  it('skips invalid spans and treats a definition alone as a partial explanation', () => {
    const definition = claim('definition', 'A lamp is a device that produces light.', 'Lamp', 'https://first.test/');
    const fabricated = claim('causal', 'A lamp glows because of magic.', 'Lamp', 'https://second.test/');
    fabricated.span.start--;
    const reply = composeExplanation(explanation('why', 'lamp'), [group(definition), group(fabricated)], []);
    expect(reply.complete).toBe(false);
    expect(reply.evidence).toEqual([definition.span]);
    expect(reply.text).not.toContain('magic');
    expect(composeExplanation(explanation('why', 'lamp'), [group(fabricated)], [])).toEqual({
      text: 'No matching evidence', evidence: [], complete: false,
    });
  });

  it('prefers a direct explanation over agreement on a sentence that only matches the page title', () => {
    const directlyRelevant = claim('causal', 'The lamp glows because its filament is hot.', 'Lighting', 'https://first.test/', { effect: 'The lamp glows' });
    const otherPhenomenon = claim('causal', 'Sunlight scatters as it travels through the air.', 'Why the lamp glows', 'https://second.test/');
    const reply = composeExplanation(explanation('why', 'the lamp glows'), [group(directlyRelevant), { claims: [otherPhenomenon], support: 3 }], []);
    expect(reply.evidence).toEqual([directlyRelevant.span]);
    expect(reply.complete).toBe(true);
    expect(composeExplanation(explanation('why', 'the lamp glows'), [group(otherPhenomenon)], []).complete).toBe(false);
  });

  it('honours a one-line result while retaining both sides of a direct conflict', () => {
    const a = claim('causal', 'The lamp glows because the filament heats.', 'First', 'https://first.test/');
    const b = claim('causal', 'The lamp glows without the filament heating.', 'Second', 'https://second.test/');
    const reply = composeExplanation(explanation('why', 'lamp', 'line'), [group(a), group(b)], [{ left: a, right: b }]);
    expect(reply.text).not.toContain('\n');
    expect(reply.text).toContain('**Conflicting sources**');
    expect(reply.evidence).toContain(b.span);
  });

  it('bounds displayed disputes without leaking omitted disputed evidence into factors', () => {
    const a = claim('causal', 'The lamp glows because the filament heats.', 'First', 'https://first.test/');
    const other = ['glass', 'metal', 'sand', 'water'].map(word =>
      claim('causal', `The lamp glows because it contains ${word}.`, word, `https://${word}.test/`));
    const reply = composeExplanation(explanation('why', 'lamp'), [group(a), ...other.map(item => group(item))],
      other.map(right => ({ left: a, right })));
    expect(reply.text).toContain('https://sand.test/');
    expect(reply.text).not.toContain('https://water.test/');
  });
});

describe('comparison composition', () => {
  it('pairs exact subjects by attribute, escapes table quotes and leaves unsupported cells empty', () => {
    const task: ExtractiveWritingTask = { kind: 'comparison', language: 'ar', format: 'table', instruction: 'ما الفرق بين الخشب والحديد؟',
      subjects: ['الخشب', 'الحديد'], source: { kind: 'search', query: 'الخشب الحديد' }, structure: { format: 'table' } };
    const a = claim('attribute', 'يتكون الخشب من السليلوز | واللجنين.', 'المصدر الأول', 'https://first.test/wood', { subject: 'خشب', attribute: 'composition' });
    const b = claim('attribute', 'يتكون الحديد من ذرات الحديد.', 'المصدر الثاني', 'https://second.test/Iron_(element)', { subject: 'الحديد', attribute: 'composition' });
    const c = claim('attribute', 'تختلف تكلفة الخشب حسب النوع.', 'المصدر الثالث', 'https://third.test/', { subject: 'الخشب', attribute: 'cost' });
    const d = claim('attribute', 'تختلف تكلفة خشب البلوط حسب الجودة.', 'المصدر الرابع', 'https://fourth.test/', { subject: 'خشب البلوط', attribute: 'cost' });
    const reply = composeExplanation(task, [group(a), group(b), group(c), { claims: [d], support: 5 }], []);
    expect(reply.text).toMatch(/^\| الجانب \| الخشب \| الحديد \|/u);
    expect(reply.text).toContain('| التركيب | «يتكون الخشب من السليلوز \\| واللجنين.» [المصدر الأول](https://first.test/wood) | «يتكون الحديد من ذرات الحديد.» [المصدر الثاني](https://second.test/Iron_(element)) |');
    expect(reply.text).toContain('| التكلفة | «تختلف تكلفة الخشب حسب النوع.» [المصدر الثالث](https://third.test/) | — |');
    expect(reply.evidence).toEqual([a.span, b.span, c.span]);
    expect(reply.complete).toBe(true);
  });

  it('keeps a direct comparison with both named items when common attributes cannot be assigned', () => {
    const task: ExtractiveWritingTask = { kind: 'comparison', language: 'en', format: 'table', instruction: 'AC and DC',
      subjects: ['AC', 'DC'], source: { kind: 'search', query: 'AC DC' }, structure: { format: 'table' } };
    const contrast = claim('contrast', 'Alternating current (AC) changes direction, whereas direct current (DC) does not.', 'Electric current', 'https://first.test/',
      { subject: 'alternating current (AC)', contrasted: 'direct current (DC)' });
    const reply = composeExplanation(task, [group(contrast)], []);
    expect(reply.text).toContain('| Direct comparison | «Alternating current (AC) changes direction, whereas direct current (DC) does not.» [Electric current](https://first.test/) | — |');
    expect(reply.evidence).toEqual([contrast.span]);
    expect(reply.complete).toBe(true);
  });

  it('matches a scoped operand only when the scope is present, and attributes a mechanism by its literal subject', () => {
    const task: ExtractiveWritingTask = { kind: 'comparison', language: 'en', format: 'table', instruction: 'Compare Paris in Texas and Rome',
      subjects: ['Paris in Texas', 'Rome'], source: { kind: 'search', query: 'Paris in Texas Rome' }, structure: { format: 'table' } };
    const unrelated = claim('mechanism', 'Paris receives supplies by rail.', 'Paris, France', 'https://first.test/', { subject: 'Paris' });
    const scoped = claim('mechanism', 'Paris receives supplies by truck.', 'Paris, Texas', 'https://second.test/', { subject: 'Paris' });
    const other = claim('mechanism', 'Rome receives supplies by ship.', 'Rome', 'https://third.test/', { predicate: 'receives' });
    const reply = composeExplanation(task, [{ claims: [unrelated], support: 5 }, group(scoped), group(other)], []);
    expect(reply.evidence).toEqual([scoped.span, other.span]);
    expect(reply.complete).toBe(true);
  });
});
