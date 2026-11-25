import { describe, expect, it, vi } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { planConversationPageRead, readConversationPageLines } from '../apps/server/src/assistant/conversation-state-page.js';
import { runHands, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';

const url = 'https://museum.example/entry';
const initial = `Visit ${url} and report the Monday admission fee.`;
const anchor = { goal: initial, status: 'completed', openedUrl: url };

function page(text: string, origin = url, documentStatus = 200): AgentPage {
  return { id: 'page', url: origin, title: 'Museum admission', text, elements: [], hash: 'content',
    observedAt: '2025-02-04T10:00:00.000Z', documentStatus,
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 } };
}

function ports(observed: AgentPage | null): HandsIO {
  return {
    page: vi.fn(async () => observed),
    act: vi.fn(async () => { throw new Error('unexpected browser action'); }),
    prepare: vi.fn(async () => null), settle: vi.fn(async current => current),
    read: vi.fn(async () => observed ? { kind: 'page' as const, page: observed } : { kind: 'unreadable' as const }),
    step: vi.fn(async () => {}), begin: vi.fn(async () => {}), complete: vi.fn(async () => {}),
    approve: vi.fn(async () => {}), hold: vi.fn(async () => {}),
  };
}

describe('conversation page reads', () => {
  it('plans a separately requested page read when the user supplies a complete URL and a read objective', () => {
    expect(planConversationPageRead(initial)?.plan.steps).toEqual([
      { kind: 'open', url, name: 'museum.example' },
      { kind: 'ask_page', question: 'the Monday admission fee.', conversationPage: {} },
    ]);
    expect(planConversationPageRead(`افتح ${url} واقرأ تكلفة الدخول للفترة الصباحية.`)?.plan.steps.at(-1)?.kind).toBe('ask_page');
    expect(planConversationPageRead(`Open ${url} and tell me the fee, then purchase one ticket.`)).toBeNull();
    expect(planConversationPageRead('Open https://museum.example/entry?session=opaque and tell me the fee.')).toBeNull();
  });

  it('inherits a field across a changed schedule selector only with the exact successful page anchor', () => {
    const subsequent = 'How about Thursday?';
    expect(planConversationPageRead(subsequent, anchor)).toMatchObject({
      question: 'the Thursday admission fee.',
      previous: 'the Monday admission fee.',
      plan: { steps: [{ kind: 'ask_page', conversationPage: { expectedUrl: url } }] },
    });
    expect(planConversationPageRead(subsequent)).toBeNull();
    expect(planConversationPageRead(subsequent, { ...anchor, status: 'blocked' })).toBeNull();
    expect(planConversationPageRead(subsequent, { ...anchor, openedUrl: 'https://museum.example/shop' })).toBeNull();
    expect(planConversationPageRead('Who painted The Night Watch?', anchor)).toBeNull();
    expect(planConversationPageRead('And open the shop?', anchor)).toBeNull();
  });

  it('quotes the exact matching field and abstains for a missing or ambiguous selector', () => {
    const observed = page('The Monday admission charge costs 12 euros. On Thursday the admission charge is 7 euros.');
    expect(readConversationPageLines(observed, 'the Thursday admission fee')).toEqual(['On Thursday the admission charge is 7 euros.']);
    expect(readConversationPageLines(observed, 'the Friday admission fee')).toEqual([]);
    expect(readConversationPageLines(page('The Thursday admission fee is 7 euros. The Thursday admission fee is 9 euros.'), 'the Thursday admission fee')).toEqual([]);
    const arabic = page('تبدأ الزيارة الصباحية عند الساعة 9. تبدأ الزيارة المسائية عند الساعة 5.');
    expect(readConversationPageLines(arabic, 'متى تبدأ الزيارة المسائية؟')).toEqual(['تبدأ الزيارة المسائية عند الساعة 5.']);
  });

  it('matches known Arabic verb inflections and keeps a requested year separate from a location', () => {
    const arabic = page('يقع المعهد قرب الميناء. أسس المعهد مجلس المدينة.');
    expect(readConversationPageLines(arabic, 'مين اللي أسسوه؟')).toEqual(['أسس المعهد مجلس المدينة.']);
    const publication = page('كتب المهندس الكتيب في مكتبه. نُشر الكتيب لأول مرة عام 1976.');
    expect(readConversationPageLines(publication, 'الكتيب اتنشر في أي عام؟')).toEqual(['نُشر الكتيب لأول مرة عام 1976.']);
    const english = page('The architect was born in Yarmouth. She was born in 1943.');
    expect(readConversationPageLines(english, 'In which year was she born?')).toEqual(['She was born in 1943.']);
  });

  it('recognizes feminine dual forms in the quoted evidence', () => {
    const text = 'في المعهد لغتان للتدريس: الفرنسية والإسبانية.';
    expect(readConversationPageLines(page(text), 'ما لغة التدريس في المعهد؟')).toEqual([text]);
  });

  it('reads a proven page without browsing away and refuses a switched page', async () => {
    const received = planConversationPageRead('How about Thursday?', anchor)!;
    const read = page('On Thursday the admission charge is 7 euros.');
    const io = ports(read);
    await expect(runHands(received.plan, io)).resolves.toMatchObject({ status: 'completed', text: expect.stringContaining(read.text) });
    expect(io.act).not.toHaveBeenCalled();
    expect(io.read).not.toHaveBeenCalled();
    expect(io.complete).toHaveBeenCalledWith(0, 'completed');
    expect(received.plan.found).toMatchObject({ url, lines: [read.text], readAt: read.observedAt });

    const changed = ports(page(read.text, 'https://museum.example/shop'));
    await expect(runHands(planConversationPageRead('How about Thursday?', anchor)!.plan, changed)).resolves.toMatchObject({ status: 'blocked' });
    expect(changed.complete).not.toHaveBeenCalled();
  });

  it('preserves structured answers and records their observed quotes for future turns', async () => {
    const firstSentence = 'The gallery opens earlier in winter.';
    const observed = page(`Museum admission\n${firstSentence} Admission fees vary by month.`);
    const io = ports(null);
    io.act = vi.fn(async () => observed);
    const { plan } = planConversationPageRead(`Open ${url} and tell me the first sentence.`)!;
    await expect(runHands(plan, io)).resolves.toMatchObject({ status: 'completed', text: expect.stringContaining(`First sentence on the page:\n> ${firstSentence}`) });
    expect(plan.found?.lines).toEqual([firstSentence]);
  });

  it('re-reads the recorded public URL after admission and accepts only an exact successful response', async () => {
    const plan = (): HandsPlan => ({ next: 0, lang: 'en', steps: [{ kind: 'ask_page', question: 'When does the permit expire?',
      conversationPage: { expectedUrl: url, readPublic: true } }] });
    const observed = page('The permit expires in January.');
    const io = ports(observed);
    await expect(runHands(plan(), io)).resolves.toMatchObject({ status: 'completed', text: expect.stringContaining(observed.text) });
    expect(io.page).not.toHaveBeenCalled();
    expect(io.act).not.toHaveBeenCalled();
    expect(io.read).toHaveBeenCalledWith(url);
    expect(vi.mocked(io.begin!).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(io.read!).mock.invocationCallOrder[0]!);
    await expect(runHands(plan(), ports(page(observed.text, url, 404)))).resolves.toMatchObject({ status: 'blocked' });
    await expect(runHands(plan(), ports(page(observed.text, 'https://museum.example/shop')))).resolves.toMatchObject({ status: 'blocked' });
    await expect(runHands(plan(), ports(page('A painting hangs on the wall.')))).resolves.toMatchObject({
      status: 'partial', text: expect.not.stringContaining('?'),
    });
  });
});
