import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelCouncilSchema, type ModelInfo } from '@mohassan/contracts';
import { CouncilPanel, ModelCouncilDetails } from '../apps/web/components/model-council';
import { ModelCard } from '../apps/web/components/models-workspace';

const council = ModelCouncilSchema.parse({
  version: 1, chosen: 'reading-v3-last', changed: true, elapsedMs: 4200,
  reason: 'لم يكن للمحرك جواب يقف، فأُرسل جواب نموذج القراءة v3 لأنه موجود في صفحة قُرئت لهذا السؤال.',
  members: [
    { model: 'router-b0', label: 'الموجّه B0', round: 'understanding', outcome: 'ok', output: 'web_search', agreesWithRules: true, elapsedMs: 3, note: 'المسار؛ القواعد: web_search' },
    { model: 'web-search', label: 'البحث في الويب', round: 'search', outcome: 'ok', output: 'Capital of France guide', elapsedMs: 1800, note: 'قرأ 1 صفحة' },
    { model: 'pipeline', label: 'المحرك (القواعد والصفحات)', round: 'answer', outcome: 'ok', output: 'لم أجد جواباً.', judge: 'withhold', agreements: 0, elapsedMs: 0 },
    { model: 'reading-v3-last', label: 'نموذج القراءة v3', round: 'answer', outcome: 'ok', output: 'Paris', inEvidence: true, agreements: 0, judge: 'send', chosen: true, elapsedMs: 900 },
    { model: 'chat-v5', label: 'نموذج المحادثة v5', round: 'answer', outcome: 'timeout', elapsedMs: 20000 },
  ],
});

describe('the model council under an owner reply', () => {
  it('opens on request and summarizes the decision while closed', () => {
    const closed = renderToStaticMarkup(createElement(ModelCouncilDetails, { council }));
    expect(closed).toContain('نقاش النماذج (3)');
    expect(closed).toContain('أُرسل جواب نموذج القراءة v3');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('data-testid="council-panel"');
  });

  it('shows the decision, the understanding, the web search and every answer with its checks', () => {
    const html = renderToStaticMarkup(createElement(CouncilPanel, { council }));
    expect(html).toContain(council.reason);
    expect(html).toContain('كيف فهمت النماذج الطلب');
    expect(html).toContain('يوافق القواعد');
    expect(html).toContain('البحث في الويب');
    expect(html).toContain('Capital of France guide');
    expect(html).toContain('الجواب المرسل');
    expect(html).toContain('موجود في الصفحات');
    expect(html).toContain('يحجبه الحَكَم');
    expect(html).toContain('انتهى وقته');
    expect(html).toContain('data-chosen="true"');
  });
});

