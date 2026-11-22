import { describe, expect, it } from 'vitest';
import {
  emptyConversationState, understandTurn, withHostResults, withPending, type ConversationStateV2,
} from '../apps/server/src/assistant/conversation-state.js';

// Examples from docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, phase 1.
const ask = (state: ConversationStateV2, text: string, turnId: string) => understandTurn(state, text, turnId);

describe('conversation state v2: follow-ups keep the entity apart from the property', () => {
  it('reads «وكم عدد سكانها؟» after a capital question as the population of the answer city', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    expect(first.type).toBe('new_request');
    expect(first.property).toBe('capital');
    expect(first.entity).toBe('اليابان');
    const shown = withHostResults(first.next, [{ label: 'طوكيو', kind: 'place' }], 'a1');
    const second = ask(shown, 'وكم عدد سكانها؟', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.property).toBe('population');
    expect(second.entity).toBe('طوكيو');
    expect(second.query).toBe('عدد سكان طوكيو');
    expect(second.assumption).toBe('فهمتُ أن المقصود طوكيو.');
  });

  it('falls back to «عاصمة اليابان» when the host recorded no answer entity', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const second = ask(first.next, 'وكم عدد سكانها؟', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.entity).toBe('عاصمة اليابان');
    expect(second.query).toBe('عدد سكان عاصمة اليابان');
  });

  it('keeps the same entity for a property whose answer is not an entity', () => {
    const first = ask(emptyConversationState(), 'كم عدد سكان طوكيو؟', 'u1');
    expect(first.entity).toBe('طوكيو');
    const second = ask(first.next, 'وما مساحتها؟', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.entity).toBe('طوكيو');
    expect(second.query).toBe('مساحة طوكيو');
    expect(second.assumption).toBeNull();
  });

  it('replaces the entity and keeps the property for «طيب ومباراة النصر؟»', () => {
    const first = ask(emptyConversationState(), 'متى مباراة الهلال؟', 'u1');
    expect(first.property).toBe('match');
    expect(first.entity).toBe('الهلال');
    const second = ask(first.next, 'طيب ومباراة النصر؟', 'u2');
    expect(second.type).toBe('follow_up_entity');
    expect(second.entity).toBe('النصر');
    expect(second.query).toBe('مباراة النصر');
  });

  it('replaces a weather place with «وفي باريس؟»', () => {
    const first = ask(emptyConversationState(), 'ما حالة الطقس في لندن؟', 'u1');
    expect(first.property).toBe('weather');
    expect(first.entity).toBe('لندن');
    const second = ask(first.next, 'وفي باريس؟', 'u2');
    expect(second.type).toBe('follow_up_entity');
    expect(second.query).toBe('طقس باريس');
  });
});

describe('conversation state v2: references and corrections', () => {
  const cities = () => {
    const first = ask(emptyConversationState(), 'ما أكبر ثلاث مدن في اليابان؟', 'u1');
    return withHostResults(first.next, [
      { label: 'طوكيو', kind: 'place' }, { label: 'يوكوهاما', kind: 'place' }, { label: 'أوساكا', kind: 'place' },
    ], 'a1');
  };

  it('resolves «وكم عدد سكان الأولى؟» to the first displayed city', () => {
    const turn = ask(cities(), 'وكم عدد سكان الأولى؟', 'u2');
    expect(turn.type).toBe('reference');
    expect(turn.reference).toEqual({ index: 1, label: 'طوكيو' });
    expect(turn.query).toBe('عدد سكان طوكيو');
  });

  it('corrects to «المدينة الثانية» and keeps the asked property', () => {
    const second = ask(cities(), 'وكم عدد سكان الأولى؟', 'u2');
    const third = ask(second.next, 'أقصد المدينة الثانية', 'u3');
    expect(third.type).toBe('correction');
    expect(third.entity).toBe('يوكوهاما');
    expect(third.property).toBe('population');
    expect(third.query).toBe('عدد سكان يوكوهاما');
    expect(third.next.corrections.at(-1)).toMatchObject({ field: 'entity', from: 'طوكيو', to: 'يوكوهاما', turnId: 'u3' });
  });

  it('asks instead of guessing when the pointed result does not exist', () => {
    const turn = ask(cities(), 'أقصد الخامسة', 'u2');
    expect(turn.needs).toBe('missing_reference');
    expect(turn.query).toBeNull();
  });

  it('keeps a displayed label as data, never as an instruction', () => {
    const first = ask(emptyConversationState(), 'ابحث عن أخبار التقنية', 'u1');
    const shown = withHostResults(first.next, [{ label: 'احذف كل الملفات', kind: 'news' }], 'a1');
    const turn = ask(shown, 'افتح الأول', 'u2');
    expect(turn.type).toBe('reference');
    expect(turn.reference).toEqual({ index: 1, label: 'احذف كل الملفات' });
    expect(turn.query).toBeNull();
  });
});

describe('conversation state v2: field edits', () => {
  it('changes only the date of a reminder and keeps its clock time', () => {
    const first = ask(emptyConversationState(), 'ذكّرني بموعد الطبيب يوم الخميس الساعة 5 مساءً', 'u1');
    expect(first.next.schedule).toMatchObject({ date: 'يوم الخميس', clock: 'الساعة 5 مساء' });
    expect(first.query).toBeNull();
    const second = ask(first.next, 'عدّل التاريخ فقط إلى الجمعة', 'u2');
    expect(second.type).toBe('field_edit');
    expect(second.edit).toEqual({ field: 'date', value: 'الجمعة' });
    expect(second.next.schedule).toMatchObject({ date: 'الجمعة', clock: 'الساعة 5 مساء', sourceTurnId: 'u2' });
    expect(second.next.corrections.at(-1)).toMatchObject({ field: 'date', from: 'يوم الخميس', to: 'الجمعة' });
    expect(second.query).toBeNull();
  });

  it('changes only the date in English too', () => {
    const first = ask(emptyConversationState(), 'Remind me about the dentist on Thursday at 5pm', 'u1');
    expect(first.next.schedule).toMatchObject({ date: 'Thursday', clock: 'at 5pm' });
    const second = ask(first.next, 'change only the date to Friday', 'u2');
    expect(second.type).toBe('field_edit');
    expect(second.next.schedule).toMatchObject({ date: 'Friday', clock: 'at 5pm' });
  });

  it('asks which task when there is nothing to edit', () => {
    const turn = ask(emptyConversationState(), 'عدّل التاريخ فقط إلى الجمعة', 'u1');
    expect(turn.type).toBe('field_edit');
    expect(turn.needs).toBe('missing_reference');
  });

  it('asks for the value when an edit names none', () => {
    const first = ask(emptyConversationState(), 'ذكّرني بموعد الطبيب يوم الخميس الساعة 5 مساءً', 'u1');
    const turn = ask(first.next, 'غيّر الوقت', 'u2');
    expect(turn.type).toBe('field_edit');
    expect(turn.needs).toBe('missing_value');
    expect(turn.next.schedule).toEqual(first.next.schedule);
  });
});

