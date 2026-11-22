import { describe, expect, it } from 'vitest';
import { applyReplyFixes, checkReply, ownWords, questionLanguage, replyLanguage } from '../apps/server/src/assistant/reply-check.js';

// Real replies of the 2026-11-22 run (artifacts/plan-2026-11-22/real-answers-2026-11-22T02-17-34.jsonl), shortened.
const RQ010 = {
  question: 'What is the speed of light?',
  reply: [
    'By Vicky Stein last updated October 29, 2024 Beyond the limits of light: exploring the speed of light and the boundaries of faster-than-light travel When you purchase through links on our site, we may earn an affiliate commission.',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- The speed of light puts a speed limit on matter, lets us peer back into the history of our universe, and has deep implications for physics and space travel.',
    '- Share Share this article Join the conversation Follow us Add us as a preferred source on Google Newsletter Subscribe to our newsletter The speed of light traveling through a vacuum is exactly 299,792,458 meters (983,571,056 feet) per second.',
    '',
    '**المصدر:** [space.com — How fast does light travel?](https://www.space.com/15830-light-speed.html)',
  ].join('\n'),
};
const RQ064_LINE = '- … 26 REVIEWS TOTAL TIME: 6 HOURS 40 MIN SERVINGS: 8 TEST KITCHEN APPROVED From the Recipe Creator: This is my favorite.';
const RQ090_LINE = '- … logos and names Updated: Nov 18, 2026 BMW Logo cars that start with b | german cars FONT ALL SVG ALL PNG BMW Logo PNG BMW (Bayerische Motoren Werke) is one of the world’s best-known premium car makers.';
const codes = (input: Parameters<typeof checkReply>[0]) => checkReply(input).findings.map(finding => finding.code);

describe('questionLanguage and the reply’s own words', () => {
  it('reads the question as Arabic when any Arabic script appears, as the assistant does', () => {
    expect(questionLanguage('ما عاصمة اليابان؟')).toBe('ar');
    expect(questionLanguage('ابحث عن Python pathlib documentation')).toBe('ar');
    expect(questionLanguage('What is photosynthesis?')).toBe('en');
  });

  it('sets quotes, links, titles, hosts and the fixed headings aside before judging the language', () => {
    const own = ownWords('من **Search — Python 3.15.2 documentation** (docs.python.org):\n\n> Searching for multiple words only shows matches that contain all words.\n\n**المصدر:** [x](https://docs.python.org/)');
    expect(own).not.toMatch(/Searching for multiple/u);
    expect(own).not.toMatch(/Python 3\.15/u);
    expect(own).not.toMatch(/docs\.python\.org/u);
    expect(own).toMatch(/من/u);
    expect(replyLanguage('15 * 23 = 345')).toMatchObject({ replyLang: 'none', arabicShare: null });
  });
});

describe('language_mismatch (review)', () => {
  it('flags an English template reply to an Arabic question (rq022) and an Arabic letter to an English request (rq097)', () => {
    expect(codes({ question: 'ابحث عن Python pathlib documentation', reply: 'I could not reach results relevant to “Python pathlib documentation” after trying more than one search engine. Send a suitable website link or name the organization to search.' })).toContain('language_mismatch');
    expect(codes({ question: 'create a campaign for tyrerescue.uk selling mobile tyre fitting in Edinburgh, budget £30 per day', reply: '**الموضوع:** رسالة\n\n[اسم المستلم]،\nالسلام عليكم ورحمة الله وبركاته، وبعد:\n\nأكتب إليكم بخصوص ما يلي:\n[اكتب التفاصيل هنا]\n\nمع التحية،\n[الاسم]' })).toContain('language_mismatch');
  });

  it('leaves numbers, one-word values, quoted English pages under an Arabic lead, and English site names alone', () => {
    expect(codes({ question: 'كم يساوي 15 ضرب 23؟', reply: '15 * 23 = 345' })).toEqual([]);
    expect(codes({ question: 'من ذاكرتي، أعد لغتي المفضلة فقط.', reply: 'Arabic' })).toEqual([]);
    expect(codes({ question: 'افتح https://docs.python.org/3/tutorial/index.html ثم اضغط على Search', reply: 'من **Search — Python 3.15.2 documentation** (docs.python.org):\n\n> Searching for multiple words only shows matches that contain all words.\n>\n> (Python exception, module, class names are also searched.)\n\nقل «اقرأ الصفحة» لأقرأ أكثر، أو «اضغط على …».' })).toEqual([]);
    expect(codes({ question: 'افتح gov.uk وابحث عن passport renewal', reply: 'بحثت عن «passport renewal» في gov.uk. أول النتائج:\n\n1. [Renew or replace your adult passport](https://www.gov.uk/renew-adult-passport) — gov.uk\n2. [Replace a lost passport](https://www.gov.uk/report-a-lost-or-stolen-passport) — gov.uk\n\nقل «افتح النتيجة 2» مثلًا لأفتحها.' })).toEqual([]);
    expect(codes({ question: 'What is photosynthesis?', reply: 'Photosynthesis is the process by which green plants use light to make food.\n\n**Source:** [BBC Bitesize — Photosynthesis](https://www.bbc.co.uk/bitesize/articles/zdxkcmn)' })).toEqual([]);
  });

  it('asks for review when an Arabic question is answered only with English page lines (rq020)', () => {
    expect(codes({ question: 'ما هو آخر إصدار مستقر من Node.js؟', reply: 'js version: node -v # Should print "v26.13.1".\n\n**تفاصيل أخرى من نفس المصدر:**\n- # Verify npm version: npm -v # Should print "11.20.0".\n\n**المصدر:** [nodejs.org — Download Node.js](https://nodejs.org/en/download)' }))
      .toEqual(['language_mismatch']);
  });
});

