import { describe, expect, it } from 'vitest';
import { comparable, cueWords, definitionForm, isFragment, judge, mentions, ownLines, pageKey, pageSubjectMismatch, questionSubject, relevance, resolvedQuestion, sourceTitleWords, sourceUrls, stem, supportedBy } from '../apps/server/src/assistant/judge.js';
import { topicWords } from '../apps/server/src/assistant/hands.js';

// Real replies of the 2026-11-22 run (artifacts/plan-2026-11-22/real-answers-2026-11-22T02-17-34.jsonl), shortened where noted.
const SOURCE = (title: string, url: string) => `**المصدر:** [ويكيبيديا — ${title}](${url})`;
const RQ016 = {
  question: 'كم عدد سكان المغرب؟',
  reply: [
    'فيما انخفضت الأقلية اليهودية المغربية بشكل كبير ويصل عددها إلى نحو 6,000 (أنظر تاريخ اليهود في المغرب).',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب ما يقارب 37 مليون نسبة بزيادة 8 في المائة مقارنة بنتائج إحصاء عام 2014.',
    '- حسب إحصاء سنة 2024، يبلغ عدد سكان المغرب 330 828 33.',
    '',
    SOURCE('التركيبة السكانية في المغرب', 'https://ar.wikipedia.org/wiki/x'),
  ].join('\n'),
};
const RQ018 = {
  question: 'كم تستغرق عملية المياه البيضاء؟',
  reply: [
    'معركة المياة البيضاء جزء من الحروب العثمانية في أوروبا والحروب العثمانية الألبانية التاريخ 2 سبتمبر 1457م /12 شوال 861 هـ الموقع شمال وسط ألبانيا …',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- كانت معركة المياه البيضاء مهمة للمقاومة بالتمرد الالباني ضد الدولة العثمانية.',
    '',
    SOURCE('معركة المياه البيضاء', 'https://ar.wikipedia.org/wiki/y'),
  ].join('\n'),
};
const RQ037 = {
  question: 'ما هي قدراتك',
  reply: [
    'ويكي بيانات أيقظ قدراتك واصنع مستقبلك هو كتاب من تأليف الدكتور إبراهيم الفقي.',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- "تلخيص كتاب أيقظ قدراتك ..',
    '',
    SOURCE('أيقظ قدراتك واصنع مستقبلك (كتاب)', 'https://ar.wikipedia.org/wiki/z'),
  ].join('\n'),
};
const RQ019 = {
  question: 'ما هي عملية الليزك؟',
  reply: [
    '5:11 فيديو لعملية الليزك من الأعراض الجانبية الشائعة بعد عملية الليزك نزيف مؤقت تحت الملتحمة تعنى كلمة الليزك تعديل شكل القرنية باستعمال الليزر …',
    '',
    SOURCE('ليزك', 'https://ar.wikipedia.org/wiki/l'),
    '',
    'ملاحظة: هذه معلومات عامة منقولة من المصدر، وليست تشخيصًا. للتشخيص والعلاج راجع طبيبًا مختصًا.',
  ].join('\n'),
};
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
const RQ005 = {
  question: 'ما عاصمة اليابان؟',
  reply: [
    'طوكيو عاصمة اليابان وأكثر مدن العالم اكتظاظًا بالسكان.',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- بعد انهيار سلالة تشينغ، سمحت لامركزية السلطة وتحسين تقنيات النقل والاتصالات لكل من القوميين الصينيين والشيوعيين الصينيين بنقل العواصم بسرعة.',
    '',
    SOURCE('عاصمة', 'https://ar.wikipedia.org/wiki/c'),
    '',
    '**للمزيد:** [اليابان](https://ar.wikipedia.org/wiki/j) · [سفارة اليابان في البحرين](https://ar.wikipedia.org/wiki/e)',
  ].join('\n'),
};
const RQ026 = {
  question: 'ما عاصمة أستراليا؟',
  reply: [
    'تقع في نصف الكرة الجنوبي جنوب شرق آسيا وغرب المحيط الهادي، عاصمتها كانبرا.',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- … أستراليا إلى ست ولايات ومقاطعتين أساسيتين: نيو ساوث ويلز وعاصمتها سيدني كوينزلاند وعاصمتها بريزبان جنوب أستراليا وعاصمتها أديليد …',
    '- تمتلك كل ولاية وكل مقاطعة كبرى له برلمانها الخاص ومجلس تشريعي واحد—في الإقليم الشمالي وإقليم عاصمة أستراليا وكوينزلاند— ومجلسين تشريعين في باقي الولايات.',
    '',
    SOURCE('أستراليا', 'https://ar.wikipedia.org/wiki/a'),
  ].join('\n'),
};
const RQ025 = {
  question: 'من هو ألبرت أينشتاين؟',
  reply: [
    'ألْبِرْت أينْشتاين (الألمانية: Albert Einstein) (14 مارس 1879 – 18 أبريل 1955) عالم فيزياء ألماني المولد (تخلى عن الجنسية الألمانية لاحقًا) سويسري وأمريكي الجنسية، يُشتهر بأبي النسبية كواضعٍ لنظريتي النسبية الخاصة والنسبية العامة الشهيرتين اللتين كانتا اللبنة …',
    '',
    '**تفاصيل أخرى من نفس المصدر:**',
    '- ألبرت أينشتاين عام 1893 (14 عامًا).',
    '',
    SOURCE('ألبرت أينشتاين', 'https://ar.wikipedia.org/wiki/e'),
  ].join('\n'),
};
const RQ013 = {
  question: 'ما عاصمة فرنسا؟',
  reply: ['… رئاسية، ويبلغ عدد سُكانها حوالِيّ 68.6 مليون نسمة في يناير 2025، و‌عاصمتها وأكبر مدنها هي بَارِيس، ولُغتها الرسميّة هي الفرنسِيّة.', '', SOURCE('فرنسا', 'https://ar.wikipedia.org/wiki/fr')].join('\n'),
};
const RQ020 = {
  question: 'ما هو آخر إصدار مستقر من Node.js؟',
  reply: ['js version: node -v # Should print "v26.13.1".', '', '**تفاصيل أخرى من نفس المصدر:**', '- # Verify npm version: npm -v # Should print "11.20.0".', '', '**المصدر:** [nodejs.org — Node.js — Download Node.js®](https://nodejs.org/en/download)'].join('\n'),
};
const RQ027 = {
  question: 'ما هو الذكاء الاصطناعي؟',
  reply: ['الذكاء الاصطناعي (AI) هو تقنية تحويلية تمكن الآلات من أداء مهام حل المشكلات بطريقة تشبه البشر.', '', SOURCE('ذكاء اصطناعي', 'https://ar.wikipedia.org/wiki/ai')].join('\n'),
};
const RQ008 = {
  question: 'ما هو أطول نهر في العالم؟',
  reply: ['نهر النيل: أطول أنهار العالم.', '', '**تفاصيل أخرى من نفس المصدر:**', '- نهر المسيسيبي: أطول نهر في أمريكا الشمالية.', '', SOURCE('نهر', 'https://ar.wikipedia.org/wiki/r')].join('\n'),
};
const RQ006 = {
  question: 'من اخترع الهاتف؟',
  reply: ['وهذا يعني أن ألكسندر غراهام بيل فقط صنع الهاتف بناءً على فكرة اختراع وجدها في نموذج من نماذج اختراعات ميوتشي.', '', SOURCE('هاتف', 'https://ar.wikipedia.org/wiki/t')].join('\n'),
};
const RQ028 = {
  question: 'What is photosynthesis?',
  reply: ['But green plants and algae can use light energy to make their own food! This process called photosynthesis.', '', '**تفاصيل أخرى من نفس المصدر:**', '- Photosynthesis is the process by which plants make food from light.', '', '**المصدر:** [ويكيبيديا — Photosynthesis](https://en.wikipedia.org/wiki/p)'].join('\n'),
};
const codesOf = (verdict: ReturnType<typeof judge>) => verdict.codes.filter(code => code !== 'evidence_unavailable');

