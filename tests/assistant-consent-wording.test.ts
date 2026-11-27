import type { GoogleAdsControl } from '@mohassan/google-ads';
import { describe, expect, it, vi } from 'vitest';
import { asksToRemember, deniesMemoryWrite } from '../apps/server/src/assistant/brain.js';
import { recognizeMemoryVerificationRequest } from '../apps/server/src/assistant/memory-verification.js';
import { createAssistantTools, requestsPausedCampaign } from '../apps/server/src/assistant/tools.js';
import { recognizeUserFactMemoryVerificationRequest } from '../apps/server/src/assistant/user-fact-memory-verification.js';
import { brief } from './fixtures/google-ads-mock.js';

// Consent and veto expectations come from the task's explicit examples and acceptance cases.
// Leading dialect examples and Ads draft clauses come from cases 164, 167, 171, 197 and 198.
// Retrieved 2026-11-27 from https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/development.json
// Existing explicit-consent controls were retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/assistant-tools.test.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/google-ads-paused-intent.test.ts
// Shared negator and Arabic spelling controls were retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/request-constraints.ts#L27
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/request-context.ts#L308
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/structured-memory-parser.ts#L27

const rememberCar = 'تذكر أن رقم سيارتي 4521';
const englishCampaign = 'Create a paused campaign in my account';
const arabicCampaign = 'أنشئ حملة بحث متوقفة في حساب Google Ads';
const arabicNegations = ['لا', 'ما', 'مش', 'مو', 'بلاش', 'ممنوع'];

describe('memory consent wording', () => {
  it.each([
    'افتكر إن موعد اجتماع النادي الثلاثاء.',
    'خلي بذاكرتك اسم ورشتي طين الرافدين.',
    'إفتكر إن موعد اجتماع النادي الثلاثاء.',
    'لا تنسى أن رقم سيارتي 4521',
    'Keep in mind that my preferred language is English.',
    'احفظ ما قلته',
  ])('accepts an affirmative leading directive in %s', request => {
    expect(deniesMemoryWrite(request)).toBe(false);
    expect(asksToRemember(request)).toBe(true);
  });

  // Owner's regression examples from the PR #171 review, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/pull/171
  it.each([
    'تذكر أن زوجتي لا تتذكر المواعيد',
    'تذكر أن ابنتي ما تحفظ جدول الضرب',
    'احفظ أن مديرتي لا تغير المواعيد أبدا',
    'تذكر أن الشركة لا تسجل المكالمات',
    'احفظ ما تكتبه لي في هذه المحادثة',
    'Remember that our backend does not store sessions',
    'Remember that I never remember names',
    'Remember that my wife does not remember birthdays',
    'Remember that the API must never store raw tokens',
  ])('allows a save when the negated wording is part of the fact in %s', request => {
    expect(deniesMemoryWrite(request)).toBe(false);
    expect(asksToRemember(request)).toBe(true);
  });

  it.each(['هل تتذكر رمز الخزانة؟', 'تذكر رمز الخزانة؟', '«احفظ هذا» عبارة في النص المعروض'])(
    'requires an affirmative directive in %s', request => {
      expect(asksToRemember(request)).toBe(false);
    },
  );

  it.each([' بس ', ' لكن ', '، '].flatMap(separator =>
    arabicNegations.map(negation => `${rememberCar}${separator}${negation} تحفظه`),
  ))('vetoes the memory write in %s', request => {
    expect(deniesMemoryWrite(request)).toBe(true);
    expect(asksToRemember(request)).toBe(false);
  });

  it.each([
    `${rememberCar} ولا تحفظه`,
    `${rememberCar}، ما تحفظه ثم احفظه`,
    `${rememberCar}\nما تحفظه`,
    `${rememberCar} بس ماتحفظهاش`,
    'Remember this but do not save it.',
    'Remember it for now but not save it.',
    'Remember this\nPlease do not\nsave it.',
    'Remember this and don’t save it.',
    "Remember this and don't save it.",
    'Keep in mind that my preferred language is English. Never store it.',
  ])('gives a refusal precedence in %s', request => {
    expect(deniesMemoryWrite(request)).toBe(true);
    expect(asksToRemember(request)).toBe(false);
  });
});

