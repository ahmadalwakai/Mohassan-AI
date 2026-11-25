import { describe, expect, it } from 'vitest';
import { entityAgreement, questionEntities, type EntityEvidence } from '../apps/server/src/assistant/selection/entity.js';

const check = (question: string, pageTitle: string, text: string, rest?: Partial<EntityEvidence>) =>
  entityAgreement(questionEntities(question), { pageTitle, text, ...rest }).agreement;

describe('selection entity agreement', () => {
  it('binds an inventor to the actual object of the invention', () => {
    const question = 'Who invented the telephone?';
    expect(check(question, 'Telephone', 'A communication device for sailing vessels, called telephone, was invented by Captain John Taylor in 1844.')).toBe('conflict');
    expect(check(question, 'Telephone', 'The telephone was common before Thomas Edison invented the phonograph.')).toBe('conflict');
    expect(check(question, 'Telephone', 'Alexander Graham Bell invented the first practical telephone.')).toBe('match');
    expect(check(question, 'Telephone', 'The electric telephone was invented by Alexander Graham Bell.')).toBe('match');
    expect(check(question, 'Telephone', 'Alexander Graham Bell was awarded a patent for the electric telephone.')).toBe('match');
    expect(check('من اخترع الهاتف؟', 'هاتف', 'اخترع ألكسندر غراهام بيل الهاتف.')).toBe('match');
    expect(check('من اخترع الهاتف؟', 'هاتف', 'اخترع جون تايلور جهازا أسماه الهاتف.')).toBe('conflict');
    expect(check('من اخترع الهاتف؟', 'هاتف', 'الهاتف اخترعه ألكسندر غراهام بيل.')).toBe('match');
  });

  it('requires the attribute to be owned by the requested person', () => {
    const en = 'How old is Messi?';
    const ar = 'كم عمر ميسي؟';
    expect(check(en, 'Lionel Messi', "Messi's son is 12 years old.")).toBe('conflict');
    expect(check(en, 'Lionel Messi', "The age of Messi's son is 12 years.")).toBe('conflict');
    expect(check(en, 'Lionel Messi', 'Messi stated his son is 12 years old.')).toBe('conflict');
    expect(check(en, 'Lionel Messi', 'Messi is 39 years old.')).toBe('match');
    expect(check(en, 'Lionel Messi', 'Messi joined Barcelona at the age of 13.')).toBe('conflict');
    expect(check(ar, 'ليونيل ميسي', 'شارك ميسي وابنه تياغو البالغ من العمر عاماً واحداً في حملة دعائية.')).toBe('conflict');
    expect(check(ar, 'ليونيل ميسي', 'الميلاد | 24 يونيو 1987 (العمر 39 سنة) روساريو، الأرجنتين', { kind: 'table' })).toBe('inferred');
    expect(check(ar, 'ليونيل ميسي', 'يبلغ عمر ابن ميسي 12 سنة.')).toBe('conflict');
  });

  it('binds pronouns to a matching page title and checks prior antecedents', () => {
    const question = 'When was Messi born?';
    const subject = 'Lionel Messi';
    const line = 'He was born in 1987.';
    expect(check(question, subject, line, { previousText: 'Lionel Messi played as a forward.' })).toBe('inferred');
    expect(check(question, subject, line, { previousText: 'John Taylor became his agent.' })).toBe('conflict');
    expect(check(question, 'John Taylor', line)).toBe('unknown');
    expect(check(question, subject, 'Lionel Messi joined a club in 2017.')).toBe('conflict');
    expect(check('متى استقلت الجزائر؟', 'الجزائر', 'استقلت عام 1962.')).toBe('inferred');
    expect(check('متى استقلت الجزائر؟', 'فرنسا', 'استقلت عام 1962.')).toBe('unknown');
    expect(check('متى استقلت الجزائر؟', 'الجزائر', 'وتم الإعلان عن استقلال الجزائر يوم 3 جويلية 1962.')).toBe('match');
    expect(check('متى استقلت الجزائر؟', 'الجزائر', 'خرج المتظاهرون في 1960 يحملون الأعلام الوطنية ويهتفون باستقلال الجزائر.')).toBe('conflict');
    expect(check('When did the Berlin Wall fall?', 'Berlin Wall', 'The Berlin Wall fell into disrepair in 1965.')).toBe('conflict');
  });

  it('requires the causal effect and keeps general and scoped phenomena distinct', () => {
    expect(check('Why is the sky blue?', 'Sky', 'The sky is sometimes obscured because clouds pass beneath it.')).toBe('conflict');
    expect(check('Why is the sky blue?', 'Sky', 'The sky appears blue because blue light scatters.')).toBe('match');
    expect(check('ما سبب زرقة السماء؟', 'السماء', 'تبدو السماء زرقاء بسبب تشتت رايلي.')).toBe('match');
    expect(check('Why does rain fall?', 'Rain', 'Within Asia, rain falls in the monsoon season due to moving air.')).toBe('conflict');
    expect(check('Why is rainfall favored across southern Asia during the monsoon?', 'Rain', 'Within Asia, rainfall is favored across its southern portion due to the monsoon advecting moisture.')).toBe('match');
    expect(check('لماذا تسقط الأمطار شتاء في مناخ البحر المتوسط؟', 'مطر', 'في نظام البحر المتوسط تسقط الأمطار في فصل الشتاء بسبب هبوب الرياح الغربية.')).toBe('match');
    expect(check('What caused World War II?', 'World War II', 'World War II led to the creation of the United Nations.')).toBe('unknown');
    expect(check('What caused World War II?', 'World War II', 'The invasion of Poland led to World War II.')).toBe('match');
  });

  it('requires the requested comparison between both participants', () => {
    const question = 'Which is larger, Mars or Earth?';
    expect(check(question, 'Mars', 'Mars is larger than Mercury, while Earth is blue.')).toBe('conflict');
    expect(check(question, 'Mars', 'Earth is faster than Mars.')).toBe('conflict');
    expect(check(question, 'Mars', 'Earth is larger than Mars.')).toBe('match');
    expect(check('Which is larger by land area, Africa or Asia?', 'Africa', "Africa is the world's second-largest and second-most populous continent after Asia.")).toBe('match');
    expect(check('أيهما أكبر مساحة اليابان أم بريطانيا؟', 'اليابان', 'تزيد مساحتها عن مساحة بريطانيا.')).toBe('match');
    expect(check('أيهما أكبر مساحة اليابان أم بريطانيا؟', 'ألمانيا', 'تزيد مساحتها عن مساحة بريطانيا.')).toBe('conflict');
  });

  it('distinguishes definitions and third-party mentions', () => {
    expect(check('What is a telephone?', 'Telephone', 'A telephone is a telecommunications device.')).toBe('match');
    expect(check('What is a telephone?', 'Telephone', 'A telegraph is a different device from a telephone.')).toBe('unknown');
    expect(check('What is the capital of Japan?', 'Japan', 'Ireland to Japan via Dublin, the capital of Ireland.')).toBe('conflict');
    expect(check('What is the capital of Japan?', 'Japan', 'Tokyo is the capital of Japan.')).toBe('match');
  });
});
