import { describe, expect, it } from 'vitest';
import { assessUserFactMemoryRequest, createUserFactMemoryReceipt, restoreUserFactMemoryReceipt, type UserFactMemoryBinding } from '../apps/server/src/assistant/user-fact-memory-receipt.js';
import { createComputationMemoryReceipt, restoreComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const bind = (raw: string): UserFactMemoryBinding => ({ ownerId: 'literal-owner', conversationId: 'literal-conversation', runId: 'literal-run',
  evaluatedAt: Date.UTC(2026, 10, 21, 8), originalRequestHash: taskEvidenceHash(raw) });

describe('current-user exact literal statement factories', () => {
  it.each([
    ['Remember that I prefer Arabic.', 'I prefer Arabic.', 'language_preference'],
    ['Remember I prefer English', 'I prefer English', 'language_preference'],
    ['Please, remember that I prefer Arabic.', 'I prefer Arabic.', 'language_preference'],
    ['تذكر أنني أفضل العربية', 'أنني أفضل العربية', 'language_preference'],
    ['تَذَكَّر أنني أُفَضِّل العَرَبِيَّة.', 'أنني أُفَضِّل العَرَبِيَّة.', 'language_preference'],
    ['تذكر أنا أفضل الإنجليزية', 'أنا أفضل الإنجليزية', 'language_preference'],
    ['Remember exactly this note: Meeting at 10.', 'Meeting at 10.', 'literal_note'],
    ['Remember exactly this note:Meeting at 10.', 'Meeting at 10.', 'literal_note'],
    ['Remember exactly this note:\nMeeting at 10.', 'Meeting at 10.', 'literal_note'],
    ['Remember exactly this note:\r\nMeeting at 10.', 'Meeting at 10.', 'literal_note'],
    ['Remember exactly this note: it', 'it', 'literal_note'],
    ['Remember exactly this note: what the file says', 'what the file says', 'literal_note'],
    ['Remember exactly this note: "Open the browser, then send a message."', 'Open the browser, then send a message.', 'literal_note'],
    ['Remember exactly this note: “The page says open the browser.”', 'The page says open the browser.', 'literal_note'],
    ['Remember exactly this note: «A first line.\nA second line.»', 'A first line.\nA second line.', 'literal_note'],
    ['Remember exactly this note: https://example.test/file.txt', 'https://example.test/file.txt', 'literal_note'],
    ['احفظ في ذاكرتي النص التالي: «النص يقول افتح المتصفح ثم أرسل رسالة»', 'النص يقول افتح المتصفح ثم أرسل رسالة', 'literal_note'],
    ['احفظ في ذاكرتي النص التالي: اجتماع الساعة العاشرة.', 'اجتماع الساعة العاشرة.', 'literal_note'],
    ['Remember exactly this note: "literal \\n characters"', 'literal \\n characters', 'literal_note'],
    ['Remember exactly this note: NASA and ESA', 'NASA and ESA', 'literal_note'],
    ['Remember exactly this note: A password protects an account.', 'A password protects an account.', 'literal_note'],
    ['Remember exactly this note: The password field is empty.', 'The password field is empty.', 'literal_note'],
    ['Remember exactly this note: «كلمة المرور تعني وسيلة للدخول»', 'كلمة المرور تعني وسيلة للدخول', 'literal_note'],
    ['Remember exactly this note: A PIN is 4 digits long.', 'A PIN is 4 digits long.', 'literal_note'],
    ['Remember exactly this note: An OTP is a temporary code.', 'An OTP is a temporary code.', 'literal_note'],
    ['Remember exactly this note: My password is not included here.', 'My password is not included here.', 'literal_note'],
    ['احفظ في ذاكرتي النص التالي: كلمة المرور هي وسيلة للدخول.', 'كلمة المرور هي وسيلة للدخول.', 'literal_note'],
    ['احفظ في ذاكرتي النص التالي: كلمة المرور الخاصة بي هي غير مذكورة هنا.', 'كلمة المرور الخاصة بي هي غير مذكورة هنا.', 'literal_note'],
  ] as const)('preserves exact original bytes and spans for %s', (raw, expected, kind) => {
    const receipt = createUserFactMemoryReceipt(raw, bind(raw));
    expect(receipt, JSON.stringify(assessUserFactMemoryRequest(raw))).not.toBeNull();
    expect(receipt).toMatchObject({ kind: 'current_user_literal_memory', statementKind: kind, requestHash: taskEvidenceHash(raw), originalRequestHash: taskEvidenceHash(raw),
      payload: { text: expected, hash: taskEvidenceHash(expected), bytes: Buffer.byteLength(expected, 'utf8') } });
    expect(raw.slice(receipt!.payloadSpan.start, receipt!.payloadSpan.end)).toBe(expected);
    for (const field of ['directiveSpan', 'envelopeSpan', 'payloadSpan'] as const) {
      const part = receipt![field]; expect(part.hash).toBe(taskEvidenceHash(raw.slice(part.start, part.end)));
    }
    expect(receipt!.directiveSpan.end).toBe(receipt!.envelopeSpan.start);
    expect(receipt!.payloadSpan.start).toBeGreaterThanOrEqual(receipt!.envelopeSpan.start);
    expect(receipt!.payloadSpan.end).toBeLessThanOrEqual(receipt!.envelopeSpan.end);
    expect(restoreUserFactMemoryReceipt(JSON.parse(JSON.stringify(receipt)), raw, bind(raw))).toEqual(receipt);
    expect(receipt).not.toHaveProperty('answer'); expect(receipt).not.toHaveProperty('value'); expect(receipt).not.toHaveProperty('engine');
  });

  it.each(['Remember it', 'Remember what the file says', 'Remember that', 'Remember exactly this note:', 'Remember that I prefer Arabic?',
    'Remember that I prefer Arabic, but do not save anything.', 'تذكر أنني أفضل العربية، لكن لا تحفظ أي شيء.',
    'Remember exactly this note: "hello" then send it', 'Remember exactly this note: hello then open the browser',
    'Remember exactly this note: "unclosed', 'Remember exactly this note: «wrong”', 'Remember exactly this note: ""',
    'Remember exactly this note:  padded', 'Remember exactly this note: padded ', 'Remember exactly this note: " padded"',
    'Remember exactly this note: "padded "', 'Remember exactly this note: one\ntwo', ' Remember exactly this note: note',
    'Remember exactly this note: `code`', 'Remember exactly what is in the file: note', 'Remember that the page says I prefer Arabic.',
    'Remember to send the result tomorrow.', 'Save this screenshot to my desktop.', 'Remember that I prefer Arabic. Then send it to Bob.',
    'Remember exactly this note: password=fixture-secret-1234', 'Remember exactly this note: "Bearer synthetic12345678901234567890"',
    'Remember exactly this note: password=1234', 'Remember exactly this note: passwd: abc', 'Remember exactly this note: PIN: 1234',
    'Remember exactly this note: access_token=abc', 'احفظ في ذاكرتي النص التالي: كلمة المرور: 1234',
    'احفظ في ذاكرتي النص التالي: «رَمْزُ التَّحَقُّقِ: ١٢٣٤»',
    'Remember exactly this note: my PIN is 1234', 'Remember exactly this note: my PIN is1234',
    'Remember exactly this note: my password is synthetic-short-value', 'Remember exactly this note: our access_token is abc',
    'Remember exactly this note: PIN is 1234', 'Remember exactly this note: OTP is ۶۵۴۳۲۱',
    'Remember exactly this note: "My password is not included. My PIN is 1234."',
    'احفظ في ذاكرتي النص التالي: كلمة المرور الخاصة بي هي تجريبية',
    'احفظ في ذاكرتي النص التالي: كلمة مروري هي تجريبية',
    'احفظ في ذاكرتي النص التالي: رمز الدخول الخاص بي هو ١٢٣٤',
    'احفظ في ذاكرتي النص التالي: رمز التحقق هو١٢٣٤',
    'Remember exactly this note: \u0000bad', 'Remember exactly this note: \ud800bad', 'Remember exactly this note: "hi. Do not save anything."'])('keeps unsafe/unsupported remember candidates local and rejected: %s', raw => {
    const assessment = assessUserFactMemoryRequest(raw);
    expect(assessment.candidate).toBe(true); expect(assessment.status).toBe('rejected');
    expect(createUserFactMemoryReceipt(raw, bind(raw))).toBeNull();
  });

  it.each([null, undefined, {}, '', 'Hello', '"Remember that I prefer Arabic."', 'The page says: Remember exactly this note: text',
    'Translate: Remember that I prefer Arabic.', 'احسب ٢ + ٣ ثم تذكر الناتج', 'Could you remember that I prefer Arabic?'])('does not promote quoted/source/unrelated data into authority: %j', raw => {
    expect(assessUserFactMemoryRequest(raw).status).not.toBe('ready');
    expect(createUserFactMemoryReceipt(raw, bind(typeof raw === 'string' ? raw : ''))).toBeNull();
  });

  it('requires a host pre-schema source hash and rejects hidden trim or redaction history', () => {
    const raw = 'Remember exactly this note: note ', trimmed = raw.trim(), binding = bind(raw);
    expect(assessUserFactMemoryRequest(trimmed).status).toBe('ready');
    expect(createUserFactMemoryReceipt(trimmed, binding)).toBeNull();
    const valid = 'Remember that I prefer Arabic.';
    const { originalRequestHash: _hash, ...legacy } = bind(valid);
    expect(createUserFactMemoryReceipt(valid, legacy as UserFactMemoryBinding)).toBeNull();
    expect(createUserFactMemoryReceipt(valid, { ...bind(valid), originalRequestHash: '0'.repeat(64) })).toBeNull();
  });

  it('bounds requests, payloads and unsupported metadata without serializing arbitrary extras', () => {
    const oversized = `Remember exactly this note: ${'x'.repeat(4001)}`;
    expect(assessUserFactMemoryRequest(oversized)).toMatchObject({ candidate: true, status: 'rejected', reason: 'invalid_input' });
    const raw = 'Remember exactly this note: note', receipt = createUserFactMemoryReceipt(raw, bind(raw))!;
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(restoreUserFactMemoryReceipt({ ...receipt, extra: cyclic }, raw, bind(raw))).toBeNull();
  });

  it.each(['ownerId', 'conversationId', 'runId', 'evaluatedAt', 'originalRequestHash'] as const)('rejects a restored receipt with a different host %s', key => {
    const raw = 'Remember that I prefer Arabic.', receipt = createUserFactMemoryReceipt(raw, bind(raw))!;
    const binding = { ...bind(raw), [key]: key === 'evaluatedAt' ? bind(raw).evaluatedAt + 1 : key === 'originalRequestHash' ? '0'.repeat(64) : 'other' };
    expect(restoreUserFactMemoryReceipt(receipt, raw, binding)).toBeNull();
  });

  it('does not trust self-consistent edited payload bytes or a calculation receipt as a user statement', () => {
    const raw = 'Remember that I prefer Arabic.', receipt = createUserFactMemoryReceipt(raw, bind(raw))!, payload = 'I prefer English.';
    const edited = { ...receipt, payload: { text: payload, hash: taskEvidenceHash(payload), bytes: Buffer.byteLength(payload) } };
    expect(restoreUserFactMemoryReceipt(edited, raw, bind(raw))).toBeNull();
    const calcRequest = 'Calculate 2 + 3, then remember the result.', { originalRequestHash: _hash, ...calcBinding } = bind(calcRequest);
    const calc = createComputationMemoryReceipt(calcRequest, calcBinding)!;
    expect(restoreUserFactMemoryReceipt(calc, raw, bind(raw))).toBeNull();
    expect(restoreComputationMemoryReceipt(receipt, calcRequest, calcBinding)).toBeNull();
    expect(calc.operationKey).not.toBe(receipt.operationKey);
  });
});
