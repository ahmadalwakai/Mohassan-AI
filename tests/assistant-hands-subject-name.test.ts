import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { entitySurface, entityWords, relevantLines, topicWords, wikiTerms } from '../apps/server/src/assistant/hands.js';
import { checkAnswerLine, isMetaLine } from '../apps/server/src/assistant/answer-check.js';

const page = (title: string, text: string): AgentPage => ({ id: title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`, title: `${title} - Wikipedia`, text, elements: [],
  signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 }, hash: title, observedAt: '2026-11-22T22:36:00.000Z', documentStatus: 200 });

describe('the subject a question names', () => {
  it('does not take a measure verb for part of the name', () => {
    // «لم أجد صفحة تجيب مباشرة» on 2026-11-22: the subject was «يبلغ جبل إيفرست» (wiring-probe.json, fact-everest).
    expect(topicWords('كم يبلغ ارتفاع جبل إيفرست؟')).toEqual(['ارتفاع', 'جبل', 'ايفرست']);
    expect(entityWords('كم يبلغ ارتفاع جبل إيفرست؟')).toEqual(['جبل', 'ايفرست']);
    expect(entitySurface('كم يبلغ ارتفاع جبل إيفرست؟', ['جبل', 'ايفرست'])).toBe('جبل إيفرست');
    expect(entityWords('كم يبلغ عدد سكان مصر؟')).toEqual(['مصر']);
    expect(wikiTerms('كم يبلغ طول نهر النيل؟')).toBe('طول نهر النيل');
  });

  it('names the work an English question asks the maker of, with its joining words', () => {
    // Answered from the page of the screenwriter adapting the novel on 2026-11-22 (wiring-probe.json, fact-author-en).
    expect(entityWords('Who wrote Pride and Prejudice?')).toEqual(['pride', 'prejudice']);
    expect(entitySurface('Who wrote Pride and Prejudice?', ['pride', 'prejudice'])).toBe('Pride and Prejudice');
    expect(entityWords('Who painted the Mona Lisa?')).toEqual(['mona', 'lisa']);
    expect(entitySurface('Who painted the Mona Lisa?', ['mona', 'lisa'])).toBe('Mona Lisa');
    expect(entityWords('Who wrote Hamlet?')).toEqual(['hamlet']);
  });

  it('leaves an invention, an Arabic who-question and a question with no maker word on the search path', () => {
    expect(entityWords('Who invented the telephone?')).toEqual([]);
    expect(entityWords('من اخترع الهاتف؟')).toEqual([]);
    expect(entityWords('What is photosynthesis?')).toEqual([]);
    expect(entityWords('كم عدد سكان مصر؟')).toEqual(['مصر']);
    expect(entityWords('متى سقط جدار برلين؟')).toEqual(['جدار', 'برلين']);
  });

  it('keeps only the subject words when another kind of word sits between them', () => {
    expect(entitySurface('كم عدد سكان مصر؟', ['مصر'])).toBe('مصر');
    expect(entitySurface('ما عاصمة المملكة العربية السعودية؟', ['مملكه', 'عربيه', 'سعوديه'])).toBe('المملكة العربية السعودية');
  });

  it('takes the Iraqi Arabic question lead out of the public subject', () => {
    const question = 'شنو لون الياقوت؟';
    expect(topicWords(question)).toEqual(['لون', 'ياقوت']);
    expect(wikiTerms(question)).toBe('لون الياقوت');
  });
});

it('keeps a short complete statement that names the subject and the requested property', () => {
  const penguin = page('البطريق', 'لون ريش البطريق\nمعلومات عن البطريق. ريش البطريق لونه أسود.');
  expect(relevantLines(penguin, 'ما لون ريش البطريق؟', 3, true)).toEqual(['ريش البطريق لونه أسود.']);
});

describe('the sentence that names the maker of a work', () => {
  it('starts at the work\'s own opening, past the infobox cells glued before it', () => {
    // The article's text as the reader returned it on 2026-11-22: infobox cells, then the first sentence, on one line.
    const pride = page('Pride and Prejudice', 'Pride and Prejudice Title page of the first edition, 1813 Author Jane Austen Working title First Impressions Language English Genre Classic Regency novel. '
      + 'P7 Text Pride and Prejudice at Wikisource Pride and Prejudice is a novel by English author Jane Austen. '
      + 'Pride and Prejudice has consistently appeared near the top of lists of "most-loved books" among literary scholars and the reading public. '
      + 'For more than a century, dramatic adaptations, reprints and films of Pride and Prejudice have portrayed the memorable characters and themes of the novel.');
    const [lead] = relevantLines(pride, 'Who wrote Pride and Prejudice?', 3, true);
    expect(lead).toBe('Pride and Prejudice is a novel by English author Jane Austen.');
    expect(checkAnswerLine('Who wrote Pride and Prejudice?', lead!).ok).toBe(true);
  });

  it('matches «written by» to the question\'s «wrote» and ranks the opening first', () => {
    // «In 1936 Andrew Cairncross suggested … Shakespeare wrote the Ur-Hamlet» led the answer on 2026-11-22 23:53.
    const hamlet = page('Hamlet', 'Hamlet (/ˈhæmlɪt/) is a tragedy written by William Shakespeare sometime between 1599 and 1601. '
      + 'It is Shakespeare\'s longest play. Set in Denmark, the play depicts Prince Hamlet and his attempts to exact revenge against his uncle. '
      + 'In 1936 Andrew Cairncross suggested that, until more becomes known, it may be assumed that Shakespeare wrote the Ur-Hamlet. '
      + 'Hamlet is by far the longest play that Shakespeare wrote, and one of the longest plays in the Western canon.');
    const [lead] = relevantLines(hamlet, 'Who wrote Hamlet?', 3, true);
    expect(lead).toBe('Hamlet (/ˈhæmlɪt/) is a tragedy written by William Shakespeare sometime between 1599 and 1601.');
  });

  it('counts a work described by its type and creator as authorship evidence', () => {
    const summer = page('Summer', 'Summer is a novel by Edith Wharton.');
    const [lead] = relevantLines(summer, 'Who wrote Summer?', 3, true);
    expect(lead).toBe('Summer is a novel by Edith Wharton.');
    expect(checkAnswerLine('Who wrote Summer?', lead!).ok).toBe(true);
  });

  it('does not change how a question that is not about a maker reads the same page', () => {
    const hamlet = page('Hamlet', 'Hamlet Title page Author William Shakespeare Language English. Hamlet is a tragedy written by William Shakespeare sometime between 1599 and 1601. Hamlet was first performed around 1600.');
    const lines = relevantLines(hamlet, 'When was Hamlet first performed?', 3, true);
    expect(lines.some(line => line.startsWith('Hamlet Title page'))).toBe(false);
    expect(lines[0]).toContain('first performed');
  });
});

it('recognizes publication metadata without dropping a publication fact', () => {
  const line = 'Treasure Island was published in book form in 1883.';
  const book = page('Treasure Island', line);
  const question = 'When did Treasure Island get published?';
  expect(relevantLines(book, question, 3, true)).toEqual([line]);
  expect(checkAnswerLine(question, line).ok).toBe(true);
  expect(isMetaLine('Published on November 14, 1883')).toBe(true);
  expect(isMetaLine('Published: 1883-11-14')).toBe(true);
});