// Write-only clause forms from the pinned verifiers, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/memory-verification.ts#L79-L83
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/user-fact-memory-verification.ts#L66-L67
it.each(['بلاش تحفظ أي شيء', 'ممنوع تحفظ أي شيء', 'ما تحفظش أي شيء'])(
  'uses the same write-only wording for both memory status questions: %s', clause => {
    expect(deniesMemoryWrite(clause)).toBe(true);
    expect(recognizeMemoryVerificationRequest(`${clause}. هل حفظت النتيجة؟`)).toMatchObject({ allowed: true });
    expect(recognizeUserFactMemoryVerificationRequest(`${clause}. هل حفظت الملاحظة؟`)).toMatchObject({ allowed: true });
  },
);

describe('paused Ads campaign consent wording', () => {
  it.each([
    englishCampaign,
    arabicCampaign,
    'أنشئ حملة متوقفة في حساب Google Ads لمخبزي ولا تفعلها',
    'أنشئ حملة متوقفة في حساب Google Ads لمخبزي ولا تطلقها قبل موافقتي',
  ])('allows an explicit paused creation request in %s', request => {
    expect(requestsPausedCampaign(request)).toBe(true);
  });

  it.each([
    `${arabicCampaign}، مسودة فقط`,
    `${arabicCampaign}، مسوده فقط`,
    `${arabicCampaign}، معاينة فقط`,
    `${arabicCampaign}، معاينه فقط`,
    `${arabicCampaign}، خليها مسودة`,
    `${arabicCampaign}، من غير نشر`,
    `${arabicCampaign} ولا تنشرها`,
    `${arabicCampaign}، لا تنشئها`,
    ...arabicNegations.map(negation => `${arabicCampaign} بس ${negation} تحفظها`),
    `${englishCampaign}, draft only.`,
    `${englishCampaign}, preview only.`,
    `${englishCampaign}. Do not publish it.`,
    `${englishCampaign} and don’t publish it.`,
    `${englishCampaign}. Keep it unpublished.`,
    'Create a draft for a Google Ads campaign.',
    'أنشئ حملة مسودة في حساب Google Ads',
    'Build a Google Ads search campaign draft for violin lessons in York at £7 daily. Keep it unpublished.',
  ])('keeps an explicit refusal or draft request out of the account in %s', request => {
    expect(requestsPausedCampaign(request)).toBe(false);
  });

  it('keeps the campaign write behind the explicit request gate', async () => {
    const draft = [
      `BUSINESS: ${brief.businessName}`, `SERVICE: ${brief.service}`, `GOAL: ${brief.goal}`,
      `URL: ${brief.landingPageUrl}`, `COUNTRY: ${brief.countryCode}`, `LANGUAGE: ${brief.adLanguage}`,
      `BUDGET: ${brief.dailyBudget}`, ...brief.locations.map(location => `LOCATION: ${location}`),
    ].join('\n');
    const unused = async (): Promise<never> => { throw new Error('Unexpected adapter call'); };
    const createPausedCampaign = vi.fn(unused);
    const googleAds = { configured: true, createPausedCampaign } satisfies Pick<GoogleAdsControl, 'configured' | 'createPausedCampaign'>;
    const tools = createAssistantTools({
      memory: { search: unused, create: unused },
      coding: { available: false, workspace: unused },
      studio: { workspace: unused, detail: unused },
      studioChange: false,
      runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused },
      windows: { enabled: false, view: unused, act: unused, command: unused },
      googleAds: googleAds as unknown as GoogleAdsControl,
    });

    await expect(tools.ads!.createPaused!('owner', draft, `${englishCampaign}. Keep it unpublished.`, 'campaign', async () => {}))
      .rejects.toMatchObject({ code: 'ADS_CREATION_NOT_REQUESTED' });
    expect(createPausedCampaign).not.toHaveBeenCalled();
  });
});