describe('reply kinds', () => {
  it('names a question card, an abstention, a computed value, a memory read, a list, a quote and a letter frame', () => {
    expect(judge({ question: 'اكتب رسالة بريد احترافية', reply: 'أكتب لك الرسالة من قالب رسمي، والتفاصيل تبقى بكلماتك. أجب عن هذه الأسئلة:', status: 'waiting_user' }).kind).toBe('question');
    expect(judge({ question: 'كم سعر الذهب اليوم؟', reply: 'لم أتمكن من الوصول إلى مصدر حديث ومرتبط بسؤالك «كم سعر الذهب اليوم» بعد تجربة البحث في الويب. إن أرسلت رابط موقع مناسب أفتحه وأقرأ المعلومة منه.' }).kind).toBe('abstain');
    // hands.ts in English since 2026-11-22, when no page passes its checks (live 08:12, the Japan travel question).
    expect(judge({ question: 'What is the best time to visit Japan?', reply: 'I found no page that answers “What is the best time to visit Japan” directly, and I will not pass you an answer from a page that is not about your question. These pages came up in the search:\n\n1. [The Third Murder](https://en.wikipedia.org/wiki/The_Third_Murder) — ويكيبيديا', status: 'partial' }).kind).toBe('abstain');
    expect(judge({ question: 'كم يساوي 15 ضرب 23؟', reply: '15 * 23 = 345' })).toMatchObject({ kind: 'computed', decision: 'send' });
    expect(judge({ question: 'من ذاكرتي، ما مدينتي المفضلة؟', reply: 'من الذاكرة: «مدينتي المفضلة هي مسقط»' })).toMatchObject({ kind: 'memory', decision: 'send' });
    expect(judge({ question: 'من ذاكرتي، أعد لغتي المفضلة فقط.', reply: 'Arabic' })).toMatchObject({ kind: 'memory', decision: 'send' });
    expect(judge({ question: 'لخّص لي أهم أخبار اليوم', reply: 'أهم العناوين الآن على الصفحة الرئيسية لـ**BBC** (bbc.com)، كما تظهر هناك دون أن أعيد صياغتها:\n\n1. [خبر أول](https://www.bbc.com/a)\n2. [خبر ثان](https://www.bbc.com/b)\n\nقل «اقرأ الخبر 2» مثلًا لأفتحه وأقرأه.' })).toMatchObject({ kind: 'list', decision: 'send' });
    expect(judge({ question: 'افتح https://docs.python.org/3/tutorial/index.html واقرأ الصفحة', reply: 'من **Search — Python 3.15.2 documentation** (docs.python.org):\n\n> Searching for multiple words only shows matches that contain all words.\n\nقل «اقرأ المزيد» لأكمل.' }).kind).toBe('quote');
    expect(judge({ question: 'تابع', reply: '**الموضوع:** رسالة\n\nإلى: أحمد' }).kind).toBe('composed');
    expect(judge({ question: 'كيف حالك؟', reply: 'مرحبًا! كيف أساعدك؟' })).toMatchObject({ kind: 'fixed', decision: 'send' });
    expect(judge({ question: 'hi', reply: 'Hello! How can I help?' })).toMatchObject({ kind: 'fixed', decision: 'send' });
  });
});

