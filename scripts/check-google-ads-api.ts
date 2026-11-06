import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '@mohassan/database';
import { GOOGLE_ADS_API_VERSION, GoogleAdsClient, GoogleAdsConnectionManager, GoogleAdsError, analyzeAccount, dateRange, googleAdsMigration, parseTokenKey, searchTermsQuery } from '@mohassan/google-ads';

/**
 * Controlled live check against the real Google Ads API. It can only read: the
 * fetch below refuses any mutate URL before it leaves this process. The result
 * file holds counts and status, never tokens, names or account figures.
 */
dotenv.config({ quiet: true, override: true });
const output = resolve('artifacts/google-ads-live-check.json');

async function finish(report: Record<string, unknown>) {
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== true) process.exitCode = 1;
}

async function main() {
  if (!process.argv.includes('--live')) throw new Error('أضف --live لتشغيل فحص القراءة الحي.');
  const base = { checkedAt: new Date().toISOString(), source: 'google-ads-api-live', apiVersion: GOOGLE_ADS_API_VERSION, passed: false };
  const missing = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_TOKEN_KEY'].filter(name => !process.env[name]);
  if (missing.length) return finish({ ...base, connectivity: 'not_attempted', reason: 'missing_settings', missing });

  const readOnly: typeof fetch = (input, init) => {
    if (/mutate/i.test(String(input))) throw new Error('This check is read-only.');
    return fetch(input, init);
  };
  const client = new GoogleAdsClient({ clientId: process.env.GOOGLE_ADS_CLIENT_ID!, clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!, ...(process.env.GOOGLE_ADS_DEVELOPER_TOKEN ? { developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN } : {}), fetch: readOnly });
  const database = await createDatabase({ connectionString: process.env.DATABASE_URL || undefined, dataDir: process.env.DATA_DIR ?? '.data/postgres' });
  try {
    await googleAdsMigration(database.db);
    const row = await database.db.selectFrom('google_ads_connections' as never).select(['owner_id', 'customer_id', 'status'] as never).where('status' as never, '=', 'connected' as never).executeTakeFirst() as { owner_id: string; customer_id: string } | undefined;
    if (!row) return finish({ ...base, connectivity: 'not_attempted', reason: 'no_connected_account' });
    const connection = new GoogleAdsConnectionManager(database.db, client, { clientId: process.env.GOOGLE_ADS_CLIENT_ID!, tokenKey: parseTokenKey(process.env.GOOGLE_ADS_TOKEN_KEY!), redirectUri: 'http://unused.invalid/' });
    const started = Date.now();
    const result = await connection.runForAccount(row.owner_id, async (context, account) => {
      const accessible = await client.listAccessibleCustomers(context);
      const report = await analyzeAccount(client, context, { currency: account.currency ?? '', timeZone: account.timeZone ?? '' }, account.bookingRules, 30);
      const range = dateRange(30);
      const terms = await client.search(searchTermsQuery(range.start, range.end), context);
      return { accessibleAccounts: accessible.length, campaigns: report.campaigns.length, conversionActions: report.conversionActions.length, enabledConversionActions: report.conversionActions.filter(item => item.status === 'ENABLED').length, recordingConversionActions: report.conversionActions.filter(item => item.recordedConversions > 0).length, mismatches: report.mismatches.length, searchTerms: terms.length, testAccount: account.testAccount };
    });
    await finish({ ...base, passed: true, connectivity: 'connected', customerId: row.customer_id, durationMs: Date.now() - started, ...result });
  } catch (error) {
    await finish({ ...base, connectivity: 'failed', code: error instanceof GoogleAdsError ? error.code : 'UNEXPECTED', googleCodes: error instanceof GoogleAdsError ? error.options.googleCodes ?? [] : [], requestId: error instanceof GoogleAdsError ? error.options.requestId ?? null : null });
  } finally { await database.close(); }
}

try { await main(); } catch (error) {
  console.error(JSON.stringify({ passed: false, message: error instanceof Error && !/postgres(?:ql)?:\/\//.test(error.message) ? error.message : 'فشل الفحص.' }));
  process.exitCode = 1;
}
