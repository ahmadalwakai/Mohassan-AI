import { describe, expect, it } from 'vitest';
import {
  emptyConversationState, understandTurn, withAssistantAnswer, withPending,
} from '../apps/server/src/assistant/conversation-state.js';

function after(user: string) {
  return understandTurn(emptyConversationState(), user, 'user-1').next;
}

// User-provided regressions, the 2026-11-23 quality report and long-conversation script, and existing
// regression tests. The specific human-written excerpts below are from COD, Multi3WOZ and CANARD.
describe('conversation state turn decisions', () => {
  it.each([
    ['ما عاصمة مصر؟', 'new_request', 'explicit_subject'],
    ['شكرًا لك.', 'small_talk', 'social_message'],
    ['موافق.', 'confirmation', 'explicit_confirmation'],
  ])('classifies %s with evidence', (text, type, reason) => {
    const { decision } = understandTurn(emptyConversationState(), text, 'user-1');
    expect(decision).toMatchObject({ type, reasons: [reason], standalone: null, reference: null });
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it('classifies each submission by its host-bound pending step', () => {
    // COD Arabic test dialogues 2_00101 and 21_00015.
    const answer = 'أريد السفر إلى بورتلاند.';
    const state = withPending(after('مساء الخير، اريد حجز 3 تذاكر ذهاب فقط على خطوط  ساوثويست الجوية من فضلك.'),
      { kind: 'question_card', id: 'card-1', fields: ['place'] });
    const { decision } = understandTurn(state, answer, 'user-2', { boundAnswer: true });
    expect(decision).toMatchObject({ type: 'card_answer', confidence: 1, reasons: ['pending_question'], standalone: null });
    expect(understandTurn(emptyConversationState(), answer, 'user-2').decision.type).toBe('new_request');

    const login = withPending(state, { kind: 'sign_in', id: 'login-1' });
    expect(understandTurn(login, 'موافق.', 'user-2', { boundAnswer: true }).decision.type).toBe('card_answer');
    const approval = withPending(login, { kind: 'approval', id: 'approve-1' });
    expect(understandTurn(approval, 'موافق.', 'user-2', { boundAnswer: true }).decision.type).toBe('confirmation');
  });

  it('distinguishes correcting the entity from changing the language or level of detail', () => {
    // The earlier public follow-up test and the owner development plan show these correction and refinement forms.
    const correction = understandTurn(after('متى مباراة الهلال؟'), 'لا، أقصد النصر', 'user-2').decision;
    expect(correction).toMatchObject({ type: 'correction', reasons: ['explicit_correction'],
      reference: { text: 'الهلال', turnId: 'user-1' }, standalone: 'متى مباراة النصر؟', questionType: 'when' });
    const topic = after('ما هو الذكاء الاصطناعي؟');
    for (const text of ['بالإنجليزي', 'اشرح أكثر', 'اختصر جوابك السابق في جملة واحدة']) {
      expect(understandTurn(topic, text, 'user-2').decision).toMatchObject({ type: 'refinement', reasons: ['answer_reformulation'],
        reference: { text: 'الذكاء الاصطناعي', turnId: 'user-1' } });
    }
  });

  it('uses the first named founder from the assistant answer for an elliptical when question', () => {
    const state = withAssistantAnswer(after('من هو مؤسس شركة مايكروسوفت؟'),
      'تأسست شركة مايكروسوفت العملاقة من قبل بيل غيتس وبول ألين في 4 نيسان من عام 1975م.', 'assistant-1');
    const decision = understandTurn(state, 'متى ولد؟', 'user-2').decision;
    expect(decision).toMatchObject({ type: 'follow_up', reasons: ['elliptical_question', 'compatible_entity'],
      reference: { text: 'بيل غيتس', kind: 'person', role: 'assistant', turnId: 'assistant-1' },
      standalone: 'متى ولد بيل غيتس؟', questionType: 'when' });
  });

  it('keeps the reason question and its pronoun refers to the capital in the visible answer', () => {
    const state = withAssistantAnswer(after('ما عاصمة مصر؟'),
      'مصر دولة عربية تقع في الركن الشمالي الشرقي من أفريقيا. عاصمة مصر هي القاهرة.', 'assistant-1');
    expect(understandTurn(state, 'لماذا هي العاصمة؟', 'user-2').decision).toMatchObject({
      type: 'follow_up', reasons: ['explicit_reference', 'compatible_entity'], questionType: 'why',
      reference: { text: 'القاهرة', kind: 'place', role: 'assistant', turnId: 'assistant-1' },
      standalone: 'لماذا القاهرة العاصمة؟',
    });
  });

  it('substitutes the river named in the answer for an Arabic possessive', () => {
    const state = withAssistantAnswer(after('ما هو أطول نهر في العالم؟'), 'نهر النيل: أطول أنهار العالم.', 'assistant-1');
    expect(understandTurn(state, 'وكم طوله؟', 'user-2').decision).toMatchObject({
      type: 'follow_up', reference: { text: 'نهر النيل', role: 'assistant' },
      standalone: 'كم طول نهر النيل؟', questionType: 'how_much',
    });
  });

  it.each([
    ['What is the capital of France?', 'How many people live there?', 'France', 'How many people live in France?', 'how_many'],
    ['What is the capital of France?', 'the same', 'France', 'What is the capital of France?', 'what'],
    ['ما عاصمة مصر؟', 'نفس الشي', 'مصر', 'ما عاصمة مصر؟', 'what'],
  ])('rewrites the existing follow-up %s / %s with its context', (initial, followup, entity, standalone, questionType) => {
    expect(understandTurn(after(initial), followup, 'user-2').decision).toMatchObject({
      type: 'follow_up', reference: { text: entity, role: 'user', turnId: 'user-1' }, standalone, questionType,
    });
  });

  it('completes bare property fragments only when there is a compatible entity', () => {
    // The fragments are already exercised by assistant-request-scope.test.ts and assistant-image-messages.test.ts.
    expect(understandTurn(after('What is the capital of France?'), 'And the address?', 'user-2').decision).toMatchObject({
      type: 'follow_up', standalone: 'What is the address of France?', questionType: 'what',
      reference: { text: 'France', kind: 'place' },
    });
    expect(understandTurn(after('كم سعر الذهب؟'), 'كم السعر؟', 'user-2').decision).toMatchObject({
      type: 'follow_up', standalone: 'كم سعر الذهب؟', questionType: 'how_much', reference: { text: 'الذهب' },
    });
    expect(understandTurn(after('ما عاصمة اليابان؟'), 'كم السعر؟', 'user-2').decision).toMatchObject({
      type: 'follow_up', standalone: null, reference: null,
    });
  });

  it.each([
    ['ما عنوان ورقم هاتف هذا المطعم ؟', 'Mono', 'ما عنوان ورقم هاتف Mono؟', 'what'],
    ['كم تكلفة الليلة الواحدة ؟', 'Pandora After 80s', 'كم تكلفة الليلة الواحدة في Pandora After 80s؟', 'how_much'],
    ['ماعنوانه ورقم الهاتف ؟', 'Bun Cha Vietnamese', 'ما عنوان Bun Cha Vietnamese ورقم الهاتف؟', 'what'],
    ['What was this show about?', 'Blunt Talk', 'What was Blunt Talk about?', 'what'],
  ] as const)('projects the observed nominal reference in %s', (question, name, standalone, questionType) => {
    // Frozen development excerpts from Arabic-TOD and CANARD; each name appeared in the previous visible answer.
    const state = { ...emptyConversationState(),
      entities: [{ text: name, kind: 'other' as const, salience: 0.9, turnId: 'assistant-1', role: 'assistant' as const }] };
    expect(understandTurn(state, question, 'user-2').decision).toMatchObject({
      type: 'follow_up', questionType, reference: { text: name, role: 'assistant' }, standalone,
    });
  });

  it('matches a previously named person for an explicit return', () => {
    const state = withAssistantAnswer(after('من هو ألبرت أينشتاين؟'), 'ألبرت أينشتاين عالم فيزياء.', 'assistant-1');
    expect(understandTurn(state, 'ارجع إلى أينشتاين: أين ولد؟', 'user-2').decision).toMatchObject({
      type: 'follow_up', reference: { text: 'ألبرت أينشتاين', kind: 'person' },
      standalone: 'أين ولد ألبرت أينشتاين؟', questionType: 'where',
    });
  });

  it.each([
    ['Did she stay successful?', 'Lillie Langtry', 'person', 'Did Lillie Langtry stay successful?', 'yes_no'],
    ['What songs did they sing?', 'The Tragically Hip', 'organization', 'What songs did The Tragically Hip sing?', 'what'],
    ['Was that movie a success?', 'Harry Potter', 'other', 'Was Harry Potter a success?', 'yes_no'],
  ] as const)('uses the named antecedent in the CANARD excerpt %s', (question, name, kind, standalone, questionType) => {
    const state = { ...emptyConversationState(),
      entities: [{ text: name, kind, salience: 1, turnId: 'assistant-1', role: 'assistant' as const }] };
    expect(understandTurn(state, question, 'user-2').decision).toMatchObject({
      type: 'follow_up', reference: { text: name, kind }, standalone, questionType,
    });
  });

  it('reports each entity inserted for separate pronouns', () => {
    // CANARD test dialogue C_0aaa843df0bd467b96e5a496fc0b033d_1.
    const state = { ...emptyConversationState(), entities: [
      { text: 'FSB', kind: 'organization' as const, salience: 1, role: 'assistant' as const, turnId: 'assistant-1', publicLookup: true },
      { text: 'Anna Politkovskaya', kind: 'person' as const, salience: 0.82, role: 'assistant' as const, turnId: 'assistant-2' },
    ] };
    expect(understandTurn(state, 'How did they target her email?', 'user-2').decision).toMatchObject({
      standalone: "How did FSB target Anna Politkovskaya's email?", reference: state.entities[0],
      references: state.entities, questionType: 'how',
    });
  });

  it('uses distinct people for a plural reference even when the answer contains an alias', () => {
    // CANARD test dialogue C_e6af1e489b6d4cc7962abc787e42f116_0.
    const earlier = { kind: 'person' as const, turnId: 'assistant-1', role: 'assistant' as const };
    const state = { ...emptyConversationState(), entities: [
      { ...earlier, text: 'Lillie Langtry', salience: 0.95 },
      { ...earlier, text: 'Lillie', aliasOf: 'Lillie Langtry', salience: 0.91 },
      { ...earlier, text: 'Prince', salience: 0.89 },
    ] };
    expect(understandTurn(state, 'How did they meet?', 'user-2').decision).toMatchObject({
      standalone: 'How did Lillie Langtry and Prince meet?', references: [state.entities[0], state.entities[2]],
    });
  });

  it('recognizes the interrogative after a polite Arabic lead', () => {
    // Multi3WOZ Arabic dialogue MUL0575.json.
    expect(understandTurn(emptyConversationState(), 'من فضلك أين يقع برج خليفة ؟', 'user-1').decision).toMatchObject({
      type: 'new_request', standalone: null, questionType: 'where',
    });
  });

  it('keeps an explicit new subject and leaves an unresolved earlier claim unprojected', () => {
    const state = after('What is the capital of France?');
    expect(understandTurn(state, 'What is the boiling point of water in Fahrenheit?', 'user-2').decision).toMatchObject({
      type: 'new_request', standalone: null, questionType: 'what',
    });
    expect(understandTurn(state, 'why?', 'user-3').decision).toMatchObject({
      type: 'follow_up', standalone: null, questionType: 'why',
    });
  });
});
