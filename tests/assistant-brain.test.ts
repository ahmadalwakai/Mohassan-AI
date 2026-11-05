import { describe, expect, it } from 'vitest';
import type { AgentElement, AgentPage } from '@mohassan/browser';
import {
  ModelPool, buildPrompt, chooseTier, directRoute, newBrainState, noteAttempt, sensitiveAction, shouldAskForHelp, siteOf, situation,
} from '../apps/server/src/assistant/brain.js';
import { CredentialVault } from '../apps/server/src/assistant/vault.js';

function element(partial: Partial<AgentElement>): AgentElement {
  return { ref: 'e1', role: 'textbox', label: '', inViewport: true, ...partial };
}

function page(partial: Partial<AgentPage>): AgentPage {
  return {
    id: 'page', url: 'https://example.com/', title: 'Example', text: '', elements: [],
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 800, viewport: 800 }, hash: 'x', observedAt: '', ...partial,
  };
}

describe('reading a page without the model', () => {
  it('recognizes a sign-in wall', () => {
    expect(situation(page({ url: 'https://accounts.example.com/login', elements: [element({ field: 'password' })] }))).toBe('password');
    expect(situation(page({ url: 'https://accounts.google.com/signin/identifier', elements: [element({ field: 'identifier' })] }))).toBe('identifier');
  });

  it('does not treat a long public article with a small login box as a wall', () => {
    expect(situation(page({ url: 'https://news.example.com/story', text: 'word '.repeat(1000), elements: [element({ field: 'password' })] }))).toBe('normal');
  });

  it('leaves account creation to the task', () => {
    expect(situation(page({ url: 'https://example.com/signup', title: 'Create an account', elements: [element({ field: 'password' })] }))).toBe('normal');
  });

  it('recognizes codes, human checks and refused browsers', () => {
    expect(situation(page({ url: 'https://example.com/verify', elements: [element({ field: 'otp' })] }))).toBe('otp');
    expect(situation(page({ signals: { captcha: true, password: false, otp: false, card: false } }))).toBe('captcha');
    expect(situation(page({ text: "Couldn't sign you in. This browser or app may not be secure." }))).toBe('browser_refused');
    expect(situation(page({ text: 'Check your phone and tap yes.' }))).toBe('device_prompt');
  });

  it('finds the privacy-friendly choice on a cookie banner', () => {
    const banner = page({ text: 'We use cookies', elements: [element({ role: 'button', label: 'Accept all' }), element({ ref: 'e2', role: 'button', label: 'Reject all' })] });
    expect(situation(banner)).toBe('cookies');
  });
});

describe('what needs the owner first', () => {
  it.each([
    ['Pay now', true], ['ادفع الآن', true], ['Delete account', true], ['حذف', true], ['Send', true], ['إرسال', true], ['Publish', true],
    ['Sign in', false], ['Next', false], ['البحث', false], ['Sender settings', false],
  ])('classifies %s', (label, expected) => {
    expect(Boolean(sensitiveAction(label))).toBe(expected);
  });
});

describe('direct routes', () => {
  it('opens plain requests with no model call', () => {
    expect(directRoute('افتح gmail')).toMatchObject({ url: 'https://mail.google.com/', finishes: true });
    expect(directRoute('open example.com')).toMatchObject({ url: 'example.com', finishes: true });
  });

  it('knows when more work follows the open', () => {
    expect(directRoute('افتح gmail واقرأ آخر رسالة')).toMatchObject({ finishes: false });
  });

  it('leaves everything else to judgement', () => {
    expect(directRoute('ما عاصمة فرنسا؟')).toBeNull();
    expect(directRoute('اشرح لي كيف يعمل gmail')).toBeNull();
  });
});

describe('credential scope', () => {
  it('keeps a credential to its own site', () => {
    expect(siteOf('https://accounts.google.com/x')).toBe('google.com');
    expect(siteOf('https://shop.example.co.uk/')).toBe('example.co.uk');
    const vault = new CredentialVault();
    vault.put('c', 'example.com', { password: 'correct-horse' });
    expect(vault.forSite('c', 'example.com')?.password).toBe('correct-horse');
    expect(vault.forSite('c', 'evil.example.net')).toBeUndefined();
  });

  it('uses a code once and scrubs echoed secrets', () => {
    const vault = new CredentialVault();
    vault.put('c', 'example.com', { password: 'correct-horse', code: '123456' });
    expect(vault.scrub('c', 'value is correct-horse and 123456')).not.toMatch(/correct-horse|123456/);
    expect(vault.takeCode('c', 'example.com')).toBe('123456');
    expect(vault.takeCode('c', 'example.com')).toBeUndefined();
    vault.clear('c');
    expect(vault.forSite('c', 'example.com')).toBeUndefined();
  });
});

describe('thinking economy', () => {
  it('uses the strong model to plan and recover, the quick one for routine steps', () => {
    const state = newBrainState();
    expect(chooseTier(state)).toBe('deep');
    state.steps = 3;
    expect(chooseTier(state)).toBe('fast');
    expect(chooseTier(state, 'repeated')).toBe('deep');
  });

  it('moves to another model when one has spent its minute', () => {
    const pool = new ModelPool({ fast: ['fast'], deep: ['deep'] });
    pool.record('fast', 100, 30000, 1000);
    expect(pool.pick('fast', 2000, 1000)).toBe('deep');
    pool.block('deep', 5000, 1000);
    expect(pool.pick('fast', 2000, 1000)).toBeNull();
    expect(pool.pick('fast', 2000, 40000)).toBe('fast');
  });

  it('notices repetition and asks for help rather than looping', () => {
    const state = newBrainState();
    expect(noteAttempt(state, 'click|e1', false, false)).toBeUndefined();
    expect(noteAttempt(state, 'click|e1', false, false)).toMatch(/different approach/);
    for (let index = 0; index < 3; index++) noteAttempt(state, `other${index}`, false, false);
    expect(shouldAskForHelp(state)).toBe(true);
    noteAttempt(state, 'worked', true, false);
    expect(shouldAskForHelp(state)).toBe(false);
  });

  it('keeps each step small and never shows a sensitive value', () => {
    const prompt = buildPrompt({
      request: 'افتح الموقع', history: [], state: newBrainState(),
      page: page({ text: 'x'.repeat(30000), elements: [element({ ref: 'e4', label: 'Password', field: 'password' })] }),
    });
    expect(prompt.length).toBeLessThan(3000);
    expect(prompt).toContain('e4 textbox "Password" (password)');
  });
});