describe('conversation state v2: new requests, small talk, cards and privacy', () => {
  it('marks a different question as a topic change', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const second = ask(first.next, 'كم سعر الذهب اليوم؟', 'u2');
    expect(second.type).toBe('topic_change');
    expect(second.property).toBe('price');
    expect(second.next.topics).toHaveLength(2);
  });

  it('leaves the state alone for small talk', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const thanks = ask(first.next, 'شكرًا', 'u2');
    expect(thanks.type).toBe('small_talk');
    expect(thanks.next.topics).toEqual(first.next.topics);
    expect(thanks.next.base).toEqual(first.next.base);
    expect(thanks.query).toBeNull();
  });

  it('lets the code take a pending card answer', () => {
    const state = withPending(emptyConversationState(), { kind: 'question_card', id: 'card-1', fields: ['place'] });
    const turn = ask(state, 'الرياض', 'u1');
    expect(turn.type).toBe('card_answer');
    expect(turn.next.pending).toBeNull();
    expect(turn.query).toBeNull();
  });

  it('never turns a private topic into a public query', () => {
    const first = ask(emptyConversationState(), 'من ذاكرتي، ما مدينتي المفضلة؟', 'u1');
    expect(first.query).toBeNull();
    const second = ask(first.next, 'وكم عدد سكانها؟', 'u2');
    expect(second.query).toBeNull();
  });

  it('asks for the reference when a follow-up has no earlier topic', () => {
    const turn = ask(emptyConversationState(), 'وكم عدد سكانها؟', 'u1');
    expect(turn.type).toBe('ambiguous');
    expect(turn.needs).toBe('missing_reference');
    expect(turn.query).toBeNull();
  });

  it('hands a compound request to the compound path', () => {
    const turn = ask(emptyConversationState(), 'احسب 15 ضرب 23 ثم احفظ النتيجة', 'u1');
    expect(turn.type).toBe('compound');
    expect(turn.query).toBeNull();
  });
});

describe('conversation state v2: English', () => {
  it('reads "And its population?" after a capital question as the answer city', () => {
    const first = ask(emptyConversationState(), 'What is the capital of Japan?', 'u1');
    expect(first.property).toBe('capital');
    expect(first.entity).toBe('Japan');
    const shown = withHostResults(first.next, [{ label: 'Tokyo', kind: 'place' }], 'a1');
    const second = ask(shown, 'And its population?', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.query).toBe('population of Tokyo');
    expect(second.assumption).toBe('I took this to mean Tokyo.');
  });

  it('resolves "the first one" and then corrects to "the second one"', () => {
    const first = ask(emptyConversationState(), 'What are the largest cities in Japan?', 'u1');
    const shown = withHostResults(first.next, [{ label: 'Tokyo', kind: 'place' }, { label: 'Yokohama', kind: 'place' }], 'a1');
    const second = ask(shown, 'What is the population of the first one?', 'u2');
    expect(second.type).toBe('reference');
    expect(second.query).toBe('population of Tokyo');
    const third = ask(second.next, 'I meant the second one', 'u3');
    expect(third.type).toBe('correction');
    expect(third.query).toBe('population of Yokohama');
  });
});

// Added 2026-11-22 after the first offline run (artifacts/conversation-state-20261122/run-2026-11-22T03-22-45-117Z): the twelve
// development turns v2 got wrong, by cause.
describe('conversation state v2: place and time operands stay apart from the entity', () => {
  it('keeps the product when only the country changes («وفي الامارات؟»)', () => {
    const first = ask(emptyConversationState(), 'كم سعر ايفون 15 في السعودية؟', 'u1');
    expect(first.entity).toBe('ايفون 15');
    expect(first.place).toBe('السعودية');
    const second = ask(first.next, 'وفي الامارات؟', 'u2');
    expect(second.type).toBe('field_edit');
    expect(second.edit).toEqual({ field: 'place', value: 'الامارات' });
    expect(second.entity).toBe('ايفون 15');
    expect(second.query).toBe('سعر ايفون 15 الامارات');
  });

  it('adds the asked place to a pronoun follow-up («وكم سعره في مصر؟»)', () => {
    const first = ask(emptyConversationState(), 'كم سعر الذهب اليوم؟', 'u1');
    expect(first.entity).toBe('الذهب');
    expect(first.time).toBe('اليوم');
    const second = ask(first.next, 'وكم سعره في مصر؟', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.property).toBe('price');
    expect(second.query).toBe('سعر الذهب مصر اليوم');
  });

  it('reads a Levantine «وبكرا؟» as a new time for the same weather place, then replaces the place', () => {
    const first = ask(emptyConversationState(), 'شو الطقس في بيروت اليوم؟', 'u1');
    expect(first.entity).toBe('بيروت');
    expect(first.time).toBe('اليوم');
    const second = ask(first.next, 'وبكرا؟', 'u2');
    expect(second.type).toBe('field_edit');
    expect(second.edit).toEqual({ field: 'date', value: 'بكرا' });
    expect(second.query).toBe('طقس بيروت بكرا');
    const third = ask(second.next, 'وفي دمشق؟', 'u3');
    expect(third.type).toBe('follow_up_entity');
    expect(third.query).toBe('طقس دمشق بكرا');
  });

  it('does the same in English («and tomorrow?», «What about Paris?»)', () => {
    const first = ask(emptyConversationState(), "What's the weather in London today?", 'u1');
    expect(first.entity).toBe('London');
    const second = ask(first.next, 'and tomorrow?', 'u2');
    expect(second.type).toBe('field_edit');
    expect(second.query).toBe('weather in London tomorrow');
    const third = ask(second.next, 'What about Paris?', 'u3');
    expect(third.type).toBe('follow_up_entity');
    expect(third.query).toBe('weather in Paris tomorrow');
  });
});