describe('a recorded council discussion under an owner reply', () => {
  // Reuse the version 1 fixture's identities. The evidence, checks and weights below are synthetic inputs.
  const reader = council.members[3];
  const router = council.members[0];
  const engine = council.members[2];
  const total = 12 + 7;
  const evidenceUrl = 'https://example.test/council-evidence';
  const evidenceQuote = `The sum of 12 and 7 is ${total}.`;
  const reasonAr = 'أيّد التحقّق جواب نموذج القراءة ووجد نصّه في الدليل.';
  const reasonEn = 'The check supported the reading model and found its answer in the evidence.';
  const checkNote = 'طابق المقترح السطر المقتبس.';
  const weightSource = 'نتيجة القياس في بيانات الاختبار';
  const failureNote = 'انتهت مهلة المحاولة قبل ورود جواب.';
  const discussion = {
    proposals: [
      { member: reader.model, answer: String(total), evidenceUrl, evidenceQuote },
      { member: engine.model, answer: String(total - 1) },
    ],
    checks: [
      { checker: router.model, member: reader.model, verdict: 'supports', note: checkNote },
      { checker: router.model, member: engine.model, verdict: 'contradicts' },
      { checker: engine.model, member: reader.model, verdict: 'unsure' },
    ],
    votes: [
      { member: reader.model, weight: 3 / 4, weightSource },
      { member: router.model, weight: 1 - 1, weightSource: ' ' },
      { member: engine.model, weight: 2 / 4, weightSource },
    ],
    decision: { chosen: reader.model, reasonAr, reasonEn },
  };
  const full = ModelCouncilSchema.parse({
    ...council,
    members: [...council.members.slice(0, -1), { ...council.members[4], note: failureNote },
      { ...router, outcome: 'failed', note: 'لم يُرجع الموجّه نتيجة.' }],
    discussion,
  });

  it('renders a native collapsed disclosure with a one-line decision summary and a hidden target', () => {
    const html = renderToStaticMarkup(createElement(ModelCouncilDetails, { council: full }));
    const button = html.match(/<button\b[^>]*>/u)?.[0] ?? '';
    const target = button.match(/aria-controls="([^"]+)"/u)?.[1];
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).not.toContain('tabindex="-1"');
    expect(target).toBeTruthy();
    expect(html).toContain(`id="${target}"`);
    expect(html).toContain('hidden="" data-testid="council-panel"');
    expect(html).toContain('ناقش نموذجان؛ اختير جواب');
    expect(html).toContain(`title="${reader.model}">${reader.label}`);
    expect(html).toContain(reasonAr);
    expect(html).not.toContain('<h3>');
  });

  it('shows the recorded proposals, evidence, checks, vote sources and participation outcomes', () => {
    const html = renderToStaticMarkup(createElement(CouncilPanel, { council: full }));
    for (const heading of ['المقترحات', 'التحقّق', 'التصويت', 'القرار', 'من تعذّرت مشاركتهم']) {
      expect(html).toContain(`<h3>${heading}</h3>`);
    }
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('role="list"');
    expect(html).toContain(`href="${evidenceUrl}"`);
    expect(html).toContain(`<blockquote dir="auto">${evidenceQuote}</blockquote>`);
    expect(html).toContain('لم يُسجّل دليل لهذا المقترح.');
    expect(html).toContain(`title="${router.model}">${router.label}`);
    for (const verdict of ['يؤيّد', 'يعارض', 'غير متأكد']) expect(html).toContain(verdict);
    expect(html).toContain(checkNote);
    expect(html).toContain(`<bdi>${discussion.votes[0].weight}</bdi>`);
    expect(html).toContain(`<bdi>${discussion.votes[1].weight}</bdi>`);
    expect(html).toContain(weightSource);
    expect(html).toContain('لا يوجد قياس مسجّل');
    expect(html).toContain('انتهت المهلة');
    expect(html).toContain(failureNote);
    expect(html).toContain('تعذّرت مشاركته');
    expect(html).toContain('لم يُرجع الموجّه نتيجة.');
  });

  it('shows when the engine kept its answer and reads the Arabic reason from the discussion', () => {
    const keptReason = 'أكمل المحرك الجواب ووافقه التحقّق.';
    const kept = ModelCouncilSchema.parse({
      ...full, chosen: engine.model, changed: false,
      discussion: { ...discussion, decision: { chosen: engine.model, reasonAr: keptReason, reasonEn: 'The engine completed the answer and the check agreed.' } },
    });
    const summary = renderToStaticMarkup(createElement(ModelCouncilDetails, { council: kept }));
    const panel = renderToStaticMarkup(createElement(CouncilPanel, { council: kept }));
    for (const html of [summary, panel]) {
      expect(html).toContain('بقي جواب');
      expect(html).toContain(`title="${engine.model}">${engine.label}`);
      expect(html).toContain(keptReason);
    }
  });

  it('identifies the verified model answer that replaced the engine answer', () => {
    const html = renderToStaticMarkup(createElement(CouncilPanel, { council: full }));
    expect(html).toContain('أُرسل جواب');
    expect(html).toContain(`title="${reader.model}">${reader.label}</bdi></strong><span`);
    expect(html).toContain('الجواب المختار');
    expect(html).toContain(reasonAr);
    expect(html).not.toContain(reasonEn);
    expect(html).not.toContain(council.reason);
  });

  it('keeps the quote visible when an evidence address cannot be opened', () => {
    const unlinked = ModelCouncilSchema.parse({
      ...full, discussion: { ...discussion, proposals: [{ ...discussion.proposals[0], evidenceUrl: '/relative' }] },
    });
    const html = renderToStaticMarkup(createElement(CouncilPanel, { council: unlinked }));
    expect(html).toContain(evidenceQuote);
    expect(html).not.toContain('href=');
  });

  it('shows what was recorded when no models contributed to a discussion', () => {
    const empty = ModelCouncilSchema.parse({
      ...full, chosen: engine.model, changed: false, members: [],
      discussion: { proposals: [], checks: [], votes: [], decision: { ...discussion.decision, chosen: engine.model } },
    });
    const summary = renderToStaticMarkup(createElement(ModelCouncilDetails, { council: empty }));
    const panel = renderToStaticMarkup(createElement(CouncilPanel, { council: empty }));
    expect(summary).toContain('لم يشارك أي نموذج في النقاش');
    expect(panel).toContain('لم تُسجّل مقترحات.');
    expect(panel).toContain('لم تُسجّل نتائج تحقّق.');
    expect(panel).toContain('لم تُسجّل أوزان للتصويت.');
    expect(panel).not.toContain('من تعذّرت مشاركتهم');
  });
});

describe('a model card on the models page', () => {
  const model: ModelInfo = { id: 'reading-v3-last', version: 'reading-v3-last', task: 'Historical extractive reading model', runtime: 'python-worker',
    present: true, input: 'reading', gates: [], measured: 'F1 ‏18٪ بالعربية و26٪ بالإنجليزية على XQuAD', uses: ['council', 'page'] };

  it('names where the model is used and offers a run when it can run', () => {
    const html = renderToStaticMarkup(createElement(ModelCard, { model, selected: false, onSelect: () => {} }));
    expect(html).toContain('ملفاته على الخادم');
    expect(html).toContain('عضو في مجلس النماذج');
    expect(html).toContain('جرّبه');
  });

  it('explains why an absent or unrunnable model has no run button', () => {
    const html = renderToStaticMarkup(createElement(ModelCard, { model: { ...model, id: 'execution', input: 'none', present: true,
      unavailable: 'يحتاج صيغة مهام المنفّذ المحلي، والمنفّذ مقفل في الإنتاج.', uses: [] }, selected: false, onSelect: () => {} }));
    expect(html).toContain('المنفّذ مقفل في الإنتاج');
    expect(html).not.toContain('جرّبه');
  });
});
