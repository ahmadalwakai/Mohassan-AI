import { describe, expect, it } from 'vitest';
import { compileQuery } from '../ranking.js';
import { parseTravelQuery, travelSubject } from './travel-query.js';

describe('travel query extraction', () => {
  it.each([
    ['أين يقع «برج إيفل»؟', 'place', 'برج إيفل'],
    ['ما عنوان مكتبة الإسكندرية؟', 'place', 'مكتبة الإسكندرية'],
    ['Where is St. John’s, Newfoundland?', 'place', 'St. John’s, Newfoundland'],
    ['Where is the Acropolis located?', 'place', 'the Acropolis'],
    ['What is the address of the British Museum?', 'place', 'the British Museum'],
    ['ما أفضل الأماكن السياحية في القاهرة؟', 'see_do', 'القاهرة'],
    ['Things to do in Paris', 'see_do', 'Paris'],
    ['Best things to do in دبي', 'see_do', 'دبي'],
    ['What are the best places to visit in Paris?', 'see_do', 'Paris'],
    ['كيف أصل إلى وسط القاهرة من المطار؟', 'get_in', 'وسط القاهرة'],
    ['كيف أصل من المطار إلى مراكش؟', 'get_in', 'مراكش'],
    ['How do I get to Kyoto from the airport?', 'get_in', 'Kyoto'],
    ['How do I get from Heathrow Airport to London?', 'get_in', 'London'],
    ['كيف أتنقل داخل مدريد؟', 'get_around', 'مدريد'],
    ['How do I get around Zürich?', 'get_around', 'Zürich'],
    ['دليل السفر إلى عمّان', 'guide', 'عمّان'],
    ['New York travel guide', 'guide', 'New York'],
  ])('extracts the destination from %s', (question, purpose, subject) => {
    expect(parseTravelQuery(compileQuery(question))).toEqual({ subject, purpose });
  });

  it.each(['Where is my order?', 'أين طلبي؟', 'Where is the JavaScript API?', 'Paris', 'How is the weather in Cairo?'])('ignores %s', question => {
    expect(parseTravelQuery(compileQuery(question))).toBeNull();
  });

  it('rejects URLs and batched input as subjects', () => {
    expect(travelSubject('https://example.org/')).toBeNull();
    expect(travelSubject('Paris; London')).toBeNull();
  });
});
