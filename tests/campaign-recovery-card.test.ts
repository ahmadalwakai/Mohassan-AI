import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CampaignRecoveryCard } from '../apps/web/components/campaign-recovery-card.js';

describe('the persisted Google Ads operation recovery action', () => {
  it('states that recovery reads the existing effect and never submits another write', () => {
    const html = renderToStaticMarkup(createElement(CampaignRecoveryCard, { busy: false, onResume: () => {} }));
    expect(html).toContain('aria-label="مراجعة العملية المحفوظة"');
    expect(html).toContain('مراجعة نتيجة العملية المحفوظة');
    expect(html).toContain('للقراءة فقط');
    expect(html).toContain('لا تعيد إنشاء الحملة أو إرسال طلب كتابة');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('disabled=""');
  });

  it('disables recovery while an action or task is in progress', () => {
    const html = renderToStaticMarkup(createElement(CampaignRecoveryCard, { busy: true, onResume: () => {} }));
    expect(html).toContain('disabled=""');
  });
});