describe('the known cases of 0-baseline §8.3', () => {
  it('rq010: byline lead, affiliate note, share buttons and the Arabic headings in an English answer', () => {
    const check = checkReply(RQ010);
    const found = check.findings.map(finding => finding.code);
    expect(found).toContain('byline_lead');
    expect(found).toContain('site_chrome');
    expect(found).toContain('foreign_heading');
    expect(found).not.toContain('language_mismatch');
    expect(check.findings.filter(finding => finding.code === 'foreign_heading').map(finding => finding.line)).toEqual([3, 7]);
    expect(check.findings.find(finding => finding.code === 'byline_lead')).toMatchObject({ line: 1, severity: 'fix' });
  });

  it('rq064 and rq090: recipe-site chrome and navigation residue inside the bullets', () => {
    expect(codes({ question: 'What should I cook for dinner tonight?', reply: `32 Delicious Dinners That Cook in 10 Minutes\n\n**تفاصيل أخرى من نفس المصدر:**\n${RQ064_LINE}` })).toEqual(expect.arrayContaining(['foreign_heading', 'site_chrome']));
    expect(codes({ question: 'bmw logo', reply: `The BMW logo combines the black ring of the original Rapp Motorenwerke badge with a quartered blue-and-white disc.\n\n**تفاصيل أخرى من نفس المصدر:**\n${RQ090_LINE}` })).toEqual(expect.arrayContaining(['foreign_heading', 'site_chrome']));
  });

  it('a «who» question whose first line names nobody is sent for review', () => {
    expect(codes({ question: 'who wrote the novel One Hundred Years of Solitude', reply: 'The novel is often cited as one of the great achievements in world literature.\n\n**Source:** [Wikipedia](https://en.wikipedia.org/wiki/One_Hundred_Years_of_Solitude)' })).toContain('lead_without_answer');
    expect(codes({ question: 'who wrote the novel One Hundred Years of Solitude', reply: 'Gabriel García Márquez wrote One Hundred Years of Solitude, first published in 1967.' })).toEqual([]);
  });

  it('a repeated sentence is a duplicate_line; short repeats are not', () => {
    expect(codes({ question: 'ما فوائد الشاي الأخضر؟', reply: 'يحتوي الشاي الأخضر على مضادات الأكسدة التي تحمي الخلايا.\n\n**تفاصيل أخرى من نفس المصدر:**\n- يحتوي الشاي الأخضر على مضادات الأكسدة التي تحمي الخلايا.\n- نعم.\n- نعم.' })).toEqual(['duplicate_line']);
  });
});

describe('applyReplyFixes: mechanical repairs only', () => {
  it('drops the byline and site sentences, localizes the headings, and keeps the page’s own sentences', () => {
    const fixed = applyReplyFixes(RQ010);
    expect(fixed).not.toMatch(/By Vicky Stein|last updated|affiliate commission|Share this article|Subscribe to our newsletter/u);
    expect(fixed).toMatch(/\*\*More from the same source:\*\*/u);
    expect(fixed).toMatch(/\*\*Source:\*\*/u);
    expect(fixed).not.toMatch(/تفاصيل أخرى|المصدر/u);
    expect(fixed).toMatch(/exactly 299,792,458 meters/u);
    expect(fixed).toMatch(/speed limit on matter/u);
    expect(fixed.startsWith('Beyond the limits of light')).toBe(true);
    expect(checkReply({ ...RQ010, reply: fixed }).findings.filter(finding => finding.severity === 'fix')).toEqual([]);
  });

  it('returns the reply unchanged when nothing is fixable, and keeps Arabic headings for Arabic questions', () => {
    const arabic = { question: 'ما عاصمة اليابان؟', reply: 'طوكيو هي عاصمة اليابان.\n\n**المصدر:** [ويكيبيديا — طوكيو](https://ar.wikipedia.org/wiki/طوكيو)' };
    expect(applyReplyFixes(arabic)).toBe(arabic.reply);
    const reviewOnly = { question: 'ابحث عن Python pathlib documentation', reply: 'I could not reach results relevant to “Python pathlib documentation” after trying more than one search engine.' };
    expect(applyReplyFixes(reviewOnly)).toBe(reviewOnly.reply);
  });

  it('removes a repeated line and leaves the first occurrence', () => {
    const fixed = applyReplyFixes({ question: 'ما فوائد الشاي الأخضر؟', reply: 'يحتوي الشاي الأخضر على مضادات الأكسدة التي تحمي الخلايا.\n\n- يحتوي الشاي الأخضر على مضادات الأكسدة التي تحمي الخلايا.\n- يساعد على التركيز.' });
    expect(fixed.match(/مضادات الأكسدة/gu)).toHaveLength(1);
    expect(fixed).toMatch(/يساعد على التركيز/u);
  });
});