describe('the lead against the question', () => {
  it('promotes the sentence that answers «كم عدد سكان المغرب» over the one about a minority (rq016)', () => {
    const verdict = judge(RQ016);
    expect(verdict.kind).toBe('answer');
    expect(verdict.codes).toContain('lead_not_best');
    expect(verdict.decision).toBe('fix');
    expect(verdict.best?.line).toBe(4);
    expect(verdict.fixedReply?.split('\n')[0]).toMatch(/^وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب/u);
    expect(verdict.fixedReply).toContain('- فيما انخفضت الأقلية اليهودية');
    // The page's own words only: nothing was written that the reply did not already hold.
    for (const line of verdict.fixedReply!.split('\n').filter(Boolean)) expect(RQ016.reply).toContain(line.replace(/^- /u, ''));
  });

  it('withholds a battle for a question about how long an eye operation takes (rq018)', () => {
    const verdict = judge(RQ018);
    expect(verdict.codes).toContain('duration_unit_missing');
    expect(verdict.decision).toBe('withhold');
    // The reason, the link to the page that was read, and the next step: fixed sentences and the host's own link.
    expect(verdict.withholdText).toBe([
      'لم أجد في الصفحة التي قرأتها الرقم الذي يسأل عنه سؤالك، فلم أنقل لك جوابًا غير مؤكد.', '',
      'الصفحة التي قرأتها: [ويكيبيديا — معركة المياه البيضاء](https://ar.wikipedia.org/wiki/y)', '',
      'أرسل رابط صفحة مناسبة أو أعد صياغة السؤال.'].join('\n'));
  });

  it('withholds a web page about a book for a question about the assistant itself (rq037), with the reason alone', () => {
    const verdict = judge(RQ037);
    expect(verdict.codes).toContain('self_question_from_web');
    expect(verdict.decision).toBe('withhold');
    expect(verdict.withholdText).toBe('هذا سؤال عنّي، ولا أجيب عنه من صفحات الويب، فلم أنقل ما وجدته في صفحة لا تخصني.');
  });

  it('marks a timestamped fragment and a missing definition form for review, and still sends (rq019)', () => {
    const verdict = judge(RQ019);
    expect(verdict.codes).toEqual(expect.arrayContaining(['fragment_lead', 'definition_form_missing']));
    expect(verdict.decision).toBe('send');
  });

  it('marks a connective-led lead for review (rq006) and an English «But …» lead with its definition (rq028)', () => {
    expect(codesOf(judge(RQ006))).toEqual(['fragment_lead']);
    const en = judge(RQ028);
    expect(en.codes).toEqual(expect.arrayContaining(['fragment_lead', 'definition_form_missing', 'foreign_heading']));
    expect(en.decision).toBe('fix');
    expect(en.fixedReply).toContain('**More from the same source:**');
  });

  it('fixes the speed-of-light reply: the number sentence leads, the byline line goes, the chrome is cut (rq010)', () => {
    const verdict = judge(RQ010);
    expect(verdict.codes).toEqual(expect.arrayContaining(['byline_lead', 'site_chrome', 'foreign_heading', 'lead_not_best']));
    expect(verdict.decision).toBe('fix');
    expect(verdict.fixedReply?.split('\n')[0]).toMatch(/^The speed of light traveling through a vacuum is exactly 299,792,458 meters/u);
    expect(verdict.fixedReply).not.toMatch(/Vicky Stein|Subscribe to our newsletter/u);
    expect(verdict.fixedReply).toContain('**Source:**');
  });

  it('sends the clean answers as they are (rq005, rq026 with the answer form on the page\'s own subject, rq027, rq008 superlative, rq025 long lead cut with an ellipsis)', () => {
    for (const input of [RQ005, RQ026, RQ027, RQ008, RQ025]) {
      const verdict = judge(input);
      expect(codesOf(verdict), input.question).toEqual([]);
      expect(verdict.decision, input.question).toBe('send');
    }
    // «عاصمتها كانبرا» outranks the passing mention «إقليم عاصمة أستراليا» in a later line: the lead is itself the best line.
    const australia = judge(RQ026);
    expect(australia.best?.line).toBe(1);
    expect(australia.lead?.score).toBeGreaterThan(3);
  });

  it('marks a lead that opens with an ellipsis (rq013) and a lowercase code line under an Arabic question (rq020) as fragments', () => {
    expect(judge(RQ013).codes).toContain('fragment_lead');
    const node = judge(RQ020);
    expect(node.codes).toEqual(expect.arrayContaining(['fragment_lead', 'language_mismatch']));
    expect(node.decision).toBe('send');
  });

  it('uses the previous turn for a follow-up that names its subject with a pronoun', () => {
    const verdict = judge({ question: 'وكم عدد سكانها؟', previous: 'ما عاصمة اليابان؟', reply: ['يبلغ عدد سكان اليابان نحو 125 مليون نسمة.', '', SOURCE('اليابان', 'https://ar.wikipedia.org/wiki/j')].join('\n') });
    expect(codesOf(verdict)).toEqual([]);
    expect(verdict.decision).toBe('send');
  });

  it('blocks a lead that names none of the subject words, and a number question with no number anywhere', () => {
    const offTopic = judge({ question: 'ما عاصمة كندا؟', reply: ['تمتد الغابات على مساحات واسعة من البلاد.', '', SOURCE('غابة', 'https://ar.wikipedia.org/wiki/f')].join('\n') });
    expect(offTopic.codes).toContain('lead_off_topic');
    expect(offTopic.decision).toBe('withhold');
    const noNumber = judge({ question: 'كم عدد سكان مصر؟', reply: ['مصر دولة عربية تقع في الركن الشمالي الشرقي من قارة أفريقيا.', '', SOURCE('مصر', 'https://ar.wikipedia.org/wiki/eg')].join('\n') });
    expect(noNumber.codes).toContain('lead_needs_number');
    expect(noNumber.decision).toBe('withhold');
  });
});

