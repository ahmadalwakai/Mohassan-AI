import dotenv from 'dotenv';
import pg from 'pg';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { GOOGLE_ADS_API_VERSION, GoogleAdsClient, analyzeAccount, dateRange, searchTermsQuery } from '@mohassan/google-ads';
import { AdsReadOnlyCheckError, adsReadOnlyPoolOptions, readStoredAdsConnection, adsInspectionContext, createAdsReadOnlyFetch, adsCheckFailureCode } from './lib/google-ads-live-check.ts';

const reportBase = () => ({ checkedAt: new Date().toISOString(), source: 'google-ads-api-live', apiVersion: GOOGLE_ADS_API_VERSION, databaseReadOnly: true, passed: false });

/** No app bootstrap, migrations, SQL writes, embedded fallback, or Google mutations. */
async function main() {
  if (!process.argv.includes('--live')) throw new AdsReadOnlyCheckError('EXPLICIT_LIVE_FLAG_REQUIRED');
  let local: Record<string, string> = {};
  try { local = dotenv.parse(await readFile('.env')); } catch (error: any) { if (error?.code !== 'ENOENT') throw new AdsReadOnlyCheckError('SETTINGS_UNREADABLE'); }
  const env = { ...local, ...process.env };
  const base = reportBase();
  const missing = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_TOKEN_KEY', 'DATABASE_URL'].filter(name => !env[name]?.trim());
  if (missing.length) return { ...base, connectivity: 'not_attempted', reason: 'missing_settings', missing };
  const ownerArgument = process.argv.indexOf('--owner-id');
  if (ownerArgument >= 0 && !process.argv[ownerArgument + 1]) return { ...base, connectivity: 'not_attempted', reason: 'OWNER_ARGUMENT_INVALID' };
  const pool = new pg.Pool(adsReadOnlyPoolOptions(env.DATABASE_URL!));
  pool.on('error', () => {});
  pool.on('connect', client => client.on('error', () => {}));
  try {
    const selected = await readStoredAdsConnection(pool, ownerArgument >= 0 ? process.argv[ownerArgument + 1] : undefined);
    if (!selected.ok) return { ...base, connectivity: 'not_attempted', reason: selected.reason };
    const { row } = selected, { context, bookingRules } = adsInspectionContext(row, env.GOOGLE_ADS_TOKEN_KEY!);
    const settings = { clientId: env.GOOGLE_ADS_CLIENT_ID!, clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!, context };
    const client = new GoogleAdsClient({ clientId: settings.clientId, clientSecret: settings.clientSecret, fetch: createAdsReadOnlyFetch(settings) });
    const started = Date.now(), accessible = await client.listAccessibleCustomers(context);
    const report = await analyzeAccount(client, context, { currency: row.currency ?? '', timeZone: row.time_zone ?? '' }, bookingRules, 30);
    const range = dateRange(30), terms = await client.search(searchTermsQuery(range.start, range.end), context);
    return { ...base, passed: true, connectivity: 'connected', customerId: row.customer_id, durationMs: Date.now() - started, accessibleAccounts: accessible.length, campaigns: report.campaigns.length, conversionActions: report.conversionActions.length, enabledConversionActions: report.conversionActions.filter(item => item.status === 'ENABLED').length, recordingConversionActions: report.conversionActions.filter(item => item.recordedConversions > 0).length, mismatches: report.mismatches.length, searchTerms: terms.length, testAccount: row.test_account };
  } catch (error) { return { ...base, connectivity: 'failed', code: adsCheckFailureCode(error) }; }
  finally { await pool.end(); }
}

let report: Record<string, unknown>;
try { report = await main(); }
catch (error) { report = { ...reportBase(), connectivity: 'failed', code: adsCheckFailureCode(error) }; }
try {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/google-ads-live-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: adsCheckFailureCode(error) }));
  process.exitCode = 1;
}
