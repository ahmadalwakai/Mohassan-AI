import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), candidates: [] as { text: string; finished: boolean }[] }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), access: vi.fn(async () => undefined) }));
import { createAdsLab, type AdsLab } from '../apps/server/src/ads-lab.js';

const answer = JSON.stringify({ keywords: ['[mobile tyre fitting wigan]', '"mobile tyres wigan"'] });
const request = { capability: 'ads.keywords.v1', brief: { business: 'Kerbside Tyres', service: 'Mobile Tyre Fitting', city: 'Wigan', goal: 'calls' }, candidates: 2 };
const children: { stdout: PassThrough; stderr: PassThrough; stdin: Writable }[] = [];
let lab: AdsLab;

beforeEach(() => {
  mocked.candidates = [];
  mocked.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
      stdin: new Writable({ write(chunk, _encoding, callback) {
        const sent = JSON.parse(String(chunk));
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: sent.id, candidates: mocked.candidates, ms: 1 }) + '\n'));
        callback();
      } }),
    });
    children.push(child);
    queueMicrotask(() => child.stdout.write(JSON.stringify({ ready: true, device: 'cpu', parameters: 1000,
      finetune_step: 12, prompt_hint: null, tokenizer_identity: 'tokenizer', config_identity: 'config', context: 1024 }) + '\n'));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  lab = createAdsLab({ enabled: true, run: 'C:/fixture-run', python: 'unused-python.exe', packageDir: 'C:/fixture-package',
    device: 'cpu', startupTimeoutMs: 1000, requestTimeoutMs: 1000 });
});

afterEach(() => {
  lab.shutdown();
  for (const child of children.splice(0)) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
});

describe('Ads lab completed-candidate requirement', () => {
  it('refuses unfinished generation even when its current text is valid, grounded JSON', async () => {
    mocked.candidates = [{ text: answer, finished: false }];
    const result = await lab.run(request);
    expect(result.decision.accepted).toBe(false);
    expect(result.candidates[0]).toMatchObject({ finished: false, passed: false, issues: [{ code: 'INCOMPLETE' }] });
  });

  it('keeps original candidate indices when a later completed answer is accepted', async () => {
    mocked.candidates = [{ text: answer, finished: false }, { text: answer, finished: true }];
    const result = await lab.run(request);
    expect(result.decision).toMatchObject({ accepted: true, candidate: 1 });
    expect(result.candidates.map(candidate => candidate.passed)).toEqual([false, true]);
  });
});