describe('the question\'s subject word (probed on the 83 real questions on record, 2026-11-22)', () => {
  const subjectOf = (question: string) => questionSubject(question, topicWords(question), /\p{Script=Arabic}/u.test(question) ? 'ar' : 'en');
  it('takes the last Arabic subject word before a trailing «في …» qualifier, and Latin capitalised names in either language', () => {
    expect(subjectOf('ما أعراض المياه البيضاء في العين؟')).toEqual({ words: ['بيضاء'], from: 'word' });
    expect(subjectOf('ما هو أطول نهر في العالم؟')).toEqual({ words: ['نهر'], from: 'word' });
    expect(subjectOf('كم عدد سكان المغرب؟')).toEqual({ words: ['مغرب'], from: 'word' });
    expect(subjectOf('ما عاصمة اليابان؟')).toEqual({ words: ['يابان'], from: 'word' });
    expect(subjectOf('ما هو آخر إصدار مستقر من Node.js؟')).toEqual({ words: ['node'], from: 'name' });
    expect(subjectOf('ابحث عن Python pathlib documentation')).toEqual({ words: ['python'], from: 'name' });
    expect(subjectOf('What is the best time to visit Japan?')).toEqual({ words: ['japan'], from: 'name' });
    expect(subjectOf('Is Python faster than Java?')).toEqual({ words: ['python', 'java'], from: 'name' });
  });
  it('only reviews a missing Arabic subject word: the cataract page «الساد» answers «المياه البيضاء» under another name (rq017)', () => {
    const verdict = judge({ question: 'ما أعراض المياه البيضاء في العين؟', reply: [
      'وهذا يؤدي إلى تجمّع المياه من مختلف أجزاء العين ودخولها إلى العدسة مسببة التورم والابيضاض وإعاقة الضوء من الوصول إلى شبكية العين.', '',
      SOURCE('الساد', 'https://ar.wikipedia.org/wiki/s')].join('\n') });
    expect(verdict.findings.find(finding => finding.code === 'subject_missing')?.severity).toBe('review');
    expect(verdict.decision).toBe('send');
  });
  it('names no subject for English without a capitalised name, so nothing is withheld on a guess', () => {
    expect(subjectOf('What is the speed of light?')).toBeNull();
    expect(subjectOf('What should I cook for dinner tonight?')).toBeNull();
    expect(subjectOf('find train teckit from glasgow to london tomorow')).toBeNull();
  });
  it('passes a comparison whose page names either subject', () => {
    const verdict = judge({ question: 'Is Python faster than Java?', reply: ['Python is an interpreted language and is often slower than compiled code.', '', '**Source:** [Wikipedia — Python (programming language)](https://en.wikipedia.org/wiki/Python_(programming_language))'].join('\n') });
    expect(verdict.codes).not.toContain('subject_missing');
  });
});

