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
