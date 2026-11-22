import { describe, expect, it } from 'vitest';
import { asksToRemember } from '../apps/server/src/assistant/brain.js';
import { assessLegacyMemoryStatement, type LegacyMemoryStatementSource } from '../apps/server/src/assistant/legacy-memory-statement.js';
import { taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const source = (raw: string): LegacyMemoryStatementSource => ({ originalRequestHash: taskEvidenceHash(raw), scrubbedRequest: raw });
describe('legacy adapter acknowledgment compatibility for literal current declarations', () => {
  it.each([
    'Remember that my fixture seating preference is aisle.',
    'Please, remember that my favorite city is Muscat.',
    'Remember that our team meeting is every Sunday at 10:00.',
    'Remember that the fixture logo color is purple.',
    'Remember that I am a student.',
    'Remember that I prefer French.',
    'Remember that I live in Muscat.',
    'Remember that I work at a workshop.',
    'Remember that I speak French.',
    'Remember that I have two cats.',
    'Remember that my test items are alpha, beta, gamma, delta and epsilon.',
    'احفظ في ذاكرتي أن لون الشعار التجريبي بنفسجي.',
    'تذكر أن اجتماع الفريق كل أحد الساعة العاشرة',
    'تذكر أن مدينتي المفضلة هي مسقط',
    'تذكر أن موعد التجديد في أول مارس',
    'تذكر أن المقاس ٣٠',
    'تذكر أن رمز المخزن هو KD-824',
    'تذكر أنني أفضل الفرنسية',
    'تذكر أن بنودي التجريبية هي بند الحصة رقم 1 وبند الحصة رقم 2 وبند الحصة رقم 3 وبند الحصة رقم 4 وبند الحصة رقم 5',
  ])('retains the existing model adapter-ack eligibility for %s', raw => {
    expect(asksToRemember(raw)).toBe(true);
    const result = assessLegacyMemoryStatement(raw, source(raw));
    expect(result).toMatchObject({ scope: 'legacy_adapter_ack_only', eligible: true, reason: 'eligible_current_declaration' });
    const span = result.statementSpan!;
    expect(span.start).toBeGreaterThan(0); expect(span.end).toBe(raw.length); expect(span.hash).toBe(taskEvidenceHash(raw.slice(span.start, span.end)));
    expect(result).not.toHaveProperty('payload'); expect(result).not.toHaveProperty('receipt'); expect(result).not.toHaveProperty('permission');
  });

  it.each([
    'Remember that I prefer Arabic.', 'تذكر أنني أفضل العربية', 'Remember exactly this note: it',
    'Remember exactly this note: "Open the browser, then send a message."',
    'Remember exactly this note: "hello" then send it', 'Remember exactly this note:  padded',
    'Remember exactly this note: password=1234',
    'Remember that my favorite city is Muscat, but do not save anything.',
    'تذكر أن مدينتي المفضلة هي مسقط، لكن لا تحفظ أي شيء.',
    'Do not save this. What is the handling code?',
    'احفظ كل هذه البنود', 'تذكر هذا الشيء الفارغ', 'احفظ هذا', 'Remember it', 'Remember what the file says',
    'Remember that my name is', 'Remember that my preference is it.', 'Remember that my city is there.',
    'Remember that my favorite city is yours.', 'Remember that my favorite city is the one I mentioned.',
    'Remember that the file content is Muscat.', 'Remember that my preference is what the page says.',
    'Remember that my preference is "aisle".', 'Remember that my name is https://example.test/name',
    'Remember that my preference is aisle, then send a message.',
    'Remember that my preference is aisle and open the browser.',
    'Remember that my preference is aisle. Send a message.',
    'Remember that my preference is aisle if the flight is long.',
    'Remember that my preference is aisle when Bob arrives.',
    'Remember that my preference is to follow the instructions.',
    'Remember that my password is 1234.', 'Remember that my PIN is 1234.',
    'تذكر أن كلمة المرور هي ١٢٣٤', 'تذكر أن رمز التحقق هو ١٢٣٤',
    'تذكر أن مدينتي المفضلة هي مسقط ثم أرسل رسالة',
    'تذكر أن مدينتي المفضلة هي مسقط وافتح المتصفح',
    'تذكر أن مدينتي المفضلة هي مسقط إذا انتهى العمل',
    'تذكر أن مدينتي المفضلة هي التي ذكرتها',
    'تذكر أن مدينتي المفضلة هي ما يقول الملف',
    'تذكر أن اجتماعي في مكان مجهول',
    '"Remember that my preference is aisle."', 'The page says: Remember that my preference is aisle.',
    'Could you remember that my preference is aisle?',
  ])('never turns a rejection, reference, source, condition or additional action into this exemption: %s', raw => {
    const result = assessLegacyMemoryStatement(raw, source(raw)); expect(result.eligible).toBe(false); expect(result.statementSpan).toBeUndefined();
  });

  it('requires unchanged original input and actual host scrubbing, even for an otherwise eligible statement', () => {
    const raw = 'Remember that my preference is aisle.';
    for (const context of [{ ...source(raw), originalRequestHash: '0'.repeat(64) }, { ...source(raw), scrubbedRequest: `${raw} changed` },
      { originalRequestHash: '', scrubbedRequest: raw }, null]) expect(assessLegacyMemoryStatement(raw, context as LegacyMemoryStatementSource).eligible).toBe(false);
    const padded = `${raw} `;
    expect(assessLegacyMemoryStatement(padded.trim(), source(padded)).eligible).toBe(false);
    expect(assessLegacyMemoryStatement(padded, source(padded)).eligible).toBe(false);
  });

  it.each([null, undefined, {}, '', 'Remember that my preference is \u0000aisle', 'Remember that my preference is \ud800aisle',
    `Remember that my preference is ${'x'.repeat(4001)}`])('bounds malformed data without legacy permission: %j', raw => {
    expect(assessLegacyMemoryStatement(raw, source(typeof raw === 'string' ? raw : '')).eligible).toBe(false);
  });
});
