import { describe, expect, it } from 'vitest';
import { alignClaims, sameEntity } from '../apps/server/src/assistant/writing/multisource/alignment.js';
import type { Claim } from '../apps/server/src/assistant/writing/multisource/types.js';

function claim(host: string, text: string, fields: Omit<Claim, 'span'>, surrounding?: string): Claim {
  const start = (surrounding ?? host).length + 1;
  const source = { title: surrounding ?? host, url: host ? `https://${host}/page` : undefined, text: `${surrounding ?? host}\n${text}` };
  return { ...fields, span: { source, start, end: start + text.length, text } };
}

describe('multi-source claim alignment', () => {
  it('aligns English causal clauses by direction and counts publishers once', () => {
    const forward = claim('one.test', 'Strong winds lead to rough waves.', { kind: 'causal', cause: 'Strong winds', effect: 'rough waves' });
    const rephrased = claim('two.test', 'Rough waves occur because of strong wind.', { kind: 'causal', cause: 'strong wind', effect: 'Rough waves' });
    const related = claim('help.one.test', 'Strong wind can produce rough waves.', { kind: 'causal', cause: 'Strong wind', effect: 'rough waves' });
    const mirrored = claim('three.test', forward.span.text, { kind: 'causal', cause: 'Strong winds', effect: 'rough waves' }, 'one.test');
    const reversed = claim('four.test', 'Rough waves lead to strong winds.', { kind: 'causal', cause: 'Rough waves', effect: 'strong winds' });
    const different = claim('five.test', 'Strong winds lead to high temperatures.', { kind: 'causal', cause: 'Strong winds', effect: 'high temperatures' });

    const result = alignClaims([forward, rephrased, related, mirrored, reversed, different]);
    expect(result.groups).toEqual([
      { claims: [forward, rephrased, related, mirrored], support: 2 },
      { claims: [reversed], support: 1 },
      { claims: [different], support: 1 },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it('aligns Arabic spelling, articles and sound plurals', () => {
    const left = claim('one.test', 'يحدث التبخر بسبب ارتفاع درجات الحرارة.', { kind: 'causal', cause: 'ارتفاع درجات الحرارة', effect: 'التبخر' });
    const right = claim('two.test', 'ارتفاع درجة الحرارة يؤدي إلى تبخّر.', { kind: 'causal', cause: 'ارتفاع درجة الحرارة', effect: 'تبخّر' });

    expect(alignClaims([left, right]).groups).toEqual([{ claims: [left, right], support: 2 }]);
  });

  it('requires full entities and consistent named attributes', () => {
    const coastA = claim('one.test', 'Lake Michigan contains fresh water.', { kind: 'attribute', subject: 'Lake Michigan', attribute: 'water type', value: 'fresh water' });
    const coastB = claim('two.test', 'Lake Ontario contains fresh water.', { kind: 'attribute', subject: 'Lake Ontario', attribute: 'water type', value: 'fresh water' });
    const source = claim('three.test', 'The source of water in Lake Michigan is fresh water.', { kind: 'attribute', subject: 'Lake Michigan', attribute: 'water origin', value: 'fresh water' });

    expect(sameEntity('The Lake Michigan', 'Lake Michigan')).toBe(true);
    expect(sameEntity('C++', 'C#')).toBe(false);
    expect(alignClaims([coastA, coastB, source]).groups.map(group => group.support)).toEqual([1, 1, 1]);
  });

  it('checks every grouped member so similar claims do not bridge distinct actions', () => {
    const left = claim('one.test', 'The switch opens the electrical circuit at the control panel.', { kind: 'mechanism' });
    const middle = claim('two.test', 'The switch operates the electrical circuit at the control panel.', { kind: 'mechanism' });
    const right = claim('three.test', 'The switch operates the lighting circuit at the control panel.', { kind: 'mechanism' });
    expect(alignClaims([left, middle, right]).groups).toEqual([{ claims: [left, middle], support: 2 }, { claims: [right], support: 1 }]);
    expect(alignClaims([middle, right]).groups).toEqual([{ claims: [middle, right], support: 2 }]);
  });

  it('keeps literal evidence for an explicit denial of the same causal link', () => {
    const affirm = claim('one.test', 'Strong winds lead to rough waves.', { kind: 'causal', cause: 'Strong winds', effect: 'rough waves', negated: false });
    const deny = claim('two.test', 'Strong winds do not lead to rough waves.', { kind: 'causal', cause: 'Strong winds', effect: 'rough waves', negated: true });
    const anotherCause = claim('three.test', 'Seismic tremors lead to rough waves.', { kind: 'causal', cause: 'Seismic tremors', effect: 'rough waves', negated: false });
    const qualified = claim('four.test', 'Strong winds may not lead to rough waves.', { kind: 'causal', cause: 'Strong winds may not', effect: 'rough waves', negated: true, conditioned: true });
    const internalNegation = claim('five.test', 'Strong winds lead to no rough waves.', { kind: 'causal', cause: 'Strong winds', effect: 'no rough waves', negated: false });

    const result = alignClaims([affirm, deny, anotherCause, qualified, internalNegation]);
    expect(result.conflicts).toEqual([{ left: affirm, right: deny }, { left: affirm, right: internalNegation }]);
    expect(result.groups.map(group => group.support)).toEqual([1, 1, 1, 1, 1]);
    for (const item of [result.conflicts[0]!.left, result.conflicts[0]!.right]) {
      expect(item.span.source.text.slice(item.span.start, item.span.end)).toBe(item.span.text);
    }
  });

  it('flags an opposite clause under identical scope with unchanged qualification', () => {
    const cause = 'More water vapor in the atmosphere can also';
    const warm = 'warming temperatures because water vapor traps energy';
    const notWarm = 'warming temperatures because water vapor does not trap energy';
    const source = (host: string, effect: string): Claim => claim(host, `${cause} lead to ${effect}.`, {
      kind: 'causal', cause, effect, negated: false, conditioned: true,
    });
    const positive = source('one.test', warm);
    const negative = source('two.test', notWarm);
    const uncertain = source('three.test', 'warming temperatures because water vapor might not trap energy');
    const scopedDifferently = source('four.test', 'warming temperatures because water vapor does not trap energy during the winter');

    expect(alignClaims([positive, negative, uncertain, scopedDifferently]).conflicts).toEqual([{ left: positive, right: negative }]);
  });

  it('reconciles equivalent units and flags a different exact value for the same property', () => {
    const numeric = (host: string, value: string): Claim => claim(host, `The canal width is ${value}.`, { kind: 'attribute', subject: 'the canal', attribute: 'width', value });
    const first = numeric('one.test', '2 metres');
    const converted = numeric('two.test', '200 cm');
    const conflicting = numeric('three.test', '٢٫٥ متر');
    const estimate = numeric('four.test', 'about 3 metres');
    const range = numeric('five.test', '2–3 metres');
    const differentSetting = numeric('six.test', '3 metres at high tide');

    const result = alignClaims([first, converted, conflicting, estimate, range, differentSetting]);
    expect(result.groups[0]).toEqual({ claims: [first, converted], support: 2 });
    expect(result.conflicts).toEqual([{ left: first, right: conflicting }]);
  });

  it('does not overcount URL-less materials or conflict within one publisher', () => {
    const first = claim('', 'The arc spans 2 m.', { kind: 'attribute', subject: 'the arc', attribute: 'width', value: '2 m' }, 'first paste');
    const second = claim('', 'The arc spans 2 m.', { kind: 'attribute', subject: 'the arc', attribute: 'width', value: '2 m' }, 'second paste');
    const sameSite = claim('www.one.test', 'The arc spans 3 m.', { kind: 'attribute', subject: 'the arc', attribute: 'width', value: '3 m' });
    const subdomain = claim('help.one.test', 'The arc spans 4 m.', { kind: 'attribute', subject: 'the arc', attribute: 'width', value: '4 m' });

    expect(alignClaims([first, second, sameSite, subdomain])).toEqual({
      groups: [{ claims: [first, second], support: 1 }, { claims: [sameSite], support: 1 }, { claims: [subdomain], support: 1 }],
      conflicts: [],
    });
  });
});
