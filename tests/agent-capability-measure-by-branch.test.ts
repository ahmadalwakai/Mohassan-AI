import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidates, optionalBranches } from '../scripts/agent-capability-bench/by-branch-candidates.js';
import { listedCandidates, originHeads, parseMeasureArgs, reserveAttempt } from '../scripts/agent-capability-bench/measure-by-branch.js';

const hash = (index: number) => index.toString(16).padStart(40, '0');
const heads = () => new Map(candidates.map((candidate, index) => [candidate.branch, hash(index + 1)]));

describe('capability v2 branch measurement', () => {
  it('requires an explicit study directory and keeps the measurement and reports separate', () => {
    expect(parseMeasureArgs(['measure', '--directory', 'private', '--browsers', 'chromium', '--jobs', '4']))
      .toMatchObject({ directory: resolve('private'), jobs: 4, browsers: resolve('chromium') });
    expect(parseMeasureArgs(['report', '--directory', 'private', '--output', 'result.md']))
      .toMatchObject({ directory: resolve('private'), output: resolve('result.md') });
    for (const options of [
      ['measure', '--directory', 'private'],
      ['measure', '--directory', 'private', '--browsers', 'chromium', '--jobs', '0'],
      ['measure', '--directory', 'private', '--browsers', 'chromium', '--output', 'result.md'],
      ['report', '--directory', 'private', '--output', 'result.md', '--jobs', '2'],
      ['report', '--directory', 'private', '--output', 'result.md', '--output', 'again.md'],
    ]) expect(() => parseMeasureArgs(options)).toThrow();
  });

  it('freezes only origin heads, including configured optional branches when present', () => {
    expect(originHeads(`${hash(1)}\trefs/heads/feat/example\n${hash(2)}\trefs/tags/tag\ninvalid\trefs/heads/ignore\n`))
      .toEqual(new Map([['feat/example', hash(1)]]));
    const result = listedCandidates(heads());
    expect(result.available.map(({ candidate }) => candidate.branch)).toEqual(candidates.map(candidate => candidate.branch));
    expect(result.absentBranches).toEqual(optionalBranches);
    const absentOptional = heads();
    absentOptional.delete('e2e/clarification-end-to-end');
    expect(listedCandidates(absentOptional).absentBranches).toContain('e2e/clarification-end-to-end');
  });

  it('rejects ambiguous or unavailable configurations before any sealed execution', () => {
    const missing = heads();
    missing.delete(candidates[0]!.branch);
    expect(() => listedCandidates(missing)).toThrow('Required candidate is absent');
    const duplicate = heads();
    duplicate.set(candidates[1]!.branch, hash(1));
    expect(() => listedCandidates(duplicate)).toThrow('same commit');
    const unconfigured = heads();
    unconfigured.set(optionalBranches[0]!, hash(100));
    expect(() => listedCandidates(unconfigured)).toThrow('verified PR flags');
  });

  it('claims a frozen SHA once across concurrent callers and keeps its attempt record private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capability-v2-attempt-'));
    try {
      const revision = hash(1);
      const attempts = await Promise.allSettled([reserveAttempt(directory, revision), reserveAttempt(directory, revision)]);
      expect(attempts.map(attempt => attempt.status).sort()).toEqual(['fulfilled', 'rejected']);
      await expect(reserveAttempt(directory, revision)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(reserveAttempt(directory, hash(2))).resolves.toBeUndefined();
      const path = join(directory, `${revision}.attempt`);
      expect(await readFile(path, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT/u);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
