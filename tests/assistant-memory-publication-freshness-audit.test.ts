import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Report {
  mode: string; status: string; text: string; contractMode: string;
  completionReview: { allowCompletion: boolean; criteria: { status: string }[] };
  hook: { count: number; advanceMs: number; fixtureLeaseRenewal: boolean; phase: string; proofCheckpointAt: number | null;
    beforeReview: { allowCompletion: boolean } | null };
  logicalRunAgeMs: number; observationAgeMs: number; leaseStillActive: boolean; currentAccountActive: boolean; accountChecksAfterAdvance: number;
  writes: number; forbiddenCalls: number; itemCount: number; operationCount: number;
  setupWrites: number; lexicalReads: number; modelCalls: number; latestObservation: number; sourceReadFinishedAt: number; modelStartedAt: number;
}
function probe(mode: string, timing: 'fresh' | 'expired' | 'model-expired' = 'expired'): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/fixtures/memory-publication-clock-audit.mjs'), mode, timing], {
      cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(60000),
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`Isolated clock fixture failed before its publication assertion (${code}): ${stderr.slice(-3000)}\n${stdout.slice(-6000)}`));
      const line = stdout.split(/\r?\n/u).find(value => value.startsWith('MEMORY_PUBLICATION_AUDIT='));
      if (!line) return reject(new Error(`Isolated clock fixture emitted no bounded audit report: ${stdout.slice(-2000)}`));
      try { resolve(JSON.parse(line.slice('MEMORY_PUBLICATION_AUDIT='.length)) as Report); } catch (error) { reject(error); }
    });
  });
}