describe('the source page and the evidence', () => {
  it('compares addresses by host and decoded path', () => {
    expect(pageKey('https://ar.wikipedia.org/wiki/%D8%B7%D9%88%D9%83%D9%8A%D9%88')).toBe('ar.wikipedia.org/wiki/طوكيو');
    expect(pageKey('https://www.Example.com/a/b/?x=1#top')).toBe('example.com/a/b');
    expect(sourceUrls(['جواب.', '', '**المصدر:** [ويكيبيديا — طوكيو](https://ar.wikipedia.org/wiki/%D8%B7%D9%88%D9%83%D9%8A%D9%88) · قُرئت 2026-11-22 05:38 UTC'].join('\n'))).toEqual(['ar.wikipedia.org/wiki/طوكيو']);
  });
  it('reports support as not measured, never unsupported, when the page the reply names is not among the evidence', () => {
    const reply = ['يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة.', '', SOURCE('المغرب', 'https://ar.wikipedia.org/wiki/m')].join('\n');
    const other = judge({ question: 'كم عدد سكان المغرب؟', reply, evidence: [{ kind: 'page', url: 'https://ar.wikipedia.org/wiki/other', text: 'نص صفحة أخرى لا علاقة له.' }] });
    expect(other.support).toBeNull();
    expect(other.codes).toContain('evidence_unavailable');
    expect(other.codes).not.toContain('unsupported_sentence');
    expect(other.decision).toBe('send');
    const same = judge({ question: 'كم عدد سكان المغرب؟', reply, evidence: [{ kind: 'page', url: 'https://ar.wikipedia.org/wiki/m', text: 'يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة حسب إحصاء 2024.' }] });
    expect(same.support).toEqual({ sentences: 1, supported: 1 });
  });
  it('withholds an invented sentence with the «unsupported» reason and the page link', () => {
    const verdict = judge({ question: 'كم عدد سكان المغرب؟', evidence: [{ kind: 'page', url: 'https://ar.wikipedia.org/wiki/m', text: 'يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة.' }],
      reply: ['يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة.', '', '**تفاصيل أخرى من نفس المصدر:**', '- ويتوقع أن يصل عدد السكان إلى خمسين مليونًا بعد عشر سنوات حسب تقديري.', '', SOURCE('المغرب', 'https://ar.wikipedia.org/wiki/m')].join('\n') });
    expect(verdict.decision).toBe('withhold');
    expect(verdict.withholdText).toMatch(/^في الجواب جملة لم أجدها في الصفحات التي قرأتها، فلم أرسله\.\n\nالصفحة التي قرأتها: \[ويكيبيديا — المغرب\]\(https:\/\/ar\.wikipedia\.org\/wiki\/m\)/u);
  });
});

describe('the question\'s subject', () => {
  it('withholds a film article for a travel question about Japan (live 2026-11-22) and keeps answers whose page is the subject', () => {
    const film = judge({ question: 'What is the best time to visit Japan?', reply: [
      'The trio visit Misumi again, this time showing him a magazine he may have come across that includes an article about a wife that paid a man to murder her husband for insurance.',
      '', '**More from the same source:**', '- … a positive review of the film, stating that "though different in feeling from the Japanese writer-director\'s perceptive family tales.',
      '', '**Source:** [ويكيبيديا — The Third Murder](https://en.wikipedia.org/wiki/The_Third_Murder) · read 2026-11-22 06:13 UTC'].join('\n') });
    expect(film.codes).toContain('subject_missing');
    expect(film.decision).toBe('withhold');
    // The page's title carries the subject the lead leaves implicit («عاصمتها كانبرا» on the Australia page).
    expect(judge(RQ026).codes).not.toContain('subject_missing');
    expect(judge(RQ013).codes).not.toContain('subject_missing');
    const japan = judge({ question: 'What is the capital of Japan?', reply: ['Tokyo is the capital and the largest city of Japan.', '', '**Source:** [Wikipedia — Tokyo](https://en.wikipedia.org/wiki/Tokyo)'].join('\n') });
    expect(japan.codes).not.toContain('subject_missing');
  });
});

describe('the page\'s own subject', () => {
  it('marks a village page for a country question (live 2026-11-22: «صباح (المغرب)» for «كم عدد سكان المغرب؟») and not a book or a disambiguation page', () => {
    const village = judge({ question: 'كم عدد سكان المغرب؟', reply: ['بلغ مجموع عدد سكان صباح (المغرب) حسب إحصاءات 2004 حوالي 12912 نسمة يعيشون في 2229 أسرة.', '', SOURCE('صباح (المغرب)', 'https://ar.wikipedia.org/wiki/s')].join('\n') });
    expect(village.codes).toContain('page_subject_mismatch');
    expect(village.decision).toBe('send');
    expect(pageSubjectMismatch(RQ037.reply, ['قدراتك'])).toBeNull();
    expect(pageSubjectMismatch('**المصدر:** [ويكيبيديا — وكالة الفضاء (توضيح)](https://x)', ['وكاله', 'فضاء', 'سعوديه'])).toBeNull();
    expect(pageSubjectMismatch('**Source:** [Wikipedia — Sabah (Morocco)](https://x)', ['population', 'morocco'])).toEqual({ page: 'Sabah', qualifier: 'Morocco' });
    expect(pageSubjectMismatch(RQ026.reply, ['عاصمه', 'استراليا'])).toBeNull();
  });
});

