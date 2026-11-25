import type { ConversationPrivacyFinding, ConversationSnapshot } from '@mohassan/contracts';
import { describe, expect, it } from 'vitest';
import {
  conversationPublicToolQuotes, conversationRunPrivacy, hasConversationPromptPrivacy, noteConversationPromptPrivacy,
  scanConversationPrivacy, visibleConversationText,
} from '../apps/server/src/conversation-share-privacy.js';

const timestamp = new Date(Date.UTC(2026, 10, 25, 10, 0)).toISOString();
const removable = '⟦حُذف محتوى خاص⟧';
const conversation = (text: string, role: 'user' | 'assistant' = 'assistant'): ConversationSnapshot => ({
  title: 'محادثة عن السفر', createdAt: timestamp, messages: [{ role, text, createdAt: timestamp, sources: [] }],
});

describe('conversation share privacy detectors', () => {
  // Positive and negative fixtures follow the documented recognition rules in conversation-share-privacy.ts.
  const cases: Array<[ConversationPrivacyFinding['kind'], string, string, string, string]> = [
    ['email', 'Contact first.last+trip@example.test.', 'راسِل بريد+سفر@مثال.اختبار من فضلك.', 'Credit @traveller and see example.test.', 'هذا معرّف @مسافر وموقع مثال.اختبار.'],
    ['phone', 'Call +1 (202) 555-0142 after lunch.', 'اتصل بي على +١ (٢٠٢) ٥٥٥-٠١٤٢ بعد الغداء.', 'The date is 2026-11-25 and we have 42 tickets.', 'التاريخ ٢٠٢٦-١١-٢٥ ولدينا ٤٢ تذكرة.'],
    ['path', 'Read "C:\\Private Folder\\trip.md" for dates.', 'اقرأ «/خاص/ملفات الرحلة/خطة.txt» لاحقًا.', 'The public website is https://example.test/help/guide.', 'الخيار هو أحمر/أخضر في https://example.test/help.'],
    ['google-ads-id', 'Google Ads customer ID: 1234567890.', 'معرّف العميل: ١٢٣-٤٥٦-٧٨٩٠.', 'The release is 123.456.7890.', 'في النتيجة ١٢٣ إعلانًا ولدينا ٤٥٦ مشاهدة.'],
    ['token-url', 'Open https://example.test/report?file=report&%61ccess_token=placeholder.', 'الرابط https://example.test/تقرير?sessionToken=placeholder للتقرير.', 'Open https://example.test/report?file=report&sort=recent.', 'هذا رابط https://example.test/تقرير?lang=ar&page=2 للملفات.'],
    ['memory', 'From memory: “a private preference”. Next topic.', 'من الذاكرة: «تفضيل خاص «للرحلة»». موضوع جديد.', 'This guide explains how to save notes from memory.', 'هكذا تعمل الملاحظات المحفوظة في الذاكرة.'],
    ['tool-output', 'Tool output: `private memo`. Next topic.', 'ناتج الأداة: «ملاحظة خاصة». موضوع جديد.', 'The tool output can be reviewed afterwards.', 'يمكنك مراجعة مخرجات الأداة بعد انتهاء التشغيل.'],
  ];

  it.each(cases)('detects %s in Arabic and English and leaves ordinary text alone', (kind, en, ar, cleanEn, cleanAr) => {
    for (const text of [en, ar]) {
      const result = scanConversationPrivacy(conversation(text));
      const flagged = result.findings.find(finding => finding.kind === kind);
      expect(flagged).toMatchObject({ location: 'message', messageIndex: 0 });
      expect(result.snapshot.messages[0]!.text).toContain(removable);
      expect(result.snapshot.messages[0]!.text).not.toContain(flagged!.preview);
    }
    for (const text of [cleanEn, cleanAr]) {
      const input = conversation(text);
      expect(scanConversationPrivacy(input)).toEqual({ snapshot: input, findings: [] });
    }
  });

  it('redacts a multiline quotation with no closing delimiter', () => {
    const input = conversation('Tool output:\nfirst private line\nsecond private line');
    expect(scanConversationPrivacy(input).snapshot.messages[0]!.text).toBe(`Tool output:\n${removable}`);
  });

  it('strips internal text from exports and never repeats a trace in findings', () => {
    const trace = '<tool_result>secret@example.test</tool_result>';
    expect(visibleConversationText(`الجواب${trace}\n<analysis>hidden`)).toBe('الجواب');
    const checked = scanConversationPrivacy(conversation(`الجواب ${trace}`));
    expect(checked.findings).toEqual([{ kind: 'tool-output', location: 'message', messageIndex: 0, preview: removable }]);
    expect(checked.snapshot.messages[0]!.text).toBe(`الجواب ${removable}`);
  });

  it('checks the title and both fields of sources, removing an unsafe source altogether', () => {
    const input = conversation('هذا نص للنشر.');
    input.title = 'ملف /خاص/حساب.txt';
    input.messages[0]!.sources = [
      { title: 'مرجع عام', url: 'https://example.test/help' },
      { title: 'Quote from specialist@example.test', url: 'https://example.test/faq' },
      { title: 'Token URL', url: 'https://example.test/report?X-Amz-Signature=placeholder' },
      { title: 'Encoded path', url: 'https://example.test/files?open=%2Fprivate%2Fnotes.txt' },
    ];
    const result = scanConversationPrivacy(input);
    expect(result.snapshot.title).toBe(`ملف ${removable}`);
    expect(result.snapshot.messages[0]!.sources).toEqual([input.messages[0]!.sources[0]]);
    expect(result.findings.map(({ kind, location }) => [kind, location])).toEqual([
      ['path', 'title'], ['email', 'source'], ['token-url', 'source'], ['path', 'source'],
    ]);
  });

  it('removes obfuscated digits and does not mistake phone context for an Ads ID', () => {
    const input = conversation('الهاتف ٢٠٢-٥٥٥-٠١\u200f٤٢، العميل ١٢٣-٤٥٦-٧٨٩٠.');
    const result = scanConversationPrivacy(input);
    expect(result.findings.map(finding => finding.kind)).toEqual(['phone', 'google-ads-id']);
    expect(result.snapshot.messages[0]!.text).toBe(`الهاتف ${removable}، العميل ${removable}.`);
  });
});

