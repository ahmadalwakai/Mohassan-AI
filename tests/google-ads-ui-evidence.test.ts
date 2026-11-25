import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GoogleAdsReadback, GoogleAdsStatus } from '@mohassan/contracts';
import { accountForDraft, moneyOf } from '../apps/web/components/google-ads-view.js';
import { GoogleAdsReadbackEvidence } from '../apps/web/components/google-ads-workspace.js';

const customerId = '1234567890';
const status: GoogleAdsStatus = { state: 'connected', message: '', missingSettings: [], retryAfterSeconds: null, connectedAt: null, lastCheckedAt: null, publishing: { available: true, gates: [] }, account: { customerId, name: 'Test', currency: 'GBP', timeZone: 'Europe/London', testAccount: true, loginCustomerId: null } };
const readback: GoogleAdsReadback = { customerId, checkedAt: '2026-11-24T04:00:00.000Z', passed: false, campaignResourceName: `customers/${customerId}/campaigns/55`, requestId: 'remote-read-1', resourceNames: [], fields: [{ field: 'campaign.status', expected: 'PAUSED', actual: 'ENABLED', passed: false }] };
const render = (value: GoogleAdsReadback) => renderToStaticMarkup(createElement(GoogleAdsReadbackEvidence, { readback: value, customerId }));

describe('Google Ads UI account and evidence boundaries', () => {
  it('formats confirmed GBP with en-GB and keeps another actual currency', () => {
    expect(moneyOf('12500000', 'GBP')).toBe('£12.50');
    expect(moneyOf('12500000', 'USD')).toContain('USD');
    expect(moneyOf('12500000', 'USD')).not.toContain('£');
    expect(moneyOf('12500000', '')).toContain('عملة الحساب غير مؤكدة');
  });

  it('does not borrow the selected account currency for an older draft in another account', () => {
    expect(accountForDraft(customerId, status)?.currency).toBe('GBP');
    expect(accountForDraft('9999999999', status)).toBeNull();
    expect(accountForDraft(customerId, { ...status, account: null })).toBeNull();
  });

  it('shows the exact mismatch, remote resource and timestamp without declaring completion', () => {
    const html = render(readback);
    expect(html).toContain('لم يثبت تطابق النتيجة');
    expect(html).toContain('campaign.status');
    expect(html).toContain('PAUSED');
    expect(html).toContain('ENABLED');
    expect(html).toContain('open=""');
    expect(html).toMatch(/datetime="2026-11-24T04:00:00\.000Z"/i);
    expect(html).toContain(readback.campaignResourceName);
    expect(html).toContain('remote-read-1');
    expect(html).not.toContain('تأكد التطابق من الحساب');
  });

  it('rejects an otherwise successful observation for the wrong account in the visible verdict', () => {
    const html = render({ ...readback, passed: true, customerId: '9999999999', fields: [{ ...readback.fields[0]!, actual: 'PAUSED', passed: true }] });
    expect(html).toContain('هذا الدليل يخص حسابًا مختلفًا');
    expect(html).not.toContain('تأكد التطابق من الحساب');
  });

  it('keeps a matching saved state separate from eligibility and performance', () => {
    const html = render({ ...readback, passed: true, fields: [{ ...readback.fields[0]!, actual: 'PAUSED', passed: true }] });
    expect(html).toContain('تأكد التطابق من الحساب');
    expect(html).toContain('أهلية الإعلان ونتائج الأداء تحتاجان أدلة منفصلة');
  });
});