describe('follow-ups (regression: live 2026-11-22 08:30, the fix replaced a right answer with a wrong line)', () => {
  // «وكم عدد سكانها؟» after «ما عاصمة اليابان؟»: the first brain answered right; the judge promoted a line about mountains
  // because it repeats «سكانها» (the question's own pronoun form scored as an answer form) and scored the raw follow-up.
  const right = 'يبلغ عدد سكان اليابان 123 مليون نسمة اعتباراً من 2024.';
  const mountains = 'تحتل المناطق الجبلية ما يزيد عن 70% من أرض اليابان، وتتركز المدن الكبرى في السهول المتبقية التي تشكل أقل من 30% من المساحة، أما المدن التي يزيد عدد سكانها على مليون نسمة فهي: مدينة سابّورو في هوكايدو، مدينة سنداي في …';
  const reply = [right, '', '**تفاصيل أخرى من نفس المصدر:**', `- ${mountains}`, '', SOURCE('اليابان', 'https://ar.wikipedia.org/wiki/j')].join('\n');

  it('keeps a clean lead that states the question, and sends the reply as the first brain wrote it', () => {
    const verdict = judge({ question: 'وكم عدد سكانها؟', previous: 'ما عاصمة اليابان؟', reply, status: 'completed' });
    expect(verdict.codes).not.toContain('lead_not_best');
    expect(verdict.decision).toBe('send');
    expect(verdict.fixedReply).toBeNull();
    expect(verdict.lead?.text).toBe(right);
  });

  it('resolves a pronoun follow-up with the previous subject only, and leaves a follow-up that names its own subject', () => {
    expect(resolvedQuestion('وكم عدد سكانها؟', 'ما عاصمة اليابان؟')).toBe('كم عدد سكانها؟ يابان');
    expect(topicWords(resolvedQuestion('وكم عدد سكانها؟', 'ما عاصمة اليابان؟'))).toEqual(['سكانها', 'يابان']);
    expect(resolvedQuestion('وماذا عن فرنسا؟', 'ما عاصمة اليابان؟')).toBe('ماذا عن فرنسا؟');
    expect(resolvedQuestion('and what about France?', 'What is the capital of Japan?')).toBe('and what about France?');
    expect(resolvedQuestion('كم عدد سكان مصر؟', 'ما عاصمة اليابان؟')).toBe('كم عدد سكان مصر؟');
    expect(resolvedQuestion('وكم عدد سكانها؟', null)).toBe('كم عدد سكانها؟');
  });

  it('still promotes over a defective lead: the owner-approved rq016 (a cut lead) and rq010 (a byline lead)', () => {
    expect(judge(RQ016).codes).toContain('lead_not_best');
    expect(judge(RQ010).codes).toContain('lead_not_best');
  });
});

describe('only page text is changed (regression: live 2026-11-22 06:39–07:16, three desktop replies lost «كتبت»)', () => {
  it('leaves a desktop action report exactly as it is', () => {
    for (const reply of ['كتبت 14 حرفًا في نافذة المفكرة.', 'كتبت 14 حرفًا في «Untitled - Notepad».', 'كتبت 14 حرفًا في «ملاحظات.txt - Notepad» وتحققت أنها ظهرت كما هي.']) {
      const verdict = judge({ question: 'اكتب مرحبا من موحسن في المفكرة', reply, status: 'completed' });
      expect(verdict.codes, reply).not.toContain('byline_lead');
      expect(verdict.decision, reply).toBe('send');
      expect(verdict.fixedReply, reply).toBeNull();
    }
    expect(judge({ question: 'اكتب مرحبا من موحسن في المفكرة', reply: 'كتبت 14 حرفًا في نافذة المفكرة.' }).kind).toBe('action');
  });
  it('does not treat evidence alone as a quoted page: a template reply in a run that opened a page is not judged as an answer', () => {
    const verdict = judge({ question: 'ما النوافذ المفتوحة؟', reply: 'النوافذ المفتوحة الآن: المفكرة، والمتصفح.', evidence: [{ kind: 'page', url: 'https://example.test/', text: 'نص صفحة فتحها التشغيل سابقًا.' }] });
    expect(verdict.sourced).toBe(false);
    expect(verdict.lead).toBeNull();
    expect(verdict.decision).toBe('send');
  });
  it('keeps «كتب …» in a quoted page sentence, and still cuts a real byline', () => {
    const novel = judge({ question: 'من كتب رواية الأيام؟', reply: ['كتب طه حسين رواية الأيام في ثلاثة أجزاء.', '', SOURCE('الأيام (رواية)', 'https://ar.wikipedia.org/wiki/a')].join('\n') });
    expect(novel.codes).not.toContain('byline_lead');
    expect(novel.fixedReply).toBeNull();
    const byline = judge({ question: 'ما فوائد الشاي الأخضر؟', reply: ['بقلم سارة أحمد آخر تحديث 3 نوفمبر 2026 الشاي الأخضر غني بمضادات الأكسدة.', '', SOURCE('شاي أخضر', 'https://ar.wikipedia.org/wiki/g')].join('\n') });
    expect(byline.codes).toContain('byline_lead');
    expect(judge(RQ010).fixedReply).not.toMatch(/Vicky Stein/u);
  });
});

