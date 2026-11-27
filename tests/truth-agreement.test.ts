import { describe, expect, it } from 'vitest';
import { inspectTruth } from '../apps/server/src/assistant/truth-agreement.js';
import type { JudgeEvidence } from '../apps/server/src/assistant/judge.js';

// Initial runtime cases from PR #27, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/7eb3713c42a1/tests/truth-agreement.test.ts
const page = (quote: string, url = 'https://archive.example/record', title?: string): JudgeEvidence => ({ kind: 'page', text: quote, url, title });

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

  it.each([
    ['Where is Cedar Hall located?', 'Cedar Hall is located in Cedar Harbor.', 'Cedar Harbor', 'Pine Harbor'],
    ['أين تقع قاعة الندى؟', 'تَقَعُ قاعة الندى في مدينة المرجان.', 'مدينة المرجان', 'مدينة النخيل'],
    ['Where did Cedar Hall open?', 'Cedar Hall opened in Cedar Harbor.', 'Cedar Harbor', 'Pine Harbor'],
    ['أين افتتح متحف الندى؟', 'افتتح متحف الندى في مدينة المرجان.', 'مدينة المرجان', 'مدينة النخيل'],
  ])('grounds a location in the relation asked by %s', (question, quote, correct, wrong) => {
    expect(inspectTruth(question, correct, [page(quote)]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, wrong, [page(quote)]).supportedAnswer).toBe(false);
  });

  it('rejects a location tied to a different entity or event', () => {
    const wrongEntity = 'Cedar Hall is mentioned in the registry. Pine Hall is located in Cedar Harbor.';
    const wrongEvent = 'Cedar Hall opened in Pine Harbor. Cedar Hall was located in Cedar Harbor.';
    expect(inspectTruth('Where is Cedar Hall located?', 'Cedar Harbor', [page(wrongEntity)]).supportedAnswer).toBe(false);
    expect(inspectTruth('Where did Cedar Hall open?', 'Cedar Harbor', [page(wrongEvent)]).supportedAnswer).toBe(false);
    expect(inspectTruth('أين تقع قاعة الندى؟', 'مدينة المرجان', [page('تقع قاعة الريحان في مدينة المرجان.')]).supportedAnswer).toBe(false);
  });

  it.each([
    ['مين كتب رواية الندى؟', 'كتب سليم ناصر رواية الندى.'],
    ['إيمتى افتتحت المكتبة؟', 'افتتحت المكتبة في ١٩٩٣.'],
    ['In what year did the press open?', 'The press opened in 1993.'],
    ['What is the location of Cedar Press?', 'Cedar Press is located in Cedar Harbor.'],
  ])('recognizes a direct answer to the question %s', (question, quote) => {
    expect(inspectTruth(question, quote, [page(quote)]).supportedAnswer).toBe(true);
  });
});

describe('truth agreement with evidence', () => {
  it.each([
    ['Who chairs Luma?', 'Q', 'A', 'K. Li', '2024'],
    ['مَن افتتح متحف الندى؟', 'السؤال', 'الجواب', 'سارة ناصر', '٢٠٢٤'],
    ['When did Cedar Hall open?', 'Question', 'Answer', '9 April 2014', 'Cedar Harbor'],
    ['متى افتتح متحف الندى؟', 'س', 'ج', '١٥ أيلول ٢٠٢٤', 'مدينة المرجان'],
    ['How many desks does Cedar Hall have?', 'Question', 'Answer', '17', '9 kilometers'],
    ['كم مقعد في قاعة الندى؟', 'السؤال', 'الجواب', '١٧', '٢٠ طالبًا'],
    ['Where is Cedar Hall?', 'Q', 'A', 'Cedar Harbor', '2024'],
    ['أين تقع قاعة الندى؟', 'السؤال', 'الجواب', 'مدينة المرجان', '٢٠٢٤'],
  ])('reads the exact labeled record and checks the answer type for %s', (question, q, a, answer, wrongType) => {
    const questionLine = q + ': ' + question;
    const answerLine = a + ': ' + answer;
    const evidence = page(questionLine + '\n' + answerLine);
    const display = questionLine + ' ' + answerLine;
    expect(inspectTruth(question, display, [evidence]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, answer, [evidence]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, display, [page(questionLine + '\n' + a + ': ' + wrongType)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, wrongType, [page(questionLine + '\n' + a + ': ' + wrongType)]).supportedAnswer).toBe(false);
    expect(inspectTruth(question, answer, [{ ...evidence, kind: 'memory' }]).supportedAnswer).toBe(false);
  });

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
      text: answer, answering: true, finding: null,
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
    expect(fragments[0]).toMatchObject({ text: first, answering: true, finding: null });
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

  it('does not use a date from a different event or entity to ground a reply', () => {
    const primary = page('Cedar Theatre opened in 2011.');
    const other = page('Cedar Theatre closed in 2014. Pine Theatre opened in 2014.', 'https://city.example/dates');
    const question = 'When did Cedar Theatre open?';
    expect(inspectTruth(question, '2011.', [primary, other]).supportedAnswer).toBe(true);
    expect(inspectTruth(question, '2014.', [primary, other]).supportedAnswer).toBe(false);
  });
});
