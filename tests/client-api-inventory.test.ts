import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientInventory } from '../scripts/client-api/inventory.js';
import { renderClientApiContracts } from '../scripts/client-api/report.js';

const root = resolve(import.meta.dirname, '..');

describe('client API inventory', () => {
  it('discovers calls in each client', () => {
    const callers = new Set(clientInventory(root).flatMap(row => row.calls.map(call => call.client)));
    expect(callers).toEqual(new Set(['Web', 'iOS', 'Android', 'Chrome', 'Windows']));
  });

  it('matches the committed table', () => {
    const committed = readFileSync(resolve(root, 'docs/CLIENT-API-CONTRACTS.md'), 'utf8');
    expect(renderClientApiContracts(root), 'Regenerate with npx tsx scripts/client-api-contracts.ts').toBe(committed);
  });
});
