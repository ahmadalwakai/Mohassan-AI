import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSourceReview, buildSwitchRegistry, generateSwitchRegistry, sourceDigests,
} from '../scripts/generate-switch-registry.js';
import type { ReviewedReader } from '../scripts/switch-registry-readers.js';
import { scanSwitchReads } from '../scripts/switch-registry-scan.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixtureModule = 'fixture.ts';

function withFixture(test: (root: string, update: (source: string) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'mohassan-switch-registry-'));
  const update = (source: string) => writeFileSync(join(root, fixtureModule), `export {};\n${source}`);
  try {
    test(root, update);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('generated production switch registry', () => {
  it('matches both the committed runtime registry and docs/SWITCHES.md', () => {
    for (const [path, generated] of Object.entries(generateSwitchRegistry(repository))) {
      expect(generated === readFileSync(join(repository, path), 'utf8'), path).toBe(true);
    }
  }, 60_000);

  it('detects alias, bracket and destructured reads and rejects unknown switches', () => withFixture((root, update) => {
    update(`
      const alias: Record<string, string | undefined> = process.env;
      const key = 'FIXTURE_BRACKET';
      const { FIXTURE_DESTRUCTURED: feature } = alias;
      export const result = process.env.FIXTURE_DOT || alias[key] || feature || Reflect.get(alias, 'FIXTURE_REFLECTED');
      export const comment = 'process.env.NOT_A_READ';
      process.env.WRITE_ONLY = 'fixture';
    `);
    const reads = scanSwitchReads(root, [fixtureModule]);
    expect([...reads.keys()].sort()).toEqual([
      'FIXTURE_BRACKET', 'FIXTURE_DESTRUCTURED', 'FIXTURE_DOT', 'FIXTURE_REFLECTED',
    ]);
    expect(() => buildSwitchRegistry(reads, {}))
      .toThrow('Unknown environment switch reader: fixture.ts reads FIXTURE_BRACKET');
  }));

  it('requires metadata review after a change to parsing under a known name', () => withFixture((root, update) => {
    const describeFlag = (mode: string) => `
      export function active() {
        const configured = process.env.FIXTURE_MODE;
        return configured === '${mode}';
      }
    `;
    const review = {
      [fixtureModule]: {
        FIXTURE_MODE: { kind: 'feature', defaultValue: 'off', parsing: 'Exact 1 enables', needsRestart: false },
      },
    } satisfies Record<string, Record<string, ReviewedReader>>;
    update(describeFlag('1'));
    const reads = scanSwitchReads(root, [fixtureModule]);
    const reviewed = sourceDigests(reads);
    expect(() => assertSourceReview(reads, reviewed)).not.toThrow();
    expect(buildSwitchRegistry(reads, review)).toMatchObject([{ name: 'FIXTURE_MODE' }]);

    update(describeFlag('true'));
    const changed = scanSwitchReads(root, [fixtureModule]);
    expect(buildSwitchRegistry(changed, review)).toMatchObject([{ name: 'FIXTURE_MODE' }]);
    expect(() => assertSourceReview(changed, reviewed)).toThrow('Environment parsing needs review');
  }));
});