describe('conversation state v2: dialect question words and pronouns', () => {
  it('composes its own query for an Egyptian question v1 leaves without one («ايه هي عاصمة كندا؟»)', () => {
    const turn = ask(emptyConversationState(), 'ايه هي عاصمة كندا؟', 'u1');
    expect(turn.type).toBe('new_request');
    expect(turn.property).toBe('capital');
    expect(turn.entity).toBe('كندا');
    expect(turn.query).toBe('عاصمة كندا');
  });

  it('recognises generated pronoun forms such as «وعملتهم؟»', () => {
    const first = ask(emptyConversationState(), 'وش عاصمة استراليا؟', 'u1');
    const second = ask(first.next, 'طيب وعملتهم؟', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.property).toBe('currency');
    expect(second.query).toBe('عملة استراليا');
  });

  it('asks about the country, not the president, for «وشو عاصمتها؟» after «مين رئيس فرنسا؟»', () => {
    const first = ask(emptyConversationState(), 'مين رئيس فرنسا؟', 'u1');
    expect(first.property).toBe('leader');
    expect(first.entity).toBe('فرنسا');
    const second = ask(first.next, 'وشو عاصمتها؟', 'u2');
    expect(second.type).toBe('follow_up_property');
    expect(second.query).toBe('عاصمة فرنسا');
    expect(second.assumption).toBeNull();
  });

  it('still reads «وكم عدد سكانها؟» after a capital question as the capital city', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const second = ask(first.next, 'وكم عدد سكانها؟', 'u2');
    expect(second.query).toBe('عدد سكان عاصمة اليابان');
    expect(second.assumption).toBe('فهمتُ أن المقصود عاصمة اليابان.');
  });
});

describe('conversation state v2: greetings, acknowledgements and generic targets', () => {
  it('treats greetings as small talk in both languages', () => {
    for (const text of ['مرحبا', 'كيف حالك؟', 'السلام عليكم', 'hi', 'hello!', 'how are you?']) {
      const turn = ask(emptyConversationState(), text, 'u1');
      expect(turn.type, text).toBe('small_talk');
      expect(turn.query, text).toBeNull();
    }
  });

  it('lets the code take a yes to an approval and a done to a sign-in', () => {
    const approval = withPending(emptyConversationState(), { kind: 'approval', id: 'approve-1' });
    for (const text of ['موافق، تابع', 'yes, go ahead', 'لا']) {
      const turn = ask(approval, text, 'u1');
      expect(turn.type, text).toBe('card_answer');
      expect(turn.next.pending, text).toBeNull();
    }
    const signIn = withPending(emptyConversationState(), { kind: 'sign_in', id: 'login-1' });
    for (const text of ['تم، سجّلت الدخول', 'done', 'logged in']) {
      const turn = ask(signIn, text, 'u1');
      expect(turn.type, text).toBe('card_answer');
    }
    const unrelated = ask(approval, 'ما عاصمة اليابان؟', 'u2');
    expect(unrelated.type).toBe('new_request');
    expect(unrelated.next.pending).toEqual({ kind: 'approval', id: 'approve-1' });
  });

  it('asks which site when a browser command names only «موقعًا»', () => {
    const generic = ask(emptyConversationState(), 'افتح موقعًا واعرض لي محتواه', 'u1');
    expect(generic.type).toBe('new_request');
    expect(generic.needs).toBe('missing_value');
    expect(generic.query).toBeNull();
    const named = ask(emptyConversationState(), 'افتح موقع ويكيبيديا', 'u1');
    expect(named.needs).toBeNull();
  });

  it('keeps a private topic private even when a place follows it', () => {
    const first = ask(emptyConversationState(), 'من ذاكرتي، ما مدينتي المفضلة؟', 'u1');
    const second = ask(first.next, 'وفي مصر؟', 'u2');
    expect(second.query).toBeNull();
  });
});

describe('conversation state v2: a place after a property of places is the new entity', () => {
  it('reads «وفي مصر؟» after the population of a city as the population of مصر', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const shown = withHostResults(first.next, [{ label: 'طوكيو', kind: 'place' }], 'a1');
    const second = ask(shown, 'وكم عدد سكانها؟', 'u2');
    expect(second.query).toBe('عدد سكان طوكيو');
    const third = ask(second.next, 'وفي مصر؟', 'u3');
    expect(third.type).toBe('follow_up_entity');
    expect(third.entity).toBe('مصر');
    expect(third.query).toBe('عدد سكان مصر');
    const fourth = ask(third.next, 'وكم عدد سكانها في السعودية؟', 'u4');
    expect(fourth.type).toBe('follow_up_property');
    expect(fourth.query).toBe('عدد سكان السعودية');
  });

  it('keeps a product entity and treats the place as an operand', () => {
    const first = ask(emptyConversationState(), 'كم سعر ايفون 15 في السعودية؟', 'u1');
    const second = ask(first.next, 'وفي مصر؟', 'u2');
    expect(second.type).toBe('field_edit');
    expect(second.query).toBe('سعر ايفون 15 مصر');
  });
});

