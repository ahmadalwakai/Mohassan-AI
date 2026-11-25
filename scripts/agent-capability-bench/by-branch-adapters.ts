const observerAdapters = {
  'conversation-reviewer': {
    imports: "import { conversationReviewForJudge } from '../../apps/server/src/assistant/review/publication.js';",
    original: 'observe: judge, async flush() {}',
    replacement: `observe(input) {
        const verdict = judge(input);
        const applied = Boolean(input.applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim())
          || Boolean(input.applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim());
        conversationReviewForJudge(input, verdict, applied);
        return verdict;
      }, async flush() {}`,
  },
  'structured-memory': {
    imports: "import { migrateStructuredMemory } from '../../apps/server/src/assistant/structured-memory-migration.js';",
    original: '    await memoryMigration(database.db);',
    replacement: '    await memoryMigration(database.db);\n    await migrateStructuredMemory(database.db);',
  },
  deliberation: {
    imports: [
      "import { createMemoryHitReader } from '../../apps/server/src/assistant/deliberation/memory-evidence.js';",
      "import { configureDeliberation } from '../../apps/server/src/assistant/deliberation/settings.js';",
    ].join('\n'),
    original: '    control = await createCommandChatControl(database.db, {',
    replacement: [
      '    configureDeliberation(database.db, { enabled: true, memoryHit: createMemoryHitReader(memory) });',
      '    control = await createCommandChatControl(database.db, {',
    ].join('\n'),
  },
  clarification: {
    imports: "import { clarifyDesktopFile } from '../../apps/server/src/assistant/clarify/host.js';",
    original: 'parse: parseDesktopCommand, describe: describeDesktopCommand,',
    replacement: 'parse: text => clarifyDesktopFile(text, parseDesktopCommand), describe: describeDesktopCommand,',
  },
} as const;

export type CapabilityObserverAdapter = keyof typeof observerAdapters;
export const capabilityObserverAdapters = Object.keys(observerAdapters) as CapabilityObserverAdapter[];

/**
 * Add only the host wiring that the candidate's production app supplies outside
 * the capability controller. The caller writes the result to a new scratch file
 * next to the untouched observer, preserving the observer's relative imports.
 */
export function adaptCapabilityObserver(source: string, adapters: readonly CapabilityObserverAdapter[]): string {
  let observer = source;
  for (const adapter of new Set(adapters)) {
    if (!Object.hasOwn(observerAdapters, adapter)) throw new Error(`Unknown capability observer adapter: ${adapter}.`);
    const { imports, original, replacement } = observerAdapters[adapter];
    const first = observer.indexOf(original);
    const hasImport = imports.split('\n').some(line => observer.includes(line));
    if (first < 0 || observer.indexOf(original, first + original.length) >= 0 || hasImport) {
      throw new Error(`Frozen capability observer does not match the ${adapter} adapter.`);
    }
    observer = `${imports}\n${observer.replace(original, () => replacement)}`;
  }
  return observer;
}