describe('final exact-memory publication freshness, with live lease/account and isolated child clocks', () => {
  it.each(['note-save', 'calculation-save', 'note-status', 'calculation-status'])
    ('preserves fresh no-delay %s completion without a clock advance or fixture renewal', async mode => {
      const result = await probe(mode, 'fresh');
      expect(result.hook.count).toBe(1); expect(result.hook.beforeReview?.allowCompletion).toBe(true);
      expect(result.hook.advanceMs).toBe(0); expect(result.hook.fixtureLeaseRenewal).toBe(false);
      expect(result.leaseStillActive).toBe(true); expect(result.currentAccountActive).toBe(true); expect(result.accountChecksAfterAdvance).toBe(0);
      expect(result.observationAgeMs).toBeLessThan(300000); expect(result.logicalRunAgeMs).toBeLessThan(15 * 60000);
      expect(result.status, JSON.stringify(result)).toBe('completed'); expect(result.completionReview.allowCompletion).toBe(true);
      expect(result.writes).toBe(1); expect(result.operationCount).toBe(1); expect(result.forbiddenCalls).toBe(0);
    }, 65000);
  it.each(['note-save', 'calculation-save', 'note-status', 'calculation-status'])
    ('does not complete %s with a freshly refreshed review that says its proof expired', async mode => {
      const result = await probe(mode);
      expect(result.hook.count).toBe(1); expect(result.hook.beforeReview?.allowCompletion).toBe(true);
      expect(result.hook.advanceMs).toBe(300001); expect(result.observationAgeMs).toBeGreaterThan(300000);
      expect(result.hook.fixtureLeaseRenewal).toBe(true);
      expect(result.logicalRunAgeMs).toBeLessThan(15 * 60000);
      expect(result.leaseStillActive).toBe(true); expect(result.currentAccountActive).toBe(true); expect(result.accountChecksAfterAdvance).toBeGreaterThan(0);
      expect(result.writes).toBe(1); expect(result.itemCount).toBe(1); expect(result.operationCount).toBe(1); expect(result.forbiddenCalls).toBe(0);
      expect(result.completionReview.allowCompletion).toBe(false);
      expect(result.completionReview.criteria.some(criterion => criterion.status === 'expired')).toBe(true);
      if (mode.endsWith('status')) expect(result.text).not.toMatch(/\bcurrently active\b/iu);
      expect(result.text).not.toContain('PUBLICATION-CLOCK-724'); expect(result.text).not.toContain('2 + 3 = 5');
      expect(result.status, JSON.stringify(result)).toBe('partial');
    }, 65000);
  it.each(['fresh', 'expired', 'model-expired'] as const)
    ('keeps formatted model recall bound to the actual memory read time: %s', async timing => {
      const result = await probe('formatted-recall', timing);
      expect(result.writes).toBe(0); expect(result.setupWrites).toBe(1); expect(result.itemCount).toBe(1); expect(result.operationCount).toBe(1);
      expect(result.lexicalReads).toBe(1); expect(result.modelCalls).toBe(1); expect(result.forbiddenCalls).toBe(0);
      expect(result.leaseStillActive).toBe(true); expect(result.currentAccountActive).toBe(true); expect(result.logicalRunAgeMs).toBeLessThan(15 * 60000);
      expect(result.latestObservation).toBeGreaterThanOrEqual(result.sourceReadFinishedAt);
      expect(result.latestObservation).toBeLessThanOrEqual(result.modelStartedAt);
      if (timing === 'fresh') {
        expect(result.status).toBe('completed'); expect(result.text).toBe('Bristol'); expect(result.completionReview.allowCompletion).toBe(true);
        expect(result.hook.fixtureLeaseRenewal).toBe(false);
      } else {
        expect(result.status, JSON.stringify(result)).toBe('partial'); expect(result.completionReview.allowCompletion).toBe(false);
        expect(result.completionReview.criteria.some(item => item.status === 'expired')).toBe(true);
        expect(result.observationAgeMs).toBeGreaterThan(300000); expect(result.accountChecksAfterAdvance).toBeGreaterThan(0);
        expect(result.text).not.toContain('Bristol');
        expect(result.hook.phase).toBe(timing === 'expired' ? 'publication_checkpoint' : 'model_after_memory_read');
      }
    }, 65000);

  it.each(['fresh', 'expired'] as const)
    ('checks unformatted self-preference publication freshness even with a configured model: %s', async timing => {
      const result = await probe('preferred-recall', timing);
      expect(result.writes).toBe(0); expect(result.setupWrites).toBe(1); expect(result.itemCount).toBe(1); expect(result.operationCount).toBe(1);
      expect(result.lexicalReads).toBe(1); expect(result.modelCalls).toBe(0); expect(result.forbiddenCalls).toBe(0);
      expect(result.hook.count).toBe(1); expect(result.hook.phase).toBe('publication_checkpoint');
      expect(result.hook.beforeReview?.allowCompletion).toBe(true);
      expect(result.latestObservation).toBeGreaterThanOrEqual(result.sourceReadFinishedAt);
      expect(result.latestObservation).toBeLessThanOrEqual(result.hook.proofCheckpointAt!);
      expect(result.leaseStillActive).toBe(true); expect(result.currentAccountActive).toBe(true);
      expect(result.logicalRunAgeMs).toBeLessThan(15 * 60000);
      if (timing === 'fresh') {
        expect(result.status, JSON.stringify(result)).toBe('completed'); expect(result.completionReview.allowCompletion).toBe(true);
        expect(result.text).toBe('From memory: «I prefer Arabic»');
        expect(result.hook.advanceMs).toBe(0); expect(result.hook.fixtureLeaseRenewal).toBe(false);
        expect(result.observationAgeMs).toBeLessThan(300000); expect(result.accountChecksAfterAdvance).toBe(0);
      } else {
        expect(result.status, JSON.stringify(result)).toBe('partial'); expect(result.completionReview.allowCompletion).toBe(false);
        expect(result.completionReview.criteria.some(item => item.status === 'expired')).toBe(true);
        expect(result.text).not.toContain('Arabic'); expect(result.text).not.toContain('I prefer');
        expect(result.hook.advanceMs).toBe(300001); expect(result.hook.fixtureLeaseRenewal).toBe(true);
        expect(result.observationAgeMs).toBeGreaterThan(300000); expect(result.accountChecksAfterAdvance).toBeGreaterThan(0);
      }
    }, 65000);
});