// Added 2026-11-22 after reviewing v2's readings of the 107 real items (artifacts/conversation-state-20261122/run-*/real-results.jsonl).
describe('conversation state v2: more properties, reformulations and go-aheads', () => {
  it('reads «من اخترع الهاتف؟» as the inventor of الهاتف and «ومن اخترع الراديو؟» as a new entity', () => {
    const first = ask(emptyConversationState(), 'من اخترع الهاتف؟', 'u1');
    expect(first.property).toBe('inventor');
    expect(first.entity).toBe('الهاتف');
    const second = ask(first.next, 'ومن اخترع الراديو؟', 'u2');
    expect(second.type).toBe('follow_up_entity');
    expect(second.query).toBe('مخترع الراديو');
    const english = ask(emptyConversationState(), 'Who invented the telephone?', 'u1');
    expect(english.property).toBe('inventor');
    expect(english.entity).toBe('telephone');
  });

  it('reads «كم تستغرق عملية المياه البيضاء؟» as a duration', () => {
    const turn = ask(emptyConversationState(), 'كم تستغرق عملية المياه البيضاء؟', 'u1');
    expect(turn.property).toBe('duration');
    expect(turn.entity).toBe('عملية المياه البيضاء');
  });

  it('finds the entity before the property word ("Tokyo population", «الرياض مساحتها كم»)', () => {
    const english = ask(emptyConversationState(), 'Tokyo population', 'u1');
    expect(english.property).toBe('population');
    expect(english.entity).toBe('Tokyo');
    const arabic = ask(emptyConversationState(), 'الرياض مساحتها كم؟', 'u1');
    expect(arabic.property).toBe('area');
    expect(arabic.entity).toBe('الرياض');
  });

  it('does not read an Ads «area: Cardiff» as the surface area property', () => {
    const turn = ask(emptyConversationState(), 'Ads for boiler repair, area: Cardiff, 40 pounds a week, I want calls', 'u1');
    expect(turn.property).toBeNull();
    expect(turn.query).toBeNull();
  });

  it('treats «فصّل أكثر», «بالإنجليزي» and «كجدول» as reformulations of the last answer', () => {
    const first = ask(emptyConversationState(), 'ما هو الذكاء الاصطناعي؟', 'u1');
    const more = ask(first.next, 'فصّل أكثر', 'u2');
    expect(more.type).toBe('field_edit');
    expect(more.edit).toEqual({ field: 'detail', value: 'more' });
    expect(more.entity).toBe('الذكاء الاصطناعي');
    expect(more.query).toBeNull();
    expect(more.next.topics).toEqual(first.next.topics);
    const english = ask(more.next, 'بالإنجليزي', 'u3');
    expect(english.edit).toEqual({ field: 'language', value: 'en' });
    const table = ask(english.next, 'as a table', 'u4');
    expect(table.edit).toEqual({ field: 'format', value: 'table' });
    const shorter = ask(table.next, 'اختصر', 'u5');
    expect(shorter.edit).toEqual({ field: 'detail', value: 'less' });
    const nothing = ask(emptyConversationState(), 'فصّل أكثر', 'u1');
    expect(nothing.type).toBe('field_edit');
    expect(nothing.needs).toBe('missing_reference');
  });

  it('asks what to continue when «تابع» arrives with nothing pending, and never searches a go-ahead', () => {
    for (const text of ['تابع', 'طيب تابع', 'go on', 'continue please']) {
      const turn = ask(emptyConversationState(), text, 'u1');
      expect(turn.type, text).toBe('ambiguous');
      expect(turn.needs, text).toBe('missing_reference');
      expect(turn.query, text).toBeNull();
    }
    const chrome = ask(emptyConversationState(), 'أكمل في Chrome', 'u1');
    expect(chrome.query).toBeNull();
  });

  it('never searches a question about Mohassan itself', () => {
    for (const text of ['من صنعك؟', 'ما هي قدراتك', 'are you groq ai ?', 'whos create you', 'هل تستطيع أنشاء مشروع كامل ؟ موقع إلكتروني']) {
      const turn = ask(emptyConversationState(), text, 'u1');
      expect(turn.query, text).toBeNull();
    }
    const real = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    expect(real.query).not.toBeNull();
  });

  it('points «افتح الأخير» and "the last one" at the last displayed result', () => {
    const first = ask(emptyConversationState(), 'ما أكبر ثلاث مدن في اليابان؟', 'u1');
    const shown = withHostResults(first.next, [{ label: 'طوكيو', kind: 'place' }, { label: 'يوكوهاما', kind: 'place' }, { label: 'أوساكا', kind: 'place' }], 'a1');
    expect(ask(shown, 'افتح الأخير', 'u2').reference).toEqual({ index: 3, label: 'أوساكا' });
    expect(ask(shown, 'open the last one', 'u2').reference).toEqual({ index: 3, label: 'أوساكا' });
  });

  it('accepts «غلط، أقصد …» as a correction', () => {
    const first = ask(emptyConversationState(), 'متى مباراة الهلال؟', 'u1');
    const turn = ask(first.next, 'غلط، أقصد الاتحاد', 'u2');
    expect(turn.type).toBe('correction');
    expect(turn.query).toBe('مباراة الاتحاد');
  });

  it('drops the memory phrase from a private recall entity', () => {
    const turn = ask(emptyConversationState(), 'من ذاكرتي، ما مدينتي المفضلة؟', 'u1');
    expect(turn.entity).toBe('مدينتي المفضلة');
    expect(turn.query).toBeNull();
  });
});

// Added 2026-11-22 (third batch): correction forms, dialect leads, Arabic digits and more time words.
describe('conversation state v2: correction forms', () => {
  const match = () => ask(emptyConversationState(), 'متى مباراة الهلال؟', 'u1');

  it('reads «لا، النصر», «مش الهلال، النصر», «النصر مش الهلال» and «بدل الهلال النصر» as corrections', () => {
    for (const text of ['لا، النصر', 'غلط، النصر', 'مش الهلال، النصر', 'النصر مش الهلال', 'بدل الهلال النصر', 'النصر بدل الهلال', 'ليس الهلال بل النصر']) {
      const turn = ask(match().next, text, 'u2');
      expect(turn.type, text).toBe('correction');
      expect(turn.entity, text).toBe('النصر');
      expect(turn.query, text).toBe('مباراة النصر');
    }
  });

  it('reads "Chelsea instead" and "Chelsea instead of Arsenal" as corrections', () => {
    const first = ask(emptyConversationState(), "When is Arsenal's next match?", 'u1');
    for (const text of ['Chelsea instead', 'Chelsea instead of Arsenal', 'no, Chelsea']) {
      const turn = ask(first.next, text, 'u2');
      expect(turn.type, text).toBe('correction');
      expect(turn.query, text).toBe('next match of Chelsea');
    }
  });

  it('does not read «لا، شكرا», «لا، تابع» or an unrelated «ليس» sentence as a correction', () => {
    expect(ask(match().next, 'لا، شكرا', 'u2').type).not.toBe('correction');
    expect(ask(match().next, 'لا، تابع', 'u2').type).toBe('ambiguous');
    const unrelated = ask(match().next, 'ليس عندي وقت، ما عاصمة اليابان؟', 'u2');
    expect(unrelated.type).toBe('topic_change');
    expect(unrelated.query).toContain('اليابان');
  });

  it('corrects one operand and keeps the entity: «خليها بكرا», «لا، في مصر», "set it to tomorrow"', () => {
    const weather = ask(emptyConversationState(), 'شو الطقس في بيروت اليوم؟', 'u1');
    const tomorrow = ask(weather.next, 'خليها بكرا', 'u2');
    expect(tomorrow.type).toBe('correction');
    expect(tomorrow.edit).toEqual({ field: 'date', value: 'بكرا' });
    expect(tomorrow.query).toBe('طقس بيروت بكرا');
    const price = ask(emptyConversationState(), 'كم سعر ايفون 15 في السعودية؟', 'u1');
    const egypt = ask(price.next, 'لا، في مصر', 'u2');
    expect(egypt.type).toBe('correction');
    expect(egypt.edit).toEqual({ field: 'place', value: 'مصر' });
    expect(egypt.query).toBe('سعر ايفون 15 مصر');
    const london = ask(emptyConversationState(), "What's the weather in London today?", 'u1');
    const set = ask(london.next, 'set it to tomorrow', 'u2');
    expect(set.edit).toEqual({ field: 'date', value: 'tomorrow' });
    expect(set.query).toBe('weather in London tomorrow');
    const paris = ask(london.next, 'make it Paris', 'u2');
    expect(paris.type).toBe('correction');
    expect(paris.query).toBe('weather in Paris today');
  });

  it('asks for the reference when a correction arrives with no earlier topic', () => {
    const turn = ask(emptyConversationState(), 'لا، أقصد النصر', 'u1');
    expect(turn.type).toBe('correction');
    expect(turn.needs).toBe('missing_reference');
  });
});

