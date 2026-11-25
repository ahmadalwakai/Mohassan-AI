import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adaptCapabilityObserver, capabilityObserverAdapters, type CapabilityObserverAdapter,
} from '../scripts/agent-capability-bench/by-branch-adapters.js';

const observer = readFileSync(new URL('../scripts/agent-capability-bench/observe.ts', import.meta.url), 'utf8');

describe('capability branch observer adapters', () => {
  it('preserves the original observer when no host wiring is requested', () => {
    expect(adaptCapabilityObserver(observer, [])).toBe(observer);
  });

  it('applies the conversation reviewer to the production judge outcome without writing a shadow log', () => {
    const adapted = adaptCapabilityObserver(observer, ['conversation-reviewer']);
    expect(adapted).toContain("from '../../apps/server/src/assistant/review/publication.js';");
    expect(adapted).toContain("judgeShadow: { logFile: '', observe(input)");
    expect(adapted).toContain("input.applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim()");
    expect(adapted).toContain("input.applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim()");
    expect(adapted).toContain('conversationReviewForJudge(input, verdict, applied);\n        return verdict;');
    expect(adapted).toContain('}, async flush() {}');
  });

  it('registers the branch memory schema after the common memory schema', () => {
    const adapted = adaptCapabilityObserver(observer, ['structured-memory']);
    expect(adapted).toContain("from '../../apps/server/src/assistant/structured-memory-migration.js';");
    expect(adapted).toContain('await memoryMigration(database.db);\n    await migrateStructuredMemory(database.db);');
  });

  it('enables deliberation with the case-local memory reader before controller creation', () => {
    const adapted = adaptCapabilityObserver(observer, ['deliberation']);
    expect(adapted).toContain("from '../../apps/server/src/assistant/deliberation/memory-evidence.js';");
    expect(adapted).toContain("from '../../apps/server/src/assistant/deliberation/settings.js';");
    expect(adapted).toContain('configureDeliberation(database.db, { enabled: true, memoryHit: createMemoryHitReader(memory) });\n'
      + '    control = await createCommandChatControl(database.db, {');
  });

  it('uses the branch desktop clarification wrapper with the recorded desktop port', () => {
    const adapted = adaptCapabilityObserver(observer, ['clarification']);
    expect(adapted).toContain("from '../../apps/server/src/assistant/clarify/host.js';");
    expect(adapted).toContain('parse: text => clarifyDesktopFile(text, parseDesktopCommand), describe: describeDesktopCommand,');
    expect(adapted).toContain('...(fixture.desktop ? { desktop: recordedDesktopPort(fixture.desktop, record) } : {}),');
  });

  it('composes host wiring and applies each adapter once', () => {
    const adapted = adaptCapabilityObserver(observer, capabilityObserverAdapters);
    expect(adaptCapabilityObserver(observer, [...capabilityObserverAdapters, 'structured-memory'])).toBe(adapted);
    for (const adapter of capabilityObserverAdapters) {
      const firstImport = adaptCapabilityObserver(observer, [adapter]).split('\n')[0]!;
      expect(adapted).toContain(firstImport);
    }
  });

  it('rejects missing, duplicated, and already replaced anchors and unknown adapters', () => {
    const adapter = 'structured-memory';
    const anchor = '    await memoryMigration(database.db);';
    expect(() => adaptCapabilityObserver(observer.replace(anchor, ''), [adapter])).toThrow(/does not match/);
    expect(() => adaptCapabilityObserver(observer + anchor, [adapter])).toThrow(/does not match/);
    expect(() => adaptCapabilityObserver(adaptCapabilityObserver(observer, [adapter]), [adapter])).toThrow(/does not match/);
    const existingImport = "import { configureDeliberation } from '../../apps/server/src/assistant/deliberation/settings.js';";
    expect(() => adaptCapabilityObserver(`${existingImport}\n${observer}`, ['deliberation'])).toThrow(/does not match/);
    expect(() => adaptCapabilityObserver(observer, ['unknown' as CapabilityObserverAdapter])).toThrow(/Unknown capability observer adapter/);
  });
});
