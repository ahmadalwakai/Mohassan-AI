import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BrowserLiveSnapshot, BrowserPremiumBriefData } from '@mohassan/contracts';
import { BrowserPremiumBrief } from '../apps/web/components/browser-premium-brief';
import { browserPremiumFavicon, browserPremiumNarration, browserPremiumSiteDomain } from '../apps/web/components/browser-premium-narration';
import { BrowserLiveView } from '../apps/web/components/browser-premium-view';

const id = 'cd6754e1-833f-4f67-b922-e4e0ad8b08cb';
const stamp = '2026-11-25T00:00:00.000Z';
const snapshot: BrowserLiveSnapshot = {
  conversationId: id, runId: id, status: 'running', title: 'حسابي',
  caption: '#raw-selector [name=password]',
  visibility: { version: 1, level: 2, code: 'browser_started', reason: 'في الخلفية',
    lang: 'ar', decidedAt: stamp, requested: 2, canView: true, history: [] },
  secure: null, approval: null,
  premium: { site: { domain: 'example.test' }, steps: [{ id: 'open', kind: 'opening' }, { id: 'type', kind: 'typing' }] },
};

function render(value: BrowserLiveSnapshot) {
  return renderToStaticMarkup(createElement(BrowserLiveView, { snapshot: value, app: 'web', onAttentionFinished: () => {} }));
}

describe('premium browser presentation', () => {
  it('uses only event kinds for narration and keeps recent timeline entries', () => {
    expect(browserPremiumNarration(snapshot, false)).toMatchObject({ status: 'typing', caption: 'يعبّئ النموذج' });
    const markup = render(snapshot);
    expect(markup).toContain('يعبّئ النموذج');
    expect(markup).toContain('يفتح الموقع');
    expect(markup).toContain('example.test');
    expect(markup).not.toContain(snapshot.caption);

    const previous = snapshot.premium!;
    const full = { ...snapshot, premium: { ...previous,
      steps: Array.from({ length: 12 }, (_, index) => ({ id: String(index), kind: 'reading' as const })) } };
    expect(browserPremiumNarration(full, true).steps.map(step => step.id)).toEqual(['7', '8', '9', '10', '11', 'state-handover']);
    expect(browserPremiumNarration({ ...full, status: 'idle' }, false)).toMatchObject({ status: 'done', caption: 'اكتمل التصفح' });
    expect(browserPremiumNarration({ ...full, status: 'failed' }, false)).toMatchObject({ status: 'failed', caption: 'توقّف التصفح' });
  });

  it('gives the account domain, exact next action and masking promise during a login handover', () => {
    const markup = render({
      ...snapshot, status: 'waiting_input',
      visibility: { ...snapshot.visibility, level: 3, code: 'needs_login' },
      secure: { id, kind: 'login', prompt: 'سجل الدخول', site: 'https://example.test/login', fields: [], note: null },
    });
    expect(markup).toContain('data-attention="needs_login"');
    expect(markup).toContain('data-status="waiting"');
    expect(markup).toContain('ينتظر اكتمال تسجيل الدخول');
    expect(markup).toContain('تبقى حقول الإدخال محجوبة');
    expect(markup).toContain('تولَّ التحكم');
  });

  it('requires a dedicated approval action and names its consequence', () => {
    const markup = render({
      ...snapshot, status: 'waiting_approval',
      visibility: { ...snapshot.visibility, level: 3, code: 'needs_approval' },
      approval: { id, prompt: 'هل تسمح بإرسال النموذج؟', detail: 'إرسال نموذج', consequence: 'يُبلّغ مسؤول الحساب.' },
    });
    expect(markup).toContain('موافقة ومتابعة');
    expect(markup).toContain('يُبلّغ مسؤول الحساب.');
    expect(markup).not.toContain('تولَّ التحكم');
  });

  it('distinguishes a risky start from read-only continuation and lists what may need attention', () => {
    const brief: BrowserPremiumBriefData = { summary: 'أقرأ الطلب وأراجع الإجراء', sites: ['example.test'], needs: ['login', 'code', 'approval'], requiresStart: true };
    const briefMarkup = renderToStaticMarkup(createElement(BrowserPremiumBrief, { brief, onStart: () => {} }));
    expect(briefMarkup).toContain('ابدأ');
    expect(briefMarkup).toContain('example.test');
    expect(briefMarkup).toContain('رمز تحقق');
    expect(briefMarkup).toContain('موافقتك');
    const readMarkup = renderToStaticMarkup(createElement(BrowserPremiumBrief, { brief: { ...brief, requiresStart: false }, onStart: () => {} }));
    expect(readMarkup).toContain('متابعة');
  });

  it('shows only the host of a legacy handover URL and rejects externally loaded icons', () => {
    expect(browserPremiumSiteDomain('https://person:pass@example.test:8443/login?code=value')).toBe('example.test:8443');
    expect(browserPremiumSiteDomain('file:///home/document')).toBeNull();
    expect(browserPremiumFavicon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(browserPremiumFavicon('https://example.test/icon.png')).toBeNull();
    expect(browserPremiumFavicon('/\\example.test/icon.png')).toBeNull();
    expect(browserPremiumFavicon('data:image/svg+xml;base64,AAAA')).toBeNull();
  });
});
