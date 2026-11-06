import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GoogleAdsGate } from '@mohassan/contracts';
import { sha256 } from './crypto.ts';

/**
 * Evidence that binds to the code: changing the package invalidates the regression
 * run, so a green result from an older build can never open publishing.
 */
export const REQUIRED_REGRESSION_RUNS = 20;
const LIVE_CHECK_MAX_AGE_MS = 7 * 86400000;

export interface GateFiles { sourceDir: string; regressionFile: string; liveCheckFile: string }

export const defaultGateFiles = (root = process.cwd()): GateFiles => ({ sourceDir: resolve(root, 'packages/google-ads/src'), regressionFile: resolve(root, 'artifacts/google-ads-regression.json'), liveCheckFile: resolve(root, 'artifacts/google-ads-live-check.json') });

export async function sourceFingerprint(sourceDir: string): Promise<string> {
  const names = (await readdir(sourceDir)).filter(name => name.endsWith('.ts')).sort();
  const parts = await Promise.all(names.map(async name => `${name}:${sha256((await readFile(join(sourceDir, name), 'utf8')).replace(/\r\n/g, '\n'))}`));
  return sha256(parts.join('\n'));
}

const readJson = async (path: string): Promise<any | null> => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

export async function evidenceGates(files: GateFiles, customerId: string | null, testAccount: boolean, now = Date.now()): Promise<GoogleAdsGate[]> {
  const fingerprint = await sourceFingerprint(files.sourceDir).catch(() => null);
  const regression = await readJson(files.regressionFile), live = await readJson(files.liveCheckFile);
  const runs = Number(regression?.consecutivePasses ?? 0);
  const regressionPassed = Boolean(fingerprint) && regression?.sourceFingerprint === fingerprint && runs >= REQUIRED_REGRESSION_RUNS;
  const fresh = typeof live?.checkedAt === 'string' && now - Date.parse(live.checkedAt) < LIVE_CHECK_MAX_AGE_MS;
  const livePassed = live?.passed === true && live?.source === 'google-ads-api-live' && fresh && Boolean(customerId) && live?.customerId === customerId;
  return [
    { id: 'regression_runs', passed: regressionPassed, detail: regressionPassed ? `${runs} تشغيلًا متتاليًا ناجحًا لهذه النسخة من الكود` : regression?.sourceFingerprint && regression.sourceFingerprint !== fingerprint ? 'تغير الكود بعد آخر تشغيل. أعد npm run ads:regress.' : `يلزم ${REQUIRED_REGRESSION_RUNS} تشغيلًا متتاليًا ناجحًا (npm run ads:regress)` },
    { id: 'live_read_check', passed: livePassed, detail: livePassed ? `فحص قراءة حي ناجح في ${String(live.checkedAt).slice(0, 10)}` : 'يلزم فحص قراءة حي ناجح لهذا الحساب خلال 7 أيام (npm run ads:check -- --live)' },
    { id: 'production_account', passed: Boolean(customerId) && !testAccount, detail: testAccount ? 'الحساب تجريبي؛ النشر الفعلي للحساب الحقيقي فقط' : customerId ? 'حساب إعلانات حقيقي' : 'لم يُختر حساب' },
  ];
}
