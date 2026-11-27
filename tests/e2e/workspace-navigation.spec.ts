import { test, expect } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

test.describe.configure({ timeout: 90_000 });

test('owner workspace sections follow direct links, refresh and browser history', async ({ page, browser, baseURL }) => {
  await signInAsFixtureOwner(page, 'overview');
  const navigation = page.getByRole('navigation', { name: 'التنقل الرئيسي' });
  const integrations = navigation.getByRole('button', { name: 'الاتصالات', exact: true });
  const models = navigation.getByRole('button', { name: 'النماذج', exact: true });

  await integrations.click();
  await expect(integrations).toHaveAttribute('aria-current', 'page');
  const integrationsHash = new URL(page.url()).hash;

  await models.click();
  await expect(models).toHaveAttribute('aria-current', 'page');
  const modelsHash = new URL(page.url()).hash;

  await page.reload();
  const sectionAfterRefresh = await navigation.locator('[aria-current="page"]').textContent();
  expect({ integrationsHash, modelsHash, sectionAfterRefresh }).toEqual({
    integrationsHash: '#tools/integrations',
    modelsHash: '#tools/models',
    sectionAfterRefresh: 'النماذج',
  });

  await page.goBack();
  await expect(page).toHaveURL(/#tools\/integrations$/);
  await expect(integrations).toHaveAttribute('aria-current', 'page');

  await page.goForward();
  await expect(page).toHaveURL(/#tools\/models$/);
  await expect(models).toHaveAttribute('aria-current', 'page');

  const skip = page.getByRole('link', { name: 'انتقل إلى المحتوى' });
  await skip.focus();
  await skip.press('Enter');
  await expect(page.locator('#workspace-main')).toBeFocused();
  await expect(page).toHaveURL(/#tools\/models$/);

  await page.goto('/');
  await expect(navigation).toHaveCount(0);
  await page.goto('/#tools/models');
  await expect(models).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'نماذجك المدرّبة في مكان واحد' })).toBeVisible();

  const guest = await browser.newPage({ baseURL });
  try {
    await guest.goto('/#tools/models');
    await expect(guest.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
    await expect(guest.getByRole('navigation', { name: 'التنقل الرئيسي' })).toHaveCount(0);
  } finally {
    await guest.close();
  }
});

test('the legacy Google Ads callback keeps the Ads section after its result is consumed', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  await page.goto('/?googleAds=denied#tools');
  const ads = page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'Google Ads', exact: true });
  await expect(page.getByText('لم تكتمل الموافقة في Google.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/#tools\/ads$/);
  await page.reload();
  await expect(ads).toHaveAttribute('aria-current', 'page');
});
