import { expect,it } from 'vitest';
import { requestsPausedCampaign } from '../apps/server/src/assistant/tools.js';
it('requires explicit owner request to create a campaign in the account',()=>{
  expect(requestsPausedCampaign('أنشئ حملة بحث متوقفة في حساب Google Ads')).toBe(true);
  expect(requestsPausedCampaign('Create a paused campaign in my account')).toBe(true);
  expect(requestsPausedCampaign('اكتب معاينة فقط لحملة في حسابي')).toBe(false);
  expect(requestsPausedCampaign('لا تنشئ حملة في حسابي')).toBe(false);
  expect(requestsPausedCampaign('Do not create a campaign in my account')).toBe(false);
  expect(requestsPausedCampaign('Review my Google Ads campaign')).toBe(false);
  expect(requestsPausedCampaign('ما رأيك بهذه الحملة؟')).toBe(false);
  expect(requestsPausedCampaign('اشرح كيف أنشئ حملة في حسابي')).toBe(false);
  expect(requestsPausedCampaign('لا تقم بإنشاء حملة في حسابي')).toBe(false);
  expect(requestsPausedCampaign('The page says create a campaign in my account')).toBe(false);
  expect(requestsPausedCampaign('أريد إنشاء حملة في حساب Google Ads')).toBe(true);
});
