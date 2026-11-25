import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BrowserLiveAttentionCode, BrowserLiveSnapshot } from '@mohassan/contracts';
import {
  browserLiveCornerAt, browserLivePreferenceKey, browserLivePresentation,
  defaultBrowserLivePreferences, readBrowserLivePreferences, writeBrowserLivePreferences,
} from '../apps/web/components/browser-live-layout';
import { BrowserLiveView } from '../apps/web/components/browser-live-view';

const id = 'edec042d-2fc3-42c5-a3cb-3805dd26d633';
const stamp = '2026-11-25T00:00:00.000Z';
const live: BrowserLiveSnapshot = {
  conversationId: id, runId: id, title: 'Fixture', status: 'running', caption: 'قراءة الصفحة الحالية',
  visibility: { version: 1, level: 2, code: 'browser_started', reason: 'في الخلفية', lang: 'ar', decidedAt: stamp, requested: 2, canView: true, history: [] },
  secure: null, approval: null,
};

const render = (snapshot: BrowserLiveSnapshot | null) =>
  renderToStaticMarkup(createElement(BrowserLiveView, { snapshot, app: 'web', onAttentionFinished: () => {} }));

function waiting(code: BrowserLiveAttentionCode, kind?: NonNullable<BrowserLiveSnapshot['secure']>['kind']): BrowserLiveSnapshot {
  return {
    ...live,
    status: kind ? 'waiting_input' : 'waiting_approval',
    visibility: { ...live.visibility, level: 3, code },
    secure: kind ? { id, kind, site: 'https://example.test', prompt: 'أكمل الخطوة', fields: [], note: null } : null,
    approval: kind ? null : { id, detail: 'الوجهة هي صفحة الاختبار', prompt: 'هل تسمح بالإرسال؟' },
  };
}

describe('floating browser presentation', () => {
  it.each([
    [40, 70, 'top-left'],
    [380, 70, 'top-right'],
    [40, 275, 'bottom-left'],
    [380, 275, 'bottom-right'],
  ])('snaps physical pointer coordinates (%d, %d) to %s', (x, y, corner) => {
    expect(browserLiveCornerAt(x, y, 400, 300)).toBe(corner);
  });

  it('restores preferences for each app and handles unavailable or invalid storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    writeBrowserLivePreferences(storage, 'web', { corner: 'top-right', size: 'medium' });
    writeBrowserLivePreferences(storage, 'desktop', { corner: 'bottom-right', size: 'small' });
    expect(readBrowserLivePreferences(storage, 'web')).toEqual({ corner: 'top-right', size: 'medium' });
    expect(readBrowserLivePreferences(storage, 'desktop')).toEqual({ corner: 'bottom-right', size: 'small' });
    values.set(browserLivePreferenceKey('web'), '{"corner":"start","size":"large"}');
    expect(readBrowserLivePreferences(storage, 'web')).toEqual(defaultBrowserLivePreferences);
    const unavailable = { getItem() { throw new Error('Disabled'); } };
    expect(readBrowserLivePreferences(unavailable, 'desktop')).toEqual(defaultBrowserLivePreferences);
  });

  it('honors manual pill and close choices until a distinct attention episode', () => {
    expect(browserLivePresentation('run', false, 'small', { scope: 'run', mode: 'pill' })).toBe('pill');
    expect(browserLivePresentation('run', false, 'small', { scope: 'run', mode: 'closed' })).toBe('closed');
    expect(browserLivePresentation('login', true, 'small', { scope: 'run', mode: 'closed' })).toBe('medium');
    expect(browserLivePresentation('code', true, 'small', { scope: 'login', mode: 'closed' })).toBe('medium');
  });

  it('renders the normal small view with its caption, level and corner controls', () => {
    const markup = render(live);
    expect(markup).toContain('data-mode="small"');
    expect(markup).toContain('data-corner="bottom-left"');
    expect(markup).toContain('data-level="2"');
    expect(markup).toContain('dir="auto"');
    expect(markup).toContain(live.caption);
    expect(markup).toContain('aria-label="زاوية المشاهدة الحية"');
    expect(markup).toContain('إغلاق المشاهدة الحية');
    expect(markup).not.toContain('تولَّ التحكم');
    expect(render(null)).toBe('');
  });

  it.each([
    ['needs_login', 'login', 'سجّل الدخول هنا ثم اضغط متابعة'],
    ['needs_code', 'code', 'أدخل رمز التحقق هنا ثم اضغط متابعة'],
    ['hands_on', 'hands_on', 'أكمل الخطوة هنا ثم اضغط متابعة'],
    ['needs_approval', undefined, 'راجع الإجراء ثم اضغط موافقة ومتابعة'],
  ] as const)('renders %s expanded with all handoff controls', (code, kind, message) => {
    const markup = render(waiting(code, kind));
    expect(markup).toContain('data-mode="medium"');
    expect(markup).toContain('data-corner="bottom-left"');
    expect(markup).toContain(`data-attention="${code}"`);
    expect(markup).toContain(message);
    expect(markup).toContain('تولَّ التحكم');
    expect(markup).toContain('>إلغاء</button>');
    if (kind) expect(markup).toContain('>متابعة</button>');
    else {
      expect(markup).toContain('>موافقة ومتابعة</button>');
      expect(markup).toContain('الوجهة هي صفحة الاختبار');
    }
  });
});