describe('routes', () => {
  it('marks an identity question met with a browsing abstention for review (rq084) and an English template to an Arabic request (rq022)', () => {
    const identity = judge({ question: 'whos create you', reply: 'I haven’t performed this request. The search or browsing route did not verify the requested result. I have not confirmed anything.' });
    expect(identity).toMatchObject({ kind: 'abstain', decision: 'send' });
    expect(identity.codes).toContain('local_intent_abstained');
    const template = judge({ question: 'ابحث عن Python pathlib documentation', reply: 'I could not reach results relevant to “Python pathlib documentation” after trying more than one search engine. Send a suitable website link or name the organization to search.' });
    expect(template.codes).toContain('language_mismatch');
    expect(template.decision).toBe('send');
  });
});

describe('support against the evidence', () => {
  const page = 'طوكيو عاصمة اليابان وأكثر مدن العالم اكتظاظًا بالسكان. تقع المدينة على خليج طوكيو.';
  it('counts every own sentence found in the evidence, and blocks one found nowhere', () => {
    const supported = judge({ ...RQ005, reply: ['طوكيو عاصمة اليابان وأكثر مدن العالم اكتظاظًا بالسكان.', '', SOURCE('عاصمة', 'https://ar.wikipedia.org/wiki/c')].join('\n'), evidence: [{ kind: 'page', text: page }] });
    expect(supported.support).toEqual({ sentences: 1, supported: 1 });
    expect(supported.codes).not.toContain('evidence_unavailable');
    expect(supported.decision).toBe('send');
    const invented = judge({ ...RQ005, reply: ['طوكيو عاصمة اليابان وأكثر مدن العالم اكتظاظًا بالسكان.', '', '**تفاصيل أخرى من نفس المصدر:**', '- يبلغ عدد سكان طوكيو أربعين مليون نسمة حسب تقديري.', '', SOURCE('عاصمة', 'https://ar.wikipedia.org/wiki/c')].join('\n'), evidence: [{ kind: 'page', text: page }] });
    expect(invented.support).toEqual({ sentences: 2, supported: 1 });
    expect(invented.codes).toContain('unsupported_sentence');
    expect(invented.decision).toBe('withhold');
  });

  it('accepts fixed texts, memory items and ellipsis-joined quotes, and reports no measurement without evidence', () => {
    const fixed = judge({ ...RQ005, reply: ['طوكيو عاصمة اليابان وأكثر مدن العالم اكتظاظًا بالسكان.', 'قرأت هذا من الصفحة المفتوحة في لوحة المتصفح.', '', SOURCE('عاصمة', 'https://ar.wikipedia.org/wiki/c')].join('\n'),
      evidence: [{ kind: 'page', text: page }], fixedTexts: ['قرأت هذا من الصفحة المفتوحة في لوحة المتصفح.'] });
    expect(fixed.support).toEqual({ sentences: 2, supported: 2 });
    const joined = judge({ ...RQ005, reply: ['… اليابان وأكثر مدن العالم اكتظاظًا بالسكان … على خليج طوكيو.', '', SOURCE('عاصمة', 'https://ar.wikipedia.org/wiki/c')].join('\n'), evidence: [{ kind: 'page', text: page }] });
    expect(joined.support).toEqual({ sentences: 1, supported: 1 });
    expect(judge(RQ005).support).toBeNull();
    expect(judge(RQ005).codes).toContain('evidence_unavailable');
  });

  it('finds a sentence the page carries with footnote marks, or with an edit mark hands.ts cleaned out, and not an invented one', () => {
    const page = comparable('ألكسندر غراهام بيل[12] اخترع الهاتف عام 1876[13] في بوسطن. الطاقة الشمسية هي أشعة الضوء [تحرير] والحرارة الصادرة من الشمس واستغلها الإنسان منذ القدم.');
    expect(supportedBy(comparable('ألكسندر غراهام بيل اخترع الهاتف عام 1876 في بوسطن.'), page)).toBe(true);
    expect(supportedBy(comparable('الطاقة الشمسية هي أشعة الضوء والحرارة الصادرة من الشمس واستغلها الإنسان منذ القدم.'), page)).toBe(true);
    expect(supportedBy(comparable('الطاقة الشمسية هي أرخص مصدر للكهرباء في العالم اليوم.'), page)).toBe(false);
    expect(supportedBy(comparable('بيل في بوسطن'), page)).toBe(false);
    const verdict = judge({ question: 'من اخترع الهاتف؟', reply: ['ألكسندر غراهام بيل اخترع الهاتف عام 1876 في بوسطن.', '', SOURCE('هاتف', 'https://ar.wikipedia.org/wiki/t')].join('\n'),
      evidence: [{ kind: 'page', text: 'ألكسندر غراهام بيل[12] اخترع الهاتف عام 1876[13] في بوسطن.' }] });
    expect(verdict.support).toEqual({ sentences: 1, supported: 1 });
    expect(verdict.decision).toBe('send');
  });
});