describe('conversation share run provenance', () => {
  it('fails closed when memory values or private tool data may reach the published reply', () => {
    expect(conversationRunPrivacy({ actionCompletion: { events: [{ event: { kind: 'memory_read' } }] } })).toEqual(['memory']);
    expect(conversationRunPrivacy({ trail: [{ action: 'workspace_list' }] })).toEqual(['tool-output']);
    expect(conversationRunPrivacy({ localComputerRead: {} })).toEqual(['tool-output']);
    expect(conversationRunPrivacy({ mindTimings: {} })).toEqual(['memory', 'tool-output']);
    expect(conversationRunPrivacy({ agentRun: { modelCalls: 1, path: 'direct' } })).toEqual(['memory', 'tool-output']);
    expect(conversationRunPrivacy({ trail: [], agentRun: { modelCalls: 0, path: 'direct' } })).toEqual([]);

    const input = conversation('خاص لا يحمل صيغة قابلة للتعرف');
    input.messages[0]!.sources.push({ title: 'Memo', url: 'https://example.test/memo' });
    input.messages.push({ role: 'user', text: 'شكرًا', createdAt: timestamp, sources: [] });
    const result = scanConversationPrivacy(input, new Map([[0, ['memory']], [1, ['tool-output']]]));
    expect(result.snapshot.messages[0]).toEqual({ role: 'assistant', text: removable, sources: [], createdAt: timestamp });
    expect(result.snapshot.messages[1]).toEqual(input.messages[1]);
    expect(result.findings.every(finding => finding.preview === removable)).toBe(true);
  });

  it('records only cumulative presence flags and leaves a run with empty automatic memory alone', () => {
    const state = { agentRun: { modelCalls: 1, path: 'direct' }, actionCompletion: { events: [{ event: { kind: 'memory_read' } }] } };
    const memory = { items: [], citations: [], method: 'lexical-v1', expiredExcluded: 0, skillProposals: [] };
    expect(hasConversationPromptPrivacy(state)).toBe(false);
    noteConversationPromptPrivacy(state, { browser: null, learning: '', memory: JSON.stringify(memory) });
    expect(hasConversationPromptPrivacy(state)).toBe(true);
    expect(conversationRunPrivacy(state)).toEqual([]);
    expect(conversationRunPrivacy({ ...state, trail: [{ action: 'memory_search' }] })).toEqual(['memory']);
    noteConversationPromptPrivacy(state, {
      browser: { text: 'محتوى خاص من الصفحة' }, learning: 'محتوى من المعرفة', skill: 'محتوى من المهارة',
      memory: JSON.stringify({ ...memory, items: [{ text: 'محتوى من الذاكرة' }] }),
    });
    noteConversationPromptPrivacy(state, { browser: null, memory: JSON.stringify(memory) });
    expect(conversationRunPrivacy(state)).toEqual(['memory', 'tool-output']);
    expect(JSON.stringify(state)).not.toContain('محتوى');
  });

  it('withholds exact anonymous HTTP tool excerpts and retains the safe framing and citation', () => {
    const url = 'https://example.test/reference';
    const quote = 'تمتد الرحلة يومًا واحدًا.';
    const run = {
      handsFound: { url, readAt: timestamp, lines: [quote] },
      trail: [{ action: 'search رحلات' }, { action: `read ${url}`, result: `HTTP 200 ${url} · ${quote.length} chars` }],
      agentRun: { modelCalls: 0, path: 'action' },
    };
    const input = conversation(`المقتطف: ${quote}\nهذه معلومة إضافية.`);
    input.messages[0]!.sources.push({ title: 'مرجع', url });
    const quotes = conversationPublicToolQuotes(run);
    expect(quotes).toEqual([quote]);
    expect(conversationRunPrivacy(run)).toEqual([]);
    const checked = scanConversationPrivacy(input, new Map(), new Map([[0, quotes]]));
    expect(checked.snapshot.messages[0]).toMatchObject({ text: `المقتطف: ${removable}\nهذه معلومة إضافية.`, sources: input.messages[0]!.sources });
    expect(checked.findings.map(finding => finding.kind)).toEqual(['tool-output']);
    expect(conversationPublicToolQuotes({ ...run, trail: [{ action: `open ${url}` }] })).toEqual([]);
    expect(conversationRunPrivacy({ ...run, trail: [{ action: `open ${url}` }] })).toEqual(['tool-output']);
    const other = 'https://example.test/earlier-reference';
    const multiPart = { ...run, trail: [...run.trail, { action: `read ${other}`, result: `HTTP 200 ${other} · 3 chars` }] };
    expect(conversationPublicToolQuotes(multiPart)).toEqual([]);
    expect(conversationRunPrivacy(multiPart)).toEqual(['tool-output']);
  });
});