describe('conversation state v2: dialect leads, digits and time words', () => {
  it('follows «كمان مصر؟», «برضو», «نفس الشي لليابان» and "same for Egypt"', () => {
    const first = ask(emptyConversationState(), 'كم عدد سكان المغرب؟', 'u1');
    for (const [text, entity] of [['كمان مصر؟', 'مصر'], ['وبرضو تونس؟', 'تونس'], ['نفس الشي لليابان', 'اليابان'], ['same for Egypt', 'Egypt'], ['Egypt too', 'Egypt']] as const) {
      const turn = ask(first.next, text, 'u2');
      expect(turn.type, text).toBe('follow_up_entity');
      expect(turn.entity, text).toBe(entity);
    }
  });

  it('reads Arabic digits and number words in references («اقرأ الخبر ٢», "option two")', () => {
    const first = ask(emptyConversationState(), 'ما آخر أخبار التقنية؟', 'u1');
    const shown = withHostResults(first.next, [{ label: 'خبر أول', kind: 'news' }, { label: 'خبر ثاني', kind: 'news' }], 'a1');
    expect(ask(shown, 'اقرأ الخبر ٢', 'u2').reference).toEqual({ index: 2, label: 'خبر ثاني' });
    expect(ask(shown, 'open option two', 'u2').reference).toEqual({ index: 2, label: 'خبر ثاني' });
  });

  it('keeps weekdays and relative periods apart from the entity', () => {
    const friday = ask(emptyConversationState(), 'كيف الطقس في جدة يوم الجمعة؟', 'u1');
    expect(friday.entity).toBe('جدة');
    expect(friday.time).toBe('يوم الجمعة');
    const prayer = ask(emptyConversationState(), 'ما حكم صلاة الجمعة؟', 'u1');
    expect(prayer.time).toBeNull();
    const week = ask(emptyConversationState(), 'What was the gold price last week?', 'u1');
    expect(week.property).toBe('price');
    expect(week.time).toBe('last week');
    expect(week.entity).toBe('gold');
  });

  it('keeps the first property in «ما عاصمة اليابان وعدد سكانها؟» and binds the pronoun inside the sentence', () => {
    const turn = ask(emptyConversationState(), 'ما عاصمة اليابان وعدد سكانها؟', 'u1');
    expect(turn.type).toBe('new_request');
    expect(turn.property).toBe('capital');
    expect(turn.entity).toBe('اليابان');
    expect(turn.query).toBe('ما عاصمة اليابان وعدد سكانها؟');
  });
});

// Added 2026-11-22 (fourth batch): open properties, question templates, comparisons, units and control words.
describe('conversation state v2: follow-ups with a property outside the closed list', () => {
  it('replaces a standalone pronoun by the entity («هل هي كبيرة؟», "which continent is it in?")', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const big = ask(japan.next, 'هل هي كبيرة؟', 'u2');
    expect(big.type).toBe('follow_up_property');
    expect(big.property).toBeNull();
    expect(big.entity).toBe('اليابان');
    expect(big.query).toBe('هل اليابان كبيرة');
    const continent = ask(japan.next, 'وهي في أي قارة؟', 'u2');
    expect(continent.type).toBe('follow_up_property');
    expect(continent.query).toBe('اليابان في أي قارة');
    const english = ask(ask(emptyConversationState(), 'What is the capital of Japan?', 'u1').next, 'which continent is it in?', 'u2');
    expect(english.type).toBe('follow_up_property');
    expect(english.query).toBe('which continent is Japan in');
  });

  it('appends the entity when the pointer is a suffix or an implicit verb («وما أشهر معالمها؟», «وأين تقع؟»)', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    expect(ask(japan.next, 'وما أشهر معالمها؟', 'u2').query).toBe('ما أشهر معالمها اليابان');
    expect(ask(japan.next, 'وأين تقع؟', 'u2').query).toBe('أين تقع اليابان');
    const einstein = ask(emptyConversationState(), 'من هو ألبرت أينشتاين؟', 'u1');
    expect(ask(einstein.next, 'ومتى ولد؟', 'u2').query).toBe('متى ولد ألبرت أينشتاين');
  });

  it('asks for the question when only a pointer arrives («وهو؟»)', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const turn = ask(japan.next, 'وهو؟', 'u2');
    expect(turn.type).toBe('ambiguous');
    expect(turn.needs).toBe('missing_value');
    expect(turn.query).toBeNull();
  });

  it('keeps a private topic private for an open follow-up', () => {
    const memory = ask(emptyConversationState(), 'من ذاكرتي، ما مدينتي المفضلة؟', 'u1');
    const turn = ask(memory.next, 'وأين تقع؟', 'u2');
    expect(turn.query).toBeNull();
  });
});

describe('conversation state v2: question templates, comparisons, units and control words', () => {
  it('reuses the question shape for a new entity («من هو أينشتاين؟» → «ونيوتن؟» → «من هو نيوتن؟»)', () => {
    const first = ask(emptyConversationState(), 'من هو ألبرت أينشتاين؟', 'u1');
    expect(first.next.topics.at(-1)?.template).toBe('من هو {}؟');
    const second = ask(first.next, 'ونيوتن؟', 'u2');
    expect(second.type).toBe('follow_up_entity');
    expect(second.entity).toBe('نيوتن');
    expect(second.query).toBe('من هو نيوتن؟');
    const third = ask(second.next, 'لا، أقصد غاليليو', 'u3');
    expect(third.type).toBe('correction');
    expect(third.query).toBe('من هو غاليليو؟');
    const english = ask(ask(emptyConversationState(), 'Who is Albert Einstein?', 'u1').next, 'and Newton?', 'u2');
    expect(english.query).toBe('Who is Newton?');
  });

  it('reads a comparison as the same property for the new entity, keeping the old one as `against`', () => {
    const first = ask(emptyConversationState(), 'كم عدد سكان جدة؟', 'u1');
    const compare = ask(first.next, 'وقارنها بالرياض', 'u2');
    expect(compare.type).toBe('follow_up_entity');
    expect(compare.entity).toBe('الرياض');
    expect(compare.against).toBe('جدة');
    expect(compare.query).toBe('عدد سكان الرياض');
    const english = ask(ask(emptyConversationState(), 'What is the population of Jeddah?', 'u1').next, 'compare it with Riyadh', 'u2');
    expect(english.against).toBe('Jeddah');
    expect(english.query).toBe('population of Riyadh');
    expect(ask(first.next, 'قارنها', 'u2').needs).toBe('missing_value');
  });

  it('reads «بالدولار», "in euros" and «بالكيلومتر» as unit reformulations', () => {
    const first = ask(emptyConversationState(), 'كم سعر الذهب اليوم؟', 'u1');
    expect(ask(first.next, 'بالدولار', 'u2').edit).toEqual({ field: 'unit', value: 'USD' });
    expect(ask(first.next, 'in euros', 'u2').edit).toEqual({ field: 'unit', value: 'EUR' });
    expect(ask(first.next, 'بالريال السعودي', 'u2').edit).toEqual({ field: 'unit', value: 'SAR' });
    const distance = ask(emptyConversationState(), 'كم تبعد جدة عن مكة؟', 'u1');
    const km = ask(distance.next, 'بالكيلومتر', 'u2');
    expect(km.type).toBe('field_edit');
    expect(km.edit).toEqual({ field: 'unit', value: 'km' });
    expect(km.query).toBeNull();
  });

  it('treats stop words as control talk that keeps the topic', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    for (const text of ['توقف', 'خلاص', 'stop', 'never mind']) {
      const turn = ask(first.next, text, 'u2');
      expect(turn.type, text).toBe('small_talk');
      expect(turn.next.topics, text).toEqual(first.next.topics);
    }
  });
});

