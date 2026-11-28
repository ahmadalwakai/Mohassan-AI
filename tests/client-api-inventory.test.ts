import { readFileSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientInventory } from '../scripts/client-api/inventory.js';
import { renderClientApiContracts } from '../scripts/client-api/report.js';
import { isWorkspaceSource } from '../scripts/client-api/server.js';

const root = resolve(import.meta.dirname, '..');

function expectMatchingTable(rendered: string, committed: string) {
  expect(rendered, 'Regenerate with npx tsx scripts/client-api-contracts.ts').toBe(committed.replaceAll('\r\n', '\n'));
}

describe('workspace source paths', () => {
  const windowsRoot = String.raw`C:\Work\Mohassan-AI`;

  it.each([
    ['C:/Work/Mohassan-AI/apps/server/src/app.ts', true],
    ['c:/work/mohassan-ai/packages/windows/src/index.ts', true],
    ['C:/Work/Mohassan-AI/node_modules/fastify/fastify.js', false],
    ['C:/Work/Mohassan-AI/apps/server/node_modules/dependency/index.ts', false],
    ['C:/Work/Mohassan-AI-other/apps/server/src/app.ts', false],
    ['D:/Work/Mohassan-AI/apps/server/src/app.ts', false],
  ])('classifies TypeScript path %s under a Windows root', (fileName, expected) => {
    expect(isWorkspaceSource(windowsRoot, fileName, win32)).toBe(expected);
  });
});

describe('client API inventory', () => {
  it('discovers calls in each client', () => {
    const callers = new Set(clientInventory(root).flatMap(row => row.calls.map(call => call.client)));
    expect(callers).toEqual(new Set(['Web', 'iOS', 'Android', 'Chrome', 'Windows']));
  });

  it('matches the committed table', () => {
    const committed = readFileSync(resolve(root, 'docs/CLIENT-API-CONTRACTS.md'), 'utf8');
    expectMatchingTable(renderClientApiContracts(root), committed);
  });

  it('matches the same table with CRLF line endings', () => {
    const rendered = '| Method | Path |\n| GET | /api/example |\n';
    expectMatchingTable(rendered, rendered.replaceAll('\n', '\r\n'));
  });
});
