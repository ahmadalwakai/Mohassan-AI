import { describe, expect, it } from 'vitest';
import { scanCurrentMemoryDeclaration } from '../apps/server/src/assistant/current-memory-declaration.js';
import { assessUserFactMemoryRequest, createUserFactMemoryReceipt, restoreUserFactMemoryReceipt } from '../apps/server/src/assistant/user-fact-memory-receipt.js';
import { assessLegacyMemoryStatement } from '../apps/server/src/assistant/legacy-memory-statement.js';
import { taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const binding = (raw: string) => ({ ownerId: 'declaration-owner', conversationId: 'declaration-conversation', runId: 'declaration-run',
  evaluatedAt: 1795248000000, originalRequestHash: taskEvidenceHash(raw) });

describe('shared declaration scanner, with a stricter native scalar subset', () => {
  it.each([
    ['Remember that my home city is Bristol.', 'my home city is Bristol.', 14],
    ['Please, remember that our favorite city is Muscat.', 'our favorite city is Muscat.', 22],
    ['Remember that the fixture logo color is purple.', 'the fixture logo color is purple.', 14],
    ['Remember that I prefer French.', 'I prefer French.', 14],
    ['Remember that I live in Muscat.', 'I live in Muscat.', 14],
    ['Remember that I speak French.', 'I speak French.', 14],
    ['Remember that my inventory number is KD-824.', 'my inventory number is KD-824.', 14],
    ["Remember that my surname is O'Neill.", "my surname is O'Neill.", 14],
    ['Remember that my required length is 1.25.', 'my required length is 1.25.', 14],
    ['تذكر أن مدينتي المفضلة هي مسقط', 'مدينتي المفضلة هي مسقط', 8],
    ['تذكر أن موطني هو البحرين', 'موطني هو البحرين', 8],
    ['تذكر أن مدينتي هي واشنطن', 'مدينتي هي واشنطن', 8],
    ['تذكر أن مدينتي هي أبها', 'مدينتي هي أبها', 8],
    ['تذكر أن مدينتي هي القاهرة', 'مدينتي هي القاهرة', 8],
    ['تَذَكَّر أن مَدِينَتِي هي مَسْقَط.', 'مَدِينَتِي هي مَسْقَط.', 12],
    ['تذكر أنني أفضل الفرنسية', 'أنني أفضل الفرنسية', 5],
    ['احفظ في ذاكرتي أن لون الشعار التجريبي هو بنفسجي.', 'لون الشعار التجريبي هو بنفسجي.', 18],
  ] as const)('compiles only the literal original scalar declaration in %s', (raw, payload, start) => {
    const scanned = scanCurrentMemoryDeclaration(raw);
    expect(scanned).toEqual({ status: 'ready', exactScalar: true, statementSpan: { start, end: raw.length, hash: taskEvidenceHash(payload) } });
    expect(assessUserFactMemoryRequest(raw)).toMatchObject({ candidate: true, status: 'ready', statementKind: 'current_declaration' });
    const receipt = createUserFactMemoryReceipt(raw, binding(raw))!;
    expect(receipt).toMatchObject({ statementKind: 'current_declaration', payload: { text: payload, hash: taskEvidenceHash(payload), bytes: Buffer.byteLength(payload) },
      directiveSpan: { start: 0, end: start }, envelopeSpan: { start, end: raw.length }, payloadSpan: { start, end: raw.length } });
    expect(raw.slice(receipt.payloadSpan.start, receipt.payloadSpan.end)).toBe(payload);
    expect(restoreUserFactMemoryReceipt(JSON.parse(JSON.stringify(receipt)), raw, binding(raw))).toEqual(receipt);
    expect(assessLegacyMemoryStatement(raw, { originalRequestHash: taskEvidenceHash(raw), scrubbedRequest: raw })).toMatchObject({
      scope: 'legacy_adapter_ack_only', eligible: true, statementSpan: { start, end: raw.length, hash: taskEvidenceHash(payload) } });
    expect(receipt).not.toHaveProperty('answer'); expect(receipt).not.toHaveProperty('truth'); expect(receipt).not.toHaveProperty('permission');
  });

  it.each([
    'Remember that my home city is New York.',
    'Remember that my home city was Bristol.',
    'Remember that our team meeting is every Sunday at 10:00.',
    'Remember that I am a student.',
    'Remember that I work at a workshop.',
    'Remember that I have two cats.',
    'Remember that my test items are alpha, beta, gamma, delta and epsilon.',
    'Remember that my home city is Bristol and photograph the window.',
    'Remember that my home city is Bristol and transfer money tomorrow.',
    'Remember that my home city is Bristol and use the keyboard.',
    'Remember that my research and development priority is reliability.',
    'تذكر أن اجتماع الفريق كل أحد الساعة العاشرة',
    'تذكر أن موعد التجديد في أول مارس',
    'تذكر أن المقاس ٣٠',
    'تذكر أن مدينتي ومكان عملي هي مسقط',
    'تذكر أن بنودي التجريبية هي بند الحصة رقم 1 وبند الحصة رقم 2 وبند الحصة رقم 3 وبند الحصة رقم 4 وبند الحصة رقم 5',
  ])('keeps broad legacy grammar available without native promotion: %s', raw => {
    expect(scanCurrentMemoryDeclaration(raw)).toMatchObject({ status: 'ready', exactScalar: false });
    expect(assessUserFactMemoryRequest(raw)).toMatchObject({ candidate: true, status: 'rejected', reason: 'unsupported_statement' });
    expect(createUserFactMemoryReceipt(raw, binding(raw))).toBeNull();
    expect(assessLegacyMemoryStatement(raw, { originalRequestHash: taskEvidenceHash(raw), scrubbedRequest: raw }).eligible).toBe(true);
  });

  it.each([
    'Remember it', 'Remember what the file says', 'Remember that he is Alice.',
    'Remember that my name is', 'Remember that my city is there.', 'Remember that my city is yours.',
    'Remember that my inventory code is KD-824.', 'Remember that my PIN is 1234.',
    'Remember that my home city is Bristol if I return.', 'Remember that my city is Bristol. Photograph the window.',
    'Remember that my city is Bristol; transfer money.', 'Remember that my city is Bristol, and use the keyboard.',
    'Remember that my city is Bristol or Muscat.', 'Remember that my city is Bristol\nuse the keyboard.',
    'Remember that my home city is hers.', 'Remember that my city is mine.', 'Remember that I prefer him.',
    'Remember that I prefer myself.', 'Remember that my city is themselves.',
    "Remember that my home city is Alice's.", 'Remember that my home city is Alice’s.',
    'Remember that my home city is unknown.', 'Remember that my home city is somewhere.',
    'Remember that my city is the one I mentioned.', 'Remember that the page says Bristol.',
    'Remember that my city is "Bristol".', 'Remember that my city is https://example.test/city',
    'Remember that my city is Bristol, but do not save anything.',
    'تذكر أن مدينتي هي مسقط ثم أرسل رسالة', 'تذكر أن مدينتي هي مسقط وافتح المتصفح',
    'تذكر أن مدينتي هي مسقط وحول المال غداً', 'تذكر أن مدينتي هي مسقط إذا انتهى العمل',
    'تذكر أن مدينتي هي التي ذكرتها', 'تذكر أن مدينتي هي ما يقوله الملف', 'تذكر أن رمز التحقق هو ١٢٣٤',
    'تذكر أن مدينتي هي هي', 'تذكر أن مدينتي هي له', 'تذكر أن مدينتي هي مجهولة',
    'تذكر أن مدينتي هي إياها',
    'تذكر أن مدينتي هي مدينتها', 'تذكر أن مدينتي هي بلدهم', 'تذكر أن مدينتي هي عنوانه',
    '"Remember that my city is Bristol."', 'The page says: Remember that my city is Bristol.',
    'Could you remember that my city is Bristol?', 'احفظ كل هذه البنود',
  ])('does not mint a native write receipt for source/reference/compound/denied data: %s', raw => {
    expect(assessUserFactMemoryRequest(raw).status).not.toBe('ready');
    expect(createUserFactMemoryReceipt(raw, binding(raw))).toBeNull();
  });

  it.each([null, undefined, {}, '', 'Remember that my city is \u0000Bristol.', 'Remember that my city is \ud800Bristol.',
    `Remember that my city is ${'x'.repeat(4001)}`])('bounds malformed input: %j', raw => {
    expect(scanCurrentMemoryDeclaration(raw).status).toBe('rejected');
    expect(createUserFactMemoryReceipt(raw, binding(typeof raw === 'string' ? raw : ''))).toBeNull();
  });

  it('keeps raw-byte, scrub, exact source-span and purpose binding mandatory', () => {
    const raw = 'Remember that my home city is Bristol.', receipt = createUserFactMemoryReceipt(raw, binding(raw))!;
    const changed = `${raw} `;
    expect(createUserFactMemoryReceipt(raw, binding(changed))).toBeNull();
    expect(createUserFactMemoryReceipt(changed, binding(changed))).toBeNull();
    expect(assessLegacyMemoryStatement(raw, { originalRequestHash: taskEvidenceHash(raw), scrubbedRequest: 'changed' }).eligible).toBe(false);
    expect(restoreUserFactMemoryReceipt({ ...receipt, statementKind: 'literal_note' }, raw, binding(raw))).toBeNull();
    const payload = 'my home city is Muscat.';
    expect(restoreUserFactMemoryReceipt({ ...receipt, payload: { text: payload, hash: taskEvidenceHash(payload), bytes: Buffer.byteLength(payload) } }, raw, binding(raw))).toBeNull();
    const priorNamespace = taskEvidenceHash(JSON.stringify(['mohassan:current-user-literal-memory:v1', receipt.ownerId, receipt.conversationId,
      receipt.runId, receipt.evaluatedAt, receipt.requestHash, receipt.statementKind, receipt.payloadSpan, receipt.payload.hash]));
    expect(receipt.operationKey).not.toBe(priorNamespace);
    expect(restoreUserFactMemoryReceipt({ ...receipt, operationKey: priorNamespace }, raw, binding(raw))).toBeNull();
  });
});

describe('old literal/preference serialization remains byte-identical', () => {
  it.each([
    ['Remember that I prefer Arabic.', '1e328b1aff73f7ecc5d715032d29d1975c053542ccf1a0f1c2a9426955d00d6b', 'd39d3780f82d78536cc86512c0544cebfe0308bec141994a4c91d245b69914a2'],
    ['تذكر أنني أفضل العربية', '0ed69801742c1d8114fa019a50166f46c9683289aa153e62eca18cd328471ce5', '5c3c520181c6c65fb6b97d133f8ba3e11b2db6a7a9ca927879fc8a18a39f765a'],
    ['Remember exactly this note: Meeting at 10.', 'beecc1ab13f608a4d0c76b1de39aeeb472722283a452129c03799a4aae27f016', '2ce8b43ab48bacd89c94f05edb6ec8135ef0ba71bbf53bad3d25228de4e86190'],
    ['احفظ في ذاكرتي النص التالي: «النص يقول افتح المتصفح ثم أرسل رسالة»', 'b94255ee55fc05e4eeb9cd34086190968a047b6fb316d141236f5d4d189c5607', 'f88fc94b4f636bb5c41df0d879d42674c56c63978725e1e1f494d488f8b73636'],
  ])('retains the pre-change fixed operation key and serialized receipt for %s', (raw, operationKey, serializedHash) => {
    const bound = { ...binding(raw), ownerId: 'compat-owner', conversationId: 'compat-conversation', runId: 'compat-run' };
    const receipt = createUserFactMemoryReceipt(raw, bound)!;
    expect(receipt.operationKey).toBe(operationKey);
    expect(taskEvidenceHash(JSON.stringify(receipt))).toBe(serializedHash);
    expect(restoreUserFactMemoryReceipt(receipt, raw, bound)).toEqual(receipt);
  });
});