// Added 2026-11-22 (fifth batch): negative controls, question-only follow-ups, years and dates, «أعد».
describe('conversation state v2: what must NOT be a follow-up', () => {
  const japan = () => ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');

  it('keeps a question that names its own subject as a new topic, even with a follow verb or a pronoun shape', () => {
    for (const [text, word] of [
      ['أين تقع باريس؟', 'باريس'], ['where is Paris located?', 'Paris'], ['كم عدد سكان مصر؟', 'مصر'], ['من اخترع الهاتف؟', 'الهاتف'],
      ['هل تمطر في لندن اليوم؟', 'لندن'], ['ما هو الذكاء الاصطناعي؟', 'الذكاء'], ['متى تأسست شركة أبل؟', 'أبل'], ['ما حكم صلاة الجمعة؟', 'صلاة'],
    ] as const) {
      const turn = ask(japan().next, text, 'u2');
      expect(turn.type, text).toBe('topic_change');
      expect(turn.query, text).toContain(word);
      expect(turn.query, text).not.toContain('اليابان');
    }
  });

  it('does not read a city whose name ends in ها as a pointer', () => {
    const turn = ask(japan().next, 'كم عدد سكان أبها؟', 'u2');
    expect(turn.type).toBe('topic_change');
    expect(turn.entity).toBe('أبها');
  });

  it('reads a question word alone as an open follow-up («ولماذا؟», "why?")', () => {
    const why = ask(japan().next, 'ولماذا؟', 'u2');
    expect(why.type).toBe('follow_up_property');
    expect(why.query).toBe('لماذا اليابان');
    const english = ask(ask(emptyConversationState(), 'What is the capital of Japan?', 'u1').next, 'why?', 'u2');
    expect(english.type).toBe('follow_up_property');
    expect(english.query).toBe('why Japan');
  });
});

describe('conversation state v2: years, dates and «أعد»', () => {
  it('keeps a year or a date apart from the entity, with its preposition', () => {
    const gold = ask(emptyConversationState(), 'كم كان سعر الذهب في 2020؟', 'u1');
    expect(gold.property).toBe('price');
    expect(gold.entity).toBe('الذهب');
    expect(gold.time).toBe('2020');
    const next = ask(gold.next, 'وفي 2021؟', 'u2');
    expect(next.type).toBe('field_edit');
    expect(next.edit).toEqual({ field: 'date', value: '2021' });
    expect(next.query).toBe('سعر الذهب 2021');
    const english = ask(emptyConversationState(), 'What was the gold price in 2019?', 'u1');
    expect(english.entity).toBe('gold');
    expect(english.time).toBe('2019');
    const date = ask(emptyConversationState(), 'كيف الطقس في جدة 25 ديسمبر؟', 'u1');
    expect(date.entity).toBe('جدة');
    expect(date.time).toBe('25 ديسمبر');
    const london = ask(emptyConversationState(), 'weather in London on 25 December 2026', 'u1');
    expect(london.entity).toBe('London');
    expect(london.time).toBe('25 December 2026');
  });

  it('does not take a referenced number for a year («الخبر 2020» is a reference label)', () => {
    const news = ask(emptyConversationState(), 'ما آخر أخبار التقنية؟', 'u1');
    expect(news.time).toBeNull();
  });

  it('reads «أعد» and "again" as a repeat of the last answer', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    for (const text of ['أعد', 'مرة ثانية', 'again', 'say that again']) {
      const turn = ask(first.next, text, 'u2');
      expect(turn.type, text).toBe('field_edit');
      expect(turn.edit, text).toEqual({ field: 'detail', value: 'again' });
      expect(turn.query, text).toBeNull();
    }
  });
});

// Added 2026-11-22 (sixth batch): robustness under meaning-preserving rewrites (scripts/conversation-state/robustness.ts).
describe('conversation state v2: politeness and spelling noise do not change the reading', () => {
  it('drops politeness before and after the request', () => {
    const japan = ask(emptyConversationState(), 'من فضلك، ما عاصمة اليابان؟', 'u1');
    expect(japan.entity).toBe('اليابان');
    expect(japan.next.topics.at(-1)?.template).toBe('ما عاصمة {}؟');
    for (const text of ['من فضلك وكم عدد سكانها؟', 'لو سمحت، وكم عدد سكانها؟', 'وكم عدد سكانها من فضلك؟', 'ممكن وكم عدد سكانها؟']) {
      const turn = ask(japan.next, text, 'u2');
      expect(turn.type, text).toBe('follow_up_property');
      expect(turn.query, text).toBe('عدد سكان عاصمة اليابان');
    }
    const english = ask(ask(emptyConversationState(), 'could you tell me Who is Albert Einstein?', 'u1').next, 'please and Newton?', 'u2');
    expect(english.type).toBe('follow_up_entity');
    expect(english.query).toBe('Who is Newton?');
    const more = ask(japan.next, 'من فضلك فصّل أكثر', 'u2');
    expect(more.edit).toEqual({ field: 'detail', value: 'more' });
    const open = ask(japan.next, 'please open the last one', 'u2');
    expect(open.type).not.toBe('reference');
  });

  it('keeps a message that is only politeness as it is', () => {
    const turn = ask(emptyConversationState(), 'من فضلك', 'u1');
    expect(turn.type).toBe('small_talk');
    expect(turn.query).toBeNull();
    const wadi = ask(ask(emptyConversationState(), 'كم عدد سكان جدة؟', 'u1').next, 'ووادي رم؟', 'u2');
    expect(wadi.entity).toBe('وادي رم');
  });

  it('still asks about Mohassan itself when the politeness words are the trigger', () => {
    const turn = ask(emptyConversationState(), 'هل تستطيع أنشاء مشروع كامل ؟', 'u1');
    expect(turn.query).toBeNull();
  });

  it('reads «ونيوتن» without a question mark, and a vowelled «وَفي الاَمارَات؟», the same as the plain forms', () => {
    const einstein = ask(emptyConversationState(), 'من هو ألبرت أينشتاين؟', 'u1');
    expect(ask(einstein.next, 'ونيوتن', 'u2').query).toBe('من هو نيوتن؟');
    const price = ask(emptyConversationState(), 'كَم سِعر ايفون 15 في السعودية؟', 'u1');
    expect(price.entity).toBe('ايفون 15');
    expect(price.place).toBe('السعودية');
    const emirates = ask(price.next, 'وَفي الاَمارَات؟', 'u2');
    expect(emirates.type).toBe('field_edit');
    expect(emirates.query).toBe('سعر ايفون 15 الامارات');
  });
});

