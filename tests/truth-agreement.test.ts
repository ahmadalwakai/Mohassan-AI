import { describe, expect, it } from 'vitest';
import { inspectTruth, type TruthPage } from '../apps/server/src/assistant/truth-agreement.js';

// Agent-written development cases for runtime behavior. These are never training data.
const page = (quote: string, url = 'https://archive.example/record', title?: string): TruthPage => ({ quote, url, title });

describe('truth agreement with the question', () => {
  it('rejects the date of another event in the same sentence, even on the correct page', () => {
    const wrong = 'The fall of the Berlin Wall paved the way for reunification on 3 October 1990.';
    const right = 'The Berlin Wall fell on 9 November 1989.';
    const question = 'When did the Berlin Wall fall?';
    expect(inspectTruth(question, wrong, [page(wrong + ' ' + right)]).fragments[0]).toMatchObject({
      answering: false, finding: 'wrong_relation',
    });
    expect(inspectTruth(question, right, [page(wrong + ' ' + right)]).supportedAnswer).toBe(true);
  });

  it('keeps a finite clause and a different event date from confirming an opening', () => {
    const quote = 'Harbor Hall opened in 1993, it moved in 1998.';
    expect(inspectTruth('When was Harbor Hall opened?', '1998.', [page(quote)]).supportedAnswer).toBe(false);
    expect(inspectTruth('When was Harbor Hall opened?', '1993.', [page(quote)]).supportedAnswer).toBe(true);
  });

  it('binds an unfamiliar asked event to its own date rather than the named subject alone', () => {
    const question = 'When did the Red Group relocate?';
    const wrong = 'The Red Group advanced in 1901.';
    const right = 'The Red Group relocated in 1904.';
    expect(inspectTruth(question, wrong, [page(wrong + ' ' + right)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, right, [page(wrong + ' ' + right)]).supportedAnswer).toBe(true);
  });

  it('distinguishes opening from a second event in Arabic', () => {
    const question = 'متى افتُتح متحف الروابي؟';
    const wrong = 'تأسس متحف الروابي عام ٢٠١٢.';
    const right = 'افتتح متحف الروابي في ١٢ مارس ٢٠١٤.';
    expect(inspectTruth(question, wrong, [page(wrong + ' ' + right)]).fragments[0]).toMatchObject({
      answering: false, finding: 'wrong_relation',
    });
    expect(inspectTruth(question, '١٢ مارس ٢٠١٤.', [page(right)]).supportedAnswer).toBe(true);
  });

  it('requires a count with a unit', () => {
    const question = 'How many seats does Cedar Theatre have?';
    const answer = 'Cedar Theatre seats 650 people.';
    expect(inspectTruth(question, '650.', [page(answer)]).fragments[0]?.finding).toBe('answer_type');
    expect(inspectTruth(question, answer, [page(answer)]).supportedAnswer).toBe(true);
  });

  it('treats an Arabic counted noun and its singular canonical unit as the same request', () => {
    const reply = 'زار معرض الليمون ٣٠ زائرًا.';
    expect(inspectTruth('كم عدد زوار معرض الليمون؟', reply, [page(reply)]).supportedAnswer).toBe(true);
  });

  it('rejects a title match for a metropolitan population or for a family member', () => {
    const subarea = 'The population of Coastal City in Veridia is 4 million people.';
    expect(inspectTruth('How many people live in Veridia?', subarea, [page(subarea, undefined, 'Veridia')]).supportedAnswer).toBe(false);
    const relative = 'Lionel Messi’s son is 14 years old.';
    expect(inspectTruth('How old is Lionel Messi?', relative, [page(relative)]).supportedAnswer).toBe(false);
    const arabic = 'يبلغ عمر ابن سمير عادل ١٤ سنة.';
    expect(inspectTruth('كم عمر سمير عادل؟', arabic, [page(arabic)]).supportedAnswer).toBe(false);
  });

  it('accepts a person in the author slot and rejects a title used as a comparison', () => {
    const direct = 'Jane Austen wrote Pride and Prejudice.';
    const indirect = 'Dolly Alderton wrote Good Material, inspired by Pride and Prejudice.';
    const question = 'Who wrote Pride and Prejudice?';
    expect(inspectTruth(question, 'Jane Austen.', [page(direct)]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, indirect, [page(indirect)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, 'Pride and Prejudice.', [page(direct)]).supportedAnswer).toBe(false);
  });

  it('accepts an organization and a person in bilingual roles', () => {
    const winner = 'Cedar Foundation won the Aster Prize.';
    expect(inspectTruth('Who won the Aster Prize?', 'Cedar Foundation', [page(winner)]).supportedAnswer).toBe(true);
    const founder = 'أسست رنا ناصر جمعية المرجان.';
    expect(inspectTruth('من أسس جمعية المرجان؟', founder, [page(founder)]).supportedAnswer).toBe(true);
  });
});

describe('truth agreement with evidence', () => {
  it('detects unsupported clauses, swapped names and omitted qualifications even when the words occur elsewhere', () => {
    const quote = 'The Cedar Hall opened in 2011. The Pine Hall opened in 2014.';
    const question = 'When did the Cedar Hall open?';
    const reply = 'The Cedar Hall opened in 2011. The Pine Hall opened in 2011.';
    const result = inspectTruth(question, reply, [page(quote)]);
    expect(result.fragments.map(item => item.finding)).toEqual([null, 'wrong_entity']);
    expect(inspectTruth(question, 'The Cedar Hall opened in 2011 and the Pine Hall opened in 2011.', [page(quote)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, 'The Cedar Hall opened in 2014.', [page(quote)]).fragments[0]?.finding).toBe('unsupported_claim');
    expect(inspectTruth(question, 'The Cedar Hall opened in 2011.', [page('The Cedar Hall did not open in 2011.')]).supportedAnswer).toBe(false);
    expect(inspectTruth('How many seats does Cedar Hall have?', '400 seats', [page('Cedar Hall has up to 400 seats.')]).supportedAnswer).toBe(false);
  });

  it('normalizes digit scripts while keeping the original displayed text', () => {
    const answer = 'تتسع قاعة الندى لـ ٣٢٠ مقعد.';
    const source = 'تتسع قاعة الندى لـ 320 مقعد.';
    expect(inspectTruth('كم مقعد في قاعة الندى؟', answer, [page(source)]).fragments[0]).toMatchObject({
      text: answer, answering: true, finding: null, quantities: [{ kind: 'number', value: '320' }],
    });
  });

  it('grounds labelled conversions and rejects unlabelled or dimension-changing conversions', () => {
    const quote = 'Aster Bridge is 2 kilometres long.';
    const question = 'How long is Aster Bridge?';
    expect(inspectTruth(question, 'Conversion: Aster Bridge is 2000 metres long.', [page(quote)]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, 'Aster Bridge is 2000 metres long.', [page(quote)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, 'Conversion: Aster Bridge is 2000 grams long.', [page(quote)]).supportedAnswer).toBe(false);
  });

  it('ignores source timestamps and validates a separate details line', () => {
    const first = 'Cedar Theatre opened in 2011.';
    const reply = 'Cedar Theatre opened in 2011.\n\n**More from the same source:**\n- Its founder was Mae Lin.\n\n**Source:** [Archive — Cedar Theatre](https://archive.example/record) · read 2026-11-25 11:45 UTC';
    const { fragments } = inspectTruth('When did Cedar Theatre open?', reply, [page(first)]);
    expect(fragments).toHaveLength(2);
    expect(fragments[0]?.quantities).toHaveLength(1);
    expect(fragments[1]?.finding).toBe('answer_type');
  });

  it('checks claims embedded in blockquotes and after metadata prefixes', () => {
    const quote = 'Mira Payne founded the Rowan Fair.';
    const question = 'Who founded the Rowan Fair?';
    const evidence = [page(quote)];
    const note = 'Note: this is general information quoted from the source, not a diagnosis. For diagnosis and treatment, see a doctor.';
    expect(inspectTruth(question, `${quote}\n\n${note}`, evidence).fragments).toHaveLength(1);
    for (const prefix of ['>', note, '**Source:** [Archive](https://archive.example/record) ·', '**More from the same source:**']) {
      const result = inspectTruth(question, `${quote}\n\n${prefix} The venue closed permanently in 2020.`, evidence);
      expect(result.fragments.some(item => item.finding && item.text.includes('closed permanently'))).toBe(true);
    }
  });

  it('grounds a counted part of a listed answer without discarding qualifiers', () => {
    const quote = 'Orchard Transit operates 12 public ferries and 5 maintenance boats.';
    const question = 'How many public ferries does Orchard Transit operate?';
    const answer = 'Orchard Transit operates 12 public ferries.';
    expect(inspectTruth(question, answer, [page(quote)]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, 'Orchard Transit operates 5 maintenance boats.', [page(quote)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, answer, [page(quote.replace('12 public', 'up to 12 public'))]).supportedAnswer).toBe(false);
  });

  it('matches independent phrasing by entity and relation and leaves unrelated dates neutral', () => {
    const reply = 'Cedar Theatre opened in 2011.';
    const primary = page(reply);
    const confirms = page('The opening of Cedar Theatre was in 2011.', 'https://daily.example/confirmation');
    const conflicts = page('Cedar Theatre opened in 2013.', 'https://records.example/disagreement');
    const unrelated = page('Cedar Theatre closed in 2014. Pine Theatre opened in 2014.', 'https://city.example/dates');
    const question = 'When did Cedar Theatre open?';
    expect(inspectTruth(question, reply, [primary, confirms, conflicts, unrelated]).fragments[0]?.quantities[0]).toMatchObject({
      supportingUrls: [primary.url, confirms.url], conflictingUrls: [conflicts.url],
    });
  });

  it('does not compare incompatible periods or geographic scopes', () => {
    const reply = 'Veridia had a population of 4 million people in 2020.';
    const primary = page(reply);
    const later = page('Veridia had a population of 5 million people in 2024.', 'https://daily.example/later');
    const regional = page('The population of Coastal City in Veridia is 4 million people.', 'https://daily.example/region');
    const question = 'How many people live in Veridia?';
    expect(inspectTruth(question, reply, [primary, later, regional]).fragments[0]?.quantities[0]).toMatchObject({
      supportingUrls: [primary.url], conflictingUrls: [],
    });
    const inJanuary = 'Veridia had a population of 4 million people as of January 2020.';
    const nextJanuary = page('Veridia had a population of 5 million people as of January 2021.', later.url);
    expect(inspectTruth(question, inJanuary, [page(inJanuary), nextJanuary]).fragments[0]?.quantities[0]).toMatchObject({
      supportingUrls: [primary.url], conflictingUrls: [],
    });
  });
});
