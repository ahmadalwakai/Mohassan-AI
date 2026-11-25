import { describe, expect, it } from 'vitest';
import { rewriteEnglishEllipsis } from '../apps/server/src/assistant/followup-english-ellipsis.js';

describe('English follow-ups with an omitted or implicit topic', () => {
  it('expands a definite reference from the named section and retains its date', () => {
    expect(rewriteEnglishEllipsis('Why did local businesses oppose the bill?', {
      articleTitle: 'Kendall Reid', sectionTitle: 'South Dock Tramway Act of 1932',
      turns: [{ question: 'Where did the proposal originate?' }],
    })).toBe('Why did local businesses oppose the South Dock Tramway Act of 1932?');
  });

  it('names a work using its type in the preceding turn or the named section', () => {
    expect(rewriteEnglishEllipsis('When did the album come out?', {
      turns: [{ question: 'What was the album called?', answer: 'Quiet Signal.' }],
    })).toBe('When did the album Quiet Signal come out?');
    expect(rewriteEnglishEllipsis('Did the film win any awards?', {
      articleTitle: 'Northbound', sectionTitle: 'Northbound Episode II: In the Fog (2017)',
      turns: [{ question: 'When was the movie released?' }],
    })).toBe('Did the film Northbound Episode II: In the Fog (2017) win any awards?');
  });

  it('supplies an article subject in an elliptical event question about a time period', () => {
    const history = {
      articleTitle: 'Marta Cedar', turns: [{ question: 'Did she reopen the studio?' }],
    };
    expect(rewriteEnglishEllipsis('What else happened in 1997?', history)).toBe('What else happened to Marta Cedar in 1997?');
    expect(rewriteEnglishEllipsis('What was one major event that occurred between 1998 and 2000?', history))
      .toBe('What was one major event that occurred between 1998 and 2000 for Marta Cedar?');
  });

  it('carries the prior question frame through an explicit replacement place or time', () => {
    expect(rewriteEnglishEllipsis('And what about Porth Haven?', {
      turns: [{ question: 'What is the busiest station in Spruce Bay?' }],
    })).toBe('What is the busiest station in Porth Haven?');
    expect(rewriteEnglishEllipsis('And in 2013?', {
      turns: [{ question: 'What was the rainfall in Spruce Bay in 2012?' }],
    })).toBe('What was the rainfall in Spruce Bay in 2013?');
  });

  it('recovers the predicate of a short time, location, or duration question', () => {
    expect(rewriteEnglishEllipsis('And when?', {
      turns: [{ question: 'Did Tessa Green reopen the studio?' }],
    })).toBe('When did Tessa Green reopen the studio?');
    expect(rewriteEnglishEllipsis('Where?', {
      turns: [{ question: 'When was the new observatory built?' }],
    })).toBe('Where was the new observatory built?');
    expect(rewriteEnglishEllipsis('How long?', {
      turns: [{ question: 'Did the ferry operate?' }],
    })).toBe('How long did the ferry operate?');
    expect(rewriteEnglishEllipsis('When?', { turns: [{ question: 'What did Tessa Green do?' }] })).toBeNull();
  });

  it('leaves quoted, modified, self-contained, and ungrounded questions available for the existing rewriter', () => {
    const history = {
      articleTitle: 'Sophie Lark', sectionTitle: 'Northbound Episode II: In the Fog (2017)',
      turns: [{ question: 'When did Neil Rowan apply?' }],
    };
    expect(rewriteEnglishEllipsis('Who said “the film” aloud?', history)).toBeNull();
    expect(rewriteEnglishEllipsis('Where was the film festival held?', history)).toBeNull();
    expect(rewriteEnglishEllipsis('What happened in 2018?', history)).toBeNull();
    expect(rewriteEnglishEllipsis('Did the movie win any awards?', history)).toBeNull();
    expect(rewriteEnglishEllipsis('وماذا عن النهر؟', history)).toBeNull();
  });
});