describe('helpers', () => {
  it('stems pronouns and plurals, and sees «عاصمة» inside «عاصمتها»', () => {
    expect(stem('سكانها')).toBe('سكان');
    expect(stem('trains')).toBe('train');
    expect(stem('class')).toBe('class');
    expect(mentions('تقع في الجنوب، عاصمتها كانبرا', 'عاصمه')).toBe(true);
    expect(mentions('تمتد الغابات على مساحات واسعة', 'عاصمه')).toBe(false);
  });
  it('finds the cue words a question asks about its subject, and the page title in the source line', () => {
    expect(cueWords('كم عدد سكان المغرب؟', ['سكان', 'مغرب'])).toEqual(['عدد']);
    // «عملية» folds to «عمليه» and loses its final «ه» to the suffix stem; the stem still sits inside «عملية» and «عمليات».
    expect(cueWords('كم تستغرق عملية المياه البيضاء؟', ['مياه', 'بيضاء'])).toEqual(expect.arrayContaining(['تستغرق', 'عملي']));
    expect(sourceTitleWords(RQ026.reply)).toEqual(['استراليا']);
  });
  it('reads fragments and definition forms', () => {
    expect(isFragment('وهذا يعني أن بيل صنع الهاتف.', 'ar')).toBe(true);
    expect(isFragment('… رئاسية، ويبلغ عدد سكانها 68.6 مليون نسمة.', 'ar')).toBe(true);
    expect(isFragment('5:11 فيديو لعملية الليزك', 'ar')).toBe(true);
    expect(isFragment('js version: node -v', 'en')).toBe(true);
    expect(isFragment('js version: node -v', 'ar')).toBe(true);
    expect(isFragment('طوكيو عاصمة اليابان.', 'ar')).toBe(false);
    expect(isFragment('ألبرت أينشتاين عالم فيزياء ألماني المولد، يُشتهر بأبي النسبية …', 'ar')).toBe(false);
    expect(definitionForm('الذكاء الاصطناعي (AI) هو تقنية تحويلية.', ['ذكاء', 'اصطناعي'])).toBe(true);
    expect(definitionForm('Photosynthesis is the process by which plants make food.', ['photosynthesis'])).toBe(true);
    expect(definitionForm('ويكي بيانات أيقظ قدراتك واصنع مستقبلك هو كتاب.', ['قدراتك'])).toBe(false);
  });
  it('scores a sentence by subject, phrase, cue and type', () => {
    const context = { question: 'كم عدد سكان المغرب؟', topic: ['سكان', 'مغرب'], cues: ['عدد'], titleWords: ['تركيبه', 'سكانيه', 'مغرب'], answerType: 'number', lang: 'ar' as const };
    const answer = relevance('حسب إحصاء سنة 2024، يبلغ عدد سكان المغرب 37 مليون نسمة.', context);
    const minority = relevance('فيما انخفضت الأقلية اليهودية المغربية ويصل عددها إلى نحو 6,000.', context);
    expect(answer).toMatchObject({ topicHits: 2, phrase: true, cue: true, typed: true, fragment: false });
    // «المغربية» is in the line; «سكان» only in the page title («التركيبة السكانية»), so it counts as implied beside it.
    expect(minority).toMatchObject({ topicHits: 2, implied: 1, phrase: false, fragment: true });
    expect(answer.score - minority.score).toBeGreaterThanOrEqual(2);
    expect(ownLines(RQ016.reply).map(line => line.line)).toEqual([1, 4, 5]);
    const english = { question: 'What is the speed of light?', topic: ['speed', 'light'], cues: [], titleWords: ['speed', 'light'], answerType: 'number', lang: 'en' as const };
    expect(relevance('The speed of light in vacuum is exactly 299,792,458 metres per second.', english)).toMatchObject({ topicHits: 2, phrase: true, typed: true });
    expect(relevance('Light travels at slower speed inside materials like glass or water.', english)).toMatchObject({ topicHits: 2, phrase: false, typed: false });
  });
  it('stops the own sentences at the source line: the host\'s single-source note after it is neither scored nor looked up', () => {
    const reply = ['يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة.', '', SOURCE('المغرب', 'https://ar.wikipedia.org/wiki/m'), '', 'لم أتحقق من هذا الرقم في مصدر ثانٍ.'].join('\n');
    expect(ownLines(reply).map(line => line.line)).toEqual([1]);
    const verdict = judge({ question: 'كم عدد سكان المغرب؟', reply, evidence: [{ kind: 'page', text: 'حسب إحصاء 2024 يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة.' }] });
    expect(verdict.support).toEqual({ sentences: 1, supported: 1 });
    expect(verdict.decision).toBe('send');
  });
});