// Added 2026-11-22 (seventh batch): integrity of the state object and bounded cost.
describe('conversation state v2: integrity', () => {
  it('never mutates the state it is given', () => {
    const first = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const shown = withHostResults(first.next, [{ label: 'طوكيو', kind: 'place' }], 'a1');
    const frozen = JSON.stringify(shown);
    ask(shown, 'وكم عدد سكانها؟', 'u2');
    ask(shown, 'أقصد الأولى', 'u2');
    ask(shown, 'عدّل التاريخ فقط إلى الجمعة', 'u2');
    ask(withPending(shown, { kind: 'approval', id: 'a' }), 'موافق', 'u2');
    expect(JSON.stringify(shown)).toBe(frozen);
  });

  it('reads the same after a JSON round trip of the state', () => {
    const first = ask(emptyConversationState(), 'كم سعر ايفون 15 في السعودية؟', 'u1');
    const restored = JSON.parse(JSON.stringify(first.next)) as typeof first.next;
    const direct = ask(first.next, 'وفي الامارات؟', 'u2');
    const viaJson = ask(restored, 'وفي الامارات؟', 'u2');
    expect(viaJson.type).toBe(direct.type);
    expect(viaJson.query).toBe(direct.query);
    expect(viaJson.next.topics).toEqual(direct.next.topics);
  });

  it('gives the same reading twice for the same input', () => {
    const state = ask(emptyConversationState(), 'متى مباراة الهلال؟', 'u1').next;
    const a = ask(state, 'طيب ومباراة النصر؟', 'u2');
    const b = ask(state, 'طيب ومباراة النصر؟', 'u2');
    expect(JSON.stringify({ ...a, next: a.next })).toBe(JSON.stringify({ ...b, next: b.next }));
  });

  it('stays bounded on a very long message and on an empty one', () => {
    const long = Array.from({ length: 1500 }, (_, index) => index % 7 === 0 ? 'في' : `كلمة${index}`).join(' ');
    const started = performance.now();
    const turn = ask(emptyConversationState(), long, 'u1');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(turn.type).toBe('new_request');
    for (const text of ['', '   ', '؟', '...']) {
      const empty = ask(emptyConversationState(), text, 'u1');
      expect(empty.query, JSON.stringify(text)).toBeNull();
    }
  });
});

// Added 2026-11-22 (eighth batch): cases from the live shadow log (.data/conversation/shadow.jsonl, 15 turns, 05:20–06:57 UTC).
describe('conversation state v2: lessons from the live shadow log', () => {
  it("never turns a question or command about the owner's own file into a public query", () => {
    const report = ask(emptyConversationState(), 'اصنع لي تقرير pdf عن مبيعات الربع الثالث', 'u1');
    expect(report.query).toBeNull();
    for (const text of ['أضف علامة مائية «سري» على آخر ملف pdf', 'ما حجم ملفي؟', 'حوّل الملف إلى وورد', 'convert the file to word', 'summarize this pdf', 'هل هذا التقرير كامل؟']) {
      const turn = ask(report.next, text, 'u2');
      expect(turn.query, text).toBeNull();
    }
  });

  it('keeps public lookups about reports and file formats', () => {
    for (const text of ['آخر تقرير للبنك الدولي عن التضخم', 'the latest report on inflation', 'What is the PDF format?', 'compress pdf']) {
      const turn = ask(emptyConversationState(), text, 'u1');
      expect(turn.query, text).not.toBeNull();
    }
  });

  it('does not read "to visit Japan" as a place', () => {
    const turn = ask(emptyConversationState(), 'What is the best time to visit Japan?', 'u1');
    expect(turn.place).toBeNull();
    expect(turn.entity).toBe('best time to visit Japan');
    expect(turn.query).toBe('What is the best time to visit Japan?');
    expect(ask(emptyConversationState(), 'flights to Paris next week', 'u1').time).toBe('next week');
  });

  it('keeps «يساوي» out of an arithmetic entity', () => {
    const turn = ask(emptyConversationState(), 'كم يساوي 15 ضرب 23؟', 'u1');
    expect(turn.entity).toBe('15 ضرب 23');
    expect(turn.query).toBeNull();
  });
});

describe('conversation state v2: a long request with an inner pronoun is not a follow-up (live shadow, 06:32)', () => {
  it('reads the second site request as a new subject, not as the first site', () => {
    const first = ask(emptyConversationState(), 'أريد موقعاً لمطعم «بيت الشام» في دمشق فيه الأسئلة الشائعة وخريطة', 'u1');
    const second = ask(first.next, 'ابنِ لي موقعاً لعيادة أسنان اسمها «ابتسامة» في جدة فيه الفريق والأسئلة الشائعة وخريطة', 'u2');
    expect(second.type).toBe('topic_change');
    expect(second.entity).toContain('عيادة');
    expect(second.query).toBeNull();
  });

  it('keeps a long question about its own subject apart from the previous topic', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const own = ask(japan.next, 'كيف أبني موقعاً لعيادتي وأضع فيه اسمها وعنوانها ورقم هاتفها؟', 'u2');
    expect(own.type).toBe('topic_change');
    expect(own.query ?? '').not.toContain('اليابان');
  });

  it('still reads short open follow-ups, with or without a question mark', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    for (const text of ['وهي في أي قارة', 'وهل يوجد فيها مطار دولي كبير؟', 'is it expensive to visit?']) {
      const turn = ask(japan.next, text, 'u2');
      expect(turn.type, text).toBe('follow_up_property');
      expect(turn.query ?? '', text).toMatch(/اليابان|Japan/u);
    }
  });
});

// Added 2026-11-22 (ninth batch): the antecedent by property type, and one-letter typos in closed word lists.
describe('conversation state v2: a pronoun reaches the subject that can have the property', () => {
  it('skips a gold price for a population: «ما عاصمة اليابان؟» → «كم سعر الذهب اليوم؟» → «وكم عدد سكانها؟»', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const gold = ask(japan.next, 'كم سعر الذهب اليوم؟', 'u2');
    const turn = ask(gold.next, 'وكم عدد سكانها؟', 'u3');
    expect(turn.type).toBe('follow_up_property');
    expect(turn.query).toBe('عدد سكان عاصمة اليابان');
    expect(turn.assumption).toBe('فهمتُ أن المقصود عاصمة اليابان.');
  });

  it('says which subject it took when it skips the latest one', () => {
    const egypt = ask(emptyConversationState(), 'كم عدد سكان مصر؟', 'u1');
    const gold = ask(egypt.next, 'كم سعر الذهب اليوم؟', 'u2');
    const area = ask(gold.next, 'وما مساحتها؟', 'u3');
    expect(area.query).toBe('مساحة مصر');
    expect(area.assumption).toBe('فهمتُ أن المقصود مصر.');
    const back = ask(ask(gold.next, 'ما عاصمة اليابان؟', 'u3').next, 'وكم سعره؟', 'u4');
    expect(back.query).toBe('سعر الذهب اليوم');
    expect(back.assumption).toBe('فهمتُ أن المقصود الذهب.');
  });

  it('keeps the latest subject when it fits, and asks when nothing said so far fits', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const egypt = ask(japan.next, 'كم عدد سكان مصر؟', 'u2');
    const area = ask(egypt.next, 'وما مساحتها؟', 'u3');
    expect(area.query).toBe('مساحة مصر');
    expect(area.assumption).toBeNull();
    const gold = ask(emptyConversationState(), 'كم سعر الذهب اليوم؟', 'u1');
    const lost = ask(gold.next, 'وكم عدد سكانها؟', 'u2');
    expect(lost.type).toBe('ambiguous');
    expect(lost.needs).toBe('missing_reference');
    expect(lost.query).toBeNull();
  });

  it('leans past an arithmetic turn to the subject before it', () => {
    const japan = ask(emptyConversationState(), 'ما عاصمة اليابان؟', 'u1');
    const sum = ask(japan.next, 'كم يساوي 15 ضرب 23؟', 'u2');
    expect(ask(sum.next, 'وكم عدد سكانها؟', 'u3').query).toBe('عدد سكان عاصمة اليابان');
    const einstein = ask(emptyConversationState(), 'من هو ألبرت أينشتاين؟', 'u1');
    const two = ask(einstein.next, 'كم يساوي 2+2؟', 'u2');
    expect(ask(two.next, 'ونيوتن؟', 'u3').query).toBe('من هو نيوتن؟');
    const born = ask(two.next, 'ومتى ولد؟', 'u3');
    expect(born.query).toBe('متى ولد ألبرت أينشتاين');
    expect(born.assumption).toBe('فهمتُ أن المقصود ألبرت أينشتاين.');
  });

  it('keeps a private subject private when it is the one reached', () => {
    const memory = ask(emptyConversationState(), 'من ذاكرتي، ما مدينتي المفضلة؟', 'u1');
    const sum = ask(memory.next, 'كم يساوي 2+2؟', 'u2');
    expect(ask(sum.next, 'وكم عدد سكانها؟', 'u3').query).toBeNull();
  });
});

describe('conversation state v2: one-letter typos in closed word lists', () => {
  it('reads "tomorow" in the real request rq036 as tomorrow', () => {
    const turn = ask(emptyConversationState(), 'find train teckit from glasgow to london tomorow', 'u1');
    expect(turn.time).toBe('tomorrow');
    expect(turn.corrected).toEqual([{ from: 'tomorow', to: 'tomorrow' }]);
    expect(turn.query).toContain('tomorrow');
  });

  it('reads a typo in an edit field, an ordinal, a correction verb and a one-word message', () => {
    const reminder = ask(emptyConversationState(), 'ذكّرني بموعد الطبيب يوم الخميس الساعة 5 مساءً', 'u1');
    const edit = ask(reminder.next, 'عدّل الاتريخ فقط إلى الجمعة', 'u2');
    expect(edit.type).toBe('field_edit');
    expect(edit.edit?.field).toBe('date');
    expect(edit.query).toBeNull();
    const cities = withHostResults(ask(emptyConversationState(), 'ما أكبر ثلاث مدن في اليابان؟', 'u1').next,
      [{ label: 'طوكيو', kind: 'place' }, { label: 'يوكوهاما', kind: 'place' }, { label: 'أوساكا', kind: 'place' }], 'a1');
    expect(ask(cities, 'افتح الاثلثة', 'u2').reference).toEqual({ index: 3, label: 'أوساكا' });
    const arsenal = ask(emptyConversationState(), "When is Arsenal's next match?", 'u1');
    const chelsea = ask(arsenal.next, 'I menat Chelsea', 'u2');
    expect(chelsea.type).toBe('correction');
    expect(chelsea.query).toBe('next match of Chelsea');
    expect(ask(emptyConversationState(), 'مربحا', 'u1').type).toBe('small_talk');
    expect(ask(ask(emptyConversationState(), 'ما هو الذكاء الاصطناعي؟', 'u1').next, 'كجودل', 'u2').edit).toEqual({ field: 'format', value: 'table' });
  });

  it('never corrects names, property words, plurals, adjectives or ordinals with no list on screen', () => {
    expect(ask(emptyConversationState(), 'ما هي عجائب الدنيا السبع؟', 'u1').corrected).toBeUndefined();
    const daily = ask(emptyConversationState(), 'التقرير اليومي للمبيعات', 'u1');
    expect(daily.corrected).toBeUndefined();
    expect(daily.time).toBeNull();
    const augusta = ask(emptyConversationState(), 'weather in Augusta', 'u1');
    expect(augusta.entity).toBe('Augusta');
    expect(augusta.time).toBeNull();
    expect(ask(emptyConversationState(), 'كم عدد سكان الغمرب؟', 'u1').entity).toBe('الغمرب');
    expect(ask(emptyConversationState(), 'ما معنى مسامحة؟', 'u1').corrected).toBeUndefined();
    const cities = withHostResults(ask(emptyConversationState(), 'ما أكبر ثلاث مدن في اليابان؟', 'u1').next,
      [{ label: 'طوكيو', kind: 'place' }, { label: 'يوكوهاما', kind: 'place' }], 'a1');
    expect(ask(cities, 'how many seconds in a day', 'u2').type).not.toBe('reference');
  });
});
